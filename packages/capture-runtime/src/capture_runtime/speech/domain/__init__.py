"""Speech transcription domain layer."""

from __future__ import annotations

from capture_runtime.speech.domain.transcript import (
    LOOP_MAX_PERIOD,
    LOOP_REPEATS,
    RepetitionLoopPolicy,
    SpeechTranscript,
    SpeechTranscriptSegment,
    SpeechWord,
)
from capture_runtime.speech.domain.window import (
    DEFAULT_OVERLAP_MS,
    DEFAULT_WINDOW_MS,
    MAX_PROGRESSIVE_WINDOW_BYTES,
    AudioWindow,
    WindowSlicingPolicy,
)

__all__ = [
    "DEFAULT_OVERLAP_MS",
    "DEFAULT_WINDOW_MS",
    "LOOP_MAX_PERIOD",
    "LOOP_REPEATS",
    "AudioWindow",
    "MAX_PROGRESSIVE_WINDOW_BYTES",
    "RepetitionLoopPolicy",
    "SpeechTranscript",
    "SpeechTranscriptSegment",
    "SpeechWord",
    "WindowSlicingPolicy",
]

