from __future__ import annotations

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    OpenIngestionV2,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StreamingIngestionStatus,
    StructuringMode,
)
from capture_runtime.storage import StreamingRepository, StreamingTransitionError


class MutableClock(Clock):
    def __init__(self) -> None:
        self.current = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


def _open(repository: StreamingRepository, source: bytes) -> tuple[str, str]:
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="repository-open-1",
            file_name="sample.mp3",
            media_type="audio/mpeg",
            total_bytes=len(source),
            source_sha256=hashlib.sha256(source).hexdigest(),
        )
    )
    return ingestion.ingestion_id, hashlib.sha256(source).hexdigest()


def test_streaming_repository_recovers_ordered_upload_and_event_log(tmp_path: Path) -> None:
    clock = MutableClock()
    source = b"abcdef"
    first = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    first.initialize()
    ingestion_id, source_sha256 = _open(first, source)

    first.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source[:3],
        sha256=hashlib.sha256(source[:3]).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    first.append_chunk(
        ingestion_id,
        chunk_index=1,
        byte_offset=3,
        data=source[3:],
        sha256=hashlib.sha256(source[3:]).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    first.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=source_sha256)
    capture = first.create_capture(
        StartCaptureV2(
            client_request_id="repository-capture-1",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    assert capture.status is StreamingCaptureStatus.EXTRACTING

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    assert restarted.get_ingestion(ingestion_id).status is StreamingIngestionStatus.READY
    recovered = restarted.get_capture(capture.capture_id)
    assert recovered.last_event_sequence == 1
    assert len(restarted.read_events(capture.capture_id, after_sequence=-1)) == 1
    assert restarted.source_path(ingestion_id).read_bytes() == source


def test_streaming_repository_prunes_expired_terminal_capture_and_ingestion(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    source = b"audio"
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=1)
    repository.initialize()
    ingestion_id, source_sha256 = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=hashlib.sha256(source).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=source_sha256)
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-capture-prune",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.cancel_capture(capture.capture_id)
    clock.current += timedelta(hours=3)

    repository.prune_expired()

    assert not (tmp_path / "streaming" / "captures" / capture.capture_id).exists()
    assert not (tmp_path / "streaming" / "ingestions" / ingestion_id).exists()


def test_streaming_repository_deletes_unreferenced_ingestion_after_terminal_capture(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    source = b"audio"
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, source_sha256 = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=source_sha256,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=source_sha256)
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-cascade-delete",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.cancel_capture(capture.capture_id)

    repository.delete_capture(capture.capture_id)

    with pytest.raises(KeyError):
        repository.get_capture(capture.capture_id)
    with pytest.raises(KeyError):
        repository.get_ingestion(ingestion_id)
    assert not (tmp_path / "streaming" / "captures" / capture.capture_id).exists()
    assert not (tmp_path / "streaming" / "ingestions" / ingestion_id).exists()


def test_streaming_repository_preserves_shared_ingestion_until_last_capture_is_deleted(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    source = b"audio"
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, source_sha256 = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=source_sha256,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=source_sha256)
    first = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-shared-capture-1",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    second = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-shared-capture-2",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.cancel_capture(first.capture_id)

    repository.delete_capture(first.capture_id)

    assert repository.get_ingestion(ingestion_id).status is StreamingIngestionStatus.READY
    assert repository.source_path(ingestion_id).read_bytes() == source
    with pytest.raises(StreamingTransitionError, match="active"):
        repository.delete_capture(second.capture_id)
    repository.cancel_capture(second.capture_id)
    repository.delete_capture(second.capture_id)
    with pytest.raises(KeyError):
        repository.get_ingestion(ingestion_id)


def test_streaming_repository_retains_capture_state_when_filesystem_delete_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = MutableClock()
    source = b"audio"
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, source_sha256 = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=source_sha256,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=source_sha256)
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-filesystem-delete-failure",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.cancel_capture(capture.capture_id)
    subscription = repository.subscribe_events(capture.capture_id, after_sequence=-1)

    def fail_delete(_directory: Path) -> None:
        raise OSError("capture directory is unavailable")

    monkeypatch.setattr(
        "capture_runtime.storage.streaming_repository.shutil.rmtree",
        fail_delete,
    )
    with pytest.raises(OSError, match="unavailable"):
        repository.delete_capture(capture.capture_id)

    assert repository.get_capture(capture.capture_id).capture_id == capture.capture_id
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.HEARTBEAT,
        stage="completed",
    )
    assert subscription.get(timeout=0.1).event_type is StreamingEventType.HEARTBEAT
    subscription.close()


def test_streaming_repository_rejects_active_capture_delete_without_detaching_subscriber(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    source = b"audio"
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, source_sha256 = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=hashlib.sha256(source).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=source_sha256)
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-capture-active-delete",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    subscription = repository.subscribe_events(capture.capture_id, after_sequence=-1)

    with pytest.raises(StreamingTransitionError, match="active"):
        repository.delete_capture(capture.capture_id)

    assert repository.get_capture(capture.capture_id).capture_id == capture.capture_id
    assert repository.get_ingestion(ingestion_id).status is StreamingIngestionStatus.READY
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.HEARTBEAT,
        stage="extracting",
    )
    assert subscription.get(timeout=0.1).event_type is StreamingEventType.HEARTBEAT
    subscription.close()


def test_streaming_repository_returns_resync_when_replay_is_too_large(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    source = b"audio"
    ingestion_id, source_sha256 = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=hashlib.sha256(source).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=source_sha256)
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-capture-resync",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    for _ in range(1_024):
        repository.append_event(
            capture.capture_id,
            event_type=StreamingEventType.HEARTBEAT,
            stage="extracting",
        )

    events = repository.read_events(capture.capture_id, after_sequence=-1)

    assert len(events) == 1
    assert events[0].event_type is StreamingEventType.RESYNC_REQUIRED
    assert events[0].sequence == repository.get_capture(capture.capture_id).last_event_sequence
