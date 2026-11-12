"""Application use cases for capture and ingestion workflows."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable

from capture_runtime.capture.application.ports import CaptureRepository
from capture_runtime.capture.domain.operation import CaptureOperation
from capture_runtime.capture.domain.size_policy import (
    SOURCE_SIZE_EXCEEDED_MESSAGE,
    IngestionSourceSizeExceededError,
    SourceSizePolicy,
)
from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEventV2,
    CaptureOperationV2,
    FinalizeIngestionV2,
    IngestionV2,
    OpenIngestionV2,
    RawCapture,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
)


class OpenIngestion:
    """Open a chunked or direct file ingestion session."""

    def __init__(
        self,
        repository: CaptureRepository,
        policy: SourceSizePolicy,
    ) -> None:
        self._repository = repository
        self._policy = policy

    def execute(self, request: OpenIngestionV2) -> IngestionV2:
        if not self._policy.is_allowed(request.kind, request.total_bytes):
            raise IngestionSourceSizeExceededError(SOURCE_SIZE_EXCEEDED_MESSAGE)
        return self._repository.create_ingestion(request)


class AppendChunk:
    """Append a verified binary chunk to an open ingestion session."""

    def __init__(self, repository: CaptureRepository, *, max_chunk_bytes: int) -> None:
        self._repository = repository
        self._max_chunk_bytes = max_chunk_bytes

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
        before = self._repository.get_ingestion(ingestion_id)
        snapshot = self._repository.append_chunk(
            ingestion_id,
            chunk_index=chunk_index,
            byte_offset=byte_offset,
            data=data,
            sha256=sha256,
            max_chunk_bytes=self._max_chunk_bytes,
            declared_total_bytes=declared_total_bytes,
        )
        if snapshot.next_chunk_index > before.next_chunk_index:
            for capture_id in self._repository.capture_ids_for_ingestion(ingestion_id):
                operation = self._repository.get_capture(capture_id)
                if operation.status in {
                    StreamingCaptureStatus.WAITING_INPUT,
                    StreamingCaptureStatus.EXTRACTING,
                }:
                    self._repository.append_event(
                        operation.capture_id,
                        event_type=StreamingEventType.INPUT_CHECKPOINT,
                        stage="extracting",
                    )
        return snapshot


class FinalizeIngestion:
    """Finalize an ingestion session after all chunks have been appended."""

    def __init__(self, repository: CaptureRepository, *, schedule: Callable[[str], None]) -> None:
        self._repository = repository
        self._schedule = schedule

    def execute(
        self,
        ingestion_id: str,
        request: FinalizeIngestionV2,
    ) -> IngestionV2:
        snapshot = self._repository.finalize_ingestion(
            ingestion_id,
            total_bytes=request.total_bytes,
            sha256=request.sha256,
        )
        changed = self._repository.mark_ingestion_ready(ingestion_id)
        for operation in changed:
            self._schedule(operation.capture_id)
        return snapshot


class StartCapture:
    """Create and start a media extraction pipeline from an ingestion."""

    def __init__(self, repository: CaptureRepository, *, schedule: Callable[[str], None]) -> None:
        self._repository = repository
        self._schedule = schedule

    def execute(self, request: StartCaptureV2) -> CaptureOperationV2:
        operation = self._repository.create_capture(request)
        if operation.status is StreamingCaptureStatus.EXTRACTING:
            self._schedule(operation.capture_id)
        return operation


class CancelCapture:
    """Cancel an active or running capture operation."""

    def __init__(
        self, repository: CaptureRepository, *, request_cancel: Callable[[str], None]
    ) -> None:
        self._repository = repository
        self._request_cancel = request_cancel

    def execute(self, capture_id: str) -> CaptureOperationV2:
        self._request_cancel(capture_id)
        return self._repository.cancel_capture(capture_id)


class PollCaptureEvents:
    """Poll sequence events for a capture operation."""

    def __init__(self, repository: CaptureRepository) -> None:
        self._repository = repository

    def execute(self, capture_id: str, *, after_sequence: int = -1) -> list[CaptureEventV2]:
        return self._repository.read_events(capture_id, after_sequence=after_sequence)


class CommitHostStructuring:
    """Commit host-structured document to complete the capture operation."""

    def __init__(
        self,
        repository: CaptureRepository,
        *,
        clock: Clock,
        validate_document: Callable[[object, RawCapture], CaptureDocument],
        discard_result: Callable[[str], None],
    ) -> None:
        self._repository = repository
        self._clock = clock
        self._validate_document = validate_document
        self._discard_result = discard_result

    def execute(
        self,
        capture_id: str,
        document: CaptureDocument,
        *,
        idempotency_key: str,
    ) -> CaptureOperationV2:
        try:
            operation = self._repository.get_capture(capture_id)
            fingerprint = _candidate_fingerprint(document)
            if operation.status is StreamingCaptureStatus.COMPLETED:
                committed = self._repository.commit_host_result(
                    capture_id,
                    idempotency_key=idempotency_key,
                    fingerprint=fingerprint,
                    result=document,
                )
            else:
                request = self._repository.capture_request(capture_id)
                CaptureOperation(
                    capture_id=operation.capture_id,
                    ingestion_id=operation.ingestion_id,
                    kind=operation.kind,
                    status=operation.status,
                ).require_host_structuring(request.structuring_mode)
                raw = self._repository.read_raw(capture_id)
                validated = self._validate_document(document, raw)
                completed = CaptureDocument.model_validate(
                    {
                        **validated.model_dump(mode="json", by_alias=True),
                        "completedAt": self._clock.now().isoformat(),
                    }
                )
                committed = self._repository.commit_host_result(
                    capture_id,
                    idempotency_key=idempotency_key,
                    fingerprint=fingerprint,
                    result=completed,
                )
            return committed
        except Exception:
            self._discard_result(capture_id)
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
