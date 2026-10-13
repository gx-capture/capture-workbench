"""Local pyannote speaker diarization adapter with one bounded CPU retry.

PyAV, PyTorch and pyannote are imported inside functions: the worker
reports each import boundary itself, and the core runtime never loads them.
"""

from __future__ import annotations

import gc
import importlib.util
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from capture_runtime.engine_adapters import (
    EngineProbe,
    EngineRuntimeUnavailableError,
    _directory_digest,
)
from capture_runtime.speaker_turns import SPEAKER_LABEL, SpeakerTurn
from capture_runtime.worker_stage_policy import sanitize_worker_stage

DIARIZATION_REQUIREMENT_ID = "speaker-diarization"
DIARIZATION_MODEL = "pyannote-speaker-diarization-community-1"
DIARIZATION_REQUIRED_FILES = (
    "config.yaml",
    "embedding/pytorch_model.bin",
    "plda/plda.npz",
    "plda/xvec_transform.npz",
    "segmentation/pytorch_model.bin",
)
SAMPLE_RATE = 16_000
_CUDA_LIBRARIES = ("cublas", "cudnn", "cudart", "nvrtc", "nvcuda")
_LIBRARY_LOAD_FAILURES = (
    "could not load",
    "cannot load",
    "failed to load",
    "unable to load",
    "not found",
    "missing",
    "dll load failed",
    "cannot be loaded",
    "undefined symbol",
)
_CUDA_INITIALIZATION_FAILURES = (
    "cuda driver version is insufficient",
    "cuda initialization",
    "cuda error: initialization error",
    "cuda_error_not_initialized",
    "cuda_error_insufficient_driver",
    "cuda_error_no_device",
    "cuda driver initialization failed",
    "found no nvidia driver",
    "no cuda gpus are available",
)


@dataclass(frozen=True, slots=True)
class SpeakerDiarizationResult:
    # ``turns`` may overlap when people talk at once; ``exclusive_turns`` never do.
    turns: tuple[SpeakerTurn, ...]
    exclusive_turns: tuple[SpeakerTurn, ...]
    duration_ms: int
    device: str
    model: str
    digest: str
    warning: str | None = None


def cuda_failure_reason(error: BaseException) -> str | None:
    """Name a CUDA device failure; any other error must not trigger a CPU retry."""

    causes: list[BaseException] = []
    current: BaseException | None = error
    while current is not None and current not in causes:
        if isinstance(current, InterruptedError):
            return None
        if not isinstance(current, (RuntimeError, OSError)):
            return None
        causes.append(current)
        current = current.__cause__
    for cause in causes:
        message = str(cause).lower()
        if type(cause).__name__ == "OutOfMemoryError" or (
            any(name in message for name in ("cuda", "cudnn", "cublas"))
            and ("out of memory" in message or "memory allocation" in message)
        ):
            return "cuda_out_of_memory"
        if any(name in message for name in _CUDA_LIBRARIES) and any(
            phrase in message for phrase in _LIBRARY_LOAD_FAILURES
        ):
            return "cuda_library_error"
        if any(phrase in message for phrase in _CUDA_INITIALIZATION_FAILURES):
            return "cuda_initialization_error"
    return None


def decode_mono_16k(
    source_path: Path, *, max_duration_ms: int, should_cancel: Callable[[], bool]
) -> bytearray:
    """Decode an audio or video file to mono 16 kHz signed 16-bit PCM in memory."""

    import av
    import av.audio.resampler

    max_bytes = max_duration_ms * SAMPLE_RATE // 1000 * 2
    pcm = bytearray()
    resampler = av.audio.resampler.AudioResampler(format="s16", layout="mono", rate=SAMPLE_RATE)
    with av.open(str(source_path)) as container:
        stream = next((item for item in container.streams if item.type == "audio"), None)
        if stream is None:
            raise ValueError("Source has no audio stream.")
        frames: list[Any] = [*container.decode(stream), None]
        for frame in frames:
            if should_cancel():
                raise InterruptedError("Speaker diarization was cancelled.")
            for decoded in resampler.resample(frame) or ():
                pcm.extend(bytes(decoded.planes[0])[: int(decoded.samples) * 2])
                if len(pcm) > max_bytes:
                    raise ValueError("Audio duration exceeds the configured limit.")
    if not pcm:
        raise ValueError("Source has no audio samples.")
    return pcm


