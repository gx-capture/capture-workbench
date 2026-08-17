"""Private pure state-transition helpers for streaming capture operations."""

from __future__ import annotations

from datetime import datetime

from capture_runtime.contracts import (
    CaptureFailureV2,
    CaptureOperationV2,
    CaptureSource,
    StartCaptureV2,
    StreamingCaptureStatus,
)
from capture_runtime.storage._streaming_records import _IngestionRecord

_TERMINAL_CAPTURE_STATUSES = frozenset(
    {
        StreamingCaptureStatus.COMPLETED,
        StreamingCaptureStatus.FAILED,
        StreamingCaptureStatus.CANCELLED,
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
    return operation.model_copy(
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
    return operation.model_copy(
        update={
            "status": StreamingCaptureStatus.AWAITING_STRUCTURING,
            "progress": 0.9,
            "updated_at": now,
        }
    )


def _mark_structuring(operation: CaptureOperationV2, *, now: datetime) -> CaptureOperationV2:
    return operation.model_copy(
        update={
            "status": StreamingCaptureStatus.STRUCTURING,
            "progress": 0.95,
            "updated_at": now,
        }
    )


def _complete_capture(operation: CaptureOperationV2, *, now: datetime) -> CaptureOperationV2:
    return operation.model_copy(
        update={
            "status": StreamingCaptureStatus.COMPLETED,
            "progress": 1.0,
            "updated_at": now,
            "completed_at": now,
        }
    )


def _fail_capture(
    operation: CaptureOperationV2,
    failure: CaptureFailureV2,
    *,
    now: datetime,
) -> CaptureOperationV2:
    return operation.model_copy(
        update={
            "status": StreamingCaptureStatus.FAILED,
            "progress": operation.progress,
            "error": failure,
            "updated_at": now,
            "completed_at": now,
        }
    )


def _cancel_capture(operation: CaptureOperationV2, *, now: datetime) -> CaptureOperationV2:
    return operation.model_copy(
        update={
            "status": StreamingCaptureStatus.CANCELLED,
            "updated_at": now,
            "completed_at": now,
        }
    )


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
