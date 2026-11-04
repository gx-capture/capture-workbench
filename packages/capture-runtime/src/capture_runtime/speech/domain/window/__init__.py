"""Audio window aggregate package."""

from __future__ import annotations

from capture_runtime.speech.domain.window.models import (
    DEFAULT_OVERLAP_MS,
    DEFAULT_WINDOW_MS,
    MAX_PROGRESSIVE_WINDOW_BYTES,
    AudioWindow,
    WindowSlicingPolicy,
)

__all__ = [
    "DEFAULT_OVERLAP_MS",
    "DEFAULT_WINDOW_MS",
    "MAX_PROGRESSIVE_WINDOW_BYTES",
    "AudioWindow",
    "WindowSlicingPolicy",
]

