from __future__ import annotations

import wave
from array import array
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from capture_runtime.engine_adapters import EngineRuntimeUnavailableError
from capture_runtime.speaker_diarization import (
    DIARIZATION_REQUIRED_FILES,
    NemotronDiarizationAdapter,
    _speaker_turns,
    cuda_failure_reason,
    decode_mono_16k,
)
from capture_runtime.speaker_turns import SpeakerTurn


class OutOfMemoryError(RuntimeError):
    pass


def _model_dir(root: Path) -> Path:
    for relative in DIARIZATION_REQUIRED_FILES:
        path = root / "model" / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(relative.encode())
    return root / "model"


def _adapter(
    tmp_path: Path,
    *,
    cuda: bool,
    failures: dict[str, Exception] | None = None,
    failure_stage: str = "inference",
    cancel_during_inference: list[bool] | None = None,
    chunks: int | None = None,
    **options: Any,
) -> tuple[NemotronDiarizationAdapter, list[Any], list[str]]:
    events: list[Any] = []
    stages: list[str] = []
    device_failures = failures or {}

    # Eight first-arrival channels, including overlapping and trailing activity.
    probabilities = [[0.0] * 8 for _ in range(1200)]
    for index, row in enumerate(probabilities):
        row[0] = 0.8 if index < 120 or index >= 950 else 0.1
        row[1] = 0.9 if 100 <= index < 250 else 0.1
    in_inference = [False]

    def fail(device: str, stage: str) -> None:
        if device in device_failures and stage == failure_stage:
            raise device_failures[device]

    class Inputs(dict[str, Any]):
        def to(self, device: str) -> Inputs:
            events.append(("inputs-to", device))
            fail(device, "inputs")
            return self

    class Processor:
        feature_extractor = SimpleNamespace(hop_length=160)

        @classmethod
        def from_pretrained(cls, model: str, **kwargs: Any) -> Processor:
            events.append(("processor-load", model, kwargs))
            return cls()

        def __call__(self, audio: array, *, sampling_rate: int) -> Inputs:
            assert sampling_rate == 16_000
            assert audio.typecode == "f"
            assert audio[:3] == array("f", [-1.0, 0.0, 32767 / 32768])
            # With chunks, 340 encoder frames of 8 mel frames each form one offline chunk.
            features = SimpleNamespace(shape=(1, chunks * 340 * 8)) if chunks else "features"
            return Inputs(input_features=features, attention_mask="mask")

    class Logits:
        def sigmoid(self) -> Logits:
            assert not in_inference[0]
            events.append(("sigmoid",))
            return self

        def __getitem__(self, index: int) -> Logits:
            assert index == 0
            return self

        def tolist(self) -> list[list[float]]:
            return probabilities

    class Classifier:
        def __init__(self) -> None:
            self.hooks: list[Any] = []

        def register_forward_hook(self, hook: Any) -> Any:
            self.hooks.append(hook)
            return SimpleNamespace(remove=lambda: self.hooks.remove(hook))

    class Model:
        device = "cpu"
        config = SimpleNamespace(
            chunk_length=340, audio_config=SimpleNamespace(subsampling_factor=8)
        )

        def __init__(self) -> None:
            if chunks:
                self.classifier = Classifier()

        @classmethod
        def from_pretrained(cls, model: str, **kwargs: Any) -> Model:
            events.append(("load", model, kwargs))
            fail("cuda" if cuda and options.get("prefer_gpu") else "cpu", "load")
            return cls()

        def to(self, device: str) -> None:
            self.device = device
            events.append(("model-to", device))
            fail(device, "transfer")

        def __call__(self, **inputs: Any) -> Any:
            assert in_inference[0]
            assert set(inputs) == {"input_features", "attention_mask"}
            events.append(("inference", self.device, {}))
            fail(self.device, "inference")
            for _ in range(chunks or 0):
                for hook in list(self.classifier.hooks):
                    hook(self.classifier, (), None)
            if cancel_during_inference is not None:
                cancel_during_inference[0] = True
            return SimpleNamespace(logits=Logits())

    class Waveform:
        def __init__(self, pcm: bytearray, dtype: str) -> None:
            assert dtype == "int16"
            self.values = array("h", pcm)

        def to(self, dtype: str) -> Waveform:
            assert dtype == "float32"
            self.values = array("f", self.values)
            return self

        def div(self, scale: float) -> Waveform:
            assert scale == 32768.0
            self.values = array("f", (sample / scale for sample in self.values))
            return self

        def numpy(self) -> array:
            return self.values

    @contextmanager
    def inference_mode() -> Any:
        in_inference[0] = True
        try:
            yield
        finally:
            in_inference[0] = False

    torch = SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: cuda, empty_cache=lambda: events.append(("empty_cache",))
        ),
        device=lambda name: name,
        int16="int16",
        float32="float32",
        frombuffer=Waveform,
        inference_mode=inference_mode,
    )
    adapter = NemotronDiarizationAdapter(
        _model_dir(tmp_path),
        max_duration_ms=60_000,
        processor_factory=Processor,
        model_factory=Model,
        torch_module=torch,
        decoder=lambda path, **_: bytearray(array("h", [-32768, 0, 32767])) + bytearray(319_994),
        stage_reporter=stages.append,
        **options,
    )
    return adapter, events, stages


