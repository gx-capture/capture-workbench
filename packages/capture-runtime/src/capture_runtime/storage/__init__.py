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
    DEFAULT_MAX_UPLOAD_BYTES,
    StreamingEventOverflow,
    StreamingEventSubscription,
    StreamingIdempotencyConflictError,
    StreamingPartialNotFoundError,
    StreamingRecordNotFoundError,
    StreamingRepository,
    StreamingTransitionError,
    StreamingUploadLimitError,
)

__all__ = [
    "IdempotencyConflictError",
    "InstallationRecord",
    "InstallationRepository",
    "ModelInstallationRecord",
    "ModelInstallationRepository",
    "RecordNotFoundError",
    "StreamingIdempotencyConflictError",
    "StreamingEventOverflow",
    "StreamingEventSubscription",
    "StreamingPartialNotFoundError",
    "StreamingRecordNotFoundError",
    "StreamingRepository",
    "StreamingTransitionError",
    "StreamingUploadLimitError",
    "DEFAULT_MAX_UPLOAD_BYTES",
    "TransitionRejectedError",
]
