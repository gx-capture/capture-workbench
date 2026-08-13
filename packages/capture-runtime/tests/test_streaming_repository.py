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
