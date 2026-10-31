from __future__ import annotations

import gc
import wave
from array import array
from pathlib import Path

import pytest

from capture_runtime import speech_recognition as speech
from tests.speech_model_fakes import FakeModels, OutOfMemoryError, _Ids, adapter


@pytest.mark.parametrize("device", ["cpu", "cuda"])
def test_processing_times_use_milliseconds_on_the_result_device(tmp_path, monkeypatch, device):
    fake = FakeModels(monkeypatch)
    clock = iter(range(0, 1000, 5))
    monkeypatch.setattr(speech.time, "perf_counter", lambda: next(clock))
    result = adapter(tmp_path, fake, prefer_gpu=device == "cuda").transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False
    )
    assert result.device == device
    assert result.stage_ms == {
        "modelLoad": 5000,
        "transcription": 5000,
        "alignerLoad": 5000,
        "alignment": 5000,
    }
    assert result.elapsed_ms == 45000


@pytest.mark.parametrize("engine", ["asr", "aligner"])
def test_cpu_fallback_time_includes_the_failed_gpu_attempt(tmp_path, monkeypatch, engine):
    fake = FakeModels(monkeypatch)
    fake.failures[(engine, "inference")] = RuntimeError("CUDA out of memory")
    clock = iter(range(0, 1000, 5))
    monkeypatch.setattr(speech.time, "perf_counter", lambda: next(clock))
    result = adapter(tmp_path, fake).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False
    )
    assert result.device == "cpu"
    assert result.stage_ms == {
        "modelLoad": 5000,
        "transcription": 5000,
        "alignerLoad": 5000,
        "alignment": 5000,
    }
    assert result.elapsed_ms == (60000 if engine == "asr" else 80000)


