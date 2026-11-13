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
    CaptureFailureV2,
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


@pytest.mark.parametrize("restart", [False, True])
def test_uncommitted_source_tail_is_replaced(tmp_path: Path, restart: bool) -> None:
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
    path = repository.source_path(ingestion_id)
    path.write_bytes(b"abcpartial-failed-write")
    assert repository.get_ingestion(ingestion_id).received_bytes == 3
    assert path.read_bytes() == b"abcpartial-failed-write"
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
    if restart:
        repository.initialize()
        assert path.read_bytes() == b"abc"
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


@pytest.mark.parametrize("missing", [False, True])
def test_startup_fails_incomplete_source_and_prunes_unowned_ingestion(
    tmp_path: Path, missing: bool
) -> None:
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=b"abc",
        sha256=hashlib.sha256(b"abc").hexdigest(),
        max_chunk_bytes=3,
        declared_total_bytes=6,
    )
    capture = _start(repository, ingestion_id, "protect-incomplete")
    path = repository.source_path(ingestion_id)
    if missing:
        path.unlink()
    else:
        path.write_bytes(b"ab")
    repository.initialize()
    failed = repository.get_capture(capture)
    assert failed.status is StreamingCaptureStatus.FAILED
    assert failed.error.code == "streaming_source_unavailable"
    events = repository.read_events(capture, after_sequence=-1)
    assert events[-1].event_type is StreamingEventType.FAILED
    assert not path.parent.exists()
    repository.initialize()
    assert repository.get_capture(capture).status is StreamingCaptureStatus.FAILED


@pytest.mark.parametrize(
    "status", [status for status in StreamingIngestionStatus if status.value != "open"]
)
def test_startup_does_not_reconcile_other_statuses(
    tmp_path: Path, status: StreamingIngestionStatus
) -> None:
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id="other-status")
    path = repository.source_path(ingestion_id)
    metadata_path = path.parent / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["status"] = status.value
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    path.write_bytes(b"abc-tail")
    repository.initialize()
    assert repository.get_ingestion(ingestion_id).status is status
    assert path.read_bytes() == b"abc-tail"


def test_startup_deletes_only_unreferenced_invalid_ingestion_directories(tmp_path: Path) -> None:
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    valid_id = _ready_ingestion(repository, b"abc", client_request_id="valid")
    protected_id = _ready_ingestion(repository, b"def", client_request_id="protected")
    _start(repository, protected_id, "protect-orphan")
    protected = repository.source_path(protected_id).parent
    (protected / "metadata.json").unlink()
    ingestions = tmp_path / "ingestions"
    missing = ingestions / "missing"
    invalid = ingestions / "invalid"
    for directory in (missing, invalid):
        directory.mkdir()
        (directory / "source.bin").write_bytes(b"orphan")
    (invalid / "metadata.json").write_text("{", encoding="utf-8")
    stray = ingestions / "stray"
    stray.write_bytes(b"keep")
    repository.initialize()
    assert not missing.exists()
    assert not invalid.exists()
    assert protected.is_dir()
    assert stray.read_bytes() == b"keep"
    assert repository.get_ingestion(valid_id).status is StreamingIngestionStatus.READY


@pytest.mark.parametrize("uppercase_reference", [False, True])
def test_startup_protects_case_variant_orphan_reference(tmp_path, uppercase_reference):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abc")
    capture = _start(repository, ingestion_id, "case-reference")
    directory = repository.source_path(ingestion_id).parent
    (directory / "metadata.json").unlink()
    if uppercase_reference:
        metadata_path = tmp_path / "captures" / capture / "metadata.json"
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
        payload["operation"]["ingestionId"] = ingestion_id.upper()
        metadata_path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        directory = directory.rename(directory.with_name(ingestion_id.upper()))
    repository.initialize()
    assert (directory / "source.bin").exists()
    assert repository.get_capture(capture).status is StreamingCaptureStatus.WAITING_INPUT


