"""Domain models, value objects, and events for capture operations."""

from __future__ import annotations

from dataclasses import dataclass

from capture_runtime.contracts import (
    CaptureSourceKind,
    StreamingCaptureStatus,
)


@dataclass(frozen=True, slots=True)
class PageLocator:
    """Spatial coordinate on a specific page."""

    page_index: int
    bounding_box: tuple[float, float, float, float] | None = None

    def __post_init__(self) -> None:
        if self.page_index < 0:
            raise ValueError(f"page_index must be non-negative, got {self.page_index}")


@dataclass(frozen=True, slots=True)
class TimeRange:
    """Temporal coordinate within audio."""

    start_ms: int
    end_ms: int

    def __post_init__(self) -> None:
        if self.start_ms < 0:
            raise ValueError(f"start_ms must be non-negative, got {self.start_ms}")
        if self.end_ms < self.start_ms:
            raise ValueError(f"end_ms ({self.end_ms}) cannot precede start_ms ({self.start_ms})")


@dataclass(frozen=True, slots=True)
class CaptureCompleted:
    """Domain event emitted when a capture operation finishes successfully."""

    capture_id: str
    completed_at_ms: int

    def __post_init__(self) -> None:
        if not self.capture_id:
            raise ValueError("capture_id cannot be empty")
        if self.completed_at_ms < 0:
            raise ValueError(f"completed_at_ms must be non-negative, got {self.completed_at_ms}")


@dataclass(frozen=True, slots=True)
class CaptureOperation:
    """Aggregate root managing capture operation execution state."""

    capture_id: str
    ingestion_id: str
    kind: CaptureSourceKind
    status: StreamingCaptureStatus = StreamingCaptureStatus.CREATED
    progress: float = 0.0
    partial_revision: int = 0
    last_event_sequence: int = 0

    def __post_init__(self) -> None:
        if not self.capture_id:
            raise ValueError("capture_id cannot be empty")
        if not self.ingestion_id:
            raise ValueError("ingestion_id cannot be empty")
        if not 0.0 <= self.progress <= 1.0:
            raise ValueError(f"progress must be in [0.0, 1.0], got {self.progress}")
        if self.partial_revision < 0:
            raise ValueError(f"partial_revision must be non-negative, got {self.partial_revision}")
        if self.last_event_sequence < 0:
            raise ValueError(
                f"last_event_sequence must be non-negative, got {self.last_event_sequence}"
            )


__all__ = [
    "CaptureCompleted",
    "CaptureOperation",
    "PageLocator",
    "TimeRange",
]
