"""Installation aggregate root and state machine."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from capture_runtime.contracts import RuntimeInstallationStatus

TERMINAL_STATUSES = frozenset(
    {
        RuntimeInstallationStatus.COMPLETED,
        RuntimeInstallationStatus.FAILED,
        RuntimeInstallationStatus.CANCELLED,
        RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
    }
)


@dataclass(slots=True)
class ModelInstallation:
    """Aggregate root managing requirement installation lifecycle and state transitions."""

    installation_id: str
    option_id: str
    status: RuntimeInstallationStatus = RuntimeInstallationStatus.QUEUED
    progress: float = 0.0
    failure_code: str | None = None
    failure_message: str | None = None
    retryable: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None
    completed_at: datetime | None = None

    @property
    def is_terminal(self) -> bool:
        return self.status in TERMINAL_STATUSES

    def mark_running(self, now: datetime, initial_progress: float = 0.05) -> None:
        if self.is_terminal:
            return
        self.status = RuntimeInstallationStatus.RUNNING
        self.progress = max(0.0, min(1.0, initial_progress))
        self.updated_at = now

    def update_progress(self, value: float, now: datetime) -> None:
        if self.is_terminal:
            return
        self.progress = max(0.0, min(1.0, value))
        self.updated_at = now

    def mark_completed(self, now: datetime) -> None:
        if self.is_terminal:
            return
        self.status = RuntimeInstallationStatus.COMPLETED
        self.progress = 1.0
        self.updated_at = now
        self.completed_at = now

    def mark_failed(
        self,
        code: str,
        message: str,
        *,
        retryable: bool,
        now: datetime,
        manual_action: bool = False,
    ) -> None:
        if self.is_terminal:
            return
        self.status = (
            RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED
            if manual_action
            else RuntimeInstallationStatus.FAILED
        )
        self.failure_code = code
        self.failure_message = message[:500]
        self.retryable = retryable
        self.updated_at = now
        self.completed_at = now

    def mark_cancelled(self, now: datetime) -> None:
        if self.is_terminal:
            return
        self.status = RuntimeInstallationStatus.CANCELLED
        self.failure_code = "installation_cancelled"
        self.failure_message = "Runtime installation was cancelled."
        self.retryable = True
        self.updated_at = now
        self.completed_at = now
