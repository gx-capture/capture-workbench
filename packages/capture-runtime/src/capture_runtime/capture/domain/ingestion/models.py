"""Domain models and value objects for source ingestion."""

from __future__ import annotations

from dataclasses import dataclass

from capture_runtime.contracts import (
    CaptureSourceKind,
    StreamingIngestionMode,
    StreamingIngestionStatus,
)


@dataclass(frozen=True, slots=True)
class IngestionChunk:
    """A verified binary chunk received during source ingestion."""

    chunk_index: int
    byte_offset: int
    byte_length: int
    sha256: str

    def __post_init__(self) -> None:
        if self.chunk_index < 0:
            raise ValueError(f"chunk_index must be non-negative, got {self.chunk_index}")
        if self.byte_offset < 0:
            raise ValueError(f"byte_offset must be non-negative, got {self.byte_offset}")
        if self.byte_length <= 0:
            raise ValueError(f"byte_length must be positive, got {self.byte_length}")
        if not self.sha256:
            raise ValueError("sha256 digest cannot be empty")


@dataclass(frozen=True, slots=True)
class Ingestion:
    """Aggregate root managing chunked source file ingestion."""

    ingestion_id: str
    kind: CaptureSourceKind
    mode: StreamingIngestionMode = StreamingIngestionMode.FILE
    status: StreamingIngestionStatus = StreamingIngestionStatus.OPEN
    received_bytes: int = 0
    expected_total_bytes: int | None = None
    expected_sha256: str | None = None

    def __post_init__(self) -> None:
        if not self.ingestion_id:
            raise ValueError("ingestion_id cannot be empty")
        if self.received_bytes < 0:
            raise ValueError(f"received_bytes must be non-negative, got {self.received_bytes}")
        if (
            self.expected_total_bytes is not None
            and self.expected_total_bytes < self.received_bytes
        ):
            raise ValueError(
                f"expected_total_bytes ({self.expected_total_bytes}) cannot be less than "
                f"received_bytes ({self.received_bytes})"
            )


__all__ = ["Ingestion", "IngestionChunk"]
