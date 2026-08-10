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

__all__ = [
    "CaptureRecord",
    "CaptureRepository",
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
    "TransitionRejectedError",
]
