"""Public repository facade for capture and installation persistence."""

from capture_runtime.storage.common import (
    IdempotencyConflictError,
    RecordNotFoundError,
    TransitionRejectedError,
)
from capture_runtime.storage.streaming_repository import (
    StreamingIdempotencyConflictError,
    StreamingPartialNotFoundError,
    StreamingRecordNotFoundError,
    StreamingRepository,
    StreamingTransitionError,
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
    "StreamingIdempotencyConflictError",
    "StreamingPartialNotFoundError",
    "StreamingRecordNotFoundError",
    "StreamingRepository",
    "StreamingTransitionError",
    "StructuringSessionDigestConflictError",
    "StructuringSessionIdempotencyConflictError",
    "StructuringSessionRecordCorruptError",
    "StructuringSessionRecordNotFoundError",
    "StructuringSessionRepository",
    "StructuringSessionTransitionError",
    "TransitionRejectedError",
]
