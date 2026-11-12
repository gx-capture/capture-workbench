from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from capture_runtime.capture.application.use_cases import OpenIngestion
from capture_runtime.capture.domain.size_policy import (
    DOCUMENT_MAX_UPLOAD_BYTES,
    IngestionSourceSizeExceededError,
    SourceSizePolicy,
)
from capture_runtime.capture.infrastructure.streaming_repository import (
    StreamingRecordNotFoundError,
    StreamingRepository,
    StreamingTransitionError,
)
from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureSourceKind,
    IngestionV2,
    OpenIngestionV2,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StreamingIngestionStatus,
    StructuringMode,
)

_DEFAULT_POLICY = SourceSizePolicy(DOCUMENT_MAX_UPLOAD_BYTES)


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
    first = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=_DEFAULT_POLICY
    )
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

    restarted = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=_DEFAULT_POLICY
    )
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
    repository = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=1, policy=_DEFAULT_POLICY
    )
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
        tmp_path / "streaming",
        clock=MutableClock(),
        retention_hours=24,
        policy=_DEFAULT_POLICY,
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
        tmp_path / "streaming",
        clock=MutableClock(),
        retention_hours=24,
        policy=_DEFAULT_POLICY,
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
    repository = StreamingRepository(
        tmp_path / "streaming",
        clock=clock,
        retention_hours=1,
        policy=_DEFAULT_POLICY,
    )
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
    restarted = StreamingRepository(
        tmp_path / "streaming",
        clock=clock,
        retention_hours=1,
        policy=_DEFAULT_POLICY,
    )
    restarted.initialize()

    assert not capture_directory.exists()
    assert not source_directory.exists()


def test_activity_keeps_an_unfinished_capture_and_its_source(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(
        tmp_path / "streaming",
        clock=clock,
        retention_hours=1,
        policy=_DEFAULT_POLICY,
    )
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
    repository = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=_DEFAULT_POLICY
    )
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


def _ready_pdf_capture(repository: StreamingRepository) -> str:
    source = b"%PDF-1.7 three pages"
    digest = hashlib.sha256(source).hexdigest()
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="repository-pdf-open",
            kind=CaptureSourceKind.PDF,
            file_name="sample.pdf",
            media_type="application/pdf",
            total_bytes=len(source),
            source_sha256=digest,
        )
    )
    repository.append_chunk(
        ingestion.ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=digest,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion.ingestion_id, total_bytes=len(source), sha256=digest)
    return repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-pdf-capture",
            ingestion_id=ingestion.ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    ).capture_id


def test_page_progress_survives_reading_the_operation_back(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture_id = _ready_pdf_capture(repository)

    for done in (0, 2, 1):
        repository.append_event(
            capture_id,
            event_type=StreamingEventType.CHECKPOINT,
            stage="extracting",
            pages=(done, 3),
        )

    # A late checkpoint never moves the count back.
    latest = repository.get_capture(capture_id)
    assert (latest.pages_done, latest.pages_total) == (2, 3)
    restarted = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=_DEFAULT_POLICY
    )
    restarted.initialize()
    recovered = restarted.get_capture(capture_id)
    assert (recovered.pages_done, recovered.pages_total) == (2, 3)
    assert [
        (event.pages_done, event.pages_total)
        for event in restarted.read_events(capture_id, after_sequence=1)
    ] == [(0, 3), (2, 3), (1, 3)]


