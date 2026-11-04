"""Domain layer for speaker diarization."""

from __future__ import annotations

from capture_runtime.diarization.domain.turn import (
    MAX_PAUSE_MS,
    MAX_SAMPLE_MS,
    SPEAKER_LABEL,
    SpeakerAssignment,
    SpeakerSample,
    SpeakerSegment,
    SpeakerTurn,
    TimedWord,
    TurnTimeline,
    assign_speakers,
    speaker_samples,
    speaker_segments,
)

__all__ = [
    "MAX_PAUSE_MS",
    "MAX_SAMPLE_MS",
    "SPEAKER_LABEL",
    "SpeakerAssignment",
    "SpeakerSample",
    "SpeakerSegment",
    "SpeakerTurn",
    "TimedWord",
    "TurnTimeline",
    "assign_speakers",
    "speaker_samples",
    "speaker_segments",
]

