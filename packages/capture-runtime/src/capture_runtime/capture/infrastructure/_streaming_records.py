"""Private durable record models used by the streaming repository facade."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from capture_runtime.contracts import (
    CaptureOperationV2,
    CaptureSourceKind,
    IngestionV2,
    OpenIngestionV2,
    StartCaptureV2,
    StreamingIngestionStatus,
)


@dataclass(slots=True)
class _IngestionRecord:
    request: OpenIngestionV2
    ingestion_id: str
    status: StreamingIngestionStatus
    expires_at: datetime
    next_chunk_index: int = 0
    next_offset: int = 0
    accepted_chunks: dict[int, tuple[int, int, str]] = field(default_factory=dict)
    finalized_sha256: str | None = None

    def snapshot(self) -> IngestionV2:
        return IngestionV2(
            ingestion_id=self.ingestion_id,
            kind=self.request.kind,
            status=self.status,
            file_name=self.request.file_name,
            media_type=self.request.media_type,
            total_bytes=self.request.total_bytes,
            received_bytes=self.next_offset,
            contiguous_bytes=self.next_offset,
            next_chunk_index=self.next_chunk_index,
            next_offset=self.next_offset,
            source_sha256=self.request.source_sha256,
            finalized_sha256=self.finalized_sha256,
            expires_at=self.expires_at,
        )

    def dump(self) -> dict[str, object]:
        return {
            "request": self.request.model_dump(mode="json", by_alias=True),
            "ingestionId": self.ingestion_id,
            "status": self.status.value,
            "expiresAt": self.expires_at.isoformat(),
            "nextChunkIndex": self.next_chunk_index,
            "nextOffset": self.next_offset,
            "acceptedChunks": {
                str(index): list(value) for index, value in self.accepted_chunks.items()
            },
            "finalizedSha256": self.finalized_sha256,
        }

    @classmethod
    def load(
        cls,
        payload: dict[str, Any],
        *,
        ingestion_id: str,
        datetime_from_text: Callable[[str], datetime],
    ) -> _IngestionRecord:
        return cls(
            request=OpenIngestionV2.model_validate(payload["request"]),
            ingestion_id=ingestion_id,
            status=StreamingIngestionStatus(payload["status"]),
            expires_at=datetime_from_text(str(payload["expiresAt"])),
            next_chunk_index=int(payload["nextChunkIndex"]),
            next_offset=int(payload["nextOffset"]),
            accepted_chunks={
                int(index): (int(values[0]), int(values[1]), str(values[2]))
                for index, values in payload.get("acceptedChunks", {}).items()
            },
            finalized_sha256=payload.get("finalizedSha256"),
        )


@dataclass(slots=True)
class _CaptureRecord:
    operation: CaptureOperationV2
    request: StartCaptureV2
    commit_idempotency_key: str | None = None
    commit_fingerprint: str | None = None
    failure_idempotency_key: str | None = None
    failure_fingerprint: str | None = None

    def dump(self) -> dict[str, object]:
        return {
            "request": self.request.model_dump(mode="json", by_alias=True),
            "operation": self.operation.model_dump(mode="json", by_alias=True),
            "commitIdempotencyKey": self.commit_idempotency_key,
            "commitFingerprint": self.commit_fingerprint,
            "failureIdempotencyKey": self.failure_idempotency_key,
            "failureFingerprint": self.failure_fingerprint,
        }

    @classmethod
    def load(
        cls,
        payload: dict[str, Any],
        *,
        kind_for_ingestion: Callable[[str], CaptureSourceKind | None],
    ) -> _CaptureRecord:
        request = StartCaptureV2.model_validate(payload["request"])
        operation_payload = payload["operation"]
        operation = CaptureOperationV2.model_validate(operation_payload)
        if "kind" not in operation_payload:
            kind = kind_for_ingestion(operation.ingestion_id)
            if kind is not None:
                operation = operation.model_copy(update={"kind": kind})
        return cls(
            operation=operation,
            request=request,
            commit_idempotency_key=payload.get("commitIdempotencyKey"),
            commit_fingerprint=payload.get("commitFingerprint"),
            failure_idempotency_key=payload.get("failureIdempotencyKey"),
            failure_fingerprint=payload.get("failureFingerprint"),
        )


__all__ = ["_CaptureRecord", "_IngestionRecord"]