def test_progress_that_does_not_fit_the_capture_kind_is_never_written(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture_id = _ready_pdf_capture(repository)
    before = repository.get_capture(capture_id)

    with pytest.raises(ValueError, match="audio captures"):
        repository.append_event(
            capture_id,
            event_type=StreamingEventType.CHECKPOINT,
            stage="extracting",
            duration_ms=60_000,
        )

    assert repository.get_capture(capture_id) == before
    assert len(repository.read_events(capture_id, after_sequence=-1)) == 1


def test_completion_event_retains_exact_domain_time_and_replays_once(tmp_path: Path) -> None:
    from capture_runtime.capture.infrastructure.streaming_repository import StreamingTransitionError

    clock = MutableClock()
    clock.current = clock.current.replace(microsecond=123456)
    repository = StreamingRepository(
        tmp_path, clock=clock, retention_hours=4, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    source = b"source"
    ingestion_id, digest = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=digest,
        max_chunk_bytes=1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion_id, total_bytes=len(source), sha256=digest)
    operation = repository.create_capture(
        StartCaptureV2(
            ingestion_id=ingestion_id,
            client_request_id="complete-once",
            structuring_mode=StructuringMode.HOST,
        )
    )
    completed = repository.complete_capture(operation.capture_id)
    events = repository.read_events(operation.capture_id, after_sequence=0)
    assert events[-1].event_type is StreamingEventType.COMPLETED
    assert events[-1].created_at == completed.completed_at == clock.current
    assert repository.complete_capture(operation.capture_id) == completed
    assert repository.read_events(operation.capture_id, after_sequence=0) == events
    with pytest.raises(StreamingTransitionError):
        repository.mark_structuring(operation.capture_id)


def test_open_ingestion_rejects_oversized_source_before_creating_records(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    policy = SourceSizePolicy(max_upload_bytes=1000)
    repository = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=policy
    )
    repository.initialize()
    use_case = OpenIngestion(repository, policy=policy)

    with pytest.raises(
        IngestionSourceSizeExceededError,
        match="Source exceeds the size limit for its kind.",
    ):
        use_case.execute(
            OpenIngestionV2(
                client_request_id="oversized-req-1",
                file_name="toolarge.pdf",
                media_type="application/pdf",
                kind=CaptureSourceKind.PDF,
                total_bytes=1001,
            )
        )

    # No directory was created
    ingestions_dir = tmp_path / "streaming" / "ingestions"
    assert not ingestions_dir.exists() or len(list(ingestions_dir.iterdir())) == 0

    # Same client_request_id with valid size succeeds
    valid = use_case.execute(
        OpenIngestionV2(
            client_request_id="oversized-req-1",
            file_name="valid.pdf",
            media_type="application/pdf",
            kind=CaptureSourceKind.PDF,
            total_bytes=1000,
        )
    )
    assert valid.total_bytes == 1000


def test_streaming_repository_prunes_recovered_oversized_ingestion_without_active_capture(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    # Step 1: Open an ingestion under a high ceiling
    permissive_policy = SourceSizePolicy(max_upload_bytes=100 * 1024 * 1024)
    first = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=permissive_policy
    )
    first.initialize()
    ingestion = first.create_ingestion(
        OpenIngestionV2(
            client_request_id="recover-oversized-1",
            file_name="large.mp3",
            media_type="audio/mpeg",
            kind=CaptureSourceKind.AUDIO,
            total_bytes=60 * 1024 * 1024,
        )
    )
    ingestion_id = ingestion.ingestion_id
    ingestion_dir = tmp_path / "streaming" / "ingestions" / ingestion_id
    assert ingestion_dir.exists()

    # Step 2: Restart with a standard 50 MiB policy under which 60 MiB is oversized
    standard_policy = SourceSizePolicy(max_upload_bytes=DOCUMENT_MAX_UPLOAD_BYTES)
    restarted = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=standard_policy
    )
    restarted.initialize()

    # The recovered oversized ingestion had no active capture: it should be deleted
    assert not ingestion_dir.exists()
    with pytest.raises(StreamingRecordNotFoundError):
        restarted.get_ingestion(ingestion_id)


def test_streaming_repository_preserves_recovered_oversized_ingestion_with_active_capture(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    permissive_policy = SourceSizePolicy(max_upload_bytes=100 * 1024 * 1024)
    first = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=permissive_policy
    )
    first.initialize()

    wav_header = (
        b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00"
        b"\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    )
    digest = hashlib.sha256(wav_header).hexdigest()
    total_bytes = 60 * 1024 * 1024
    ingestion = first.create_ingestion(
        OpenIngestionV2(
            client_request_id="recover-active-1",
            file_name="sample.wav",
            media_type="audio/wav",
            kind=CaptureSourceKind.AUDIO,
            total_bytes=total_bytes,
            source_sha256=digest,
        )
    )
    ingestion_id = ingestion.ingestion_id
    first.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=wav_header,
        sha256=digest,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=total_bytes,
    )
    capture = first.create_capture(
        StartCaptureV2(
            client_request_id="active-capture-1",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
            start_policy="eager",
        )
    )
    assert capture.status is StreamingCaptureStatus.WAITING_INPUT

    # Step 2: Restart with standard policy
    standard_policy = SourceSizePolicy(max_upload_bytes=DOCUMENT_MAX_UPLOAD_BYTES)
    restarted = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=standard_policy
    )
    restarted.initialize()

    # Active capture must NOT be deleted, and its ingestion record is preserved
    recovered_capture = restarted.get_capture(capture.capture_id)
    assert recovered_capture.status is StreamingCaptureStatus.WAITING_INPUT
    recovered_ingestion = restarted.get_ingestion(ingestion_id)
    assert recovered_ingestion.ingestion_id == ingestion_id


