"""Transcript adapter port for speech recognition."""

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path
from typing import Protocol

from capture_runtime.speech.domain.transcript.models import SpeechRecognitionResult
from capture_runtime.worker_probe import EngineProbe


class SpeechRecognitionAdapter(Protocol):
    def probe(self) -> EngineProbe: ...

    def transcribe(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool = False,
        language: str | None = None,
    ) -> SpeechRecognitionResult: ...


__all__ = [
    "SpeechRecognitionAdapter",
]