@pytest.mark.parametrize("failure_point", ["persist", "resolve", "read"])
def test_startup_defers_io_failure_without_pruning(tmp_path, monkeypatch, caplog, failure_point):
    clock = MutableClock()
    repository = StreamingRepository(
        tmp_path, clock=clock, retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id="io-recovery")
    capture = _start(repository, ingestion_id, "io-protected-capture")
    source = repository.source_path(ingestion_id)
    metadata_path = source.parent / "metadata.json"
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload["status"] = "open"
    metadata_path.write_text(json.dumps(payload), encoding="utf-8")
    capture_path = tmp_path / "captures" / capture / "metadata.json"
    capture_payload = json.loads(capture_path.read_text(encoding="utf-8"))
    capture_payload["operation"]["status"] = "waiting_input"
    capture_payload["operation"]["source"] = None
    capture_path.write_text(json.dumps(capture_payload), encoding="utf-8")
    before = metadata_path.read_bytes()
    capture_before = capture_path.read_bytes()
    if failure_point == "persist":
        source.write_bytes(b"ab")
    clock.current += timedelta(days=3)
    original_open = Path.open

    def denied(*args, **kwargs):
        raise PermissionError("private-user-path bearer-secret")

    if failure_point == "persist":
        monkeypatch.setattr(repository, "_persist_ingestion", denied)
    elif failure_point == "resolve":
        monkeypatch.setattr(repository, "_ingestion_directory", denied)
    else:

        def guarded_open(path, *args, **kwargs):
            if path == source:
                return denied()
            return original_open(path, *args, **kwargs)

        monkeypatch.setattr(Path, "open", guarded_open)
    repository.initialize()
    assert repository.get_ingestion(ingestion_id).status is StreamingIngestionStatus.OPEN
    assert metadata_path.read_bytes() == before
    assert source.exists()
    assert capture_path.read_bytes() == capture_before
    assert repository.get_capture(capture).status is StreamingCaptureStatus.WAITING_INPUT
    assert "recovery deferred" in caplog.text
    assert "private-user-path" not in caplog.text
    assert "bearer-secret" not in caplog.text
    # The first request prunes again; the deferral protects for the life of the process.
    repository.prune_expired()
    assert repository.get_ingestion(ingestion_id).status is StreamingIngestionStatus.OPEN
    assert repository.get_capture(capture).status is StreamingCaptureStatus.WAITING_INPUT
    assert source.exists()


def test_startup_keeps_memory_and_disk_equal_when_failing_a_capture_cannot_be_saved(
    tmp_path, monkeypatch
):
    clock = MutableClock()
    repository = StreamingRepository(
        tmp_path, clock=clock, retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id="fail-save")
    capture = _start(repository, ingestion_id, "fail-save-capture")
    source = repository.source_path(ingestion_id)
    metadata_path = source.parent / "metadata.json"
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload["status"] = "open"
    metadata_path.write_text(json.dumps(payload), encoding="utf-8")
    capture_path = tmp_path / "captures" / capture / "metadata.json"
    capture_payload = json.loads(capture_path.read_text(encoding="utf-8"))
    capture_payload["operation"]["status"] = "waiting_input"
    capture_payload["operation"]["source"] = None
    capture_path.write_text(json.dumps(capture_payload), encoding="utf-8")
    capture_before = capture_path.read_bytes()
    source.write_bytes(b"ab")  # shorter than accepted: the ingestion fails at startup

    def denied(*_args, **_kwargs):
        raise PermissionError("locked")

    monkeypatch.setattr(repository, "_persist_capture", denied)
    repository.initialize()
    # Saving the failed capture was refused, so memory keeps what disk still says.
    assert repository.get_capture(capture).status is StreamingCaptureStatus.WAITING_INPUT
    assert capture_path.read_bytes() == capture_before
    repository.prune_expired()
    assert repository.get_capture(capture).status is StreamingCaptureStatus.WAITING_INPUT
    assert source.exists()


