"""Small streaming-ingestion seam used by runtime adapters and tests.

The port deliberately owns only input ordering and final source integrity.  It
does not expose storage paths or worker details to callers; both the in-memory
test adapter and the file-backed runtime implementation sit behind this seam.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Protocol
from uuid import uuid4

from capture_runtime.contracts import (
    IngestionV2,
    OpenIngestionV2,
    StreamingIngestionStatus,
)

DEFAULT_STREAM_CHUNK_BYTES = 1024 * 1024
MAX_STREAM_CHUNK_BYTES = 4 * 1024 * 1024
DEFAULT_INGESTION_TTL = timedelta(hours=2)


class StreamingIngestionError(ValueError):
    """A safe, stable error from the streaming-ingestion interface."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class StreamingIngestionPort(Protocol):
    async def open(self, request: OpenIngestionV2) -> IngestionV2: ...

    async def append(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
    ) -> IngestionV2: ...

    async def finalize(
        self,
        ingestion_id: str,
        *,
        total_bytes: int,
        sha256: str,
    ) -> IngestionV2: ...

    async def cancel(self, ingestion_id: str) -> IngestionV2: ...


@dataclass(slots=True)
class _MemoryIngestion:
    request: OpenIngestionV2
    ingestion_id: str
    expires_at: datetime
    data: bytearray = field(default_factory=bytearray)
    next_chunk_index: int = 0
    accepted_chunks: dict[int, tuple[int, int, str]] = field(default_factory=dict)
    status: StreamingIngestionStatus = StreamingIngestionStatus.OPEN
    finalized_sha256: str | None = None