def test_streaming_repository_chunk_zero_audio_sniffing_rejects_non_audio_and_cleans_up(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    policy = SourceSizePolicy(max_upload_bytes=100 * 1024 * 1024)
    repository = StreamingRepository(
        tmp_path / "streaming", clock=clock, retention_hours=4, policy=policy
    )
    repository.initialize()

    declared_total = DOCUMENT_MAX_UPLOAD_BYTES + 10_000
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="audio-fake-pdf-chunk",
            file_name="fake.wav",
            media_type="audio/wav",
            kind=CaptureSourceKind.AUDIO,
            total_bytes=declared_total,
        )
    )
    ingestion_id = ingestion.ingestion_id
    pdf_chunk = b"%PDF-1.7 disguised as audio in chunk 0"

    with pytest.raises(StreamingTransitionError):
        repository.append_chunk(
            ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=pdf_chunk,
            sha256=hashlib.sha256(pdf_chunk).hexdigest(),
            max_chunk_bytes=4 * 1024 * 1024,
            declared_total_bytes=declared_total,
        )

    # The rejected chunk is not stored.
    source_bin = tmp_path / "streaming" / "ingestions" / ingestion_id / "source.bin"
    assert source_bin.read_bytes() == b""

    # Valid audio signature succeeds
    wav_header = (
        b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00"
        b"\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    )
    valid_ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="audio-real-wav-chunk",
            file_name="real.wav",
            media_type="audio/wav",
            kind=CaptureSourceKind.AUDIO,
            total_bytes=declared_total,
        )
    )
    valid_snapshot = repository.append_chunk(
        valid_ingestion.ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=wav_header,
        sha256=hashlib.sha256(wav_header).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=declared_total,
    )
    assert valid_snapshot.next_chunk_index == 1
    valid_source_bin = (
        tmp_path / "streaming" / "ingestions" / valid_ingestion.ingestion_id / "source.bin"
    )
    assert valid_source_bin.exists()
    assert valid_source_bin.read_bytes() == wav_header


def _open_large_recording(
    repository: StreamingRepository, client_request_id: str, total_bytes: int
) -> str:
    return repository.create_ingestion(
        OpenIngestionV2(
            client_request_id=client_request_id,
            file_name="large.wav",
            media_type="audio/wav",
            kind=CaptureSourceKind.AUDIO,
            total_bytes=total_bytes,
        )
    ).ingestion_id


def _append(
    repository: StreamingRepository,
    ingestion_id: str,
    *,
    chunk_index: int,
    byte_offset: int,
    data: bytes,
    total_bytes: int,
) -> IngestionV2:
    return repository.append_chunk(
        ingestion_id,
        chunk_index=chunk_index,
        byte_offset=byte_offset,
        data=data,
        sha256=hashlib.sha256(data).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=total_bytes,
    )


