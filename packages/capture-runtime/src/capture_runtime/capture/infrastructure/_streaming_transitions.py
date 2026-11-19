"""Contract adapters for capture aggregate decisions; no independent state policy."""

from __future__ import annotations

from datetime import datetime

from capture_runtime.capture.domain.operation.models import (
    TERMINAL_CAPTURE_STATUSES,
    CaptureOperation,
)
from capture_runtime.capture.infrastructure._streaming_records import _IngestionRecord
from capture_runtime.contracts import CaptureOperation as CaptureOperationContract
from capture_runtime.contracts import (
    CaptureSource,
    CaptureStatus,
    OperationFailure,
    StartCapture,
)

_TERMINAL_CAPTURE_STATUSES = TERMINAL_CAPTURE_STATUSES


def operation_domain(operation: CaptureOperationContract) -> CaptureOperation:
    return CaptureOperation.from_contract(operation)


def transition_operation(
    operation: CaptureOperationContract,
    status: CaptureStatus,
    *,
    now: datetime,
) -> CaptureOperationContract:
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
    request: StartCapture,
    ingestion: _IngestionRecord,
    *,
    source: CaptureSource | None,
    now: datetime,
) -> CaptureOperationContract:
    return CaptureOperationContract(
        capture_id=capture_id,
        ingestion_id=request.ingestion_id,
        kind=ingestion.request.kind,
        status=(CaptureStatus.EXTRACTING if source is not None else CaptureStatus.WAITING_INPUT),
        progress=0,
        partial_revision=0,
        last_event_sequence=0,
        source=source,
        created_at=now,
        updated_at=now,
    )


def _mark_ingestion_ready(
    operation: CaptureOperationContract,
    ingestion: _IngestionRecord,
    *,
    source: CaptureSource,
    now: datetime,
) -> CaptureOperationContract:
    return transition_operation(operation, CaptureStatus.EXTRACTING, now=now).model_copy(
        update={
            "status": CaptureStatus.EXTRACTING,
            "kind": ingestion.request.kind,
            "source": source,
            "progress": 0.1,
            "updated_at": now,
        }
    )


def _mark_awaiting_structuring(
    operation: CaptureOperationContract,
    *,
    now: datetime,
) -> CaptureOperationContract:
    return transition_operation(operation, CaptureStatus.AWAITING_STRUCTURING, now=now)


def _mark_structuring(
    operation: CaptureOperationContract,
    *,
    now: datetime,
) -> CaptureOperationContract:
    return transition_operation(operation, CaptureStatus.STRUCTURING, now=now)


def _release_structuring(
    operation: CaptureOperationContract,
    *,
    now: datetime,
) -> CaptureOperationContract:
    return transition_operation(operation, CaptureStatus.AWAITING_STRUCTURING, now=now)


def _complete_capture(
    operation: CaptureOperationContract,
    *,
    now: datetime,
) -> CaptureOperationContract:
    return transition_operation(operation, CaptureStatus.COMPLETED, now=now)


def _fail_capture(
    operation: CaptureOperationContract,
    failure: OperationFailure,
    *,
    now: datetime,
) -> CaptureOperationContract:
    return transition_operation(operation, CaptureStatus.FAILED, now=now).model_copy(
        update={"error": failure}
    )


def _cancel_capture(
    operation: CaptureOperationContract,
    *,
    now: datetime,
) -> CaptureOperationContract:
    return transition_operation(operation, CaptureStatus.CANCELLED, now=now)


__all__ = [
    "_TERMINAL_CAPTURE_STATUSES",
    "_cancel_capture",
    "_complete_capture",
    "_create_capture_operation",
    "_fail_capture",
    "_mark_awaiting_structuring",
    "_mark_ingestion_ready",
    "_mark_structuring",
    "_release_structuring",
]
