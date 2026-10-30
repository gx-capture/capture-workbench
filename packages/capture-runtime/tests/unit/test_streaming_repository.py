from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureSourceKind,
    OpenIngestionV2,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StreamingIngestionStatus,
    StructuringMode,
)
from capture_runtime.storage import StreamingRepository


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
    assert capture.kind is CaptureSourceKind.AUDIO
    metadata = json.loads(
        (tmp_path / "streaming" / "captures" / capture.capture_id / "metadata.json").read_text(
            encoding="utf-8"
        )
    )
    assert metadata["operation"]["kind"] == "audio"

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    assert restarted.get_ingestion(ingestion_id).status is StreamingIngestionStatus.READY
    recovered = restarted.get_capture(capture.capture_id)
    assert recovered.last_event_sequence == 1
    assert recovered.kind is CaptureSourceKind.AUDIO
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


def _ready_ingestion(
    repository: StreamingRepository, source: bytes, *, client_request_id: str
) -> str:
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id=client_request_id,
            file_name="sample.pdf",
            media_type="application/pdf",
            total_bytes=len(source),
            source_sha256=hashlib.sha256(source).hexdigest(),
        )
    )
    repository.append_chunk(
        ingestion.ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=hashlib.sha256(source).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(
        ingestion.ingestion_id,
        total_bytes=len(source),
        sha256=hashlib.sha256(source).hexdigest(),
    )
    return ingestion.ingestion_id


def _start(repository: StreamingRepository, ingestion_id: str, client_request_id: str) -> str:
    return repository.create_capture(
        StartCaptureV2(
            client_request_id=client_request_id,
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    ).capture_id


def test_deleting_the_last_capture_deletes_its_uploaded_source(tmp_path: Path) -> None:
    repository = StreamingRepository(
        tmp_path / "streaming", clock=MutableClock(), retention_hours=24
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"confidential", client_request_id="open-own")
    capture_id = _start(repository, ingestion_id, "capture-own")
    source = tmp_path / "streaming" / "ingestions" / ingestion_id / "source.bin"
    assert source.read_bytes() == b"confidential"

    repository.cancel_capture(capture_id)
    repository.delete_capture(capture_id)

    assert not source.parent.exists()
    try:
        repository.get_ingestion(ingestion_id)
    except KeyError:
        pass
    else:
        raise AssertionError("the ingestion record must be gone")


def test_a_source_shared_by_captures_stays_until_the_last_is_deleted(tmp_path: Path) -> None:
    repository = StreamingRepository(
        tmp_path / "streaming", clock=MutableClock(), retention_hours=24
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"shared", client_request_id="open-shared")
    first = _start(repository, ingestion_id, "capture-shared-1")
    second = _start(repository, ingestion_id, "capture-shared-2")
    source = tmp_path / "streaming" / "ingestions" / ingestion_id / "source.bin"

    repository.cancel_capture(first)
    repository.delete_capture(first)
    assert source.read_bytes() == b"shared"

    repository.cancel_capture(second)
    repository.delete_capture(second)
    assert not source.parent.exists()


def test_an_abandoned_unfinished_capture_expires_with_its_source(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=1)
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abandoned", client_request_id="open-left")
    capture_id = _start(repository, ingestion_id, "capture-left")
    repository.mark_awaiting_structuring(capture_id)
    capture_directory = tmp_path / "streaming" / "captures" / capture_id
    source_directory = tmp_path / "streaming" / "ingestions" / ingestion_id

    clock.current += timedelta(minutes=59)
    repository.prune_expired()
    assert repository.get_capture(capture_id).status is (
        StreamingCaptureStatus.AWAITING_STRUCTURING
    )
    assert source_directory.exists()

    clock.current += timedelta(minutes=2)
    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=1)
    restarted.initialize()

    assert not capture_directory.exists()
    assert not source_directory.exists()


def test_activity_keeps_an_unfinished_capture_and_its_source(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=1)
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"working", client_request_id="open-busy")
    capture_id = _start(repository, ingestion_id, "capture-busy")

    for _ in range(3):
        clock.current += timedelta(minutes=50)
        repository.append_event(
            capture_id,
            event_type=StreamingEventType.HEARTBEAT,
            stage="extracting",
            progress=0.5,
        )
        repository.prune_expired()

    assert repository.get_capture(capture_id).status is StreamingCaptureStatus.EXTRACTING
    assert repository.source_path(ingestion_id).read_bytes() == b"working"


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