def test_turns_are_reported_in_milliseconds_ordered_and_bounded_by_the_audio(
    tmp_path: Path,
) -> None:
    adapter, events, _ = _adapter(tmp_path, cuda=False, prefer_gpu=True)

    result = adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)

    assert result.turns == (
        SpeakerTurn(0, 1_200, "SPEAKER_00"),
        SpeakerTurn(1_000, 2_500, "SPEAKER_01"),
        SpeakerTurn(9_500, 10_000, "SPEAKER_00"),
    )
    assert result.exclusive_turns == (
        SpeakerTurn(0, 1_000, "SPEAKER_00"),
        SpeakerTurn(1_000, 2_500, "SPEAKER_01"),
        SpeakerTurn(9_500, 10_000, "SPEAKER_00"),
    )
    assert (result.duration_ms, result.device, result.warning) == (10_000, "cpu", None)
    assert result.digest.startswith("sha256:")
    assert ("inference", "cpu", {}) in events
    assert result.model == "nvidia-nemotron-3-diarization"
    for kind in ("processor-load", "load"):
        assert (kind, str(adapter.model_dir), {"local_files_only": True}) in events
    assert events.index(("load", str(adapter.model_dir), {"local_files_only": True})) < (
        events.index(("model-to", "cpu"))
    )


@pytest.mark.parametrize("stage", ["transfer", "inputs", "inference"])
def test_cuda_out_of_memory_retries_the_same_model_once_on_cpu(tmp_path: Path, stage: str) -> None:
    adapter, events, stages = _adapter(
        tmp_path,
        cuda=True,
        prefer_gpu=True,
        failures={"cuda": OutOfMemoryError("CUDA out of memory")},
        failure_stage=stage,
    )

    result = adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)

    assert result.device == "cpu"
    assert result.warning == "Diarization GPU fallback: cuda_out_of_memory"
    assert [event[1] for event in events if event[0] == "model-to"] == ["cuda", "cpu"]
    assert len([event for event in events if event[0] == "load"]) == 2
    assert events.index(("empty_cache",)) < events.index(("inference", "cpu", {}))
    assert "diarization-gpu-fallback" in stages


def test_activity_threshold_overlap_argmax_tie_and_duration_clamping() -> None:
    rows = [
        [0.5, 0.5],
        [0.6, 0.6],
        [0.7, 0.8],
        [0.1, 0.8],
        [0.9, 0.0],
    ]
    probabilities = [row + [0.0] * 6 for row in rows]

    regular, exclusive = _speaker_turns(probabilities, hop_length=160, duration_ms=35)

    assert regular == (SpeakerTurn(10, 30, "SPEAKER_00"), SpeakerTurn(10, 35, "SPEAKER_01"))
    assert exclusive == (SpeakerTurn(10, 20, "SPEAKER_00"), SpeakerTurn(20, 35, "SPEAKER_01"))


def test_turn_timing_uses_the_processor_hop_length() -> None:
    assert _speaker_turns([[0.0, 0.8], [0.9, 0.1]], 320, 40) == (
        (SpeakerTurn(0, 20, "SPEAKER_01"), SpeakerTurn(20, 40, "SPEAKER_00")),
        (SpeakerTurn(0, 20, "SPEAKER_01"), SpeakerTurn(20, 40, "SPEAKER_00")),
    )


@pytest.mark.parametrize("probabilities", [[], [[0.0] * 8, [0.5] * 8]])
def test_empty_or_inactive_frames_produce_no_turns(probabilities: list[list[float]]) -> None:
    assert _speaker_turns(probabilities, 160, 1000) == ((), ())


def test_failed_cpu_retry_is_bounded(tmp_path: Path) -> None:
    adapter, events, _ = _adapter(
        tmp_path,
        cuda=True,
        prefer_gpu=True,
        failures={
            "cuda": OutOfMemoryError("CUDA out of memory"),
            "cpu": RuntimeError("CPU failed"),
        },
    )
    with pytest.raises(RuntimeError, match="CPU failed"):
        adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)
    assert [event[1] for event in events if event[0] == "model-to"] == ["cuda", "cpu"]


def test_native_inference_progress_reports_completion(tmp_path: Path) -> None:
    reported: list[tuple[int, int]] = []
    adapter, _, _ = _adapter(
        tmp_path,
        cuda=False,
        prefer_gpu=False,
        progress_reporter=lambda completed, total: reported.append((completed, total)),
    )
    adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)
    assert reported == [(0, 1000), (1000, 1000)]


def test_offline_chunks_report_progress(tmp_path: Path) -> None:
    reported: list[tuple[int, int]] = []
    adapter, _, _ = _adapter(
        tmp_path,
        cuda=False,
        prefer_gpu=False,
        chunks=3,
        progress_reporter=lambda completed, total: reported.append((completed, total)),
    )
    adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)
    assert reported == [(0, 1000), (333, 1000), (666, 1000), (999, 1000), (1000, 1000)]


