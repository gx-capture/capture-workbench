"""File-backed storage for the v2 streaming ingestion and event seams."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from queue import Empty, Full, Queue
from typing import Any
from uuid import UUID, uuid4

from pydantic import ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocumentV1,
    CaptureEventV2,
    CaptureFailureV2,
    CaptureOperationV2,
    CaptureSourceKind,
    CaptureSourceV1,
    IngestionV2,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCaptureV1,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StreamingIngestionStatus,
    StructuringMode,
    capture_event_id,
)


class StreamingRecordNotFoundError(KeyError):
    pass


class StreamingIdempotencyConflictError(ValueError):
    pass


class StreamingTransitionError(ValueError):
    pass


class StreamingUploadLimitError(StreamingTransitionError):
    pass


class StreamingPartialNotFoundError(StreamingRecordNotFoundError):
    pass


@dataclass(frozen=True, slots=True)
class StreamingEventOverflow:
    """Marker returned when a live subscriber exceeded its bounded queue."""


@dataclass(slots=True)
class StreamingEventSubscription:
    replay: list[CaptureEventV2]
    _queue: Queue[CaptureEventV2 | StreamingEventOverflow]
    _close: Any
    closed: bool = False

    def get(self, timeout: float) -> CaptureEventV2 | StreamingEventOverflow:
        return self._queue.get(timeout=timeout)

    def close(self) -> None:
        if not self.closed:
            self.closed = True
            self._close(self._queue)


_SAFE_ID = re.compile(r"^[0-9a-f-]{36}$")
_MAX_EVENT_REPLAY = 1_024
DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024
_SAFE_HOST_FAILURE_CODE = "host_provider_failed"
_SAFE_HOST_FAILURE_MESSAGE = "Host structuring failed."
_TERMINAL_CAPTURE_STATUSES = {
    StreamingCaptureStatus.COMPLETED,
    StreamingCaptureStatus.FAILED,
    StreamingCaptureStatus.CANCELLED,
}


def _terminal_status_for_event(
    event_type: StreamingEventType,
) -> StreamingCaptureStatus | None:
    return {
        StreamingEventType.COMPLETED: StreamingCaptureStatus.COMPLETED,
        StreamingEventType.FAILED: StreamingCaptureStatus.FAILED,
        StreamingEventType.CANCELLED: StreamingCaptureStatus.CANCELLED,
    }.get(event_type)


def _sanitize_host_failure(failure: CaptureFailureV2) -> CaptureFailureV2:
    if failure.code == _SAFE_HOST_FAILURE_CODE and failure.message == _SAFE_HOST_FAILURE_MESSAGE:
        return failure.model_copy(update={"stage": "structuring", "retryable": False})
    return CaptureFailureV2(
        code=_SAFE_HOST_FAILURE_CODE,
        message=_SAFE_HOST_FAILURE_MESSAGE,
        stage="structuring",
        retryable=False,
    )


def _identifier(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise StreamingRecordNotFoundError(value) from error
    normalized = str(parsed)
    if normalized != value.lower() or _SAFE_ID.fullmatch(normalized) is None:
        raise StreamingRecordNotFoundError(value)
    return normalized


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("w", encoding="utf-8") as output:
            output.write(json.dumps(payload, ensure_ascii=False, indent=2))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
        except OSError:
            directory_fd = None
        if directory_fd is not None:
            try:
                os.fsync(directory_fd)
            except OSError:
                pass
            finally:
                os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        try:
            directory_fd = os.open(path.parent, os.O_RDONLY)
        except OSError:
            directory_fd = None
        if directory_fd is not None:
            try:
                os.fsync(directory_fd)
            except OSError:
                pass
            finally:
                os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


def _remove_directory(directory: Path) -> None:
    try:
        shutil.rmtree(directory)
    except FileNotFoundError:
        if directory.exists() or directory.is_symlink():
            raise


def _ensure_contained(root: Path, candidate: Path) -> None:
    """Reject candidates whose canonical path escapes a persistence root."""
    canonical_root = Path(os.path.realpath(root))
    canonical_candidate = Path(os.path.realpath(candidate))
    if canonical_candidate != canonical_root and canonical_root not in canonical_candidate.parents:
        raise RuntimeError(f"{candidate} escaped repository root")


@dataclass(slots=True)
class _IngestionRecord:
    request: OpenIngestionV2
    ingestion_id: str
    status: StreamingIngestionStatus
    expires_at: datetime
    next_chunk_index: int = 0
    next_offset: int = 0
    accepted_chunks: dict[int, tuple[int, int, str]] = field(default_factory=dict)
    finalized_sha256: str | None = None


@dataclass(slots=True)
class _CaptureRecord:
    operation: CaptureOperationV2
    request: StartCaptureV2
    structure_idempotency_key: str | None = None
    structure_fingerprint: str | None = None
    failure_idempotency_key: str | None = None
    failure_fingerprint: str | None = None


class StreamingRepository:
    """A bounded, recoverable repository behind the streaming service seam."""

    def __init__(
        self,
        root: Path,
        *,
        clock: Clock,
        retention_hours: int,
        max_upload_bytes: int = DEFAULT_MAX_UPLOAD_BYTES,
    ) -> None:
        self.root = root
        self._clock = clock
        self._retention = timedelta(hours=retention_hours)
        if max_upload_bytes <= 0:
            raise ValueError("max_upload_bytes must be positive")
        self.max_upload_bytes = max_upload_bytes
        self._ingestions: dict[str, _IngestionRecord] = {}
        self._ingestion_idempotency: dict[str, str] = {}
        self._captures: dict[str, _CaptureRecord] = {}
        self._capture_idempotency: dict[str, str] = {}
        self._subscribers: dict[str, set[Queue[CaptureEventV2 | StreamingEventOverflow]]] = {}
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            self._verify_persistence_roots()
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root / "ingestions").mkdir(exist_ok=True)
            (self.root / "captures").mkdir(exist_ok=True)
            self._verify_persistence_roots()
            self._ingestions.clear()
            self._ingestion_idempotency.clear()
            self._captures.clear()
            self._capture_idempotency.clear()
            self._subscribers.clear()
            self._load_ingestions()
            self._load_captures()
            self.recover_interrupted()
            self.prune_expired()

    def _verify_persistence_roots(self) -> None:
        if self.root.is_symlink():
            raise RuntimeError("configured persistence root must not be a symlink")
        canonical_root = Path(os.path.realpath(self.root))
        for category in ("ingestions", "captures"):
            child = self.root / category
            if child.is_symlink():
                raise RuntimeError(f"{category} root must not be a symlink")
            if Path(os.path.realpath(child)) != canonical_root / category:
                raise RuntimeError(f"{category} root escaped repository root")

    def create_ingestion(self, request: OpenIngestionV2) -> IngestionV2:
        with self._lock:
            if request.total_bytes > self.max_upload_bytes:
                raise StreamingUploadLimitError("ingestion exceeds configured upload limit")
            existing_id = self._ingestion_idempotency.get(request.client_request_id)
            if existing_id is not None:
                existing = self._ingestions[existing_id]
                if existing.request != request:
                    raise StreamingIdempotencyConflictError(request.client_request_id)
                return self._ingestion_snapshot(existing)
            ingestion_id = str(uuid4())
            record = _IngestionRecord(
                request=request,
                ingestion_id=ingestion_id,
                status=StreamingIngestionStatus.OPEN,
                expires_at=self._clock.now() + timedelta(hours=2),
            )
            directory = self._ingestion_directory(ingestion_id)
            directory.mkdir(parents=True, exist_ok=False)
            self._ingestion_source_path(ingestion_id).touch()
            self._ingestions[ingestion_id] = record
            self._ingestion_idempotency[request.client_request_id] = ingestion_id
            self._persist_ingestion(record)
            return self._ingestion_snapshot(record)

    def get_ingestion(self, ingestion_id: str) -> IngestionV2:
        with self._lock:
            return self._ingestion_snapshot(self._get_ingestion(ingestion_id))

    def get_ingestion_by_client_request_id(self, client_request_id: str) -> IngestionV2:
        with self._lock:
            ingestion_id = self._ingestion_idempotency.get(client_request_id)
            if ingestion_id is None:
                raise StreamingRecordNotFoundError(client_request_id)
            return self._ingestion_snapshot(self._get_ingestion(ingestion_id))

    def append_chunk(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
        max_chunk_bytes: int,
        declared_total_bytes: int,
    ) -> IngestionV2:
        with self._lock:
            record = self._get_ingestion(ingestion_id)
            if record.status is not StreamingIngestionStatus.OPEN:
                raise StreamingTransitionError("ingestion is not open")
            if chunk_index < 0 or byte_offset < 0 or not data:
                raise StreamingTransitionError("chunk metadata is invalid")
            if len(data) > max_chunk_bytes:
                raise StreamingTransitionError("chunk exceeds the configured limit")
            if (
                record.request.total_bytes > self.max_upload_bytes
                or record.next_offset + len(data) > self.max_upload_bytes
            ):
                raise StreamingUploadLimitError("ingestion exceeds configured upload limit")
            if declared_total_bytes != record.request.total_bytes:
                raise StreamingTransitionError("chunk total bytes conflict with ingestion")
            actual_sha256 = hashlib.sha256(data).hexdigest()
            if sha256 != actual_sha256:
                raise StreamingTransitionError("chunk checksum does not match bytes")
            if chunk_index < record.next_chunk_index:
                accepted = record.accepted_chunks.get(chunk_index)
                if accepted == (byte_offset, len(data), sha256):
                    return self._ingestion_snapshot(record)
                raise StreamingTransitionError("chunk conflicts with an accepted chunk")
            if chunk_index != record.next_chunk_index or byte_offset != record.next_offset:
                raise StreamingTransitionError("chunks must be contiguous and ordered")
            if record.next_offset + len(data) > record.request.total_bytes:
                raise StreamingTransitionError("chunks exceed declared source size")
            with self._ingestion_source_path(ingestion_id).open("ab") as source:
                source.write(data)
                source.flush()
                os.fsync(source.fileno())
            record.accepted_chunks[chunk_index] = (byte_offset, len(data), sha256)
            record.next_chunk_index += 1
            record.next_offset += len(data)
            self._persist_ingestion(record)
            return self._ingestion_snapshot(record)

    def finalize_ingestion(
        self,
        ingestion_id: str,
        *,
        total_bytes: int,
        sha256: str,
    ) -> IngestionV2:
        with self._lock:
            record = self._get_ingestion(ingestion_id)
            if record.status is StreamingIngestionStatus.READY:
                if record.finalized_sha256 == sha256 and total_bytes == record.next_offset:
                    return self._ingestion_snapshot(record)
                raise StreamingTransitionError("finalize conflicts with existing source")
            if record.status is not StreamingIngestionStatus.OPEN:
                raise StreamingTransitionError("ingestion is not open")
            if record.request.total_bytes > self.max_upload_bytes:
                raise StreamingUploadLimitError("ingestion exceeds configured upload limit")
            if total_bytes != record.request.total_bytes or total_bytes != record.next_offset:
                raise StreamingTransitionError("final byte count does not match upload")
            actual_sha256 = _file_sha256(self._ingestion_source_path(ingestion_id))
            if sha256 != actual_sha256 or (
                record.request.source_sha256 is not None and record.request.source_sha256 != sha256
            ):
                raise StreamingTransitionError("final source checksum does not match upload")
            record.status = StreamingIngestionStatus.READY
            record.finalized_sha256 = sha256
            self._persist_ingestion(record)
            return self._ingestion_snapshot(record)

    def create_capture(self, request: StartCaptureV2) -> CaptureOperationV2:
        with self._lock:
            existing_id = self._capture_idempotency.get(request.client_request_id)
            if existing_id is not None:
                existing = self._captures[existing_id]
                if existing.request != request:
                    raise StreamingIdempotencyConflictError(request.client_request_id)
                return existing.operation
            ingestion = self._get_ingestion(request.ingestion_id)
            now = self._clock.now()
            capture_id = str(uuid4())
            source = (
                self._source_for(ingestion)
                if ingestion.status is StreamingIngestionStatus.READY
                else None
            )
            operation = CaptureOperationV2(
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
            record = _CaptureRecord(operation=operation, request=request)
            directory = self._capture_directory(capture_id)
            directory.mkdir(parents=True, exist_ok=False)
            (directory / "events.jsonl").touch()
            self._captures[capture_id] = record
            self._capture_idempotency[request.client_request_id] = capture_id
            self._persist_capture(record)
            self.append_event(
                capture_id,
                event_type=StreamingEventType.ACCEPTED,
                stage="queued",
                progress=0,
            )
            return self._captures[capture_id].operation

    def get_capture(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            return self._get_capture(capture_id).operation

    def get_capture_by_client_request_id(self, client_request_id: str) -> CaptureOperationV2:
        with self._lock:
            capture_id = self._capture_idempotency.get(client_request_id)
            if capture_id is None:
                raise StreamingRecordNotFoundError(client_request_id)
            return self._get_capture(capture_id).operation

    def capture_request(self, capture_id: str) -> StartCaptureV2:
        with self._lock:
            return self._get_capture(capture_id).request

    def capture_ids_for_ingestion(self, ingestion_id: str) -> list[str]:
        with self._lock:
            self._get_ingestion(ingestion_id)
            return [
                record.operation.capture_id
                for record in self._captures.values()
                if record.operation.ingestion_id == ingestion_id
            ]

    def mark_ingestion_ready(self, ingestion_id: str) -> list[CaptureOperationV2]:
        with self._lock:
            changed: list[CaptureOperationV2] = []
            ingestion = self._get_ingestion(ingestion_id)
            for record in self._captures.values():
                if record.operation.ingestion_id != ingestion_id:
                    continue
                if record.operation.status is not StreamingCaptureStatus.WAITING_INPUT:
                    continue
                now = self._clock.now()
                record.operation = record.operation.model_copy(
                    update={
                        "status": StreamingCaptureStatus.EXTRACTING,
                        "kind": ingestion.request.kind,
                        "source": self._source_for(ingestion),
                        "updated_at": now,
                    }
                )
                self._persist_capture(record)
                self.append_event(
                    record.operation.capture_id,
                    event_type=StreamingEventType.INPUT_CHECKPOINT,
                    stage="extracting",
                    progress=0.1,
                )
                changed.append(record.operation)
            return changed

    def append_event(
        self,
        capture_id: str,
        *,
        event_type: StreamingEventType,
        stage: str,
        kind: CaptureSourceKind | None = None,
        progress: float | None = None,
        partial_revision: int | None = None,
        covered_until_ms: int | None = None,
        segments: list[Any] | None = None,
        error: CaptureFailureV2 | None = None,
    ) -> CaptureEventV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
                raise StreamingTransitionError("capture is terminal")
            sequence = record.operation.last_event_sequence + 1
            event = CaptureEventV2(
                event_id=capture_event_id(capture_id, sequence),
                sequence=sequence,
                capture_id=capture_id,
                kind=kind or record.operation.kind,
                event_type=event_type,
                stage=stage,
                progress=progress,
                partial_revision=partial_revision,
                covered_until_ms=covered_until_ms,
                segments=segments or [],
                error=error,
                created_at=self._clock.now(),
            )
            directory = self._capture_directory(capture_id)
            events_path = directory / "events.jsonl"
            self._ensure_leaf_contained(directory, events_path)
            with events_path.open("a", encoding="utf-8") as events:
                events.write(json.dumps(event.model_dump(mode="json", by_alias=True)) + "\n")
                events.flush()
                os.fsync(events.fileno())
            now = self._clock.now()
            record.operation = record.operation.model_copy(
                update={
                    "last_event_sequence": sequence,
                    "partial_revision": max(
                        record.operation.partial_revision, partial_revision or 0
                    ),
                    "progress": (
                        record.operation.progress
                        if progress is None
                        else max(record.operation.progress or 0, progress)
                    ),
                    "updated_at": now,
                }
            )
            terminal_status = _terminal_status_for_event(event_type)
            if terminal_status is not None:
                record.operation = record.operation.model_copy(
                    update={
                        "status": terminal_status,
                        "completed_at": event.created_at,
                        "error": (
                            error if terminal_status is StreamingCaptureStatus.FAILED else None
                        ),
                    }
                )
            self._persist_capture(record)
            for subscriber in self._subscribers.get(capture_id, set()).copy():
                try:
                    subscriber.put_nowait(event)
                except Full:
                    while True:
                        try:
                            subscriber.get_nowait()
                        except Empty:
                            break
                    try:
                        subscriber.put_nowait(StreamingEventOverflow())
                    except Full:
                        pass
            return event

    def subscribe_events(
        self, capture_id: str, *, after_sequence: int
    ) -> StreamingEventSubscription:
        with self._lock:
            self._get_capture(capture_id)
            if after_sequence < -1:
                raise ValueError("event cursor must not be less than -1")
            subscriber: Queue[CaptureEventV2 | StreamingEventOverflow] = Queue(maxsize=256)
            self._subscribers.setdefault(capture_id, set()).add(subscriber)
            replay = self._read_events_locked(capture_id, after_sequence=after_sequence)
            return StreamingEventSubscription(
                replay=replay,
                _queue=subscriber,
                _close=lambda value: self.unsubscribe_events(capture_id, value),
            )

    def unsubscribe_events(
        self,
        capture_id: str,
        subscriber: Queue[CaptureEventV2 | StreamingEventOverflow],
    ) -> None:
        with self._lock:
            subscribers = self._subscribers.get(capture_id)
            if subscribers is None:
                return
            subscribers.discard(subscriber)
            if not subscribers:
                self._subscribers.pop(capture_id, None)

    def read_events(self, capture_id: str, *, after_sequence: int) -> list[CaptureEventV2]:
        with self._lock:
            return self._read_events_locked(capture_id, after_sequence=after_sequence)

    def _read_events_locked(self, capture_id: str, *, after_sequence: int) -> list[CaptureEventV2]:
        record = self._get_capture(capture_id)
        directory = self._capture_directory(capture_id)
        path = directory / "events.jsonl"
        self._ensure_leaf_contained(directory, path)
        events: deque[CaptureEventV2] = deque(maxlen=_MAX_EVENT_REPLAY)
        replay_count = 0
        previous_sequence: int | None = None
        with path.open("r", encoding="utf-8") as event_log:
            for line in event_log:
                line = line.rstrip("\r\n")
                if not line:
                    continue
                try:
                    event = CaptureEventV2.model_validate_json(line)
                except ValidationError as error:
                    raise RuntimeError("streaming event log is corrupted") from error
                if (
                    event.capture_id != capture_id
                    or event.event_id != f"{capture_id}/{event.sequence}"
                    or (previous_sequence is not None and event.sequence <= previous_sequence)
                ):
                    raise RuntimeError("streaming event log is corrupted")
                previous_sequence = event.sequence
                if event.sequence > after_sequence:
                    replay_count += 1
                    if replay_count > _MAX_EVENT_REPLAY:
                        latest_sequence = record.operation.last_event_sequence
                        return [
                            CaptureEventV2(
                                event_id=capture_event_id(capture_id, latest_sequence),
                                sequence=latest_sequence,
                                capture_id=capture_id,
                                kind=record.operation.kind,
                                event_type=StreamingEventType.RESYNC_REQUIRED,
                                stage="resync",
                                partial_revision=record.operation.partial_revision,
                                created_at=self._clock.now(),
                            )
                        ]
                    events.append(event)
        return list(events)

    def recover_interrupted(self) -> None:
        """Fail active captures left behind by a runtime process restart.

        Worker tasks are intentionally not reconstructed from persisted state:
        replaying a partially processed source could duplicate extraction or
        append an ambiguous event suffix. A persisted terminal failure gives
        hosts a deterministic, idempotent recovery point instead.
        """
        with self._lock:
            interrupted = [
                record.operation.capture_id
                for record in self._captures.values()
                if record.operation.status not in _TERMINAL_CAPTURE_STATUSES
            ]
            for capture_id in interrupted:
                operation = self._get_capture(capture_id).operation
                stage = (
                    "structuring"
                    if operation.status
                    in {
                        StreamingCaptureStatus.AWAITING_STRUCTURING,
                        StreamingCaptureStatus.STRUCTURING,
                    }
                    else "extraction"
                )
                self.fail_capture(
                    capture_id,
                    CaptureFailureV2(
                        code="runtime_restarted",
                        message="Capture Runtime restarted before capture completed.",
                        stage=stage,
                        retryable=True,
                    ),
                )

    def write_partial(self, partial: PartialCaptureV2) -> None:
        with self._lock:
            record = self._get_capture(partial.capture_id)
            if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
                raise StreamingTransitionError("capture is terminal")
            if partial.revision < record.operation.partial_revision:
                raise StreamingTransitionError("partial revision regressed")
            directory = self._capture_directory(partial.capture_id)
            self._ensure_leaf_contained(directory, directory / "partial.json")
            _atomic_json(
                directory / "partial.json",
                partial.model_dump(mode="json", by_alias=True),
            )
            record.operation = record.operation.model_copy(
                update={
                    "partial_revision": partial.revision,
                    "updated_at": partial.updated_at,
                }
            )
            self._persist_capture(record)

    def write_raw(self, capture_id: str, raw: RawCaptureV1) -> None:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
                raise StreamingTransitionError("capture is terminal")
            directory = self._capture_directory(capture_id)
            self._ensure_leaf_contained(directory, directory / "raw.json")
            _atomic_json(
                directory / "raw.json",
                raw.model_dump(mode="json", by_alias=True),
            )

    def read_raw(self, capture_id: str) -> RawCaptureV1:
        with self._lock:
            self._get_capture(capture_id)
            try:
                directory = self._capture_directory(capture_id)
                raw_path = directory / "raw.json"
                self._ensure_leaf_contained(directory, raw_path)
                return RawCaptureV1.model_validate_json(raw_path.read_text(encoding="utf-8"))
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def write_result(self, capture_id: str, result: CaptureDocumentV1) -> None:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
                raise StreamingTransitionError("capture is terminal")
            directory = self._capture_directory(capture_id)
            self._ensure_leaf_contained(directory, directory / "result.json")
            _atomic_json(
                directory / "result.json",
                result.model_dump(mode="json", by_alias=True),
            )

    def read_result(self, capture_id: str) -> CaptureDocumentV1:
        with self._lock:
            self._get_capture(capture_id)
            try:
                directory = self._capture_directory(capture_id)
                result_path = directory / "result.json"
                self._ensure_leaf_contained(directory, result_path)
                return CaptureDocumentV1.model_validate_json(
                    result_path.read_text(encoding="utf-8")
                )
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def mark_awaiting_structuring(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in {
                StreamingCaptureStatus.COMPLETED,
                StreamingCaptureStatus.FAILED,
                StreamingCaptureStatus.CANCELLED,
            }:
                return record.operation
            now = self._clock.now()
            self.append_event(
                capture_id,
                event_type=StreamingEventType.CHECKPOINT,
                stage="awaiting_structuring",
                progress=0.9,
                partial_revision=record.operation.partial_revision,
            )
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.AWAITING_STRUCTURING,
                    "progress": 0.9,
                    "updated_at": now,
                }
            )
            self._persist_capture(record)
            return record.operation

    def mark_structuring(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status is StreamingCaptureStatus.STRUCTURING:
                return record.operation
            if record.operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING:
                raise StreamingTransitionError("capture is not awaiting structuring")
            now = self._clock.now()
            self.append_event(
                capture_id,
                event_type=StreamingEventType.CHECKPOINT,
                stage="structuring",
                progress=0.95,
            )
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.STRUCTURING,
                    "progress": 0.95,
                    "updated_at": now,
                }
            )
            self._persist_capture(record)
            return record.operation

    def complete_capture(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status is StreamingCaptureStatus.COMPLETED:
                return record.operation
            if record.operation.status is StreamingCaptureStatus.CANCELLED:
                return record.operation
            now = self._clock.now()
            self.append_event(
                capture_id,
                event_type=StreamingEventType.COMPLETED,
                stage="completed",
                progress=1.0,
            )
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.COMPLETED,
                    "progress": 1.0,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
            self._persist_capture(record)
            return record.operation

    def commit_host_result(
        self,
        capture_id: str,
        *,
        idempotency_key: str,
        fingerprint: str,
        result: CaptureDocumentV1,
    ) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status is StreamingCaptureStatus.COMPLETED:
                if (
                    record.structure_idempotency_key == idempotency_key
                    and record.structure_fingerprint == fingerprint
                ):
                    return record.operation
                raise StreamingIdempotencyConflictError(idempotency_key)
            if (
                record.request.structuring_mode is not StructuringMode.HOST
                or record.operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING
            ):
                raise StreamingTransitionError("capture is not awaiting host structuring")
            _atomic_json(
                self._capture_directory(capture_id) / "result.json",
                result.model_dump(mode="json", by_alias=True),
            )
            record.structure_idempotency_key = idempotency_key
            record.structure_fingerprint = fingerprint
            now = result.completed_at
            self.append_event(
                capture_id,
                event_type=StreamingEventType.COMPLETED,
                stage="completed",
                progress=1.0,
            )
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.COMPLETED,
                    "progress": 1.0,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
            self._persist_capture(record)
            return record.operation

    def fail_host_structure(
        self,
        capture_id: str,
        *,
        idempotency_key: str,
        fingerprint: str,
        failure: CaptureFailureV2,
    ) -> CaptureOperationV2:
        with self._lock:
            safe_failure = _sanitize_host_failure(failure)
            record = self._get_capture(capture_id)
            if record.operation.status is StreamingCaptureStatus.FAILED:
                if (
                    record.failure_idempotency_key == idempotency_key
                    and record.failure_fingerprint == fingerprint
                ):
                    return record.operation
                raise StreamingIdempotencyConflictError(idempotency_key)
            if (
                record.request.structuring_mode is not StructuringMode.HOST
                or record.operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING
            ):
                raise StreamingTransitionError("capture is not awaiting host structuring")
            record.failure_idempotency_key = idempotency_key
            record.failure_fingerprint = fingerprint
            self._persist_capture(record)
            return self.fail_capture(capture_id, safe_failure)

    def fail_capture(self, capture_id: str, failure: CaptureFailureV2) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in {
                StreamingCaptureStatus.COMPLETED,
                StreamingCaptureStatus.FAILED,
                StreamingCaptureStatus.CANCELLED,
            }:
                return record.operation
            now = self._clock.now()
            self.append_event(
                capture_id,
                event_type=StreamingEventType.FAILED,
                stage=failure.stage or "failed",
                progress=record.operation.progress,
                error=failure,
            )
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.FAILED,
                    "progress": record.operation.progress,
                    "error": failure,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
            self._persist_capture(record)
            return record.operation

    def read_partial(self, capture_id: str) -> PartialCaptureV2:
        with self._lock:
            self._get_capture(capture_id)
            try:
                directory = self._capture_directory(capture_id)
                partial_path = directory / "partial.json"
                self._ensure_leaf_contained(directory, partial_path)
                return PartialCaptureV2.model_validate_json(
                    partial_path.read_text(encoding="utf-8")
                )
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def cancel_capture(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            terminal = {
                StreamingCaptureStatus.COMPLETED,
                StreamingCaptureStatus.FAILED,
                StreamingCaptureStatus.CANCELLED,
            }
            if record.operation.status in terminal:
                return record.operation
            now = self._clock.now()
            self.append_event(
                capture_id,
                event_type=StreamingEventType.CANCELLED,
                stage="cancelled",
                progress=record.operation.progress,
            )
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.CANCELLED,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
            self._persist_capture(record)
            return record.operation

    def delete_capture(self, capture_id: str) -> None:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status not in _TERMINAL_CAPTURE_STATUSES:
                raise StreamingTransitionError("capture is active")
            directory = self._capture_directory(capture_id)
            _ensure_contained(self.root / "captures", directory)
            # Keep the capture record and directory as the durable recovery
            # anchor until a private ingestion has been removed successfully.
            # A failed ingestion delete must leave the capture retryable.
            self._delete_unreferenced_ingestion(
                record.operation.ingestion_id,
                excluding_capture_id=capture_id,
            )
            self._ensure_no_symlink_leaves(directory)
            _remove_directory(directory)
            self._captures.pop(capture_id, None)
            self._capture_idempotency.pop(record.request.client_request_id, None)
            self._subscribers.pop(capture_id, None)

    def prune_expired(self) -> None:
        with self._lock:
            now = self._clock.now()
            cutoff = now - self._retention
            terminal = {
                StreamingCaptureStatus.COMPLETED,
                StreamingCaptureStatus.FAILED,
                StreamingCaptureStatus.CANCELLED,
            }
            expired_captures = [
                capture_id
                for capture_id, record in self._captures.items()
                if record.operation.status in terminal and record.operation.updated_at < cutoff
            ]
            for capture_id in expired_captures:
                self.delete_capture(capture_id)

            active_ingestions = {
                record.operation.ingestion_id
                for record in self._captures.values()
                if record.operation.status not in terminal
            }
            expired_ingestions = [
                ingestion_id
                for ingestion_id, record in self._ingestions.items()
                if record.expires_at <= now and ingestion_id not in active_ingestions
            ]
            for ingestion_id in expired_ingestions:
                self.delete_ingestion(ingestion_id)

    def delete_ingestion(self, ingestion_id: str) -> None:
        with self._lock:
            normalized = _identifier(ingestion_id)
            record = self._get_ingestion(normalized)
            if any(
                operation.ingestion_id == normalized
                and operation.status not in _TERMINAL_CAPTURE_STATUSES
                for operation in (capture.operation for capture in self._captures.values())
            ):
                raise StreamingTransitionError("ingestion has an active capture")
            directory = self._ingestion_directory(normalized)
            _ensure_contained(self.root / "ingestions", directory)
            self._ensure_no_symlink_leaves(directory)
            _remove_directory(directory)
            self._ingestions.pop(normalized, None)
            self._ingestion_idempotency.pop(record.request.client_request_id, None)

    def _delete_unreferenced_ingestion(
        self,
        ingestion_id: str,
        *,
        excluding_capture_id: str | None = None,
    ) -> None:
        excluded = _identifier(excluding_capture_id) if excluding_capture_id else None
        if any(
            operation.ingestion_id == ingestion_id and operation.capture_id != excluded
            for operation in (capture.operation for capture in self._captures.values())
        ):
            return
        try:
            record = self._get_ingestion(ingestion_id)
        except StreamingRecordNotFoundError:
            return
        directory = self._ingestion_directory(ingestion_id)
        _ensure_contained(self.root / "ingestions", directory)
        self._ensure_no_symlink_leaves(directory)
        _remove_directory(directory)
        self._ingestions.pop(record.ingestion_id, None)
        self._ingestion_idempotency.pop(record.request.client_request_id, None)

    def source_path(self, ingestion_id: str) -> Path:
        with self._lock:
            self._get_ingestion(ingestion_id)
            return self._ingestion_source_path(ingestion_id)

    def _ingestion_source_path(self, ingestion_id: str) -> Path:
        directory = self._ingestion_directory(ingestion_id)
        _ensure_contained(self.root / "ingestions", directory)
        source_path = directory / "source.bin"
        self._ensure_leaf_contained(directory, source_path)
        return source_path

    def _ensure_leaf_contained(self, directory: Path, leaf: Path) -> None:
        _ensure_contained(directory, leaf)
        if leaf.is_symlink():
            raise RuntimeError(f"{leaf} must not be a symlink")

    def _ensure_no_symlink_leaves(self, directory: Path) -> None:
        for name in (
            "events.jsonl",
            "metadata.json",
            "raw.json",
            "result.json",
            "partial.json",
            "source.bin",
        ):
            candidate = directory / name
            if candidate.is_symlink():
                raise RuntimeError(f"{candidate} must not be a symlink")

    def _get_ingestion(self, ingestion_id: str) -> _IngestionRecord:
        normalized = _identifier(ingestion_id)
        try:
            return self._ingestions[normalized]
        except KeyError as error:
            raise StreamingRecordNotFoundError(ingestion_id) from error

    def _get_capture(self, capture_id: str) -> _CaptureRecord:
        normalized = _identifier(capture_id)
        try:
            return self._captures[normalized]
        except KeyError as error:
            raise StreamingRecordNotFoundError(capture_id) from error

    def _source_for(self, record: _IngestionRecord) -> CaptureSourceV1:
        if record.status is not StreamingIngestionStatus.READY or record.finalized_sha256 is None:
            raise StreamingTransitionError("source is not finalized")
        return CaptureSourceV1(
            sha256=record.finalized_sha256,
            file_name=record.request.file_name,
            media_type=record.request.media_type,
            bytes=record.request.total_bytes,
        )

    def _ingestion_directory(self, ingestion_id: str) -> Path:
        category_root = self.root / "ingestions"
        if self.root.is_symlink():
            raise RuntimeError("configured persistence root must not be a symlink")
        if category_root.is_symlink():
            raise RuntimeError("ingestions root must not be a symlink")
        _ensure_contained(self.root, category_root)
        directory = category_root / _identifier(ingestion_id)
        _ensure_contained(category_root, directory)
        return directory

    def _capture_directory(self, capture_id: str) -> Path:
        category_root = self.root / "captures"
        if self.root.is_symlink():
            raise RuntimeError("configured persistence root must not be a symlink")
        if category_root.is_symlink():
            raise RuntimeError("captures root must not be a symlink")
        _ensure_contained(self.root, category_root)
        directory = category_root / _identifier(capture_id)
        _ensure_contained(category_root, directory)
        return directory

    @staticmethod
    def _ingestion_snapshot(record: _IngestionRecord) -> IngestionV2:
        return IngestionV2(
            ingestion_id=record.ingestion_id,
            kind=record.request.kind,
            status=record.status,
            file_name=record.request.file_name,
            media_type=record.request.media_type,
            total_bytes=record.request.total_bytes,
            received_bytes=record.next_offset,
            contiguous_bytes=record.next_offset,
            next_chunk_index=record.next_chunk_index,
            next_offset=record.next_offset,
            source_sha256=record.request.source_sha256,
            finalized_sha256=record.finalized_sha256,
            expires_at=record.expires_at,
        )

    def _persist_ingestion(self, record: _IngestionRecord) -> None:
        directory = self._ingestion_directory(record.ingestion_id)
        _ensure_contained(self.root / "ingestions", directory)
        self._ensure_leaf_contained(directory, directory / "metadata.json")
        _atomic_json(
            directory / "metadata.json",
            {
                "request": record.request.model_dump(mode="json", by_alias=True),
                "ingestionId": record.ingestion_id,
                "status": record.status.value,
                "expiresAt": record.expires_at.isoformat(),
                "nextChunkIndex": record.next_chunk_index,
                "nextOffset": record.next_offset,
                "acceptedChunks": {
                    str(index): list(value) for index, value in record.accepted_chunks.items()
                },
                "finalizedSha256": record.finalized_sha256,
            },
        )

    def _persist_capture(self, record: _CaptureRecord) -> None:
        directory = self._capture_directory(record.operation.capture_id)
        _ensure_contained(self.root / "captures", directory)
        self._ensure_leaf_contained(directory, directory / "metadata.json")
        _atomic_json(
            directory / "metadata.json",
            {
                "request": record.request.model_dump(mode="json", by_alias=True),
                "operation": record.operation.model_dump(mode="json", by_alias=True),
                "structureIdempotencyKey": record.structure_idempotency_key,
                "structureFingerprint": record.structure_fingerprint,
                "failureIdempotencyKey": record.failure_idempotency_key,
                "failureFingerprint": record.failure_fingerprint,
            },
        )

    def _reconcile_loaded_ingestion(
        self,
        record: _IngestionRecord,
        directory: Path,
    ) -> None:
        """Repair source bytes to the last metadata-confirmed chunk boundary."""
        source_path = directory / "source.bin"
        _ensure_contained(self.root / "ingestions", directory)
        self._ensure_leaf_contained(directory, source_path)
        if source_path.exists():
            source = source_path.read_bytes()
        else:
            source = b""
            _atomic_bytes(source_path, source)

        accepted: dict[int, tuple[int, int, str]] = {}
        next_offset = 0
        for index in range(max(record.next_chunk_index, 0)):
            candidate = record.accepted_chunks.get(index)
            if candidate is None:
                break
            offset, length, digest = candidate
            if (
                offset != next_offset
                or length <= 0
                or offset + length > len(source)
                or hashlib.sha256(source[offset : offset + length]).hexdigest() != digest
            ):
                break
            accepted[index] = candidate
            next_offset += length

        if len(source) > next_offset:
            self._truncate_recovered_source(source_path, source, next_offset)

        changed = (
            record.accepted_chunks != accepted
            or record.next_chunk_index != len(accepted)
            or record.next_offset != next_offset
        )
        record.accepted_chunks = accepted
        record.next_chunk_index = len(accepted)
        record.next_offset = next_offset

        source_after_repair = source[:next_offset]
        source_is_ready = (
            next_offset == record.request.total_bytes
            and len(source_after_repair) == record.request.total_bytes
            and record.finalized_sha256 is not None
            and hashlib.sha256(source_after_repair).hexdigest() == record.finalized_sha256
        )
        if record.status is StreamingIngestionStatus.READY and not source_is_ready:
            record.status = StreamingIngestionStatus.OPEN
            record.finalized_sha256 = None
            changed = True
        elif record.status is StreamingIngestionStatus.OPEN and record.finalized_sha256 is not None:
            record.finalized_sha256 = None
            changed = True
        if changed:
            self._persist_ingestion(record)

    @staticmethod
    def _truncate_recovered_source(
        source_path: Path,
        source: bytes,
        next_offset: int,
    ) -> None:
        suffix = source[next_offset:]
        if suffix:
            digest = hashlib.sha256(suffix).hexdigest()[:16]
            evidence = source_path.with_name(f"{source_path.name}.recovered.{digest}")
            if not evidence.exists():
                _atomic_bytes(evidence, suffix)
        with source_path.open("r+b") as output:
            output.truncate(next_offset)
            output.flush()
            os.fsync(output.fileno())

    def _load_ingestions(self) -> None:
        for directory in sorted((self.root / "ingestions").iterdir()):
            if not directory.is_dir():
                continue
            try:
                _ensure_contained(self.root / "ingestions", directory)
                metadata_path = directory / "metadata.json"
                self._ensure_leaf_contained(directory, metadata_path)
                payload = json.loads(metadata_path.read_text(encoding="utf-8"))
                request = OpenIngestionV2.model_validate(payload["request"])
                normalized_id = _identifier(str(payload["ingestionId"]))
                if directory.name != normalized_id:
                    raise ValueError("ingestion metadata id does not match directory")
                record = _IngestionRecord(
                    request=request,
                    ingestion_id=normalized_id,
                    status=StreamingIngestionStatus(payload["status"]),
                    expires_at=datetime_from_text(str(payload["expiresAt"])),
                    next_chunk_index=int(payload["nextChunkIndex"]),
                    next_offset=int(payload["nextOffset"]),
                    accepted_chunks={
                        int(index): (int(values[0]), int(values[1]), str(values[2]))
                        for index, values in payload.get("acceptedChunks", {}).items()
                    },
                    finalized_sha256=payload.get("finalizedSha256"),
                )
                self._reconcile_loaded_ingestion(record, directory)
            except (
                OSError,
                RuntimeError,
                StreamingRecordNotFoundError,
                KeyError,
                IndexError,
                TypeError,
                ValueError,
                ValidationError,
                json.JSONDecodeError,
            ):
                self._quarantine_directory(directory, "ingestions")
                continue
            self._ingestions[record.ingestion_id] = record
            self._ingestion_idempotency[record.request.client_request_id] = record.ingestion_id

    def _load_captures(self) -> None:
        for directory in sorted((self.root / "captures").iterdir()):
            if not directory.is_dir():
                continue
            try:
                _ensure_contained(self.root / "captures", directory)
                metadata_path = directory / "metadata.json"
                self._ensure_leaf_contained(directory, metadata_path)
                payload = json.loads(metadata_path.read_text(encoding="utf-8"))
                request = StartCaptureV2.model_validate(payload["request"])
                operation = CaptureOperationV2.model_validate(payload["operation"])
                if directory.name != _identifier(operation.capture_id):
                    raise ValueError("capture metadata id does not match directory")
                record = _CaptureRecord(
                    operation=operation,
                    request=request,
                    structure_idempotency_key=payload.get("structureIdempotencyKey"),
                    structure_fingerprint=payload.get("structureFingerprint"),
                    failure_idempotency_key=payload.get("failureIdempotencyKey"),
                    failure_fingerprint=payload.get("failureFingerprint"),
                )
            except (
                OSError,
                RuntimeError,
                StreamingRecordNotFoundError,
                KeyError,
                TypeError,
                ValueError,
                ValidationError,
                json.JSONDecodeError,
            ):
                self._quarantine_directory(directory, "captures")
                continue
            self._captures[operation.capture_id] = record
            self._capture_idempotency[request.client_request_id] = operation.capture_id
            try:
                self._reconcile_loaded_capture(record)
            except (OSError, RuntimeError, UnicodeError, ValidationError):
                self._captures.pop(operation.capture_id, None)
                self._capture_idempotency.pop(request.client_request_id, None)
                self._quarantine_directory(directory, "captures")

    def _quarantine_directory(self, directory: Path, category: str) -> None:
        quarantine_root = self.root / "quarantine" / category
        try:
            _ensure_contained(self.root, quarantine_root)
            quarantine_root.mkdir(parents=True, exist_ok=True)
            destination = quarantine_root / directory.name
            suffix = 1
            while destination.exists():
                destination = quarantine_root / f"{directory.name}.{suffix}"
                suffix += 1
            os.replace(directory, destination)
        except OSError:
            # Startup must remain available even if the platform cannot move a
            # damaged record. The original directory remains as evidence and
            # will be reconsidered deterministically on the next initialize.
            return

    def _reconcile_loaded_capture(self, record: _CaptureRecord) -> None:
        """Make the event log and operation metadata agree after a crash.

        Events are the append-only source of truth for sequence and terminal
        state.  A transition writes its event before terminal metadata, while
        this repair handles records written by older versions or a crash in
        the opposite order.  The repair is idempotent: a second initialize
        observes the repaired terminal event and does not append another one.
        """
        latest = self._latest_persisted_event(record.operation.capture_id)
        operation = record.operation
        if latest is None:
            if operation.status in _TERMINAL_CAPTURE_STATUSES:
                self._repair_terminal_without_event(record)
                return
            if operation.last_event_sequence != 0:
                record.operation = operation.model_copy(update={"last_event_sequence": 0})
                self._persist_capture(record)
            return

        terminal_status = _terminal_status_for_event(latest.event_type)
        if terminal_status is None and operation.status in _TERMINAL_CAPTURE_STATUSES:
            self._repair_terminal_without_event(record)
            return

        updates: dict[str, object] = {}
        if operation.last_event_sequence != latest.sequence:
            updates["last_event_sequence"] = latest.sequence
        if (
            latest.partial_revision is not None
            and latest.partial_revision > operation.partial_revision
        ):
            updates["partial_revision"] = latest.partial_revision
        if latest.progress is not None and (
            operation.progress is None or latest.progress > operation.progress
        ):
            updates["progress"] = latest.progress
        if latest.created_at > operation.updated_at:
            updates["updated_at"] = latest.created_at
        if terminal_status is not None:
            updates.update(
                {
                    "status": terminal_status,
                    "completed_at": latest.created_at,
                    "error": (
                        latest.error if terminal_status is StreamingCaptureStatus.FAILED else None
                    ),
                }
            )
        if updates:
            record.operation = operation.model_copy(update=updates)
            self._persist_capture(record)

    def _repair_terminal_without_event(self, record: _CaptureRecord) -> None:
        """Turn metadata-only terminal state into an explicit failed event."""
        now = self._clock.now()
        failure = CaptureFailureV2(
            code="runtime_state_recovered",
            message="Capture Runtime recovered terminal metadata without its terminal event.",
            stage="extraction",
            retryable=True,
        )
        record.operation = record.operation.model_copy(
            update={
                "status": StreamingCaptureStatus.EXTRACTING,
                "error": None,
                "completed_at": None,
                "updated_at": now,
            }
        )
        self.append_event(
            record.operation.capture_id,
            event_type=StreamingEventType.FAILED,
            stage="extraction",
            progress=record.operation.progress,
            error=failure,
        )
        record.operation = record.operation.model_copy(
            update={
                "status": StreamingCaptureStatus.FAILED,
                "error": failure,
                "updated_at": now,
                "completed_at": now,
            }
        )
        self._persist_capture(record)

    def _latest_persisted_event(self, capture_id: str) -> CaptureEventV2 | None:
        directory = self._capture_directory(capture_id)
        path = directory / "events.jsonl"
        self._ensure_leaf_contained(directory, path)
        if not path.exists():
            _atomic_bytes(path, b"")
            return None
        latest: CaptureEventV2 | None = None
        valid_lines: list[bytes] = []
        corrupted_suffix: bytes | None = None
        with path.open("rb") as event_log:
            lines = event_log.readlines()
        for index, raw_line in enumerate(lines):
            line = raw_line.rstrip(b"\r\n")
            if not line:
                valid_lines.append(raw_line)
                continue
            try:
                text_line = line.decode("utf-8")
                event = CaptureEventV2.model_validate_json(text_line)
            except (UnicodeDecodeError, ValidationError, ValueError):
                corrupted_suffix = b"".join(lines[index:])
                break
            if (
                event.capture_id != capture_id
                or event.event_id != f"{capture_id}/{event.sequence}"
                or (latest is not None and event.sequence <= latest.sequence)
            ):
                corrupted_suffix = b"".join(lines[index:])
                break
            valid_lines.append(raw_line)
            latest = event
        if corrupted_suffix is not None:
            digest = hashlib.sha256(corrupted_suffix).hexdigest()[:16]
            evidence = path.with_name(f"{path.name}.corrupt.{digest}")
            if not evidence.exists():
                _atomic_bytes(evidence, corrupted_suffix)
            _atomic_bytes(path, b"".join(valid_lines))
        return latest


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def datetime_from_text(value: str) -> datetime:
    return datetime.fromisoformat(value)


__all__ = [
    "StreamingIdempotencyConflictError",
    "StreamingPartialNotFoundError",
    "StreamingRecordNotFoundError",
    "StreamingRepository",
    "StreamingTransitionError",
]
