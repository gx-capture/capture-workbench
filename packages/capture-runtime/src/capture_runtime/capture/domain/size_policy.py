"""Size policy enforcement for capture source ingestion."""

from __future__ import annotations

from dataclasses import dataclass

from capture_runtime.contracts import CaptureSourceKind

DOCUMENT_MAX_UPLOAD_BYTES: int = 50 * 1024 * 1024
SOURCE_SIZE_EXCEEDED_MESSAGE: str = "Source exceeds the size limit for its kind."


class IngestionSourceSizeExceededError(ValueError):
    """Raised when a declared source total size exceeds the policy limit for its kind."""


@dataclass(frozen=True, slots=True)
class SourceSizePolicy:
    """Enforces byte ceilings per capture source kind."""

    max_upload_bytes: int

    def limit_for(self, kind: CaptureSourceKind) -> int:
        if kind is CaptureSourceKind.AUDIO:
            return self.max_upload_bytes
        return min(self.max_upload_bytes, DOCUMENT_MAX_UPLOAD_BYTES)

    def is_allowed(self, kind: CaptureSourceKind, declared_total_bytes: int) -> bool:
        if declared_total_bytes <= 0:
            return False
        return declared_total_bytes <= self.limit_for(kind)

    def needs_recording_signature(self, kind: CaptureSourceKind, declared_total_bytes: int) -> bool:
        return kind is CaptureSourceKind.AUDIO and declared_total_bytes > DOCUMENT_MAX_UPLOAD_BYTES


__all__ = [
    "DOCUMENT_MAX_UPLOAD_BYTES",
    "IngestionSourceSizeExceededError",
    "SOURCE_SIZE_EXCEEDED_MESSAGE",
    "SourceSizePolicy",
]
