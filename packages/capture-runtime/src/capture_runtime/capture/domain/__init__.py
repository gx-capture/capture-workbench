"""Capture domain layer."""

from __future__ import annotations

from capture_runtime.capture.domain.ingestion import Ingestion, IngestionChunk
from capture_runtime.capture.domain.operation import (
    CaptureCompleted,
    CaptureOperation,
    PageLocator,
    TimeRange,
)
from capture_runtime.capture.domain.size_policy import (
    DOCUMENT_MAX_UPLOAD_BYTES,
    SOURCE_SIZE_EXCEEDED_MESSAGE,
    IngestionSourceSizeExceededError,
    SourceSizePolicy,
)

__all__ = [
    "CaptureCompleted",
    "CaptureOperation",
    "DOCUMENT_MAX_UPLOAD_BYTES",
    "Ingestion",
    "IngestionChunk",
    "IngestionSourceSizeExceededError",
    "PageLocator",
    "SOURCE_SIZE_EXCEEDED_MESSAGE",
    "SourceSizePolicy",
    "TimeRange",
]
