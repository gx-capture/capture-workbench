"""Speaker turn value shared by the diarization worker and the core runtime."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SpeakerTurn:
    start_ms: int
    end_ms: int
    speaker: str


__all__ = ["SpeakerTurn"]