class PyannoteDiarizationAdapter:
    """Run a local pyannote pipeline directory; never contacts a model hub."""

    def __init__(
        self,
        model_dir: Path,
        *,
        prefer_gpu: bool,
        max_duration_ms: int,
        allow_cpu_fallback: bool = True,
        num_speakers: int | None = None,
        pipeline_factory: Any | None = None,
        torch_module: Any | None = None,
        decoder: Callable[..., bytearray] = decode_mono_16k,
        stage_reporter: Callable[[str], None] | None = None,
    ) -> None:
        self.model_dir = model_dir
        self.prefer_gpu = prefer_gpu
        self.max_duration_ms = max_duration_ms
        self.allow_cpu_fallback = allow_cpu_fallback
        self.num_speakers = num_speakers
        self._pipeline_factory = pipeline_factory
        self._torch = torch_module
        self._decoder = decoder
        self._stage_reporter = stage_reporter

    def _report_stage(self, stage: str) -> None:
        safe_stage = sanitize_worker_stage(stage)
        if safe_stage is not None and self._stage_reporter is not None:
            self._stage_reporter(safe_stage)

    def probe(self) -> EngineProbe:
        code_ready = self._pipeline_factory is not None or all(
            importlib.util.find_spec(name) is not None for name in ("torch", "pyannote", "av")
        )
        missing = [
            relative
            for relative in DIARIZATION_REQUIRED_FILES
            if not (self.model_dir / relative).is_file()
        ]
        assets_ready = not missing
        code_detail = None if code_ready else "Missing speaker diarization runtime dependency."
        assets_detail = (
            None if assets_ready else "Missing diarization model assets: " + ", ".join(missing)
        )
        detail = code_detail or assets_detail or "Speaker diarization model is locally ready."
        return EngineProbe(
            code_ready and assets_ready,
            code_ready,
            assets_ready,
            detail,
            code_detail=code_detail,
            assets_detail=assets_detail,
        )

    def cuda_available(self) -> bool:
        torch = self._torch_module()
        try:
            return bool(torch.cuda.is_available())
        except Exception:
            return False

    def diarize(
        self, source_path: Path, *, should_cancel: Callable[[], bool]
    ) -> SpeakerDiarizationResult:
        self._report_stage("diarization-assets-probe-start")
        probe = self.probe()
        if not probe.ready:
            raise EngineRuntimeUnavailableError(probe.detail)
        self._report_stage("diarization-assets-probe-complete")
        self._report_stage("diarization-audio-decode-start")
        pcm = self._decoder(
            source_path, max_duration_ms=self.max_duration_ms, should_cancel=should_cancel
        )
        duration_ms = round(len(pcm) // 2 * 1000 / SAMPLE_RATE)
        self._report_stage("diarization-audio-decode-complete")
        torch = self._torch_module()
        audio = torch.frombuffer(pcm, dtype=torch.int16).to(torch.float32).div(32768.0)
        device = "cuda" if self.prefer_gpu and self.cuda_available() else "cpu"
        if self.prefer_gpu and device == "cpu" and not self.allow_cpu_fallback:
            raise EngineRuntimeUnavailableError("Diarization CUDA device is unavailable.")
        warning = None
        while True:
            try:
                regular, exclusive = self._attempt(
                    torch, audio, device, duration_ms, should_cancel=should_cancel
                )
                break
            except Exception as error:
                reason = cuda_failure_reason(error)
                if device != "cuda" or not self.allow_cpu_fallback or reason is None:
                    raise
            # Outside the handler the failed attempt's frames, and the GPU model
            # they hold, are gone; free that memory before loading the CPU model.
            gc.collect()
            torch.cuda.empty_cache()
            self._report_stage("diarization-gpu-fallback")
            device = "cpu"
            warning = f"Diarization GPU fallback: {reason}"
        if not regular:
            self._report_stage("diarization-output-empty")
        return SpeakerDiarizationResult(
            turns=regular,
            exclusive_turns=exclusive,
            duration_ms=duration_ms,
            device=device,
            model=DIARIZATION_MODEL,
            digest=_directory_digest(self.model_dir, DIARIZATION_REQUIRED_FILES),
            warning=warning,
        )

    def _torch_module(self) -> Any:
        if self._torch is None:
            import torch

            self._torch = torch
        return self._torch

    def _attempt(
        self,
        torch: Any,
        audio: Any,
        device: str,
        duration_ms: int,
        *,
        should_cancel: Callable[[], bool],
    ) -> tuple[tuple[SpeakerTurn, ...], tuple[SpeakerTurn, ...]]:
        factory: Any = self._pipeline_factory
        if factory is None:
            from pyannote.audio import Pipeline

            factory = Pipeline

        def stop_when_cancelled(*_args: object, **_kwargs: object) -> None:
            if should_cancel():
                raise InterruptedError("Speaker diarization was cancelled.")

        stop_when_cancelled()
        if device == "cuda":
            self._report_stage("diarization-device-cuda")
        else:
            self._report_stage("diarization-device-cpu")
        self._report_stage("diarization-model-load-start")
        pipeline: Any = factory.from_pretrained(str(self.model_dir))
        if pipeline is None:
            raise EngineRuntimeUnavailableError("Diarization model could not be loaded.")
        pipeline.to(torch.device(device))
        self._report_stage("diarization-model-load-complete")
        options: dict[str, Any] = {"hook": stop_when_cancelled}
        if self.num_speakers is not None:
            options["num_speakers"] = self.num_speakers
        self._report_stage("diarization-inference-start")
        output: Any = pipeline(
            {"waveform": audio.unsqueeze(0), "sample_rate": SAMPLE_RATE},
            **options,
        )
        stop_when_cancelled()
        self._report_stage("diarization-inference-complete")
        return (
            _turns(output.speaker_diarization, duration_ms),
            _turns(output.exclusive_speaker_diarization, duration_ms),
        )


def _turns(annotation: Any, duration_ms: int) -> tuple[SpeakerTurn, ...]:
    turns: list[SpeakerTurn] = []
    for segment, _track, label in annotation.itertracks(yield_label=True):
        speaker = str(label)
        if SPEAKER_LABEL.fullmatch(speaker) is None:
            raise ValueError("Diarization speaker label is invalid.")
        start_ms = max(0, round(float(segment.start) * 1000))
        end_ms = min(duration_ms, round(float(segment.end) * 1000))
        if start_ms < end_ms:
            turns.append(SpeakerTurn(start_ms, end_ms, speaker))
    return tuple(sorted(turns, key=lambda turn: (turn.start_ms, turn.end_ms, turn.speaker)))


__all__ = [
    "DIARIZATION_MODEL",
    "DIARIZATION_REQUIRED_FILES",
    "DIARIZATION_REQUIREMENT_ID",
    "PyannoteDiarizationAdapter",
    "SpeakerDiarizationResult",
    "SpeakerTurn",
    "cuda_failure_reason",
    "decode_mono_16k",
]