class InMemoryStreamingIngestionAdapter:
    """Deterministic adapter for contract tests and future API tests."""

    def __init__(
        self,
        *,
        now: datetime | None = None,
        ttl: timedelta = DEFAULT_INGESTION_TTL,
        max_chunk_bytes: int = MAX_STREAM_CHUNK_BYTES,
    ) -> None:
        if max_chunk_bytes <= 0 or max_chunk_bytes > MAX_STREAM_CHUNK_BYTES:
            raise ValueError("max_chunk_bytes is outside the streaming safety limit")
        self._now = now or datetime.now(UTC)
        self._ttl = ttl
        self._max_chunk_bytes = max_chunk_bytes
        self._records: dict[str, _MemoryIngestion] = {}
        self._idempotency: dict[str, tuple[str, OpenIngestionV2]] = {}

    async def open(self, request: OpenIngestionV2) -> IngestionV2:
        existing = self._idempotency.get(request.client_request_id)
        if existing is not None:
            ingestion_id, original = existing
            if original != request:
                raise StreamingIngestionError(
                    "idempotency_conflict",
                    "Ingestion request id was already used with different metadata.",
                )
            return self._snapshot(self._records[ingestion_id])

        ingestion_id = str(uuid4())
        record = _MemoryIngestion(
            request=request,
            ingestion_id=ingestion_id,
            expires_at=self._now + self._ttl,
        )
        self._records[ingestion_id] = record
        self._idempotency[request.client_request_id] = (ingestion_id, request)
        return self._snapshot(record)

    async def append(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
    ) -> IngestionV2:
        record = self._record(ingestion_id)
        if record.status is not StreamingIngestionStatus.OPEN:
            raise StreamingIngestionError("ingestion_closed", "Ingestion is no longer open.")
        if not 0 <= chunk_index:
            raise StreamingIngestionError("invalid_chunk", "Chunk index must not be negative.")
        if not 0 <= byte_offset:
            raise StreamingIngestionError("invalid_chunk", "Chunk offset must not be negative.")
        if not data or len(data) > self._max_chunk_bytes:
            raise StreamingIngestionError("chunk_too_large", "Chunk size is outside the limit.")
        actual_sha256 = hashlib.sha256(data).hexdigest()
        if sha256 != actual_sha256:
            raise StreamingIngestionError(
                "chunk_checksum_mismatch", "Chunk checksum does not match its bytes."
            )
        if chunk_index < record.next_chunk_index:
            accepted = record.accepted_chunks.get(chunk_index)
            if accepted == (byte_offset, len(data), sha256):
                return self._snapshot(record)
            raise StreamingIngestionError(
                "chunk_conflict", "Chunk index was already accepted with different bytes."
            )
        if chunk_index != record.next_chunk_index or byte_offset != len(record.data):
            raise StreamingIngestionError(
                "chunk_out_of_order", "Chunks must be appended contiguously and in order."
            )
        if len(record.data) + len(data) > record.request.total_bytes:
            raise StreamingIngestionError(
                "ingestion_too_large", "Chunks exceed the declared source size."
            )
        record.data.extend(data)
        record.accepted_chunks[chunk_index] = (byte_offset, len(data), sha256)
        record.next_chunk_index += 1
        return self._snapshot(record)

    async def finalize(
        self,
        ingestion_id: str,
        *,
        total_bytes: int,
        sha256: str,
    ) -> IngestionV2:
        record = self._record(ingestion_id)
        if record.status is StreamingIngestionStatus.READY:
            if record.finalized_sha256 == sha256 and total_bytes == len(record.data):
                return self._snapshot(record)
            raise StreamingIngestionError(
                "finalize_conflict", "Ingestion was finalized with different source metadata."
            )
        if record.status is not StreamingIngestionStatus.OPEN:
            raise StreamingIngestionError("ingestion_closed", "Ingestion is no longer open.")
        actual_sha256 = hashlib.sha256(record.data).hexdigest()
        if total_bytes != len(record.data) or total_bytes != record.request.total_bytes:
            raise StreamingIngestionError(
                "total_bytes_mismatch", "Final byte count does not match the uploaded source."
            )
        if sha256 != actual_sha256 or (
            record.request.source_sha256 is not None and record.request.source_sha256 != sha256
        ):
            raise StreamingIngestionError(
                "source_checksum_mismatch", "Final source checksum does not match the upload."
            )
        record.status = StreamingIngestionStatus.READY
        record.finalized_sha256 = sha256
        return self._snapshot(record)

    async def cancel(self, ingestion_id: str) -> IngestionV2:
        record = self._record(ingestion_id)
        if record.status in {
            StreamingIngestionStatus.CANCELLED,
            StreamingIngestionStatus.EXPIRED,
        }:
            return self._snapshot(record)
        if record.status is StreamingIngestionStatus.READY:
            raise StreamingIngestionError(
                "ingestion_closed", "Ready ingestion cannot be cancelled."
            )
        record.status = StreamingIngestionStatus.CANCELLED
        return self._snapshot(record)

    def _record(self, ingestion_id: str) -> _MemoryIngestion:
        try:
            return self._records[ingestion_id]
        except KeyError as error:
            raise StreamingIngestionError(
                "ingestion_not_found", "Ingestion was not found."
            ) from error

    @staticmethod
    def _snapshot(record: _MemoryIngestion) -> IngestionV2:
        return IngestionV2(
            ingestion_id=record.ingestion_id,
            status=record.status,
            file_name=record.request.file_name,
            media_type=record.request.media_type,
            total_bytes=record.request.total_bytes,
            received_bytes=len(record.data),
            contiguous_bytes=len(record.data),
            next_chunk_index=record.next_chunk_index,
            next_offset=len(record.data),
            source_sha256=record.request.source_sha256,
            finalized_sha256=record.finalized_sha256,
            expires_at=record.expires_at,
        )


__all__ = [
    "DEFAULT_INGESTION_TTL",
    "DEFAULT_STREAM_CHUNK_BYTES",
    "InMemoryStreamingIngestionAdapter",
    "MAX_STREAM_CHUNK_BYTES",
    "StreamingIngestionError",
    "StreamingIngestionPort",
]