def test_transcription_time_includes_all_chunks_and_split_retries(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    elapsed = [0.0]
    monkeypatch.setattr(speech.time, "perf_counter", lambda: elapsed[0])
    monkeypatch.setattr(speech, "_quiet_point", lambda _a, left, right: (left + right) // 2)

    def generation_time(samples):
        elapsed[0] += 0.125
        return samples > speech.SAMPLE_RATE * 5

    fake.runaway = generation_time
    result = adapter(tmp_path, fake, audio=[0.0] * (speech.SAMPLE_RATE * 40)).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False
    )
    calls = sum(event[0] == "generate" for event in fake.events)
    assert calls > 2
    assert result.stage_ms["transcription"] == calls * 125
    assert result.elapsed_ms == calls * 125


def test_loader_preserves_tea_tokenizer_and_local_architecture(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    fake.transcript = "你好！台灣。"
    fake.alignment = [
        {"text": char, "start_time": i * 0.2, "end_time": i * 0.2}
        for i, char in enumerate("你好台灣")
    ]
    stages = []
    recognizer = adapter(tmp_path, fake, word_timestamps=True, stage_reporter=stages.append)

    result = recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert [x.text for x in result.segments] == ["你好！", "台灣。"]
    assert "".join(w.text for s in result.segments for w in s.words) == fake.transcript
    assert result.segments[0].words[0].start_ms == result.segments[0].words[0].end_ms == 0
    assert (result.model, result.device) == ("tea-asr-1.1", "cuda")
    assert fake.loads("asr")[0][3]["dtype"] == "bfloat16"
    assert any(e[:2] == ("tokenizer", str(tmp_path / "primary")) for e in fake.events)
    for e in fake.events:
        if e[0] in {"processor", "tokenizer", "load"}:
            options = e[-1]
            assert options["local_files_only"] is True
            assert options["trust_remote_code"] is False
            assert "token" not in options
    assert all(speech.sanitize_worker_stage(stage) == stage for stage in stages)


def test_models_stay_loaded_for_the_next_window(tmp_path, monkeypatch):
    # A streaming capture transcribes 120 s windows; 0.7.1 reloaded both models for each.
    fake = FakeModels(monkeypatch)
    recognizer = adapter(tmp_path, fake)

    for _ in range(3):
        result = recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)

    assert (result.model, result.device) == ("tea-asr-1.1", "cuda")
    assert len(fake.loads("asr")) == 1
    assert len(fake.loads("aligner")) == 1
    assert result.stage_ms is not None and set(result.stage_ms) >= {"modelLoad", "alignerLoad"}


def test_the_recognizer_makes_room_when_the_aligner_does_not_fit_beside_it(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    recognizer = adapter(tmp_path, fake)
    attempts = []

    def aligner_fits_alone():
        if fake.loads("aligner") and not attempts:
            attempts.append("first")
            fake.failures[("aligner", "transfer")] = OutOfMemoryError("CUDA out of memory")
        elif len(fake.loads("aligner")) > 1:
            gc.collect()
            assert all(ref() is None or ref().engine != "asr" for ref in fake.gpu_models)
            fake.failures.pop(("aligner", "transfer"), None)

    fake.on_load = aligner_fits_alone
    result = recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)

    assert (result.model, result.device) == ("tea-asr-1.1", "cuda")
    assert len(fake.loads("aligner")) == 2
    assert ("empty_cache",) in fake.events


@pytest.mark.parametrize("engine", ["asr", "aligner"])
def test_cuda_failure_discards_partial_results_and_uses_mini_once(tmp_path, monkeypatch, engine):
    fake = FakeModels(monkeypatch)
    fake.failures[(engine, "inference")] = RuntimeError("CUDA out of memory private/path")
    recognizer = adapter(tmp_path, fake)
    result = recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert [Path(e[2]).name for e in fake.loads("asr")] == ["primary", "fallback"]
    assert fake.devices("asr") == ["cuda", "cpu"]
    assert fake.loads("asr")[-1][3]["dtype"] == "float32"
    assert (result.model, result.device) == ("tea-asr-1.1-mini", "cpu")
    assert len(result.segments) == 1
    assert result.warning == "Speech recognition GPU fallback: RuntimeError"
    gc.collect()
    assert all(ref() is None for ref in fake.gpu_models)


@pytest.mark.parametrize(
    "error",
    [ValueError("invalid input"), RuntimeError("broken checkpoint"), InterruptedError("cancelled")],
)
def test_non_device_errors_never_retry(tmp_path, monkeypatch, error):
    fake = FakeModels(monkeypatch)
    fake.failures[("asr", "inference")] = error
    with pytest.raises(type(error), match=str(error)):
        adapter(tmp_path, fake).transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert fake.devices("asr") == ["cuda"]


def test_explicit_cpu_does_not_probe_cuda_and_strict_cuda_never_falls_back(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch, cuda=False)
    result = adapter(tmp_path, fake, prefer_gpu=False).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False
    )
    assert ("probe",) not in fake.events
    assert result.model == "tea-asr-1.1-mini"
    with pytest.raises(speech.EngineRuntimeUnavailableError, match="CUDA"):
        adapter(tmp_path, fake, allow_cpu_fallback=False).transcribe(
            tmp_path / "source.wav", should_cancel=lambda: False
        )


