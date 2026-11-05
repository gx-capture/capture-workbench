"""Unit tests for capture domain models, value objects, events, and use cases."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from capture_runtime.capture.application.use_cases import (
    FinalizeIngestion,
    StartCapture,
)
from capture_runtime.capture.domain.ingestion import Ingestion, IngestionChunk
from capture_runtime.capture.domain.operation import (
    CaptureCompleted,
    CaptureOperation,
    PageLocator,
    TimeRange,
)
from capture_runtime.contracts import (
    CaptureSourceKind,
    FinalizeIngestionV2,
    OpenIngestionV2,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingIngestionMode,
    StreamingIngestionStatus,
    StructuringMode,
)


def test_ingestion_invariants() -> None:
    ingestion = Ingestion(
        ingestion_id="ing-1",
        kind=CaptureSourceKind.PDF,
        mode=StreamingIngestionMode.FILE,
        status=StreamingIngestionStatus.OPEN,
        received_bytes=100,
        expected_total_bytes=200,
        expected_sha256="abc",
    )
    assert ingestion.ingestion_id == "ing-1"
    assert ingestion.received_bytes == 100

    # Empty ingestion_id
    with pytest.raises(ValueError, match="ingestion_id cannot be empty"):
        Ingestion(ingestion_id="", kind=CaptureSourceKind.PDF)

    # Negative received_bytes
    with pytest.raises(ValueError, match="received_bytes must be non-negative"):
        Ingestion(ingestion_id="i", kind=CaptureSourceKind.PDF, received_bytes=-1)

    # expected_total_bytes < received_bytes
    with pytest.raises(ValueError, match="expected_total_bytes.*cannot be less than"):
        Ingestion(
            ingestion_id="i",
            kind=CaptureSourceKind.PDF,
            received_bytes=200,
            expected_total_bytes=100,
        )


def test_ingestion_chunk_invariants() -> None:
    chunk = IngestionChunk(
        chunk_index=0,
        byte_offset=0,
        byte_length=1024,
        sha256="sha256:abc",
    )
    assert chunk.chunk_index == 0
    assert chunk.byte_length == 1024

    with pytest.raises(ValueError, match="chunk_index must be non-negative"):
        IngestionChunk(chunk_index=-1, byte_offset=0, byte_length=10, sha256="s")

    with pytest.raises(ValueError, match="byte_offset must be non-negative"):
        IngestionChunk(chunk_index=0, byte_offset=-1, byte_length=10, sha256="s")

    with pytest.raises(ValueError, match="byte_length must be positive"):
        IngestionChunk(chunk_index=0, byte_offset=0, byte_length=0, sha256="s")

    with pytest.raises(ValueError, match="sha256 digest cannot be empty"):
        IngestionChunk(chunk_index=0, byte_offset=0, byte_length=10, sha256="")


def test_capture_operation_invariants() -> None:
    op = CaptureOperation(
        capture_id="cap-1",
        ingestion_id="ing-1",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.CREATED,
        progress=0.5,
        partial_revision=1,
        last_event_sequence=2,
    )
    assert op.capture_id == "cap-1"
    assert op.progress == 0.5

    with pytest.raises(ValueError, match="capture_id cannot be empty"):
        CaptureOperation(capture_id="", ingestion_id="i", kind=CaptureSourceKind.IMAGE)

    with pytest.raises(ValueError, match="ingestion_id cannot be empty"):
        CaptureOperation(capture_id="c", ingestion_id="", kind=CaptureSourceKind.IMAGE)

    with pytest.raises(ValueError, match="progress must be in"):
        CaptureOperation(
            capture_id="c", ingestion_id="i", kind=CaptureSourceKind.IMAGE, progress=1.5
        )

    with pytest.raises(ValueError, match="partial_revision must be non-negative"):
        CaptureOperation(
            capture_id="c",
            ingestion_id="i",
            kind=CaptureSourceKind.IMAGE,
            partial_revision=-1,
        )

    with pytest.raises(ValueError, match="last_event_sequence must be non-negative"):
        CaptureOperation(
            capture_id="c",
            ingestion_id="i",
            kind=CaptureSourceKind.IMAGE,
            last_event_sequence=-1,
        )


def test_page_locator_and_time_range_invariants() -> None:
    locator = PageLocator(page_index=0, bounding_box=(0.1, 0.1, 0.9, 0.9))
    assert locator.page_index == 0

    with pytest.raises(ValueError, match="page_index must be non-negative"):
        PageLocator(page_index=-1)

    time_range = TimeRange(start_ms=100, end_ms=500)
    assert time_range.start_ms == 100
    assert time_range.end_ms == 500

    with pytest.raises(ValueError, match="start_ms must be non-negative"):
        TimeRange(start_ms=-1, end_ms=100)

    with pytest.raises(ValueError, match="end_ms.*cannot precede start_ms"):
        TimeRange(start_ms=500, end_ms=400)


def test_capture_completed_event_invariants() -> None:
    event = CaptureCompleted(capture_id="cap-1", completed_at=datetime.fromtimestamp(1, UTC))
    assert event.capture_id == "cap-1"
    assert event.completed_at == datetime.fromtimestamp(1, UTC)

    with pytest.raises(ValueError, match="capture_id cannot be empty"):
        CaptureCompleted(capture_id="", completed_at=datetime.fromtimestamp(0.1, UTC))

    with pytest.raises(ValueError, match="completed_at must not precede"):
        CaptureCompleted(capture_id="c", completed_at=datetime.fromtimestamp(-1, UTC))


def test_capture_use_cases_run_upload_schedule_replay_and_cancel(tmp_path, monkeypatch) -> None:
    import hashlib

    from capture_runtime.capture.application.streaming_capture_service import (
        StreamingCaptureService,
    )
    from capture_runtime.capture.infrastructure.streaming_repository import (
        StreamingRepository,
        StreamingTransitionError,
    )
    from capture_runtime.clock import SystemClock
    from capture_runtime.contracts import StreamingEventType

    clock = SystemClock()
    repository = StreamingRepository(tmp_path, clock=clock, retention_hours=4)
    repository.initialize()
    service = StreamingCaptureService(repository, clock=clock)
    scheduled = []
    service.start_capture_use_case = StartCapture(repository, schedule=scheduled.append)
    service.finalize_ingestion_use_case = FinalizeIngestion(repository, schedule=scheduled.append)
    content = b"abcdef"
    digest = hashlib.sha256(content).hexdigest()
    ingestion = service.open_ingestion_use_case.execute(
        OpenIngestionV2(
            client_request_id="upload",
            file_name="test.wav",
            media_type="audio/wav",
            total_bytes=len(content),
            source_sha256=digest,
        )
    )
    operation = service.start_capture_use_case.execute(
        StartCaptureV2(
            ingestion_id=ingestion.ingestion_id,
            client_request_id="capture",
            structuring_mode=StructuringMode.HOST,
        )
    )
    assert scheduled == []
    arguments = dict(
        chunk_index=0, byte_offset=0, data=content, sha256=digest, declared_total_bytes=len(content)
    )
    uploaded = service.append_chunk_use_case.execute(ingestion.ingestion_id, **arguments)
    events = service.events_use_case.execute(operation.capture_id, after_sequence=0)
    assert service.append_chunk_use_case.execute(ingestion.ingestion_id, **arguments) == uploaded
    assert service.events_use_case.execute(operation.capture_id, after_sequence=0) == events
    finalized = service.finalize_ingestion_use_case.execute(
        ingestion.ingestion_id, FinalizeIngestionV2(total_bytes=len(content), sha256=digest)
    )
    assert (
        service.finalize_ingestion_use_case.execute(
            ingestion.ingestion_id, FinalizeIngestionV2(total_bytes=len(content), sha256=digest)
        )
        == finalized
    )
    assert scheduled == [operation.capture_id]
    cancelled = service.cancel_capture_use_case.execute(operation.capture_id)
    assert service._cancellations[operation.capture_id].is_set()
    assert cancelled.status is StreamingCaptureStatus.CANCELLED
    assert service.cancel_capture_use_case.execute(operation.capture_id) == cancelled
    assert (
        service.events_use_case.execute(operation.capture_id)[-1].event_type
        is StreamingEventType.CANCELLED
    )
    with pytest.raises(StreamingTransitionError, match="no longer accepts events"):
        repository.append_event(
            operation.capture_id, event_type=StreamingEventType.HEARTBEAT, stage="late"
        )
    restarted = StreamingRepository(tmp_path, clock=clock, retention_hours=4)
    restarted.initialize()
    assert restarted.get_capture(operation.capture_id) == cancelled
    with pytest.raises(StreamingTransitionError):
        restarted.append_event(
            operation.capture_id, event_type=StreamingEventType.SEGMENT, stage="late"
        )
    assert restarted.read_events(
        operation.capture_id, after_sequence=0
    ) == service.events_use_case.execute(operation.capture_id, after_sequence=0)


def test_capture_aggregate_rejects_skipped_states_and_keeps_terminal_state() -> None:
    from capture_runtime.capture.domain.operation.models import CaptureTransitionError
    from capture_runtime.contracts import StreamingEventType

    operation = CaptureOperation(capture_id="c", ingestion_id="i", kind=CaptureSourceKind.AUDIO)
    with pytest.raises(CaptureTransitionError):
        operation.transition(StreamingCaptureStatus.STRUCTURING)
    extracting = operation.transition(StreamingCaptureStatus.EXTRACTING)
    progressed = extracting.record_event(
        StreamingEventType.CHECKPOINT, progress=0.5, partial_revision=2
    )
    assert (
        progressed.record_event(
            StreamingEventType.HEARTBEAT, progress=0.2, partial_revision=1
        ).progress
        == 0.5
    )
    completed = progressed.transition(StreamingCaptureStatus.AWAITING_STRUCTURING).transition(
        StreamingCaptureStatus.COMPLETED
    )
    assert completed.transition(StreamingCaptureStatus.COMPLETED) is completed
    with pytest.raises(CaptureTransitionError):
        completed.transition(StreamingCaptureStatus.FAILED)
    with pytest.raises(CaptureTransitionError):
        completed.transition(StreamingCaptureStatus.STRUCTURING)
    with pytest.raises(CaptureTransitionError):
        completed.record_event(StreamingEventType.CHECKPOINT)


def test_capture_operation_from_contract_and_require_pull_structuring() -> None:
    from capture_runtime.capture.domain.operation.models import CaptureTransitionError
    from capture_runtime.contracts import CaptureOperationV2

    now = datetime.now(UTC)
    contract_op = CaptureOperationV2(
        capture_id="cap-1",
        ingestion_id="ing-1",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.AWAITING_STRUCTURING,
        progress=0.75,
        partial_revision=1,
        last_event_sequence=3,
        created_at=now,
        updated_at=now,
    )
    domain_op = CaptureOperation.from_contract(contract_op)
    assert domain_op.capture_id == "cap-1"
    assert domain_op.ingestion_id == "ing-1"
    assert domain_op.status is StreamingCaptureStatus.AWAITING_STRUCTURING
    assert domain_op.progress == 0.75
    assert domain_op.partial_revision == 1
    assert domain_op.last_event_sequence == 3

    # require_pull_structuring succeeds for AWAITING_STRUCTURING and STRUCTURING with HOST mode
    domain_op.require_pull_structuring(StructuringMode.HOST)

    structuring_op = domain_op.transition(StreamingCaptureStatus.STRUCTURING)
    structuring_op.require_pull_structuring(StructuringMode.HOST)

    # Rejects non-HOST mode
    with pytest.raises(CaptureTransitionError, match="pull structuring requires host capture mode"):
        domain_op.require_pull_structuring(StructuringMode.RUNTIME)

    # Rejects invalid status (e.g. EXTRACTING)
    extracting_op = CaptureOperation(
        capture_id="cap-2",
        ingestion_id="ing-2",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.EXTRACTING,
    )
    with pytest.raises(CaptureTransitionError, match="capture is not awaiting pull structuring"):
        extracting_op.require_pull_structuring(StructuringMode.HOST)
