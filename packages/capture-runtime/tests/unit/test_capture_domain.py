"""Unit tests for capture domain models, value objects, events, and use cases."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from capture_runtime.capture.application.use_cases import (
    AppendChunk,
    CancelCapture,
    CommitHostStructuring,
    FinalizeIngestion,
    OpenIngestion,
    PollCaptureEvents,
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
    CaptureDocument,
    CaptureEventV2,
    CaptureOperationV2,
    CaptureSourceKind,
    FinalizeIngestionV2,
    IngestionV2,
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
    event = CaptureCompleted(capture_id="cap-1", completed_at_ms=1000)
    assert event.capture_id == "cap-1"
    assert event.completed_at_ms == 1000

    with pytest.raises(ValueError, match="capture_id cannot be empty"):
        CaptureCompleted(capture_id="", completed_at_ms=100)

    with pytest.raises(ValueError, match="completed_at_ms must be non-negative"):
        CaptureCompleted(capture_id="c", completed_at_ms=-1)


def test_capture_use_cases() -> None:
    mock_service = Mock()

    # 1. OpenIngestion
    open_req = OpenIngestionV2(
        client_request_id="req-1",
        file_name="doc.pdf",
        media_type="application/pdf",
        total_bytes=1000,
        kind=CaptureSourceKind.PDF,
    )
    mock_ingestion = Mock(spec=IngestionV2)
    mock_service.open_ingestion.return_value = mock_ingestion
    open_uc = OpenIngestion(mock_service)
    assert open_uc.execute(open_req) is mock_ingestion
    mock_service.open_ingestion.assert_called_once_with(open_req)

    # 2. AppendChunk
    mock_service.append_chunk.return_value = mock_ingestion
    append_uc = AppendChunk(mock_service)
    assert (
        append_uc.execute(
            "ing-1",
            chunk_index=0,
            byte_offset=0,
            data=b"bytes",
            sha256="s",
            declared_total_bytes=5,
        )
        is mock_ingestion
    )
    mock_service.append_chunk.assert_called_once_with(
        "ing-1",
        chunk_index=0,
        byte_offset=0,
        data=b"bytes",
        sha256="s",
        declared_total_bytes=5,
    )

    # 3. FinalizeIngestion
    finalize_req = FinalizeIngestionV2(total_bytes=5, sha256="0" * 64)
    mock_service.finalize_ingestion.return_value = mock_ingestion
    finalize_uc = FinalizeIngestion(mock_service)
    assert finalize_uc.execute("ing-1", finalize_req) is mock_ingestion
    mock_service.finalize_ingestion.assert_called_once_with("ing-1", finalize_req)

    # 4. StartCapture
    start_req = StartCaptureV2(
        ingestion_id="ing-1",
        client_request_id="req-2",
        structuring_mode=StructuringMode.HOST,
    )
    mock_op = Mock(spec=CaptureOperationV2)
    mock_service.start_capture.return_value = mock_op
    start_uc = StartCapture(mock_service)
    assert start_uc.execute(start_req) is mock_op
    mock_service.start_capture.assert_called_once_with(start_req)

    # 5. CancelCapture
    mock_service.cancel_capture.return_value = mock_op
    cancel_uc = CancelCapture(mock_service)
    assert cancel_uc.execute("cap-1") is mock_op
    mock_service.cancel_capture.assert_called_once_with("cap-1")

    # 6. PollCaptureEvents
    mock_event = Mock(spec=CaptureEventV2)
    mock_service.events.return_value = [mock_event]
    poll_uc = PollCaptureEvents(mock_service)
    assert poll_uc.execute("cap-1", after_sequence=0) == [mock_event]
    mock_service.events.assert_called_once_with("cap-1", after_sequence=0)

    # 7. CommitHostStructuring
    mock_doc = Mock(spec=CaptureDocument)
    mock_service.commit_host_result.return_value = mock_op
    commit_uc = CommitHostStructuring(mock_service)
    assert commit_uc.execute("cap-1", mock_doc, idempotency_key="idemp-1") is mock_op
    mock_service.commit_host_result.assert_called_once_with(
        "cap-1", mock_doc, idempotency_key="idemp-1"
    )
