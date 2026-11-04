"""Speaker turn value shared by the diarization worker and the core runtime."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Final

SPEAKER_LABEL: Final = re.compile(r"[A-Za-z0-9_]{1,32}")


@dataclass(frozen=True, slots=True)
class SpeakerTurn:
    start_ms: int
    end_ms: int
    speaker: str


__all__ = ["SPEAKER_LABEL", "SpeakerTurn"]
