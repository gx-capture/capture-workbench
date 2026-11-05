"""Audio window value objects and slicing policies for progressive speech recognition."""

from __future__ import annotations

from dataclasses import dataclass

from capture_runtime.contracts import CaptureEngine

MAX_PROGRESSIVE_WINDOW_BYTES = 4 * 1024 * 1024
DEFAULT_WINDOW_MS = 120_000
DEFAULT_OVERLAP_MS = 30_000


@dataclass(frozen=True, slots=True)
class AudioWindow:
    """A bounded PCM audio window ready for speech recognition."""

    start_ms: int
    end_ms: int
    payload: bytes

    def __post_init__(self) -> None:
        if self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("audio window interval is invalid")
        if not self.payload:
            raise ValueError("audio window payload must not be empty")
        if len(self.payload) > MAX_PROGRESSIVE_WINDOW_BYTES:
            raise ValueError("audio window exceeds the bounded payload limit")

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True, slots=True)
class WindowSlicingPolicy:
    """Policy for computing progressive audio window intervals with fixed overlap."""

    window_ms: int = DEFAULT_WINDOW_MS
    overlap_ms: int = DEFAULT_OVERLAP_MS

    def __post_init__(self) -> None:
        if self.window_ms <= 0:
            raise ValueError("window_ms must be positive")
        if self.overlap_ms < 0 or self.overlap_ms >= self.window_ms:
            raise ValueError("overlap_ms must be non-negative and smaller than window_ms")

    @property
    def step_ms(self) -> int:
        return self.window_ms - self.overlap_ms

    def compute_windows(
        self, total_duration_ms: int, *, start_ms: int = 0, include_partial: bool = True
    ) -> tuple[tuple[int, int], ...]:
        if total_duration_ms <= 0:
            return ()
        windows: list[tuple[int, int]] = []
        start = start_ms
        step = self.step_ms
        while start < total_duration_ms:
            end = min(start + self.window_ms, total_duration_ms)
            if include_partial or end - start == self.window_ms:
                windows.append((start, end))
            if end == total_duration_ms:
                break
            start += step
        return tuple(windows)


@dataclass(frozen=True, slots=True)
class WindowTranscriptSegment:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class WindowTranscript:
    segments: tuple[WindowTranscriptSegment, ...]
    extraction_engine: CaptureEngine
    warnings: tuple[str, ...] = ()
