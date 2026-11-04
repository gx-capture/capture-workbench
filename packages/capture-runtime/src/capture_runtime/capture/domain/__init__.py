"""Capture domain layer."""

from __future__ import annotations

from capture_runtime.capture.domain.ingestion import Ingestion, IngestionChunk
from capture_runtime.capture.domain.operation import (
    CaptureCompleted,
    CaptureOperation,
    PageLocator,
    TimeRange,
)

__all__ = [
    "CaptureCompleted",
    "CaptureOperation",
    "Ingestion",
    "IngestionChunk",
    "PageLocator",
    "TimeRange",
]