def test_startup_keeps_invalid_ingestions_when_a_capture_cannot_be_loaded(tmp_path, monkeypatch):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id="hidden-reference")
    capture = _start(repository, ingestion_id, "hidden-reference-capture")
    ingestion_directory = repository.source_path(ingestion_id).parent
    (ingestion_directory / "metadata.json").unlink()  # the ingestion now looks invalid
    capture_metadata = tmp_path / "captures" / capture / "metadata.json"
    original_read_text = Path.read_text

    def guarded_read_text(path, *args, **kwargs):
        if path == capture_metadata:
            raise PermissionError("locked")
        return original_read_text(path, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", guarded_read_text)
    repository.initialize()
    # The capture that references it could not be read, so its source stays.
    assert (ingestion_directory / "source.bin").read_bytes() == b"abc"


def test_startup_continues_the_event_sequence_after_the_logged_events(tmp_path):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id="sequence")
    capture = _start(repository, ingestion_id, "sequence-capture")
    saved = repository.get_capture(capture).last_event_sequence
    events_path = tmp_path / "captures" / capture / "events.jsonl"
    lines = [line for line in events_path.read_text(encoding="utf-8").splitlines() if line]
    # An event reached the log but its metadata save failed before the crash.
    extra = json.loads(lines[-1])
    extra["sequence"] = saved + 1
    extra["eventId"] = f"{capture}/{saved + 1}"
    events_path.write_text("\n".join([*lines, json.dumps(extra)]) + "\n", encoding="utf-8")
    repository.initialize()
    assert repository.get_capture(capture).last_event_sequence == saved + 1


@pytest.mark.parametrize("tail", ["partial", "whole-without-newline", "invalid-utf8"])
def test_startup_repairs_a_damaged_event_log_tail(tmp_path, tail):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id=f"tail-{tail}")
    capture = _start(repository, ingestion_id, f"tail-capture-{tail}")
    saved = repository.get_capture(capture).last_event_sequence
    events_path = tmp_path / "captures" / capture / "events.jsonl"
    lines = [line for line in events_path.read_bytes().split(b"\n") if line]
    logged = json.loads(lines[-1])
    logged["sequence"] = saved + 1
    logged["eventId"] = f"{capture}/{saved + 1}"
    complete = json.dumps(logged).encode("utf-8")
    if tail == "partial":
        # A complete event, then a crash in the middle of the next line.
        content = b"\n".join([*lines, complete]) + b"\n" + complete[:20]
        expected, expected_lines = saved + 1, len(lines) + 1
    elif tail == "whole-without-newline":
        content = b"\n".join([*lines, complete])
        expected, expected_lines = saved + 1, len(lines) + 1
    else:
        # A damaged line must not stop startup; the last good line still counts.
        content = b"\n".join([*lines, complete, b'{"sequence": \xff\xfe}']) + b"\n"
        expected, expected_lines = saved + 1, len(lines) + 2
    events_path.write_bytes(content)
    repository.initialize()
    assert repository.get_capture(capture).last_event_sequence == expected
    repaired = events_path.read_bytes()
    assert repaired.endswith(b"\n")
    assert len([line for line in repaired.split(b"\n") if line]) == expected_lines


def test_startup_keeps_an_ingestion_whose_metadata_is_unreadable(tmp_path, monkeypatch, caplog):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id="unreadable")
    directory = repository.source_path(ingestion_id).parent
    metadata_path = directory / "metadata.json"
    original_read_bytes = Path.read_bytes

    def guarded_read_bytes(path):
        if path == metadata_path:
            raise PermissionError("private-user-path")
        return original_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", guarded_read_bytes)
    repository.initialize()
    # A lock or permission problem is not proof of damage: nothing is deleted.
    assert directory.is_dir()
    assert metadata_path.is_file()
    assert "unreadable at startup" in caplog.text
    assert "private-user-path" not in caplog.text
    monkeypatch.setattr(Path, "read_bytes", original_read_bytes)
    repository.initialize()
    assert repository.get_ingestion(ingestion_id).status is StreamingIngestionStatus.READY