def test_cancellation_between_offline_chunks_stops_inference(tmp_path: Path) -> None:
    reported: list[tuple[int, int]] = []
    adapter, events, _ = _adapter(
        tmp_path,
        cuda=True,
        prefer_gpu=True,
        chunks=3,
        progress_reporter=lambda completed, total: reported.append((completed, total)),
    )
    with pytest.raises(InterruptedError):
        adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: len(reported) >= 2)
    assert reported == [(0, 1000), (333, 1000)]
    assert [event[1] for event in events if event[0] == "inference"] == ["cuda"]


@pytest.mark.parametrize(
    ("failure", "options"),
    [
        (ValueError("invalid input"), {}),
        (RuntimeError("shape mismatch"), {}),
        (OutOfMemoryError("CUDA out of memory"), {"allow_cpu_fallback": False}),
    ],
)
def test_other_failures_and_disabled_fallback_do_not_retry_on_cpu(
    tmp_path: Path, failure: Exception, options: dict[str, Any]
) -> None:
    adapter, events, _ = _adapter(
        tmp_path, cuda=True, prefer_gpu=True, failures={"cuda": failure}, **options
    )

    with pytest.raises(type(failure)):
        adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)

    assert [event[1] for event in events if event[0] == "inference"] == ["cuda"]


def test_required_gpu_is_refused_when_cuda_is_unavailable(tmp_path: Path) -> None:
    adapter, events, _ = _adapter(tmp_path, cuda=False, prefer_gpu=True, allow_cpu_fallback=False)

    with pytest.raises(EngineRuntimeUnavailableError, match="CUDA"):
        adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)

    assert events == []


def test_cancellation_during_inference_stops_without_a_result(tmp_path: Path) -> None:
    cancelled = [False]
    adapter, events, _ = _adapter(
        tmp_path, cuda=True, prefer_gpu=True, cancel_during_inference=cancelled
    )

    with pytest.raises(InterruptedError):
        adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: cancelled[0])

    assert [event[1] for event in events if event[0] == "inference"] == ["cuda"]


def test_missing_model_files_are_named_and_block_the_run(tmp_path: Path) -> None:
    adapter, events, _ = _adapter(tmp_path, cuda=False, prefer_gpu=False)
    (adapter.model_dir / "processor_config.json").unlink()

    probe = adapter.probe()

    assert (probe.ready, probe.code_ready, probe.assets_ready) == (False, True, False)
    assert "processor_config.json" in probe.detail
    with pytest.raises(EngineRuntimeUnavailableError):
        adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)
    assert events == []


@pytest.mark.parametrize("missing", ["torch", "transformers", "librosa", "av"])
def test_probe_requires_each_runtime_dependency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, missing: str
) -> None:
    monkeypatch.setattr(
        "capture_runtime.speaker_diarization.importlib.util.find_spec",
        lambda name: None if name == missing else object(),
    )
    adapter = NemotronDiarizationAdapter(
        _model_dir(tmp_path), prefer_gpu=False, max_duration_ms=1000
    )
    probe = adapter.probe()
    assert (probe.ready, probe.code_ready, probe.assets_ready) == (False, False, True)


@pytest.mark.parametrize(
    ("error", "reason"),
    [
        (OutOfMemoryError("allocation failed"), "cuda_out_of_memory"),
        (RuntimeError("Could not load library cudnn_ops64_9.dll"), "cuda_library_error"),
        (RuntimeError("Found no NVIDIA driver on your system"), "cuda_initialization_error"),
        (RuntimeError("CUDA error: device-side assert triggered"), None),
        (InterruptedError("CUDA out of memory"), None),
        (ValueError("CUDA out of memory"), None),
    ],
)
def test_only_recognized_cuda_device_failures_are_named(
    error: Exception, reason: str | None
) -> None:
    assert cuda_failure_reason(error) == reason


def _write_wav(path: Path, *, seconds: float, rate: int, channels: int) -> None:
    with wave.open(str(path), "wb") as output:
        output.setnchannels(channels)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"\x00\x10" * int(seconds * rate) * channels)


def test_real_decoder_returns_mono_16k_pcm(tmp_path: Path) -> None:
    source = tmp_path / "stereo-8k.wav"
    _write_wav(source, seconds=1.5, rate=8_000, channels=2)

    pcm = decode_mono_16k(source, max_duration_ms=2_000, should_cancel=lambda: False)

    assert abs(len(pcm) // 2 - 24_000) <= 160
    assert bytes(pcm[:2]) == bytes([0, 16])


def test_real_decoder_enforces_the_duration_limit_and_cancellation(tmp_path: Path) -> None:
    source = tmp_path / "long.wav"
    _write_wav(source, seconds=3, rate=16_000, channels=1)

    with pytest.raises(ValueError, match="duration exceeds"):
        decode_mono_16k(source, max_duration_ms=1_000, should_cancel=lambda: False)
    with pytest.raises(InterruptedError):
        decode_mono_16k(source, max_duration_ms=10_000, should_cancel=lambda: True)
