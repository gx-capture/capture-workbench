"""Transcript produced by the speech recognition adapter, and the adapter port.

The ``Whisper*`` names predate the TEA-ASR engine; they are renamed when the
speech context moves into its own package (DDD plan, decision D9).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from capture_runtime.speech.domain import (
    SpeechTranscriptSegment,
    SpeechWord,
)
from capture_runtime.worker_probe import EngineProbe

# Backwards compatibility aliases for domain models
WhisperWord = SpeechWord
WhisperTextSegment = SpeechTranscriptSegment


@dataclass(frozen=True, slots=True)
class WhisperTranscriptionResult:
    segments: tuple[WhisperTextSegment, ...]
    duration_ms: int
    device: str
    model: str
    digest: str
    warning: str | None = None
    elapsed_ms: int | None = None
    stage_ms: dict[str, int] | None = None


class WhisperAdapter(Protocol):
    def probe(self) -> EngineProbe: ...

    def transcribe(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool = False,
        language: str | None = None,
    ) -> WhisperTranscriptionResult: ...


__all__ = [
    "WhisperAdapter",
    "WhisperTextSegment",
    "WhisperTranscriptionResult",
    "WhisperWord",
]