def test_startup_failed_source_remains_protected_by_active_capture(tmp_path):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    ingestion_id = _ready_ingestion(repository, b"abc", client_request_id="active-recovery")
    capture = _start(repository, ingestion_id, "active-source")
    path = repository.source_path(ingestion_id)
    metadata_path = path.parent / "metadata.json"
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload["status"] = "open"
    metadata_path.write_text(json.dumps(payload), encoding="utf-8")
    path.write_bytes(b"ab")
    repository.initialize()
    assert repository.get_ingestion(ingestion_id).status is StreamingIngestionStatus.FAILED
    assert repository.get_capture(capture).status is StreamingCaptureStatus.EXTRACTING
    assert path.read_bytes() == b"ab"


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
@pytest.mark.parametrize("recovery", ["restart", "operation", "events", "damaged-tail"])
def test_terminal_event_repair(tmp_path, monkeypatch, status, recovery):
    def repository_at_root():
        repo = StreamingRepository(
            tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
        )
        repo.initialize()
        return repo

    repository = repository_at_root()
    capture = _ready_pdf_capture(repository)
    previous = repository.get_capture(capture).last_event_sequence
    metadata = tmp_path / "captures" / capture / "metadata.json"
    log = metadata.with_name("events.jsonl")
    append = repository._persistence.append_event

    def denied(*args, **kwargs):
        raise OSError("private-path-and-content")

    monkeypatch.setattr(repository._persistence, "append_event", denied)
    with pytest.raises(OSError):
        if status == "completed":
            repository.complete_capture(capture)
        elif status == "failed":
            repository.fail_capture(
                capture, CaptureFailureV2(code="test_failure", message="failure", stage="ocr")
            )
        else:
            repository.cancel_capture(capture)
    persisted = json.loads(metadata.read_text(encoding="utf-8"))["operation"]
    assert persisted["status"] == status
    assert capture in repository._terminal_event_pending
    monkeypatch.setattr(repository._persistence, "append_event", append)
    if recovery == "damaged-tail":
        with log.open("ab") as stream:
            stream.write(b'{"sequence":')
    if recovery in {"restart", "damaged-tail"}:
        repository = repository_at_root()
    elif recovery == "operation":
        repository.get_capture(capture)
    events = repository.read_events(capture, after_sequence=0)
    terminal = [event for event in events if event.event_type.value == status]
    assert len(terminal) == 1
    assert capture not in repository._terminal_event_pending
    before_second_read = log.read_bytes()
    repository.read_events(capture, after_sequence=0)
    assert log.read_bytes() == before_second_read
    assert terminal[0].sequence == previous + 1
    assert terminal[0].progress == persisted["progress"]
    assert terminal[0].stage == ("ocr" if status == "failed" else status)
    if status == "failed":
        assert terminal[0].error.code == "test_failure"
    assert repository.get_capture(capture).last_event_sequence == previous + 1
    saved = json.loads(metadata.read_text(encoding="utf-8"))["operation"]
    assert saved["lastEventSequence"] == previous + 1
    before = (log.read_bytes(), metadata.read_bytes())
    repository_at_root()
    repository_at_root()
    assert (log.read_bytes(), metadata.read_bytes()) == before


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
def test_startup_leaves_existing_terminal_event_unchanged(tmp_path, status):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture = _ready_pdf_capture(repository)
    if status == "failed":
        repository.fail_capture(capture, CaptureFailureV2(code="test_failure", message="failure"))
    else:
        if status == "completed":
            repository.complete_capture(capture)
        else:
            repository.cancel_capture(capture)
    directory = tmp_path / "captures" / capture
    before = [(directory / name).read_bytes() for name in ("metadata.json", "events.jsonl")]
    repository.initialize()
    assert [(directory / name).read_bytes() for name in ("metadata.json", "events.jsonl")] == before


def test_startup_defers_terminal_event_io_failure_without_disclosing_content(
    tmp_path, monkeypatch, caplog
):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture = _ready_pdf_capture(repository)

    def denied(*args, **kwargs):
        raise OSError("private-path-and-content")

    with monkeypatch.context() as patch:
        patch.setattr(repository._persistence, "append_event", denied)
        with pytest.raises(OSError):
            repository.cancel_capture(capture)
        repository.initialize()
        repository.prune_expired()
    assert "terminal event recovery deferred" in caplog.text
    assert "private-path-and-content" not in caplog.text
    repository.initialize()
    events = repository.read_events(capture, after_sequence=0)
    assert events[-1].event_type is StreamingEventType.CANCELLED


