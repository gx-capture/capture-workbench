"""Domain models, value objects, and events for capture operations."""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import datetime

from capture_runtime.contracts import (
    CaptureEventType,
    CaptureSourceKind,
    CaptureStatus,
    StructuringMode,
)
from capture_runtime.contracts import CaptureOperation as CaptureOperationContract

TERMINAL_CAPTURE_STATUSES = frozenset(
    {
        CaptureStatus.COMPLETED,
        CaptureStatus.FAILED,
        CaptureStatus.CANCELLED,
    }
)


class CaptureTransitionError(ValueError):
    """An action cannot advance this capture's lifecycle."""


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
    completed_at: datetime

    def __post_init__(self) -> None:
        if not self.capture_id:
            raise ValueError("capture_id cannot be empty")
        if self.completed_at.timestamp() < 0:
            raise ValueError("completed_at must not precede the Unix epoch")


@dataclass(frozen=True, slots=True)
class CaptureOperation:
    """Aggregate root managing capture operation execution state."""

    capture_id: str
    ingestion_id: str
    kind: CaptureSourceKind
    status: CaptureStatus = CaptureStatus.WAITING_INPUT
    progress: float = 0.0
    partial_revision: int = 0
    last_event_sequence: int = 0

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_CAPTURE_STATUSES

    def completed_event(self, completed_at: datetime) -> CaptureCompleted:
        if self.status is not CaptureStatus.COMPLETED:
            raise CaptureTransitionError("capture has not completed")
        return CaptureCompleted(self.capture_id, completed_at)

    @classmethod
    def from_contract(cls, operation: CaptureOperationContract) -> CaptureOperation:
        return cls(
            capture_id=operation.capture_id,
            ingestion_id=operation.ingestion_id,
            kind=operation.kind,
            status=operation.status,
            progress=operation.progress or 0.0,
            partial_revision=operation.partial_revision,
            last_event_sequence=operation.last_event_sequence,
        )

    def require_host_structuring(self, mode: StructuringMode) -> None:
        if (
            mode is not StructuringMode.HOST
            or self.status is not CaptureStatus.AWAITING_STRUCTURING
        ):
            raise CaptureTransitionError("capture is not awaiting host structuring")

    def require_pull_structuring(self, mode: StructuringMode) -> None:
        if mode is not StructuringMode.HOST:
            raise CaptureTransitionError("pull structuring requires host capture mode")
        if self.status not in {
            CaptureStatus.AWAITING_STRUCTURING,
            CaptureStatus.STRUCTURING,
        }:
            raise CaptureTransitionError("capture is not awaiting pull structuring")

    def begin_structuring(self) -> CaptureOperation:
        if self.status is CaptureStatus.STRUCTURING:
            return self
        if self.status is not CaptureStatus.AWAITING_STRUCTURING:
            raise CaptureTransitionError("capture is not awaiting structuring")
        return self.transition(CaptureStatus.STRUCTURING)

    def release_structuring(self) -> CaptureOperation:
        """Return to awaiting so a caller-driven structure attempt can be retried."""

        if self.status is not CaptureStatus.STRUCTURING:
            return self
        return self.transition(CaptureStatus.AWAITING_STRUCTURING)

    def transition(self, status: CaptureStatus) -> CaptureOperation:
        """Advance the existing lifecycle; a terminal state never changes."""
        if status is self.status:
            return self
        if self.is_terminal:
            raise CaptureTransitionError(f"cannot move capture from {self.status} to {status}")
        allowed = {
            CaptureStatus.WAITING_INPUT: {CaptureStatus.EXTRACTING},
            CaptureStatus.EXTRACTING: {
                CaptureStatus.AWAITING_STRUCTURING,
                CaptureStatus.COMPLETED,
            },
            CaptureStatus.AWAITING_STRUCTURING: {
                CaptureStatus.STRUCTURING,
                CaptureStatus.COMPLETED,
            },
            CaptureStatus.STRUCTURING: {
                CaptureStatus.AWAITING_STRUCTURING,
                CaptureStatus.COMPLETED,
            },
        }
        if status != self.status and status not in allowed.get(self.status, set()) | {
            CaptureStatus.FAILED,
            CaptureStatus.CANCELLED,
        }:
            raise CaptureTransitionError(f"cannot move capture from {self.status} to {status}")
        progress = {
            CaptureStatus.EXTRACTING: 0.1,
            CaptureStatus.AWAITING_STRUCTURING: 0.9,
            CaptureStatus.STRUCTURING: 0.95,
            CaptureStatus.COMPLETED: 1.0,
        }.get(status, self.progress)
        return replace(self, status=status, progress=progress)

    def record_event(
        self,
        event_type: CaptureEventType,
        *,
        progress: float | None = None,
        partial_revision: int | None = None,
        terminal_transition: bool = False,
    ) -> CaptureOperation:
        """Fold an event once; only the transition itself may publish its terminal event."""
        terminal_event = {
            CaptureStatus.COMPLETED: CaptureEventType.COMPLETED,
            CaptureStatus.FAILED: CaptureEventType.FAILED,
            CaptureStatus.CANCELLED: CaptureEventType.CANCELLED,
        }.get(self.status)
        if self.is_terminal and not (terminal_transition and event_type == terminal_event):
            raise CaptureTransitionError("terminal capture no longer accepts events")
        return replace(
            self,
            last_event_sequence=self.last_event_sequence + 1,
            partial_revision=max(self.partial_revision, partial_revision or 0),
            progress=self.progress if progress is None else max(self.progress, progress),
        )

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
