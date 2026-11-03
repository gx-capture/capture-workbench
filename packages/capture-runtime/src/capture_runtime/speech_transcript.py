"""Transcript produced by the speech recognition adapter, and the adapter port.

The ``Whisper*`` names predate the TEA-ASR engine; they are renamed when the
speech context moves into its own package (DDD plan, decision D9).
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from capture_runtime.worker_probe import EngineProbe


@dataclass(frozen=True, slots=True)
class WhisperWord:
    start_ms: int
    end_ms: int
    # Raw model token text; a leading space marks a word boundary.
    text: str


@dataclass(frozen=True, slots=True)
class WhisperTextSegment:
    start_ms: int
    end_ms: int
    text: str
    # Filled only when the adapter was asked for word timestamps.
    words: tuple[WhisperWord, ...] = ()


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
