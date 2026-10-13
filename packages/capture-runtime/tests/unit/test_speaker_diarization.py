from __future__ import annotations

import wave
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from capture_runtime.engine_adapters import EngineRuntimeUnavailableError
from capture_runtime.speaker_diarization import (
    DIARIZATION_REQUIRED_FILES,
    PyannoteDiarizationAdapter,
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


def _annotation(*turns: tuple[float, float, str]) -> Any:
    return SimpleNamespace(
        itertracks=lambda yield_label: iter(
            (SimpleNamespace(start=start, end=end), 0, speaker) for start, end, speaker in turns
        )
    )


def _adapter(
    tmp_path: Path,
    *,
    cuda: bool,
    failures: dict[str, Exception] | None = None,
    cancel_during_inference: list[bool] | None = None,
    **options: Any,
) -> tuple[PyannoteDiarizationAdapter, list[Any], list[str]]:
    events: list[Any] = []
    stages: list[str] = []
    device_failures = failures or {}

    class Pipeline:
        device = "cpu"

        @classmethod
        def from_pretrained(cls, model: str) -> Pipeline:
            events.append(("load", model))
            return cls()

        def to(self, device: str) -> None:
            self.device = device

        def __call__(self, audio: Any, **call_options: Any) -> Any:
            hook = call_options.pop("hook")
            assert audio == {"waveform": "waveform", "sample_rate": 16_000}
            events.append(("inference", self.device, call_options))
            if self.device in device_failures:
                raise device_failures[self.device]
            if cancel_during_inference is not None:
                cancel_during_inference[0] = True
            hook("embeddings", None, total=2, completed=1)
            return SimpleNamespace(
                speaker_diarization=_annotation(
                    (1.0, 2.5, "SPEAKER_01"), (0.0, 1.2, "SPEAKER_00"), (9.5, 12.0, "SPEAKER_00")
                ),
                exclusive_speaker_diarization=_annotation(
                    (0.0, 1.0, "SPEAKER_00"), (1.0, 2.5, "SPEAKER_01")
                ),
            )

    waveform = SimpleNamespace(unsqueeze=lambda axis: "waveform")
    waveform.to = lambda dtype: waveform
    waveform.div = lambda scale: waveform
    torch = SimpleNamespace(
        cuda=SimpleNamespace(
            is_available=lambda: cuda, empty_cache=lambda: events.append(("empty_cache",))
        ),
        device=lambda name: name,
        int16="int16",
        float32="float32",
        frombuffer=lambda pcm, dtype: waveform,
    )
    adapter = PyannoteDiarizationAdapter(
        _model_dir(tmp_path),
        max_duration_ms=60_000,
        pipeline_factory=Pipeline,
        torch_module=torch,
        decoder=lambda path, **_: bytearray(320_000),
        stage_reporter=stages.append,
        **options,
    )
    return adapter, events, stages


def test_turns_are_reported_in_milliseconds_ordered_and_bounded_by_the_audio(
    tmp_path: Path,
) -> None:
    adapter, events, _ = _adapter(tmp_path, cuda=False, prefer_gpu=True, num_speakers=2)

    result = adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)

    assert result.turns == (
        SpeakerTurn(0, 1_200, "SPEAKER_00"),
        SpeakerTurn(1_000, 2_500, "SPEAKER_01"),
        SpeakerTurn(9_500, 10_000, "SPEAKER_00"),
    )
    assert result.exclusive_turns == (
        SpeakerTurn(0, 1_000, "SPEAKER_00"),
        SpeakerTurn(1_000, 2_500, "SPEAKER_01"),
    )
    assert (result.duration_ms, result.device, result.warning) == (10_000, "cpu", None)
    assert result.digest.startswith("sha256:")
    assert ("inference", "cpu", {"num_speakers": 2}) in events


def test_cuda_out_of_memory_retries_the_same_model_once_on_cpu(tmp_path: Path) -> None:
    adapter, events, stages = _adapter(
        tmp_path,
        cuda=True,
        prefer_gpu=True,
        failures={"cuda": OutOfMemoryError("CUDA out of memory")},
    )

    result = adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)

    assert result.device == "cpu"
    assert result.warning == "Diarization GPU fallback: cuda_out_of_memory"
    assert [event[1] for event in events if event[0] == "inference"] == ["cuda", "cpu"]
    assert events.index(("empty_cache",)) < events.index(("inference", "cpu", {}))
    assert "diarization-gpu-fallback" in stages


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
    (adapter.model_dir / "plda" / "plda.npz").unlink()

    probe = adapter.probe()

    assert (probe.ready, probe.code_ready, probe.assets_ready) == (False, True, False)
    assert "plda/plda.npz" in probe.detail
    with pytest.raises(EngineRuntimeUnavailableError):
        adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)
    assert events == []


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
