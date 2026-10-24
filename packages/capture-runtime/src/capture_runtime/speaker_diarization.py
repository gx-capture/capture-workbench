"""Local Nemotron speaker diarization adapter with one bounded CPU retry.

PyAV, PyTorch and Transformers are imported inside functions: the worker
reports each import boundary itself, and the core runtime never loads them.
"""

from __future__ import annotations

import gc
import importlib.util
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from capture_runtime.constants import DIARIZATION_REQUIREMENT_ID
from capture_runtime.engine_adapters import (
    EngineProbe,
    EngineRuntimeUnavailableError,
    _directory_digest,
)
from capture_runtime.speaker_turns import SPEAKER_LABEL, SpeakerTurn
from capture_runtime.worker_stage_policy import sanitize_worker_stage

DIARIZATION_MODEL = "nvidia-nemotron-3-diarization"
DIARIZATION_REQUIRED_FILES = (
    "config.json",
    "processor_config.json",
    "model.safetensors",
)
SAMPLE_RATE = 16_000
SPEAKER_ACTIVITY_THRESHOLD = 0.5
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


class NemotronDiarizationAdapter:
    """Run a local Transformers model directory; never contacts a model hub."""

    def __init__(
        self,
        model_dir: Path,
        *,
        prefer_gpu: bool,
        max_duration_ms: int,
        allow_cpu_fallback: bool = True,
        processor_factory: Any | None = None,
        model_factory: Any | None = None,
        torch_module: Any | None = None,
        decoder: Callable[..., bytearray] = decode_mono_16k,
        stage_reporter: Callable[[str], None] | None = None,
        progress_reporter: Callable[[int, int], None] | None = None,
    ) -> None:
        self.model_dir = model_dir
        self._progress_reporter = progress_reporter
        self.prefer_gpu = prefer_gpu
        self.max_duration_ms = max_duration_ms
        self.allow_cpu_fallback = allow_cpu_fallback
        self._processor_factory = processor_factory
        self._model_factory = model_factory
        self._torch = torch_module
        self._decoder = decoder
        self._stage_reporter = stage_reporter

    def _report_stage(self, stage: str) -> None:
        safe_stage = sanitize_worker_stage(stage)
        if safe_stage is not None and self._stage_reporter is not None:
            self._stage_reporter(safe_stage)

    def probe(self) -> EngineProbe:
        code_ready = (
            self._processor_factory is not None and self._model_factory is not None
        ) or all(
            importlib.util.find_spec(name) is not None
            for name in ("torch", "transformers", "librosa", "av")
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
        audio = torch.frombuffer(pcm, dtype=torch.int16).to(torch.float32).div(32768.0).numpy()
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
        processor_factory = self._processor_factory
        model_factory = self._model_factory
        if processor_factory is None or model_factory is None:
            from transformers import AutoModelForAudioFrameClassification, AutoProcessor

            processor_factory = AutoProcessor
            model_factory = AutoModelForAudioFrameClassification

        def stop_when_cancelled() -> None:
            if should_cancel():
                raise InterruptedError("Speaker diarization was cancelled.")

        stop_when_cancelled()
        if device == "cuda":
            self._report_stage("diarization-device-cuda")
        else:
            self._report_stage("diarization-device-cpu")
        self._report_stage("diarization-model-load-start")
        model = inputs = logits = None
        try:
            processor = processor_factory.from_pretrained(
                str(self.model_dir), local_files_only=True
            )
            # Load on CPU first; only the explicit transfer selects the device.
            model = model_factory.from_pretrained(str(self.model_dir), local_files_only=True)
            stop_when_cancelled()
            model.to(torch.device(device))
            self._report_stage("diarization-model-load-complete")
            inputs = processor(audio, sampling_rate=SAMPLE_RATE).to(torch.device(device))
            stop_when_cancelled()
            self._report_stage("diarization-inference-start")
            if self._progress_reporter is not None:
                self._progress_reporter(0, 1000)
            chunk_count = _offline_chunk_count(model, inputs)
            completed = 0

            def after_chunk(*_: object) -> None:
                # The offline forward runs the classifier once per chunk.
                nonlocal completed
                completed += 1
                stop_when_cancelled()
                if self._progress_reporter is not None and chunk_count:
                    self._progress_reporter(min(completed * 1000 // chunk_count, 999), 1000)

            hook = model.classifier.register_forward_hook(after_chunk) if chunk_count else None
            try:
                # Omit streaming arguments: forward chunks the whole recording using
                # the checkpoint's 30.4 s buffer and internal speaker cache.
                with torch.inference_mode():
                    logits = model(**inputs).logits
            finally:
                if hook is not None:
                    hook.remove()
            stop_when_cancelled()
            probabilities = logits.sigmoid()[0].tolist()
            result = _speaker_turns(
                probabilities, processor.feature_extractor.hop_length, duration_ms
            )
            stop_when_cancelled()
            self._report_stage("diarization-inference-complete")
            if self._progress_reporter is not None:
                self._progress_reporter(1000, 1000)
            return result
        finally:
            # Exceptions retain their traceback until the fallback handler exits.
            # Drop large tensors here so that handler cannot retain the GPU model.
            model = inputs = logits = None


def _offline_chunk_count(model: Any, inputs: Any) -> int | None:
    """Chunks the offline forward runs, or None when its classifier cannot be observed."""
    classifier = getattr(model, "classifier", None)
    features = inputs.get("input_features")
    if not hasattr(classifier, "register_forward_hook") or not hasattr(features, "shape"):
        return None
    config = model.config
    embeds = -(-int(features.shape[1]) // int(config.audio_config.subsampling_factor))
    return max(1, -(-embeds // int(config.chunk_length)))


def _activity_turns(
    active: list[list[bool]], hop_length: int, duration_ms: int
) -> tuple[SpeakerTurn, ...]:
    """Merge each first-arrival speaker channel's consecutive active frames."""
    turns: list[SpeakerTurn] = []
    for speaker, frames in enumerate(zip(*active, strict=True)):
        label = f"SPEAKER_{speaker:02d}"
        if SPEAKER_LABEL.fullmatch(label) is None:
            raise ValueError("Diarization speaker label is invalid.")
        start = None
        for index, on in enumerate((*frames, False)):
            if on and start is None:
                start = index
            elif not on and start is not None:
                start_ms = round(start * hop_length * 1000 / SAMPLE_RATE)
                end_ms = min(round(index * hop_length * 1000 / SAMPLE_RATE), duration_ms)
                if start_ms < end_ms:
                    turns.append(SpeakerTurn(start_ms, end_ms, label))
                start = None
    return tuple(sorted(turns, key=lambda turn: (turn.start_ms, turn.speaker)))


def _speaker_turns(
    probabilities: list[list[float]], hop_length: int, duration_ms: int
) -> tuple[tuple[SpeakerTurn, ...], tuple[SpeakerTurn, ...]]:
    """Keep overlaps in regular turns and only the likeliest active speaker in exclusive turns."""
    regular = [[score > SPEAKER_ACTIVITY_THRESHOLD for score in row] for row in probabilities]
    exclusive = []
    for row, active in zip(probabilities, regular, strict=True):
        best = max(range(len(row)), key=row.__getitem__)
        exclusive.append([index == best and active[index] for index in range(len(row))])
    return (
        _activity_turns(regular, hop_length, duration_ms),
        _activity_turns(exclusive, hop_length, duration_ms),
    )


__all__ = [
    "DIARIZATION_MODEL",
    "DIARIZATION_REQUIRED_FILES",
    "DIARIZATION_REQUIREMENT_ID",
    "NemotronDiarizationAdapter",
    "SpeakerDiarizationResult",
    "SpeakerTurn",
    "cuda_failure_reason",
    "decode_mono_16k",
]
