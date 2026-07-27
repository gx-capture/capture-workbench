"""Public repository facade for capture and installation persistence."""

from capture_runtime.storage.capture_repository import (
    CaptureRecord,
    CaptureRepository,
    IdempotencyConflictError,
    RecordNotFoundError,
    TransitionRejectedError,
)
from capture_runtime.storage.installation_repository import (
    InstallationRecord,
    InstallationRepository,
)

__all__ = [
    "CaptureRecord",
    "CaptureRepository",
    "IdempotencyConflictError",
    "InstallationRecord",
    "InstallationRepository",
    "RecordNotFoundError",
    "TransitionRejectedError",
]
