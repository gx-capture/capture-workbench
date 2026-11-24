"""Private durable record models used by the streaming repository facade."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from capture_runtime.capture.domain.ingestion.models import Ingestion
from capture_runtime.contracts import (
    CaptureOperation,
    CaptureSourceKind,
    IngestionStatus,
    OpenIngestion,
    StartCapture,
)
from capture_runtime.contracts import Ingestion as IngestionContract
from capture_runtime.storage.common import (
    RETIRED_FAILURE_CODES,
    project_stored_capture_kind,
    project_stored_failure_field,
)


def _stored_kind(payload: dict[str, Any]) -> str | None:
    if "kind" not in payload:
        return None
    # Preserve the retired spelling only. Current kinds come from the model.
    return "audio" if payload["kind"] == "audio" else ""


def _preserve_stored_kind(payload: dict[str, Any], kind: str | None) -> dict[str, Any]:
    if kind is None:
        payload.pop("kind", None)
    elif kind:
        payload["kind"] = kind
    return payload


def _stored_failure_code(payload: dict[str, Any]) -> str | None:
    """A retired failure code as stored, kept so a rewrite leaves it as it was."""
    error = payload.get("error")
    if isinstance(error, dict) and error.get("code") in RETIRED_FAILURE_CODES:
        return str(error["code"])
    return None


def _preserve_stored_failure_code(payload: dict[str, Any], code: str | None) -> dict[str, Any]:
    error = payload.get("error")
    if (
        code is not None
        and isinstance(error, dict)
        and error.get("code") == RETIRED_FAILURE_CODES[code]
    ):
        payload["error"] = {**error, "code": code}
    return payload


@dataclass(slots=True)
class _IngestionRecord:
    request: OpenIngestion
    ingestion_id: str
    status: IngestionStatus
    expires_at: datetime
    next_chunk_index: int = 0
    next_offset: int = 0
    accepted_chunks: dict[int, tuple[int, int, str]] = field(default_factory=dict)
    finalized_sha256: str | None = None
    # An empty value writes the current kind. None preserves an omitted kind.
    stored_kind: str | None = ""

    def domain(self) -> Ingestion:
        return Ingestion(
            ingestion_id=self.ingestion_id,
            kind=self.request.kind,
            mode=self.request.mode,
            status=self.status,
            received_bytes=self.next_offset,
            expected_total_bytes=self.request.total_bytes,
            expected_sha256=self.request.source_sha256,
            next_chunk_index=self.next_chunk_index,
            finalized_sha256=self.finalized_sha256,
        )

    def snapshot(self) -> IngestionContract:
        return IngestionContract(
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
            "request": _preserve_stored_kind(
                self.request.model_dump(mode="json", by_alias=True), self.stored_kind
            ),
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
            request=OpenIngestion.model_validate(project_stored_capture_kind(payload["request"])),
            stored_kind=_stored_kind(payload["request"]),
            ingestion_id=ingestion_id,
            status=IngestionStatus(payload["status"]),
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
    operation: CaptureOperation
    request: StartCapture
    commit_idempotency_key: str | None = None
    commit_fingerprint: str | None = None
    failure_idempotency_key: str | None = None
    failure_fingerprint: str | None = None
    # An empty value writes the current kind. None preserves an omitted kind.
    stored_kind: str | None = ""
    # A failure code a 0.10.x runtime stored, read under its current name.
    stored_failure_code: str | None = None

    @property
    def host_reported_failure(self) -> bool:
        """Whether the host reported the failure; its code is the host's own."""
        return self.failure_idempotency_key is not None

    def dump(self) -> dict[str, object]:
        return {
            "request": self.request.model_dump(mode="json", by_alias=True),
            "operation": _preserve_stored_failure_code(
                _preserve_stored_kind(
                    self.operation.model_dump(mode="json", by_alias=True), self.stored_kind
                ),
                self.stored_failure_code,
            ),
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
        request = StartCapture.model_validate(payload["request"])
        operation_payload = payload["operation"]
        projected_operation = project_stored_capture_kind(operation_payload)
        if isinstance(operation_payload, dict) and "kind" not in operation_payload:
            ingestion_id = operation_payload.get("ingestionId")
            if isinstance(ingestion_id, str):
                kind = kind_for_ingestion(ingestion_id)
                if kind is not None:
                    projected_operation = {**operation_payload, "kind": kind.value}
        # A host-reported failure keeps the code the host chose, even one that
        # is also a retired runtime code; only runtime failures are projected.
        host_reported_failure = payload.get("failureIdempotencyKey") is not None
        operation = CaptureOperation.model_validate(
            projected_operation
            if host_reported_failure
            else project_stored_failure_field(projected_operation, "error")
        )
        return cls(
            operation=operation,
            stored_kind=_stored_kind(operation_payload),
            stored_failure_code=(
                _stored_failure_code(operation_payload)
                if isinstance(operation_payload, dict) and not host_reported_failure
                else None
            ),
            request=request,
            commit_idempotency_key=payload.get("commitIdempotencyKey"),
            commit_fingerprint=payload.get("commitFingerprint"),
            failure_idempotency_key=payload.get("failureIdempotencyKey"),
            failure_fingerprint=payload.get("failureFingerprint"),
        )


__all__ = ["_CaptureRecord", "_IngestionRecord"]
