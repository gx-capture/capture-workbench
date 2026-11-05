"""Domain models and value objects for source ingestion."""

from __future__ import annotations

from dataclasses import dataclass, replace

from capture_runtime.contracts import (
    CaptureSourceKind,
    StreamingIngestionMode,
    StreamingIngestionStatus,
)


class IngestionTransitionError(ValueError):
    """An upload violates ordering, integrity or lifecycle rules."""


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
    next_chunk_index: int = 0
    finalized_sha256: str | None = None

    def append(
        self,
        chunk: IngestionChunk,
        *,
        actual_sha256: str,
        declared_total_bytes: int,
        max_chunk_bytes: int,
        accepted_chunk: IngestionChunk | None = None,
    ) -> Ingestion:
        if self.status is not StreamingIngestionStatus.OPEN:
            raise IngestionTransitionError("ingestion is not open")
        if chunk.byte_length > max_chunk_bytes:
            raise IngestionTransitionError("chunk exceeds the configured limit")
        if declared_total_bytes != self.expected_total_bytes:
            raise IngestionTransitionError("chunk total bytes conflict with ingestion")
        if chunk.sha256 != actual_sha256:
            raise IngestionTransitionError("chunk checksum does not match bytes")
        if chunk.chunk_index < self.next_chunk_index:
            if chunk == accepted_chunk:
                return self
            raise IngestionTransitionError("chunk conflicts with an accepted chunk")
        if chunk.chunk_index != self.next_chunk_index or chunk.byte_offset != self.received_bytes:
            raise IngestionTransitionError("chunks must be contiguous and ordered")
        if (
            self.expected_total_bytes is not None
            and self.received_bytes + chunk.byte_length > self.expected_total_bytes
        ):
            raise IngestionTransitionError("chunks exceed declared source size")
        return replace(
            self,
            received_bytes=self.received_bytes + chunk.byte_length,
            next_chunk_index=self.next_chunk_index + 1,
        )

    def finalize(self, *, total_bytes: int, sha256: str, actual_sha256: str) -> Ingestion:
        if self.status is StreamingIngestionStatus.READY:
            if self.finalized_sha256 == sha256 and total_bytes == self.received_bytes:
                return self
            raise IngestionTransitionError("finalize conflicts with existing source")
        if self.status is not StreamingIngestionStatus.OPEN:
            raise IngestionTransitionError("ingestion is not open")
        if total_bytes != self.expected_total_bytes or total_bytes != self.received_bytes:
            raise IngestionTransitionError("final byte count does not match upload")
        if sha256 != actual_sha256 or (
            self.expected_sha256 is not None and self.expected_sha256 != sha256
        ):
            raise IngestionTransitionError("final source checksum does not match upload")
        return replace(self, status=StreamingIngestionStatus.READY, finalized_sha256=sha256)

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
