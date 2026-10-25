"""Window transcriber adapter that preserves speech recognition provenance rules."""

from __future__ import annotations

import tempfile
import wave
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any

from capture_runtime.contracts import CaptureEngine
from capture_runtime.engine_adapters import WhisperAdapter
from capture_runtime.progressive_audio import (
    DecodedAudioWindow,
    ProgressiveAudioSession,
    ProgressiveSessionEvent,
    WhisperWindowResult,
    WhisperWindowSegment,
)


class SpeechRecognitionWindowTranscriber:
    """Adapt bounded PCM windows to the GPU-first TEA-ASR adapter."""

    def __init__(
        self,
        adapter: WhisperAdapter,
        *,
        temp_dir: Path,
        sample_rate: int = 16_000,
    ) -> None:
        if sample_rate <= 0:
            raise ValueError("Whisper sample rate must be positive")
        self.adapter = adapter
        self.temp_dir = temp_dir
        self.sample_rate = sample_rate
        # Provenance times the whole recording, so add up every window.
        self._elapsed_ms = 0
        self._stage_ms: dict[str, int] = {}

    def transcribe(self, window: DecodedAudioWindow) -> WhisperWindowResult:
        self.temp_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix="capture-progressive-window-",
            suffix=".wav",
            dir=self.temp_dir,
            delete=False,
        ) as temporary:
            path = Path(temporary.name)
        try:
            with wave.open(str(path), "wb") as audio:
                audio.setnchannels(1)
                audio.setsampwidth(2)
                audio.setframerate(self.sample_rate)
                audio.writeframes(window.payload)
            result = self.adapter.transcribe(
                path,
                should_cancel=lambda: False,
                allow_empty_output=True,
            )
            self._elapsed_ms += result.elapsed_ms or 0
            for stage, milliseconds in (result.stage_ms or {}).items():
                self._stage_ms[stage] = self._stage_ms.get(stage, 0) + milliseconds
            return WhisperWindowResult(
                segments=tuple(
                    WhisperWindowSegment(item.start_ms, item.end_ms, item.text)
                    for item in result.segments
                ),
                extraction_engine=CaptureEngine(
                    engine="speech-recognition",
                    model=result.model,
                    digest=result.digest,
                    device=result.device,
                    elapsed_ms=self._elapsed_ms if result.elapsed_ms is not None else None,
                    stage_ms=dict(self._stage_ms) or None,
                ),
                warnings=(result.warning,) if result.warning else (),
            )
        finally:
            path.unlink(missing_ok=True)


class DirectWindowDecoder:
    """No-op decoder for the worker protocol, which receives decoded windows."""

    def push(self, _data: bytes) -> Iterable[DecodedAudioWindow]:
        return ()

    def finish(self) -> Iterable[DecodedAudioWindow]:
        return ()


class ProgressiveWhisperWorkerBackend:
    """Bind the binary worker protocol to one progressive session per START."""

    def __init__(
        self, session_factory: Callable[[dict[str, Any]], ProgressiveAudioSession]
    ) -> None:
        self._session_factory = session_factory
        self._session: ProgressiveAudioSession | None = None

    @property
    def session(self) -> ProgressiveAudioSession:
        if self._session is None:
            raise RuntimeError("progressive session has not started")
        return self._session

    def start(self, metadata: dict[str, Any]) -> None:
        self._session = self._session_factory(metadata)

    def input(self, window: DecodedAudioWindow) -> Iterable[ProgressiveSessionEvent]:
        return tuple(self._with_provenance(self.session.consume_window(window)))

    def finish(self) -> Iterable[ProgressiveSessionEvent]:
        return tuple(self._with_provenance(self.session.finish()))

    def cancel(self) -> None:
        self.session.cancel()

    def _with_provenance(
        self,
        events: Iterable[ProgressiveSessionEvent],
    ) -> Iterable[ProgressiveSessionEvent]:
        for event in events:
            yield ProgressiveSessionEvent(
                event_type=event.event_type,
                stage=event.stage,
                partial_revision=event.partial_revision,
                covered_until_ms=event.covered_until_ms,
                segments=event.segments,
                error=event.error,
                extraction_engine=self.session.extraction_engine,
            )


__all__ = [
    "DirectWindowDecoder",
    "SpeechRecognitionWindowTranscriber",
    "ProgressiveWhisperWorkerBackend",
]
