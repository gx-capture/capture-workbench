"""Public repository facade for model installation and structuring persistence."""

from capture_runtime.storage.common import (
    IdempotencyConflictError,
    RecordNotFoundError,
    TransitionRejectedError,
)
from capture_runtime.structuring.infrastructure.model_installation_repository import (
    ModelInstallationRecord,
    ModelInstallationRepository,
)
from capture_runtime.structuring.infrastructure.structuring_session_repository import (
    StructuringSessionDigestConflictError,
    StructuringSessionIdempotencyConflictError,
    StructuringSessionRecordCorruptError,
    StructuringSessionRecordNotFoundError,
    StructuringSessionRepository,
    StructuringSessionTransitionError,
)

__all__ = [
    "IdempotencyConflictError",
    "ModelInstallationRecord",
    "ModelInstallationRepository",
    "RecordNotFoundError",
    "StructuringSessionDigestConflictError",
    "StructuringSessionIdempotencyConflictError",
    "StructuringSessionRecordCorruptError",
    "StructuringSessionRecordNotFoundError",
    "StructuringSessionRepository",
    "StructuringSessionTransitionError",
    "TransitionRejectedError",
]
