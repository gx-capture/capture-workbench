"""Public repository facade for capture and installation persistence."""

from capture_runtime.storage.common import (
    IdempotencyConflictError,
    RecordNotFoundError,
    TransitionRejectedError,
)
from capture_runtime.storage.installation_repository import (
    InstallationRecord,
    InstallationRepository,
)
from capture_runtime.storage.model_installation_repository import (
    ModelInstallationRecord,
    ModelInstallationRepository,
)
from capture_runtime.storage.streaming_repository import (
    StreamingIdempotencyConflictError,
    StreamingPartialNotFoundError,
    StreamingRecordNotFoundError,
    StreamingRepository,
    StreamingTransitionError,
)
from capture_runtime.storage.structuring_session_repository import (
    StructuringSessionDigestConflictError,
    StructuringSessionIdempotencyConflictError,
    StructuringSessionRecordCorruptError,
    StructuringSessionRecordNotFoundError,
    StructuringSessionRepository,
    StructuringSessionTransitionError,
)

__all__ = [
    "IdempotencyConflictError",
    "InstallationRecord",
    "InstallationRepository",
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