def test_terminal_event_repair_does_not_duplicate_a_write_that_raised(tmp_path, monkeypatch):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture = _ready_pdf_capture(repository)
    previous = repository.get_capture(capture).last_event_sequence
    append = repository._persistence.append_event

    def written_then_failed(path, event):
        append(path, event)
        raise OSError("flush failed")

    with monkeypatch.context() as patch:
        patch.setattr(repository._persistence, "append_event", written_then_failed)
        with pytest.raises(OSError):
            repository.cancel_capture(capture)
    repository.initialize()
    events = repository.read_events(capture, after_sequence=0)
    assert len([event for event in events if event.event_type is StreamingEventType.CANCELLED]) == 1
    assert repository.get_capture(capture).last_event_sequence == previous + 1
    metadata = tmp_path / "captures" / capture / "metadata.json"
    saved = json.loads(metadata.read_text(encoding="utf-8"))["operation"]
    assert saved["lastEventSequence"] == previous + 1


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
def test_unsaved_terminal_status_is_not_repaired_as_terminal(tmp_path, monkeypatch, status):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture = _ready_pdf_capture(repository)
    before = repository.get_capture(capture)
    log = tmp_path / "captures" / capture / "events.jsonl"
    content = log.read_bytes()

    def denied(*args, **kwargs):
        raise OSError("metadata write failed")

    with monkeypatch.context() as patch:
        patch.setattr(repository, "_persist_capture", denied)
        with pytest.raises(OSError):
            if status == "completed":
                repository.complete_capture(capture)
            elif status == "failed":
                repository.fail_capture(
                    capture, CaptureFailureV2(code="test_failure", message="failure")
                )
            else:
                repository.cancel_capture(capture)
    assert repository.get_capture(capture) == before
    assert log.read_bytes() == content


@pytest.mark.parametrize("status", ["completed", "failed", "cancelled"])
@pytest.mark.parametrize("restart", [False, True])
def test_complete_terminal_log_reads_do_not_run_recovery(tmp_path, monkeypatch, status, restart):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture = _ready_pdf_capture(repository)
    if status == "failed":
        repository.fail_capture(capture, CaptureFailureV2(code="test_failure", message="failure"))
    elif status == "completed":
        repository.complete_capture(capture)
    else:
        repository.cancel_capture(capture)
    if restart:
        repository.initialize()

    def unexpected_recovery(*args, **kwargs):
        raise AssertionError("complete terminal log must not be scanned for repair")

    monkeypatch.setattr(repository._persistence, "recover_last_event", unexpected_recovery)
    monkeypatch.setattr(repository._persistence, "recover_last_event_sequence", unexpected_recovery)
    monkeypatch.setattr(repository._persistence, "append_event", unexpected_recovery)
    monkeypatch.setattr(repository._persistence, "persist_capture", unexpected_recovery)
    assert repository.get_capture(capture).status.value == status
    events = repository.read_events(capture, after_sequence=0)
    assert events[-1].event_type.value == status


def test_pending_terminal_repair_failure_never_blocks_reads_or_deletion(tmp_path, monkeypatch):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture = _ready_pdf_capture(repository)

    def denied(*args, **kwargs):
        raise OSError("event write failed")

    with monkeypatch.context() as patch:
        # A full disk: every event write keeps failing.
        patch.setattr(repository._persistence, "append_event", denied)
        with pytest.raises(OSError):
            repository.cancel_capture(capture)
        # Reads return what is saved and keep the repair pending.
        assert repository.get_capture(capture).status is StreamingCaptureStatus.CANCELLED
        events = repository.read_events(capture, after_sequence=-1)
        assert StreamingEventType.CANCELLED not in [event.event_type for event in events]
        assert capture in repository._terminal_event_pending
        # Deleting the capture, which frees the space, still works.
        repository.delete_capture(capture)
    assert capture not in repository._terminal_event_pending


def test_terminal_startup_repair_reads_log_once(tmp_path, monkeypatch):
    repository = StreamingRepository(
        tmp_path, clock=MutableClock(), retention_hours=24, policy=_DEFAULT_POLICY
    )
    repository.initialize()
    capture = _ready_pdf_capture(repository)
    repository.cancel_capture(capture)
    log = tmp_path / "captures" / capture / "events.jsonl"
    original = Path.read_bytes
    reads = []

    def counted(path):
        if path == log:
            reads.append(path)
        return original(path)

    monkeypatch.setattr(Path, "read_bytes", counted)
    repository.initialize()
    assert reads == [log]
