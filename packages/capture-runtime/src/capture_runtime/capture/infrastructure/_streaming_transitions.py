"""Contract adapters for capture aggregate decisions; no independent state policy."""

from __future__ import annotations

from datetime import datetime

from capture_runtime.capture.domain.operation.models import (
    TERMINAL_CAPTURE_STATUSES,
    CaptureOperation,
)
from capture_runtime.capture.infrastructure._streaming_records import _IngestionRecord
from capture_runtime.contracts import (
    CaptureFailureV2,
    CaptureOperationV2,
    CaptureSource,
    StartCaptureV2,
    StreamingCaptureStatus,
)

_TERMINAL_CAPTURE_STATUSES = TERMINAL_CAPTURE_STATUSES


def operation_domain(operation: CaptureOperationV2) -> CaptureOperation:
    return CaptureOperation(
        capture_id=operation.capture_id,
        ingestion_id=operation.ingestion_id,
        kind=operation.kind,
        status=operation.status,
        progress=operation.progress or 0,
        partial_revision=operation.partial_revision,
        last_event_sequence=operation.last_event_sequence,
    )


def transition_operation(
    operation: CaptureOperationV2,
    status: StreamingCaptureStatus,
    *,
    now: datetime,
) -> CaptureOperationV2:
    domain = operation_domain(operation).transition(status)
    if domain.status == operation.status and domain.is_terminal:
        return operation
    return operation.model_copy(
        update={
            "status": domain.status,
            "progress": domain.progress,
            "updated_at": now,
            **({"completed_at": now} if domain.is_terminal else {}),
        }
    )


def _create_capture_operation(
    capture_id: str,
    request: StartCaptureV2,
    ingestion: _IngestionRecord,
    *,
    source: CaptureSource | None,
    now: datetime,
) -> CaptureOperationV2:
    return CaptureOperationV2(
        capture_id=capture_id,
        ingestion_id=request.ingestion_id,
        kind=ingestion.request.kind,
        status=(
            StreamingCaptureStatus.EXTRACTING
            if source is not None
            else StreamingCaptureStatus.WAITING_INPUT
        ),
        progress=0,
        partial_revision=0,
        last_event_sequence=0,
        source=source,
        created_at=now,
        updated_at=now,
    )


def _mark_ingestion_ready(
    operation: CaptureOperationV2,
    ingestion: _IngestionRecord,
    *,
    source: CaptureSource,
    now: datetime,
) -> CaptureOperationV2:
    return transition_operation(operation, StreamingCaptureStatus.EXTRACTING, now=now).model_copy(
        update={
            "status": StreamingCaptureStatus.EXTRACTING,
            "kind": ingestion.request.kind,
            "source": source,
            "progress": 0.1,
            "updated_at": now,
        }
    )


def _mark_awaiting_structuring(
    operation: CaptureOperationV2,
    *,
    now: datetime,
) -> CaptureOperationV2:
    return transition_operation(operation, StreamingCaptureStatus.AWAITING_STRUCTURING, now=now)


def _mark_structuring(operation: CaptureOperationV2, *, now: datetime) -> CaptureOperationV2:
    return transition_operation(operation, StreamingCaptureStatus.STRUCTURING, now=now)


def _complete_capture(operation: CaptureOperationV2, *, now: datetime) -> CaptureOperationV2:
    return transition_operation(operation, StreamingCaptureStatus.COMPLETED, now=now)


def _fail_capture(
    operation: CaptureOperationV2,
    failure: CaptureFailureV2,
    *,
    now: datetime,
) -> CaptureOperationV2:
    return transition_operation(operation, StreamingCaptureStatus.FAILED, now=now).model_copy(
        update={"error": failure}
    )


def _cancel_capture(operation: CaptureOperationV2, *, now: datetime) -> CaptureOperationV2:
    return transition_operation(operation, StreamingCaptureStatus.CANCELLED, now=now)


__all__ = [
    "_TERMINAL_CAPTURE_STATUSES",
    "_cancel_capture",
    "_complete_capture",
    "_create_capture_operation",
    "_fail_capture",
    "_mark_awaiting_structuring",
    "_mark_ingestion_ready",
    "_mark_structuring",
]
