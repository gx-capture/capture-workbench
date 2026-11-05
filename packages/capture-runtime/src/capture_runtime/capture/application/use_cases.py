"""Application use cases for capture and ingestion workflows."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import TYPE_CHECKING

from capture_runtime.capture.domain.operation.models import (
    CaptureTransitionError as StreamingTransitionError,
)
from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEventV2,
    CaptureOperationV2,
    FinalizeIngestionV2,
    IngestionV2,
    OpenIngestionV2,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StructuringMode,
)

if TYPE_CHECKING:
    from capture_runtime.capture.application.streaming_capture_service import (
        StreamingCaptureService,
    )


class OpenIngestion:
    """Open a chunked or direct file ingestion session."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, request: OpenIngestionV2) -> IngestionV2:
        return self._service.repository.create_ingestion(request)


class AppendChunk:
    """Append a verified binary chunk to an open ingestion session."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
        declared_total_bytes: int,
    ) -> IngestionV2:
        before = self._service.repository.get_ingestion(ingestion_id)
        snapshot = self._service.repository.append_chunk(
            ingestion_id,
            chunk_index=chunk_index,
            byte_offset=byte_offset,
            data=data,
            sha256=sha256,
            max_chunk_bytes=self._service.max_chunk_bytes,
            declared_total_bytes=declared_total_bytes,
        )
        if snapshot.next_chunk_index > before.next_chunk_index:
            for operation in self._service._captures_for(ingestion_id):
                if operation.status in {
                    StreamingCaptureStatus.WAITING_INPUT,
                    StreamingCaptureStatus.EXTRACTING,
                }:
                    self._service.repository.append_event(
                        operation.capture_id,
                        event_type=StreamingEventType.INPUT_CHECKPOINT,
                        stage="extracting",
                    )
        return snapshot


class FinalizeIngestion:
    """Finalize an ingestion session after all chunks have been appended."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(
        self,
        ingestion_id: str,
        request: FinalizeIngestionV2,
    ) -> IngestionV2:
        snapshot = self._service.repository.finalize_ingestion(
            ingestion_id,
            total_bytes=request.total_bytes,
            sha256=request.sha256,
        )
        changed = self._service.repository.mark_ingestion_ready(ingestion_id)
        for operation in changed:
            self._service._schedule(operation.capture_id)
        return snapshot


class StartCapture:
    """Create and start a media extraction pipeline from an ingestion."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, request: StartCaptureV2) -> CaptureOperationV2:
        operation = self._service.repository.create_capture(request)
        if operation.status is StreamingCaptureStatus.EXTRACTING:
            self._service._schedule(operation.capture_id)
        return operation


class CancelCapture:
    """Cancel an active or running capture operation."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, capture_id: str) -> CaptureOperationV2:
        self._service._clear_pending_execution_proof(capture_id)
        cancellation = self._service._cancellations.setdefault(capture_id, asyncio.Event())
        cancellation.set()
        return self._service.repository.cancel_capture(capture_id)


class PollCaptureEvents:
    """Poll sequence events for a capture operation."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(self, capture_id: str, *, after_sequence: int = -1) -> list[CaptureEventV2]:
        return self._service.repository.read_events(capture_id, after_sequence=after_sequence)


class CommitHostStructuring:
    """Commit host-structured document to complete the capture operation."""

    def __init__(self, service: StreamingCaptureService) -> None:
        self._service = service

    def execute(
        self,
        capture_id: str,
        document: CaptureDocument,
        *,
        idempotency_key: str,
    ) -> CaptureOperationV2:
        try:
            operation = self._service.repository.get_capture(capture_id)
            fingerprint = _candidate_fingerprint(document)
            if operation.status is StreamingCaptureStatus.COMPLETED:
                committed = self._service.repository.commit_host_result(
                    capture_id,
                    idempotency_key=idempotency_key,
                    fingerprint=fingerprint,
                    result=document,
                )
            else:
                request = self._service.repository.capture_request(capture_id)
                if (
                    request.structuring_mode is not StructuringMode.HOST
                    or operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING
                ):
                    raise StreamingTransitionError("capture is not awaiting host structuring")
                raw = self._service.repository.read_raw(capture_id)
                validated = self._service._validate_document(document, raw)
                completed = CaptureDocument.model_validate(
                    {
                        **validated.model_dump(mode="json", by_alias=True),
                        "completedAt": self._service._clock.now().isoformat(),
                    }
                )
                committed = self._service.repository.commit_host_result(
                    capture_id,
                    idempotency_key=idempotency_key,
                    fingerprint=fingerprint,
                    result=completed,
                )
            return committed
        except Exception:
            self._service._clear_pending_execution_proof(capture_id)
            raise


__all__ = [
    "AppendChunk",
    "CancelCapture",
    "CommitHostStructuring",
    "FinalizeIngestion",
    "OpenIngestion",
    "PollCaptureEvents",
    "StartCapture",
]


def _candidate_fingerprint(candidate: CaptureDocument) -> str:
    canonical = json.dumps(
        candidate.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()