def test_cpu_failure_is_not_retried(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    fake.failures[("asr", "inference")] = RuntimeError("CUDA out of memory")
    fake.cpu_failures["asr"] = RuntimeError("CPU failed")
    with pytest.raises(RuntimeError, match="CPU failed"):
        adapter(tmp_path, fake).transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert fake.devices("asr") == ["cuda", "cpu"]


def test_token_generation_cancellation_and_callback_failure_never_retry(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    recognizer = adapter(tmp_path, fake)
    with pytest.raises(InterruptedError):
        recognizer.transcribe(
            tmp_path / "source.wav",
            should_cancel=lambda: any(e[0] == "request" for e in fake.events),
        )
    assert fake.devices("asr") == ["cuda"]
    fake.events.clear()

    def fail_progress(*_):
        raise RuntimeError("CUDA out of memory from callback")

    recognizer = adapter(tmp_path, fake, progress_reporter=fail_progress)
    with pytest.raises(RuntimeError, match="callback"):
        recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert fake.devices("asr") == ["cuda"]


def test_chinese_is_forced_for_recognition_and_alignment(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    fake.language = "English"  # what auto-detection might have reported
    adapter(tmp_path, fake).transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert next(e for e in fake.events if e[0] == "request")[1] == "zh"
    assert next(e for e in fake.events if e[0] == "align_request")[1] == "zh"


@pytest.mark.parametrize(
    ("language", "aligned_as"),
    [("en", "en"), ("yue", "yue"), ("ja", None), ("ko", None)],
)
def test_a_named_spoken_language_is_forced_for_recognition(
    tmp_path, monkeypatch, language, aligned_as
):
    # The aligner would need nagisa or soynlp for Japanese or Korean words; the worker
    # ships neither, so those align with the default split.
    fake = FakeModels(monkeypatch)
    adapter(tmp_path, fake).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False, language=language
    )
    assert next(e for e in fake.events if e[0] == "request")[1] == language
    assert next(e for e in fake.events if e[0] == "align_request")[1] == aligned_as


def test_chunk_splitting_covers_audio_and_loop_retry_is_bounded(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    monkeypatch.setattr(speech, "_quiet_point", lambda _a, left, right: (left + right + 1) // 2)
    audio = [0.0] * (speech.SAMPLE_RATE * 65)
    chunks = speech._split_audio(audio)
    assert [
        (start // speech.SAMPLE_RATE, len(chunk) // speech.SAMPLE_RATE) for start, chunk in chunks
    ] == [(0, 30), (30, 30), (60, 5)]
    assert sum(len(chunk) for _, chunk in chunks) == len(audio)
    fake.runaway = lambda samples: True
    result = adapter(tmp_path, fake, audio=[0.0] * (speech.SAMPLE_RATE * 20)).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False
    )
    assert [e[2] for e in fake.events if e[0] == "request"] == [
        320000,
        160000,
        80000,
        80000,
        160000,
        80000,
        80000,
    ]
    assert "4 chunk(s)" in result.warning
    assert len(result.segments) == 4
    assert [s.start_ms for s in result.segments] == [0, 5000, 10000, 15000]


def test_a_repeating_generation_stops_early_and_halves_its_chunk(tmp_path, monkeypatch):
    # 0.7.1 generated one character 564 times (20 s) before halving a 25 s chunk.
    fake = FakeModels(monkeypatch)
    monkeypatch.setattr(speech, "_quiet_point", lambda _a, left, right: (left + right) // 2)
    fake.runaway = lambda samples: samples > speech.SAMPLE_RATE * 15
    result = adapter(tmp_path, fake, audio=[0.0] * (speech.SAMPLE_RATE * 20)).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False
    )

    requests = [e[2] for e in fake.events if e[0] == "request"]
    assert requests[0] == 320000 and len(requests) == 3 and sum(requests[1:]) == 320000
    assert fake.generated == [speech.LOOP_REPEATS, 3, 3]
    assert result.warning is None
    assert len(result.segments) == 2


def test_a_pattern_must_repeat_many_times_to_stop_a_generation():
    loop = speech._LoopStop()
    tokens = []
    stopped_at = None
    # Speech such as "對對對對" repeats a little; a loop repeats until stopped.
    for index, token in enumerate([5, 5, 5, 5, 6, 7] + [8, 9, 10] * 40):
        tokens.append(token)
        if loop(_Ids(tokens)):
            stopped_at = index + 1
            break
    assert stopped_at == 6 + 3 * speech.LOOP_REPEATS
    assert loop.stopped


def test_quiet_point_and_short_tail_padding(tmp_path, monkeypatch):
    np = pytest.importorskip("numpy")
    audio = np.ones(speech.SAMPLE_RATE * 3, dtype=np.float32)
    audio[16000:17600] = 0
    assert speech._quiet_point(audio, 0, len(audio)) == 16000
    fake = FakeModels(monkeypatch)
    result = adapter(tmp_path, fake, audio=np.zeros(1600, dtype=np.float32)).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False
    )
    assert next(e for e in fake.events if e[0] == "request")[2] == 8000
    assert result.duration_ms == 100
    assert all(w.end_ms <= 100 for s in result.segments for w in s.words)


def test_empty_progressive_window_keeps_provenance_and_digest_covers_aligner(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    fake.transcript = ""
    first = adapter(tmp_path, fake).transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False, allow_empty_output=True
    )
    assert first.segments == ()
    assert first.digest.startswith("sha256:")
    recognizer = adapter(tmp_path, fake)
    (tmp_path / "aligner/config.json").write_bytes(b"different aligner")
    second = recognizer.transcribe(
        tmp_path / "source.wav", should_cancel=lambda: False, allow_empty_output=True
    )
    assert first.digest != second.digest
    with pytest.raises(ValueError, match="no non-empty"):
        recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)


def test_models_are_hashed_once_per_worker_beside_the_model_load(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    hashed = []

    def digest(root, paths):
        hashed.append(list(paths))
        return "sha256:" + "d" * 64

    monkeypatch.setattr(speech, "_directory_digest", digest)
    recognizer = adapter(tmp_path, fake)
    results = [
        recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
        for _ in range(2)
    ]

    assert [result.digest for result in results] == ["sha256:" + "d" * 64] * 2
    assert len(hashed) == 1
    assert {Path(path).parts[0] for path in hashed[0]} == {
        "primary",
        "primary-architecture",
        "aligner",
    }


def test_a_failed_model_hash_fails_the_capture_and_is_retried(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    calls = []

    def digest(root, paths):
        calls.append(root)
        if len(calls) == 1:
            raise FileNotFoundError("primary/model.safetensors")
        return "sha256:" + "e" * 64

    monkeypatch.setattr(speech, "_directory_digest", digest)
    recognizer = adapter(tmp_path, fake)
    with pytest.raises(FileNotFoundError):
        recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)

    result = recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert result.digest == "sha256:" + "e" * 64
    assert len(calls) == 2


@pytest.mark.parametrize("bf16,expected", [(True, "bfloat16"), (False, "float16")])
def test_dtype_selection(monkeypatch, bf16, expected):
    fake = FakeModels(monkeypatch, bf16=bf16)
    assert speech._asr_dtype("auto", "cuda", fake._torch()) == expected
    assert speech._asr_dtype("float16", "cpu", fake._torch()) == "float32"


def test_decoder_reads_pcm_and_enforces_duration_and_cancellation(tmp_path):
    pytest.importorskip("numpy")
    source = tmp_path / "audio.wav"
    samples = array("h", [-32768, 0, 32767] * 16000)
    with wave.open(str(source), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(samples.tobytes())
    audio = speech.decode_audio(source, max_duration_ms=3000, should_cancel=lambda: False)
    assert len(audio) == 48000
    assert list(audio[:3]) == [-1, 0, 32767 / 32768]
    with pytest.raises(ValueError, match="duration"):
        speech.decode_audio(source, max_duration_ms=1000, should_cancel=lambda: False)
    with pytest.raises(InterruptedError):
        speech.decode_audio(source, max_duration_ms=3000, should_cancel=lambda: True)


def test_missing_companion_assets_fail_before_model_loading(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    recognizer = adapter(tmp_path, fake)
    (tmp_path / "primary-architecture/processor_config.json").unlink()
    assert recognizer.probe().assets_ready is False
    with pytest.raises(speech.EngineRuntimeUnavailableError, match="primary-architecture"):
        recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert not fake.loads("asr")


def test_progress_failure_preserves_the_original_exception(tmp_path, monkeypatch):
    fake = FakeModels(monkeypatch)
    failure = RuntimeError("CUDA out of memory in a user callback")

    def progress(*_):
        raise failure

    with pytest.raises(RuntimeError) as raised:
        adapter(tmp_path, fake, progress_reporter=progress).transcribe(
            tmp_path / "source.wav", should_cancel=lambda: False
        )
    assert raised.value is failure
    assert fake.devices("asr") == ["cuda"]
