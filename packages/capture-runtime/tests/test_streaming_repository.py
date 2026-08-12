from __future__ import annotations

import hashlib
import json
import os
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path
from uuid import uuid4

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
from capture_runtime.storage import (
    StreamingRecordNotFoundError,
    StreamingRepository,
    StreamingTransitionError,
    StreamingUploadLimitError,
)


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
    assert recovered.status is StreamingCaptureStatus.FAILED
    assert recovered.error is not None
    assert recovered.error.code == "runtime_restarted"
    assert recovered.last_event_sequence == 2
    assert [
        event.event_type for event in restarted.read_events(capture.capture_id, after_sequence=-1)
    ] == [StreamingEventType.ACCEPTED, StreamingEventType.FAILED]
    assert restarted.source_path(ingestion_id).read_bytes() == source

    restarted_again = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted_again.initialize()

    assert restarted_again.get_capture(capture.capture_id).last_event_sequence == 2
    assert len(restarted_again.read_events(capture.capture_id, after_sequence=-1)) == 2


def test_streaming_repository_finds_ingestion_by_client_request_id_and_clears_on_delete(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abc")

    recovered = repository.get_ingestion_by_client_request_id("repository-open-1")

    assert recovered.ingestion_id == ingestion_id
    with pytest.raises(StreamingRecordNotFoundError):
        repository.get_ingestion_by_client_request_id("missing-request")

    repository.delete_ingestion(ingestion_id)

    with pytest.raises(StreamingRecordNotFoundError):
        repository.get_ingestion_by_client_request_id("repository-open-1")


def test_streaming_repository_containment_guard_rejects_external_canonical_children(
    tmp_path: Path,
) -> None:
    from capture_runtime.storage.streaming_repository import _ensure_contained

    root = tmp_path / "root"
    outside = tmp_path / "outside"

    _ensure_contained(root, root / "child")
    with pytest.raises(RuntimeError, match="escaped repository root"):
        _ensure_contained(root, outside)


def test_streaming_repository_rejects_symlinked_ingestion_source(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    source_path = repository.source_path(ingestion_id)
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"EVIL")
    source_path.unlink()
    try:
        os.symlink(outside, source_path)
    except OSError:
        pytest.skip("file symlinks are not available")

    with pytest.raises(RuntimeError, match="escaped repository root"):
        repository.source_path(ingestion_id)
    with pytest.raises(RuntimeError, match="escaped repository root"):
        repository.append_chunk(
            ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=b"a",
            sha256=hashlib.sha256(b"a").hexdigest(),
            max_chunk_bytes=4 * 1024 * 1024,
            declared_total_bytes=6,
        )

    assert outside.read_bytes() == b"EVIL"


def test_streaming_repository_rejects_symlinked_ingestion_directory_cleanup(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    directory = tmp_path / "streaming" / "ingestions" / ingestion_id
    outside = tmp_path / "outside-directory"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    shutil.rmtree(directory)
    try:
        os.symlink(outside, directory, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")

    with pytest.raises(RuntimeError, match="escaped repository root"):
        repository.delete_ingestion(ingestion_id)

    assert (outside / "keep.txt").exists()


def test_streaming_repository_quarantines_symlinked_ingestion_directory_on_load(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    directory = tmp_path / "streaming" / "ingestions" / ingestion_id
    outside = tmp_path / "outside-load-directory"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    shutil.rmtree(directory)
    try:
        os.symlink(outside, directory, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    with pytest.raises(StreamingRecordNotFoundError):
        restarted.get_ingestion(ingestion_id)
    assert (outside / "keep.txt").exists()


def test_streaming_repository_rejects_symlinked_persistence_root(tmp_path: Path) -> None:
    real = tmp_path / "real-root"
    real.mkdir()
    link = tmp_path / "root-link"
    try:
        os.symlink(real, link, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")

    with pytest.raises(RuntimeError, match="persistence root must not be a symlink"):
        StreamingRepository(link, clock=MutableClock(), retention_hours=4).initialize()


def test_streaming_repository_rejects_symlinked_ingestions_root_on_initialize(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    category = tmp_path / "streaming" / "ingestions"
    outside = tmp_path / "outside-ingestions-root"
    outside.mkdir()
    (outside / "keep.txt").write_text("keep")
    shutil.rmtree(category)
    try:
        os.symlink(outside, category, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")

    with pytest.raises(RuntimeError, match="ingestions root must not be a symlink"):
        StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4).initialize()

    assert (outside / "keep.txt").exists()


def test_streaming_repository_rechecks_capture_directory_containment_before_event_read(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-capture-containment",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    directory = tmp_path / "streaming" / "captures" / capture.capture_id
    outside = tmp_path / "outside-capture-directory"
    outside.mkdir()
    (outside / "events.jsonl").write_text("[]\n")
    shutil.rmtree(directory)
    try:
        os.symlink(outside, directory, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")

    with pytest.raises(RuntimeError, match="escaped repository root"):
        repository.read_events(capture.capture_id, after_sequence=-1)

    assert (outside / "events.jsonl").read_text() == "[]\n"


def test_streaming_repository_rejects_symlinked_events_leaf(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-capture-leaf",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    events_path = tmp_path / "streaming" / "captures" / capture.capture_id / "events.jsonl"
    outside = tmp_path / "outside-events.jsonl"
    outside.write_text("[]\n")
    events_path.unlink()
    try:
        os.symlink(outside, events_path)
    except OSError:
        pytest.skip("file symlinks are not available")

    with pytest.raises(RuntimeError, match="must not be a symlink"):
        repository.read_events(capture.capture_id, after_sequence=-1)

    assert outside.read_text() == "[]\n"


def test_streaming_repository_rejects_symlinked_ingestion_metadata_leaf_on_persist(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    metadata_path = tmp_path / "streaming" / "ingestions" / ingestion_id / "metadata.json"
    outside = tmp_path / "outside-metadata.json"
    outside.write_text("{}")
    metadata_path.unlink()
    try:
        os.symlink(outside, metadata_path)
    except OSError:
        pytest.skip("file symlinks are not available")

    with pytest.raises(RuntimeError, match="must not be a symlink"):
        repository.append_chunk(
            ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=b"a",
            sha256=hashlib.sha256(b"a").hexdigest(),
            max_chunk_bytes=4 * 1024 * 1024,
            declared_total_bytes=6,
        )

    assert outside.read_text() == "{}"


def test_streaming_repository_quarantines_ingestion_metadata_id_mismatch(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    metadata_path = tmp_path / "streaming" / "ingestions" / ingestion_id / "metadata.json"
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload["ingestionId"] = str(uuid4())
    metadata_path.write_text(json.dumps(payload), encoding="utf-8")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    with pytest.raises(StreamingRecordNotFoundError):
        restarted.get_ingestion(ingestion_id)


def test_streaming_repository_quarantines_capture_metadata_id_mismatch(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-capture-id-mismatch",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    metadata_path = tmp_path / "streaming" / "captures" / capture.capture_id / "metadata.json"
    payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    payload["operation"]["captureId"] = str(uuid4())
    metadata_path.write_text(json.dumps(payload), encoding="utf-8")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    with pytest.raises(StreamingRecordNotFoundError):
        restarted.get_capture(capture.capture_id)


@pytest.mark.parametrize("corruption", ["capture_id", "event_id", "sequence", "gap"])
def test_streaming_repository_replay_fails_closed_on_corrupt_event_log(
    tmp_path: Path,
    corruption: str,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-replay-corruption",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.ACCEPTED,
        stage="queued",
    )
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.CHECKPOINT,
        stage="extracting",
    )
    path = tmp_path / "streaming" / "captures" / capture.capture_id / "events.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    if corruption == "capture_id":
        payload = json.loads(lines[0])
        payload["captureId"] = "other-capture"
        lines[0] = json.dumps(payload)
    elif corruption == "event_id":
        payload = json.loads(lines[0])
        payload["eventId"] = f"{payload['captureId']}/{payload['sequence'] + 1}"
        lines[0] = json.dumps(payload)
    elif corruption == "sequence":
        payload = json.loads(lines[1])
        payload["sequence"] = 1
        payload["eventId"] = f"{payload['captureId']}/1"
        lines[1] = json.dumps(payload)
    else:
        payload = json.loads(lines[1])
        payload["sequence"] = 3
        payload["eventId"] = f"{payload['captureId']}/3"
        lines[1] = json.dumps(payload)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="streaming event log is corrupted"):
        repository.read_events(capture.capture_id, after_sequence=-1)


def test_streaming_repository_subscribe_fails_closed_without_registering_subscriber(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"abcdef")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-subscriber-corruption",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.ACCEPTED,
        stage="queued",
    )
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.CHECKPOINT,
        stage="extracting",
    )
    path = tmp_path / "streaming" / "captures" / capture.capture_id / "events.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    payload = json.loads(lines[1])
    payload["sequence"] = 3
    payload["eventId"] = f"{payload['captureId']}/3"
    lines[1] = json.dumps(payload)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(RuntimeError, match="streaming event log is corrupted"):
        repository.subscribe_events(capture.capture_id, after_sequence=-1)

    assert capture.capture_id not in repository._subscribers


def test_streaming_repository_quarantines_a_sequence_gap_on_startup(tmp_path: Path) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-startup-gap",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.ACCEPTED,
        stage="queued",
    )
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.CHECKPOINT,
        stage="extracting",
    )
    path = repository.root / "captures" / capture.capture_id / "events.jsonl"
    lines = path.read_text(encoding="utf-8").splitlines()
    payload = json.loads(lines[1])
    payload["sequence"] = 3
    payload["eventId"] = f"{payload['captureId']}/3"
    lines[1] = json.dumps(payload)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    with pytest.raises(KeyError):
        restarted.get_capture(capture.capture_id)
    assert (
        repository.root / "quarantine" / "captures" / capture.capture_id / "metadata.json"
    ).is_file()


def test_streaming_repository_quarantines_a_symlinked_record_directory_alias_on_load(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    directory = repository.root / "ingestions" / ingestion_id
    alias = repository.root / "ingestions" / ("f" * 36)
    try:
        os.symlink(directory, alias, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    assert restarted.get_ingestion(ingestion_id).ingestion_id == ingestion_id
    assert not alias.exists()
    assert (directory / "metadata.json").is_file()


def test_streaming_repository_rejects_symlinked_record_directory_alias_before_access(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    first_id, _ = _open(repository, b"audio")
    second = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="repository-alias-target-2",
            file_name="second.wav",
            media_type="audio/wav",
            total_bytes=4,
        )
    )
    second_id = second.ingestion_id
    directory = repository.root / "ingestions" / first_id
    target = repository.root / "ingestions" / second_id
    shutil.rmtree(directory)
    try:
        os.symlink(target, directory, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are not available")

    with pytest.raises(RuntimeError, match="must not be a symlink"):
        repository.append_chunk(
            first_id,
            chunk_index=0,
            byte_offset=0,
            data=b"a",
            sha256=hashlib.sha256(b"a").hexdigest(),
            max_chunk_bytes=4 * 1024 * 1024,
            declared_total_bytes=4,
        )

    assert repository.get_ingestion(second_id).received_bytes == 0


def test_streaming_repository_truncates_source_after_source_write_crash_window(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    source = b"abcdef"
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, source_sha256 = _open(repository, source)
    first_chunk = source[:3]
    repository.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=first_chunk,
        sha256=hashlib.sha256(first_chunk).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )

    # Simulate the source write succeeding while metadata persistence was still
    # stale. Reload must make the persisted offset authoritative before retry.
    repository.source_path(ingestion_id).write_bytes(source)

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    repaired = restarted.get_ingestion(ingestion_id)
    assert repaired.next_chunk_index == 1
    assert repaired.next_offset == 3
    assert restarted.source_path(ingestion_id).read_bytes() == first_chunk

    second_chunk = source[3:]
    restarted.append_chunk(
        ingestion_id,
        chunk_index=1,
        byte_offset=3,
        data=second_chunk,
        sha256=hashlib.sha256(second_chunk).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    finalized = restarted.finalize_ingestion(
        ingestion_id,
        total_bytes=len(source),
        sha256=source_sha256,
    )

    assert finalized.status is StreamingIngestionStatus.READY
    assert restarted.source_path(ingestion_id).read_bytes() == source


def test_streaming_repository_rejects_append_after_configured_limit_changes(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    source = b"abcd"
    original = StreamingRepository(
        tmp_path / "streaming",
        clock=clock,
        retention_hours=4,
        max_upload_bytes=len(source),
    )
    original.initialize()
    ingestion_id, _ = _open(original, source)
    first_chunk = source[:2]
    original.append_chunk(
        ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=first_chunk,
        sha256=hashlib.sha256(first_chunk).hexdigest(),
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )

    limited = StreamingRepository(
        tmp_path / "streaming",
        clock=clock,
        retention_hours=4,
        max_upload_bytes=3,
    )
    limited.initialize()

    with pytest.raises(StreamingUploadLimitError):
        limited.append_chunk(
            ingestion_id,
            chunk_index=1,
            byte_offset=2,
            data=source[2:],
            sha256=hashlib.sha256(source[2:]).hexdigest(),
            max_chunk_bytes=4 * 1024 * 1024,
            declared_total_bytes=len(source),
        )

    assert limited.source_path(ingestion_id).read_bytes() == first_chunk


def test_streaming_repository_repairs_terminal_metadata_without_a_terminal_event(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-terminal-metadata-only",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )

    metadata_path = repository.root / "captures" / capture.capture_id / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["operation"].update(
        {
            "status": "completed",
            "progress": 1,
            "completedAt": clock.now().isoformat(),
        }
    )
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    recovered = restarted.get_capture(capture.capture_id)
    assert recovered.status is StreamingCaptureStatus.FAILED
    assert recovered.error is not None
    assert recovered.error.code == "runtime_state_recovered"
    assert recovered.last_event_sequence == 2
    assert [
        event.event_type for event in restarted.read_events(capture.capture_id, after_sequence=-1)
    ] == [StreamingEventType.ACCEPTED, StreamingEventType.FAILED]

    restarted_again = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted_again.initialize()
    assert restarted_again.get_capture(capture.capture_id).last_event_sequence == 2
    assert len(restarted_again.read_events(capture.capture_id, after_sequence=-1)) == 2


def test_streaming_repository_recreates_missing_event_log_during_startup(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-missing-events",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    events_path = repository.root / "captures" / capture.capture_id / "events.jsonl"
    events_path.unlink()

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    assert events_path.is_file()
    recovered = restarted.get_capture(capture.capture_id)
    assert recovered.status is StreamingCaptureStatus.FAILED
    assert recovered.error is not None
    assert recovered.error.code == "runtime_restarted"
    assert [
        event.event_type for event in restarted.read_events(capture.capture_id, after_sequence=-1)
    ] == [StreamingEventType.FAILED]


def test_streaming_repository_quarantines_a_torn_final_event_line(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-torn-events",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.HEARTBEAT,
        stage="extracting",
    )
    events_path = repository.root / "captures" / capture.capture_id / "events.jsonl"
    with events_path.open("a", encoding="utf-8") as event_log:
        event_log.write('{"protocolVersion":"2","sequence":')

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    assert list(events_path.parent.glob("events.jsonl.corrupt.*"))
    assert [
        event.event_type for event in restarted.read_events(capture.capture_id, after_sequence=-1)
    ] == [
        StreamingEventType.ACCEPTED,
        StreamingEventType.HEARTBEAT,
        StreamingEventType.FAILED,
    ]


def test_streaming_repository_quarantines_invalid_capture_metadata(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-invalid-capture-metadata",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    metadata_path = repository.root / "captures" / capture.capture_id / "metadata.json"
    metadata_path.write_text("{not-json", encoding="utf-8")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    with pytest.raises(KeyError):
        restarted.get_capture(capture.capture_id)
    assert (
        repository.root / "quarantine" / "captures" / capture.capture_id / "metadata.json"
    ).is_file()


def test_streaming_repository_quarantines_invalid_ingestion_metadata(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    metadata_path = repository.root / "ingestions" / ingestion_id / "metadata.json"
    metadata_path.write_text("{not-json", encoding="utf-8")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    with pytest.raises(KeyError):
        restarted.get_ingestion(ingestion_id)
    assert (
        repository.root / "quarantine" / "ingestions" / ingestion_id / "metadata.json"
    ).is_file()


def test_streaming_repository_reconciles_terminal_event_when_metadata_is_stale(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-terminal-event-ahead",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    event = repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.COMPLETED,
        stage="completed",
        progress=1,
    )
    metadata_path = repository.root / "captures" / capture.capture_id / "metadata.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["operation"]["status"] = "waiting_input"
    metadata["operation"]["lastEventSequence"] = 1
    metadata["operation"]["completedAt"] = None
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    restarted = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    restarted.initialize()

    recovered = restarted.get_capture(capture.capture_id)
    assert recovered.status is StreamingCaptureStatus.COMPLETED
    assert recovered.last_event_sequence == event.sequence
    assert recovered.completed_at == event.created_at
    assert [
        persisted.event_type
        for persisted in restarted.read_events(capture.capture_id, after_sequence=-1)
    ] == [StreamingEventType.ACCEPTED, StreamingEventType.COMPLETED]


def test_streaming_repository_rejects_events_after_terminal_event(
    tmp_path: Path,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-terminal-event-fence",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )

    repository.append_event(
        capture.capture_id,
        event_type=StreamingEventType.COMPLETED,
        stage="completed",
        progress=1,
    )

    with pytest.raises(StreamingTransitionError, match="terminal"):
        repository.append_event(
            capture.capture_id,
            event_type=StreamingEventType.HEARTBEAT,
            stage="extracting",
        )

    assert repository.get_capture(capture.capture_id).status is StreamingCaptureStatus.COMPLETED
    assert [
        event.event_type for event in repository.read_events(capture.capture_id, after_sequence=-1)
    ] == [StreamingEventType.ACCEPTED, StreamingEventType.COMPLETED]


def test_streaming_repository_keeps_capture_retryable_when_ingestion_delete_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    clock = MutableClock()
    repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
    repository.initialize()
    ingestion_id, _ = _open(repository, b"audio")
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="repository-ingestion-delete-failure",
            ingestion_id=ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.cancel_capture(capture.capture_id)

    original_remove = __import__("shutil").rmtree

    def fail_ingestion_once(directory: Path) -> None:
        if directory.name == ingestion_id:
            raise OSError("ingestion directory is unavailable")
        original_remove(directory)

    monkeypatch.setattr(
        "capture_runtime.storage.streaming_repository.shutil.rmtree",
        fail_ingestion_once,
    )
    with pytest.raises(OSError, match="ingestion directory"):
        repository.delete_capture(capture.capture_id)

    assert repository.get_capture(capture.capture_id).capture_id == capture.capture_id
    assert repository.get_ingestion(ingestion_id).ingestion_id == ingestion_id
    assert (repository.root / "captures" / capture.capture_id).exists()
    assert (repository.root / "ingestions" / ingestion_id).exists()

    monkeypatch.setattr(
        "capture_runtime.storage.streaming_repository.shutil.rmtree",
        original_remove,
    )
    repository.delete_capture(capture.capture_id)
    with pytest.raises(KeyError):
        repository.get_capture(capture.capture_id)
    with pytest.raises(KeyError):
        repository.get_ingestion(ingestion_id)


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
    with pytest.raises(StreamingTransitionError, match="terminal"):
        repository.append_event(
            capture.capture_id,
            event_type=StreamingEventType.HEARTBEAT,
            stage="completed",
        )
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
    with (repository.root / "captures" / capture.capture_id / "events.jsonl").open(
        "a", encoding="utf-8"
    ) as event_log:
        event_log.write("corrupt tail is outside the replay cap\n")

    events = repository.read_events(capture.capture_id, after_sequence=-1)

    assert len(events) == 1
    assert events[0].event_type is StreamingEventType.RESYNC_REQUIRED
    assert events[0].sequence == repository.get_capture(capture.capture_id).last_event_sequence
    assert events[0].event_id == f"{capture.capture_id}/{events[0].sequence}"
