"""Application use cases for speech transcription."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from capture_runtime.speech.domain.transcript import (
    RepetitionLoopPolicy,
    SpeechTranscript,
    SpeechTranscriptSegment,
    SpeechWord,
)
from capture_runtime.speech.domain.window import (
    AudioWindow,
    WindowSlicingPolicy,
)

if TYPE_CHECKING:
    from capture_runtime.speech.infrastructure.progressive_audio import WhisperWindowResult
    from capture_runtime.speech.infrastructure.speech_transcript import (
        WhisperTranscriptionResult,
    )


class AudioTranscriber(Protocol):
    """Protocol for transcribing complete audio sources."""

    def transcribe(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool = False,
        language: str | None = None,
    ) -> WhisperTranscriptionResult: ...


class WindowTranscriberPort(Protocol):
    """Protocol for transcribing individual audio windows."""

    def transcribe(self, window: AudioWindow) -> WhisperWindowResult: ...


class TranscribeAudio:
    """Execute speech transcription on an audio file and return a domain transcript."""

    def __init__(self, transcriber: AudioTranscriber) -> None:
        self._transcriber = transcriber

    def execute(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool] | None = None,
        allow_empty_output: bool = False,
        language: str | None = None,
    ) -> SpeechTranscript:
        cancel_cb = should_cancel or (lambda: False)
        result = self._transcriber.transcribe(
            source_path,
            should_cancel=cancel_cb,
            allow_empty_output=allow_empty_output,
            language=language,
        )
        segments = tuple(
            SpeechTranscriptSegment(
                start_ms=s.start_ms,
                end_ms=s.end_ms,
                text=s.text,
                words=tuple(
                    SpeechWord(start_ms=w.start_ms, end_ms=w.end_ms, text=w.text) for w in s.words
                ),
            )
            for s in result.segments
        )
        transcript = SpeechTranscript(
            segments=segments,
            duration_ms=result.duration_ms,
            model=result.model,
            device=result.device,
            digest=result.digest,
            warning=result.warning,
        )
        _ = transcript.text
        return transcript


class TranscribeAudioWindow:
    """Transcribe a decoded audio window in progressive capture."""

    def __init__(self, transcriber: WindowTranscriberPort) -> None:
        self._transcriber = transcriber

    def execute(self, window: AudioWindow) -> WhisperWindowResult:
        return self._transcriber.transcribe(window)


class SliceAudioStream:
    """Compute progressive window intervals with overlap for an audio duration."""

    def __init__(self, policy: WindowSlicingPolicy | None = None) -> None:
        self._policy = policy or WindowSlicingPolicy()

    def execute(self, total_duration_ms: int) -> tuple[tuple[int, int], ...]:
        return self._policy.compute_windows(total_duration_ms)


class DetectRepetitionLoop:
    """Evaluate token sequence repetition stopping policy."""

    def __init__(self, policy: RepetitionLoopPolicy | None = None) -> None:
        self._policy = policy or RepetitionLoopPolicy()

    def execute(self, tokens: list[int]) -> bool:
        return self._policy.is_repeating_sequence(tokens)


__all__ = [
    "DetectRepetitionLoop",
    "SliceAudioStream",
    "TranscribeAudio",
    "TranscribeAudioWindow",
]