def test_a_recording_signature_split_over_small_chunks_is_accepted(tmp_path: Path) -> None:
    repository = StreamingRepository(
        tmp_path / "streaming",
        clock=MutableClock(),
        retention_hours=4,
        policy=SourceSizePolicy(max_upload_bytes=100 * 1024 * 1024),
    )
    repository.initialize()
    total_bytes = DOCUMENT_MAX_UPLOAD_BYTES + 10_000
    ingestion_id = _open_large_recording(repository, "split-signature", total_bytes)
    wav_header = (
        b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00"
        b"\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    )
    # The first 8 bytes ("RIFF" and a length) do not yet say WAVE.
    _append(
        repository,
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=wav_header[:8],
        total_bytes=total_bytes,
    )
    snapshot = _append(
        repository,
        ingestion_id,
        chunk_index=1,
        byte_offset=8,
        data=wav_header[8:],
        total_bytes=total_bytes,
    )

    assert snapshot.received_bytes == len(wav_header)
    source = tmp_path / "streaming" / "ingestions" / ingestion_id / "source.bin"
    assert source.read_bytes() == wav_header


def test_an_unrecognized_start_is_rejected_once_the_signature_window_is_full(
    tmp_path: Path,
) -> None:
    repository = StreamingRepository(
        tmp_path / "streaming",
        clock=MutableClock(),
        retention_hours=4,
        policy=SourceSizePolicy(max_upload_bytes=100 * 1024 * 1024),
    )
    repository.initialize()
    total_bytes = DOCUMENT_MAX_UPLOAD_BYTES + 10_000
    ingestion_id = _open_large_recording(repository, "unknown-start", total_bytes)
    first = bytes(100)
    _append(
        repository,
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=first,
        total_bytes=total_bytes,
    )

    with pytest.raises(StreamingTransitionError):
        _append(
            repository,
            ingestion_id,
            chunk_index=1,
            byte_offset=100,
            data=bytes(150),
            total_bytes=total_bytes,
        )

    # The rejected chunk is not stored and the accepted one is untouched.
    source = tmp_path / "streaming" / "ingestions" / ingestion_id / "source.bin"
    assert source.read_bytes() == first
    assert repository.get_ingestion(ingestion_id).received_bytes == len(first)


def test_a_conflicting_replay_of_the_first_chunk_keeps_the_accepted_bytes(
    tmp_path: Path,
) -> None:
    repository = StreamingRepository(
        tmp_path / "streaming",
        clock=MutableClock(),
        retention_hours=4,
        policy=SourceSizePolicy(max_upload_bytes=100 * 1024 * 1024),
    )
    repository.initialize()
    total_bytes = DOCUMENT_MAX_UPLOAD_BYTES + 10_000
    ingestion_id = _open_large_recording(repository, "conflicting-replay", total_bytes)
    wav_header = (
        b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00"
        b"\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    )
    _append(
        repository,
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=wav_header,
        total_bytes=total_bytes,
    )

    with pytest.raises(StreamingTransitionError):
        _append(
            repository,
            ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=b"%PDF-1.7 sent again as the first chunk",
            total_bytes=total_bytes,
        )

    source = tmp_path / "streaming" / "ingestions" / ingestion_id / "source.bin"
    assert source.read_bytes() == wav_header
    assert repository.get_ingestion(ingestion_id).received_bytes == len(wav_header)


def test_startup_removes_an_expired_capture_whose_source_exceeds_a_lowered_limit(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    first = StreamingRepository(
        tmp_path / "streaming",
        clock=clock,
        retention_hours=4,
        policy=SourceSizePolicy(max_upload_bytes=100 * 1024 * 1024),
    )
    first.initialize()
    total_bytes = 60 * 1024 * 1024
    ingestion_id = _open_large_recording(first, "expired-oversized", total_bytes)
    wav_header = (
        b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x44\xac\x00\x00"
        b"\x88\x58\x01\x00\x02\x00\x10\x00data\x00\x00\x00\x00"
    )
    _append(
        first,
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=wav_header,
        total_bytes=total_bytes,
    )
    capture = first.create_capture(
        StartCaptureV2(
            client_request_id="expired-oversized-capture",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
            start_policy="eager",
        )
    )

    # Nothing happens for longer than the retention period, then the runtime
    # restarts with the lower limit.
    clock.current += timedelta(hours=5)
    restarted = StreamingRepository(
        tmp_path / "streaming",
        clock=clock,
        retention_hours=4,
        policy=SourceSizePolicy(max_upload_bytes=DOCUMENT_MAX_UPLOAD_BYTES),
    )
    restarted.initialize()

    with pytest.raises(StreamingRecordNotFoundError):
        restarted.get_capture(capture.capture_id)
    with pytest.raises(StreamingRecordNotFoundError):
        restarted.get_ingestion(ingestion_id)
    assert not (tmp_path / "streaming" / "ingestions" / ingestion_id).exists()


def test_a_replayed_chunk_replaces_the_tail_of_a_failed_write(tmp_path: Path) -> None:
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    source = b"abcdef"
    ingestion_id, digest = _open(repository, source)
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=b"abc",
        sha256=hashlib.sha256(b"abc").hexdigest(),
        max_chunk_bytes=3,
        declared_total_bytes=6,
    )
    # A write that failed halfway left bytes after the accepted chunk.
    path = repository.source_path(ingestion_id)
    path.write_bytes(b"abcpartial-failed-write")
    assert repository.get_ingestion(ingestion_id).received_bytes == 3

    # A chunk at the wrong offset is still rejected and changes nothing.
    with pytest.raises(StreamingTransitionError):
        repository.append_chunk(
            ingestion_id,
            chunk_index=1,
            byte_offset=4,
            data=b"def",
            sha256=hashlib.sha256(b"def").hexdigest(),
            max_chunk_bytes=3,
            declared_total_bytes=6,
        )
    assert path.read_bytes() == b"abcpartial-failed-write"

    # The replay lands at its offset, and the source finalizes with its digest.
    repository.append_chunk(
        ingestion_id,
        chunk_index=1,
        byte_offset=3,
        data=b"def",
        sha256=hashlib.sha256(b"def").hexdigest(),
        max_chunk_bytes=3,
        declared_total_bytes=6,
    )
    assert (
        repository.finalize_ingestion(ingestion_id, total_bytes=6, sha256=digest).status
        is StreamingIngestionStatus.READY
    )
    assert path.read_bytes() == source
