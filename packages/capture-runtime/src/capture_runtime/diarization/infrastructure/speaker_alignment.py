"""Give timed transcript items a speaker from diarization turns, without guessing.

Pure standard library: the core runtime joins Whisper output with the
diarization worker's turns here, so neither worker depends on the other.
"""

from __future__ import annotations

from capture_runtime.diarization.domain.turn import (
    MAX_PAUSE_MS,
    MAX_SAMPLE_MS,
    SpeakerAssignment,
    SpeakerSample,
    SpeakerSegment,
    TimedWord,
    assign_speakers,
    speaker_samples,
    speaker_segments,
)

__all__ = [
    "MAX_PAUSE_MS",
    "MAX_SAMPLE_MS",
    "SpeakerAssignment",
    "SpeakerSample",
    "SpeakerSegment",
    "TimedWord",
    "assign_speakers",
    "speaker_samples",
    "speaker_segments",
]
