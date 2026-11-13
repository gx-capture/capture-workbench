"""File-backed storage for the v2 streaming ingestion and event seams."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from pydantic import ValidationError

from capture_runtime.capture.domain.ingestion.models import IngestionChunk, IngestionTransitionError
from capture_runtime.capture.domain.operation.models import CaptureTransitionError
from capture_runtime.capture.domain.size_policy import SourceSizePolicy
from capture_runtime.capture.infrastructure._streaming_persistence import (
    _atomic_json,
    _file_sha256,
    _StreamingRepositoryPersistence,
    datetime_from_text,
)
from capture_runtime.capture.infrastructure._streaming_records import (
    _CaptureRecord,
    _IngestionRecord,
)
from capture_runtime.capture.infrastructure._streaming_transitions import (
    _TERMINAL_CAPTURE_STATUSES,
    _cancel_capture,
    _complete_capture,
    _create_capture_operation,
    _fail_capture,
    _mark_awaiting_structuring,
    _mark_ingestion_ready,
    _mark_structuring,
    operation_domain,
)
from capture_runtime.capture.infrastructure.source_sniffing import (
    SNIFF_BYTES,
    recording_prefix_verdict,
)
from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEventV2,
    CaptureFailureV2,
    CaptureOcrProjectionV3,
    CaptureOperationV2,
    CaptureSource,
    CaptureSourceKind,
    IngestionV2,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCapture,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StreamingIngestionStatus,
)


class StreamingRecordNotFoundError(KeyError):
    pass


class StreamingIdempotencyConflictError(ValueError):
    pass


StreamingTransitionError = CaptureTransitionError


class StreamingPartialNotFoundError(StreamingRecordNotFoundError):
    pass


_SAFE_ID = re.compile(r"^[0-9a-f-]{36}$")
_MAX_EVENT_REPLAY = 1_024
_LOGGER = logging.getLogger(__name__)


def _identifier(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise StreamingRecordNotFoundError(value) from error
    normalized = str(parsed)
    if normalized != value.lower() or _SAFE_ID.fullmatch(normalized) is None:
        raise StreamingRecordNotFoundError(value)
    return normalized


def _progress_update(operation: CaptureOperationV2, event: CaptureEventV2) -> dict[str, int]:
    """The page and media progress an event moves the operation to.

    Counts only move forward, so a late or repeated checkpoint never shows a
    host fewer pages or less covered time than it already saw.
    """
    update: dict[str, int] = {}
    if event.pages_total is not None and event.pages_done is not None:
        done = event.pages_done
        if operation.pages_total == event.pages_total and operation.pages_done is not None:
            done = max(done, operation.pages_done)
        update["pages_total"] = event.pages_total
        update["pages_done"] = done
    if event.duration_ms is not None:
        update["duration_ms"] = event.duration_ms
    if event.covered_until_ms is not None and operation.kind is CaptureSourceKind.AUDIO:
        update["covered_until_ms"] = max(operation.covered_until_ms or 0, event.covered_until_ms)
    return update


class StreamingRepository:
    """A bounded, recoverable repository behind the streaming service seam."""

    def __init__(
        self,
        root: Path,
        *,
        clock: Clock,
        retention_hours: int,
        policy: SourceSizePolicy,
    ) -> None:
        self.root = root
        self._clock = clock
        self._retention = timedelta(hours=retention_hours)
        self._policy = policy
        self._ingestions: dict[str, _IngestionRecord] = {}
        self._ingestion_idempotency: dict[str, str] = {}
        self._captures: dict[str, _CaptureRecord] = {}
        self._running_captures: set[str] = set()
        # Ingestions whose startup recovery hit an I/O failure. They stay protected
        # from pruning for the life of this process; the next start retries them.
        self._recovery_deferred: set[str] = set()
        self._capture_idempotency: dict[str, str] = {}
        self._persistence = _StreamingRepositoryPersistence(root)
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            self._persistence.initialize()
            self._ingestions.clear()
            self._ingestion_idempotency.clear()
            self._captures.clear()
            self._running_captures.clear()
            self._capture_idempotency.clear()
            self._recovery_deferred.clear()
            invalid_directories = self._load_ingestions()
            all_captures_loaded = self._load_captures()
            # A crash in create_ingestion leaves a directory without metadata;
            # nothing can reach it, so it only holds disk space. When a capture
            # could not be loaded, its reference is unknown: keep them all.
            referenced = {record.operation.ingestion_id for record in self._captures.values()}
            for directory in invalid_directories if all_captures_loaded else []:
                try:
                    directory_id = _identifier(directory.name)
                except StreamingRecordNotFoundError:
                    directory_id = directory.name
                if directory_id not in referenced:
                    self._persistence.delete_ingestion_directory(directory)
            protected: set[str] = set()
            for record in self._ingestions.values():
                try:
                    if record.status is StreamingIngestionStatus.OPEN:
                        self._reconcile_open_source(record)
                    if record.status is StreamingIngestionStatus.FAILED:
                        for capture in self._captures.values():
                            if (
                                capture.operation.ingestion_id == record.ingestion_id
                                and capture.operation.status is StreamingCaptureStatus.WAITING_INPUT
                            ):
                                self._fail_capture_locked(
                                    capture,
                                    CaptureFailureV2(
                                        code="streaming_source_unavailable",
                                        message=(
                                            "Streaming source content is unavailable after restart."
                                        ),
                                        stage="input",
                                    ),
                                )
                except OSError:
                    # Do not include exception text: it may contain a user path.
                    _LOGGER.warning("Startup ingestion recovery deferred after an I/O failure")
                    protected.add(record.ingestion_id)
            self._recovery_deferred = protected
            self.prune_expired()

    def _reconcile_open_source(self, record: _IngestionRecord) -> None:
        """Reconcile accepted bytes; defer inaccessible files until another start."""
        # Resolution is inside the caller's OSError boundary too.
        source_path = self._ingestion_directory(record.ingestion_id) / "source.bin"
        try:
            size = source_path.stat().st_size
        except FileNotFoundError:
            size = -1
        if size >= record.next_offset:
            # Even an exact-length source must be readable for finalization and
            # extraction. A locked/unreadable source is left untouched rather
            # than expiring potentially valid bytes on a temporary I/O failure.
            with source_path.open("r+b" if size > record.next_offset else "rb") as source:
                source.read(1)
                if size > record.next_offset:
                    source.truncate(record.next_offset)
                    source.flush()
                    os.fsync(source.fileno())
            return
        previous_status, previous_expiry = record.status, record.expires_at
        record.status = StreamingIngestionStatus.FAILED
        record.expires_at = self._clock.now()
        try:
            self._persist_ingestion(record)
        except OSError:
            record.status, record.expires_at = previous_status, previous_expiry
            raise

    def create_ingestion(self, request: OpenIngestionV2) -> IngestionV2:
        with self._lock:
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
            self._persistence.create_ingestion_directory(ingestion_id)
            self._ingestions[ingestion_id] = record
            self._ingestion_idempotency[request.client_request_id] = ingestion_id
            self._persist_ingestion(record)
            return self._ingestion_snapshot(record)

    def get_ingestion(self, ingestion_id: str) -> IngestionV2:
        with self._lock:
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
            try:
                chunk = IngestionChunk(chunk_index, byte_offset, len(data), sha256)
                current = record.domain()
                accepted = record.accepted_chunks.get(chunk_index)
                updated = current.append(
                    chunk,
                    actual_sha256=hashlib.sha256(data).hexdigest(),
                    declared_total_bytes=declared_total_bytes,
                    max_chunk_bytes=max_chunk_bytes,
                    accepted_chunk=IngestionChunk(chunk_index, *accepted) if accepted else None,
                )
            except ValueError as error:
                raise StreamingTransitionError(str(error)) from error
            if updated is current:
                return self._ingestion_snapshot(record)
            self._require_recording_signature(record, ingestion_id, byte_offset, data)
            self._persistence.write_source(
                self._ingestion_directory(ingestion_id) / "source.bin", record.next_offset, data
            )
            record.accepted_chunks[chunk_index] = (byte_offset, len(data), sha256)
            record.next_chunk_index = updated.next_chunk_index
            record.next_offset = updated.received_bytes
            self._persist_ingestion(record)
            return self._ingestion_snapshot(record)

    def _require_recording_signature(
        self, record: _IngestionRecord, ingestion_id: str, byte_offset: int, data: bytes
    ) -> None:
        """A source over the document limit must start like a recording.

        Checked on each new chunk that still lies inside the signature window,
        before it is stored: bytes already accepted are never changed.
        """
        if byte_offset >= SNIFF_BYTES or not self._policy.needs_recording_signature(
            record.request.kind, record.request.total_bytes
        ):
            return
        stored = b""
        if byte_offset:
            source_path = self._ingestion_directory(ingestion_id) / "source.bin"
            with source_path.open("rb") as source:
                stored = source.read(byte_offset)
        if recording_prefix_verdict((stored + data)[:SNIFF_BYTES]) is False:
            raise StreamingTransitionError("source content is not a recording")

    def finalize_ingestion(
        self,
        ingestion_id: str,
        *,
        total_bytes: int,
        sha256: str,
    ) -> IngestionV2:
        with self._lock:
            record = self._get_ingestion(ingestion_id)
            current = record.domain()
            # Replay is a metadata decision; do not reread a previously finalized source.
            actual_sha256 = (
                record.finalized_sha256
                if record.status is StreamingIngestionStatus.READY
                else _file_sha256(self._ingestion_directory(ingestion_id) / "source.bin")
            )
            try:
                updated = current.finalize(
                    total_bytes=total_bytes, sha256=sha256, actual_sha256=actual_sha256 or ""
                )
            except IngestionTransitionError as error:
                raise StreamingTransitionError(str(error)) from error
            if updated is current:
                return self._ingestion_snapshot(record)
            record.status = updated.status
            record.finalized_sha256 = updated.finalized_sha256
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
            operation = _create_capture_operation(
                capture_id,
                request,
                ingestion,
                source=source,
                now=now,
            )
            record = _CaptureRecord(operation=operation, request=request)
            self._persistence.create_capture_directory(capture_id)
            self._captures[capture_id] = record
            self._capture_idempotency[request.client_request_id] = capture_id
            self._persist_capture(record)
            self.append_event(capture_id, event_type=StreamingEventType.ACCEPTED, stage="queued")
            return self._captures[capture_id].operation

    def get_capture(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            return self._get_capture(capture_id).operation

    def capture_request(self, capture_id: str) -> StartCaptureV2:
        with self._lock:
            return self._get_capture(capture_id).request

    def has_active_capture(self) -> bool:
        """Whether any capture has not reached a terminal status."""

        with self._lock:
            return any(
                record.operation.status not in _TERMINAL_CAPTURE_STATUSES
                for record in self._captures.values()
            )

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
                record.operation = _mark_ingestion_ready(
                    record.operation,
                    ingestion,
                    source=self._source_for(ingestion),
                    now=now,
                )
                self._persist_capture(record)
                self.append_event(
                    record.operation.capture_id,
                    event_type=StreamingEventType.INPUT_CHECKPOINT,
                    stage="extracting",
                )
                changed.append(record.operation)
            return changed

    def append_event(
        self,
        capture_id: str,
        *,
        event_type: StreamingEventType,
        stage: str,
        partial_revision: int | None = None,
        covered_until_ms: int | None = None,
        segments: list[Any] | None = None,
        error: CaptureFailureV2 | None = None,
        progress: float | None = None,
        pages: tuple[int, int] | None = None,
        duration_ms: int | None = None,
        _terminal_transition: bool = False,
        _created_at: datetime | None = None,
    ) -> CaptureEventV2:
        """Append an event and fold its progress into the operation.

        `pages` is (pagesDone, pagesTotal) for a document; `duration_ms` and
        `covered_until_ms` describe an audio source. The event validates them
        against the capture kind before anything is written.
        """
        with self._lock:
            record = self._get_capture(capture_id)
            domain = operation_domain(record.operation).record_event(
                event_type,
                progress=progress,
                partial_revision=partial_revision,
                terminal_transition=_terminal_transition,
            )
            sequence = domain.last_event_sequence
            event = CaptureEventV2(
                event_id=f"{capture_id}/{sequence}",
                sequence=sequence,
                capture_id=capture_id,
                kind=record.operation.kind,
                event_type=event_type,
                stage=stage,
                progress=(record.operation.progress if progress is None else progress),
                partial_revision=partial_revision,
                covered_until_ms=covered_until_ms,
                segments=segments or [],
                error=error,
                created_at=_created_at or self._clock.now(),
                pages_done=None if pages is None else pages[0],
                pages_total=None if pages is None else pages[1],
                duration_ms=duration_ms,
            )
            operation = record.operation
            # Validate before the event is written, so the persisted operation
            # never holds a combination a reload would reject.
            updated = CaptureOperationV2.model_validate(
                {
                    **operation.model_dump(),
                    "last_event_sequence": sequence,
                    "partial_revision": domain.partial_revision,
                    "progress": domain.progress,
                    **_progress_update(operation, event),
                    "updated_at": self._clock.now(),
                }
            )
            self._persistence.append_event(
                self._capture_directory(capture_id) / "events.jsonl", event
            )
            record.operation = updated
            self._persist_capture(record)
            return event

    def read_events(self, capture_id: str, *, after_sequence: int) -> list[CaptureEventV2]:
        with self._lock:
            record = self._get_capture(capture_id)
            if after_sequence < -1:
                raise ValueError("event cursor must not be less than -1")
            path = self._capture_directory(capture_id) / "events.jsonl"
            events: list[CaptureEventV2] = []
            for line in self._persistence.read_event_lines(path):
                if not line:
                    continue
                try:
                    payload = json.loads(line)
                    event = CaptureEventV2.model_validate(payload)
                    if "kind" not in payload:
                        event = event.model_copy(update={"kind": record.operation.kind})
                except ValidationError as error:
                    raise RuntimeError("streaming event log is corrupted") from error
                if event.sequence > after_sequence:
                    events.append(event)
            if len(events) <= _MAX_EVENT_REPLAY:
                return events
            latest_sequence = record.operation.last_event_sequence
            return [
                CaptureEventV2(
                    event_id=f"{capture_id}/resync/{latest_sequence}",
                    sequence=latest_sequence,
                    capture_id=capture_id,
                    event_type=StreamingEventType.RESYNC_REQUIRED,
                    stage="resync",
                    kind=record.operation.kind,
                    progress=record.operation.progress,
                    partial_revision=record.operation.partial_revision,
                    covered_until_ms=record.operation.covered_until_ms,
                    pages_done=record.operation.pages_done,
                    pages_total=record.operation.pages_total,
                    duration_ms=record.operation.duration_ms,
                    created_at=self._clock.now(),
                )
            ]

    def write_partial(self, partial: PartialCaptureV2) -> None:
        with self._lock:
            record = self._get_capture(partial.capture_id)
            if partial.revision < record.operation.partial_revision:
                raise StreamingTransitionError("partial revision regressed")
            _atomic_json(
                self._capture_directory(partial.capture_id) / "partial.json",
                partial.model_dump(mode="json", by_alias=True),
            )
            record.operation = record.operation.model_copy(
                update={
                    "partial_revision": partial.revision,
                    "updated_at": partial.updated_at,
                }
            )
            self._persist_capture(record)

    def write_raw(self, capture_id: str, raw: RawCapture) -> None:
        with self._lock:
            self._get_capture(capture_id)
            _atomic_json(
                self._capture_directory(capture_id) / "raw.json",
                raw.model_dump(mode="json", by_alias=True),
            )

    def read_raw(self, capture_id: str) -> RawCapture:
        with self._lock:
            self._get_capture(capture_id)
            try:
                return RawCapture.model_validate_json(
                    (self._capture_directory(capture_id) / "raw.json").read_text(encoding="utf-8")
                )
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def write_ocr_projection(self, capture_id: str, projection: CaptureOcrProjectionV3) -> None:
        with self._lock:
            self._get_capture(capture_id)
            _atomic_json(
                self._capture_directory(capture_id) / "ocr.json",
                projection.model_dump(mode="json", by_alias=True),
            )

    def read_ocr_projection(self, capture_id: str) -> CaptureOcrProjectionV3:
        with self._lock:
            self._get_capture(capture_id)
            try:
                return CaptureOcrProjectionV3.model_validate_json(
                    (self._capture_directory(capture_id) / "ocr.json").read_text(encoding="utf-8")
                )
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def write_result(self, capture_id: str, result: CaptureDocument) -> None:
        with self._lock:
            self._get_capture(capture_id)
            _atomic_json(
                self._capture_directory(capture_id) / "result.json",
                result.model_dump(mode="json", by_alias=True),
            )

    def commit_host_result(
        self,
        capture_id: str,
        *,
        idempotency_key: str,
        fingerprint: str,
        result: CaptureDocument,
    ) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status is StreamingCaptureStatus.COMPLETED:
                if (
                    record.commit_idempotency_key == idempotency_key
                    and record.commit_fingerprint == fingerprint
                ):
                    return record.operation
                raise StreamingIdempotencyConflictError(idempotency_key)
            operation_domain(record.operation).require_host_structuring(
                record.request.structuring_mode
            )
            _atomic_json(
                self._capture_directory(capture_id) / "result.json",
                result.model_dump(mode="json", by_alias=True),
            )
            record.commit_idempotency_key = idempotency_key
            record.commit_fingerprint = fingerprint
            return self._complete_capture_locked(record, now=result.completed_at)

    def read_result(self, capture_id: str) -> CaptureDocument:
        with self._lock:
            self._get_capture(capture_id)
            try:
                return CaptureDocument.model_validate_json(
                    (self._capture_directory(capture_id) / "result.json").read_text(
                        encoding="utf-8"
                    )
                )
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def mark_awaiting_structuring(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
                return record.operation
            now = self._clock.now()
            record.operation = _mark_awaiting_structuring(record.operation, now=now)
            self._persist_capture(record)
            self.append_event(
                capture_id,
                event_type=StreamingEventType.CHECKPOINT,
                stage="awaiting_structuring",
                partial_revision=record.operation.partial_revision,
            )
            return record.operation

    def mark_structuring(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            domain = operation_domain(record.operation).begin_structuring()
            if domain.status is record.operation.status:
                return record.operation
            now = self._clock.now()
            record.operation = _mark_structuring(record.operation, now=now)
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
            record = self._get_capture(capture_id)
            if record.operation.status is StreamingCaptureStatus.FAILED:
                if (
                    record.failure_idempotency_key == idempotency_key
                    and record.failure_fingerprint == fingerprint
                ):
                    return record.operation
                raise StreamingIdempotencyConflictError(idempotency_key)
            operation_domain(record.operation).require_host_structuring(
                record.request.structuring_mode
            )
            record.failure_idempotency_key = idempotency_key
            record.failure_fingerprint = fingerprint
            return self._fail_capture_locked(record, failure)

    def complete_capture(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
                return record.operation
            return self._complete_capture_locked(record, now=self._clock.now())

    def _complete_capture_locked(
        self, record: _CaptureRecord, *, now: datetime
    ) -> CaptureOperationV2:
        record.operation = _complete_capture(record.operation, now=now)
        self._persist_capture(record)
        event = operation_domain(record.operation).completed_event(now)
        self.append_event(
            event.capture_id,
            event_type=StreamingEventType.COMPLETED,
            _terminal_transition=True,
            _created_at=event.completed_at,
            stage="completed",
        )
        return record.operation

    def fail_capture(self, capture_id: str, failure: CaptureFailureV2) -> CaptureOperationV2:
        with self._lock:
            return self._fail_capture_locked(self._get_capture(capture_id), failure)

    def _fail_capture_locked(
        self, record: _CaptureRecord, failure: CaptureFailureV2
    ) -> CaptureOperationV2:
        if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
            return record.operation
        now = self._clock.now()
        previous = record.operation
        record.operation = _fail_capture(record.operation, failure, now=now)
        try:
            self._persist_capture(record)
        except OSError:
            # Memory must match disk: a failure that was not saved did not happen.
            record.operation = previous
            raise
        self.append_event(
            record.operation.capture_id,
            event_type=StreamingEventType.FAILED,
            _terminal_transition=True,
            stage=failure.stage or "failed",
            error=failure,
        )
        return record.operation

    def read_partial(self, capture_id: str) -> PartialCaptureV2:
        with self._lock:
            self._get_capture(capture_id)
            try:
                return PartialCaptureV2.model_validate_json(
                    (self._capture_directory(capture_id) / "partial.json").read_text(
                        encoding="utf-8"
                    )
                )
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def cancel_capture(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status in _TERMINAL_CAPTURE_STATUSES:
                return record.operation
            now = self._clock.now()
            record.operation = _cancel_capture(record.operation, now=now)
            self._persist_capture(record)
            self.append_event(
                capture_id,
                event_type=StreamingEventType.CANCELLED,
                _terminal_transition=True,
                stage="cancelled",
            )
            return record.operation

    def set_capture_running(self, capture_id: str, running: bool) -> None:
        """Protect source ownership until the worker task has fully stopped."""
        with self._lock:
            if running:
                self._get_capture(capture_id)
                self._running_captures.add(capture_id)
            else:
                self._running_captures.discard(capture_id)

    def delete_capture(self, capture_id: str) -> None:
        """Delete a capture, and its uploaded source once no capture uses it.

        Sources are confidential host documents: the runtime keeps one only
        while a capture still refers to it.
        """
        with self._lock:
            record = self._get_capture(capture_id)
            normalized = record.operation.capture_id
            if normalized in self._running_captures:
                raise StreamingTransitionError("capture workers are still running")
            self._captures.pop(normalized, None)
            self._capture_idempotency.pop(record.request.client_request_id, None)
            directory = self._capture_directory(normalized)
            self._persistence.delete_capture_directory(directory)
            ingestion_id = record.operation.ingestion_id
            if ingestion_id in self._ingestions and not any(
                other.operation.ingestion_id == ingestion_id for other in self._captures.values()
            ):
                self.delete_ingestion(ingestion_id)

    def prune_expired(self) -> None:
        with self._lock:
            now = self._clock.now()
            protected_ingestions = self._recovery_deferred
            cutoff = now - self._retention
            # A terminal capture expires one retention period after it ended. An
            # unfinished one with no activity for that long is abandoned (a host
            # that never structured it, or work a runtime stop interrupted);
            # running work records events, which keeps it fresh.
            expired_captures = [
                capture_id
                for capture_id, record in self._captures.items()
                if record.operation.updated_at < cutoff
                and capture_id not in self._running_captures
                and record.operation.ingestion_id not in protected_ingestions
            ]
            for capture_id in expired_captures:
                self.delete_capture(capture_id)

            active_ingestions = protected_ingestions | {
                record.operation.ingestion_id
                for record in self._captures.values()
                if record.operation.status not in _TERMINAL_CAPTURE_STATUSES
                or record.operation.capture_id in self._running_captures
            }
            expired_ingestions = [
                ingestion_id
                for ingestion_id, record in self._ingestions.items()
                if (
                    record.expires_at <= now
                    or not self._policy.is_allowed(record.request.kind, record.request.total_bytes)
                )
                and ingestion_id not in active_ingestions
            ]
            for ingestion_id in expired_ingestions:
                record = self._ingestions.get(ingestion_id)
                if record is not None:
                    self._delete_ingestion_record(record, ingestion_id)

    def _delete_ingestion_record(self, record: _IngestionRecord, normalized: str) -> None:
        self._ingestions.pop(normalized, None)
        self._ingestion_idempotency.pop(record.request.client_request_id, None)
        directory = self._ingestion_directory(normalized)
        self._persistence.delete_ingestion_directory(directory)

    def delete_ingestion(self, ingestion_id: str) -> None:
        with self._lock:
            normalized = _identifier(ingestion_id)
            record = self._get_ingestion(normalized)
            if any(
                operation.ingestion_id == normalized
                and (
                    operation.status not in _TERMINAL_CAPTURE_STATUSES
                    or operation.capture_id in self._running_captures
                )
                for operation in (capture.operation for capture in self._captures.values())
            ):
                raise StreamingTransitionError("ingestion has an active capture")
            self._delete_ingestion_record(record, normalized)

    def source_path(self, ingestion_id: str) -> Path:
        with self._lock:
            self._get_ingestion(ingestion_id)
            return self._ingestion_directory(ingestion_id) / "source.bin"

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

    def _source_for(self, record: _IngestionRecord) -> CaptureSource:
        if record.status is not StreamingIngestionStatus.READY or record.finalized_sha256 is None:
            raise StreamingTransitionError("source is not finalized")
        return CaptureSource(
            sha256=record.finalized_sha256,
            file_name=record.request.file_name,
            media_type=record.request.media_type,
            bytes=record.request.total_bytes,
        )

    def _ingestion_directory(self, ingestion_id: str) -> Path:
        return self._persistence.ingestion_directory(_identifier(ingestion_id))

    def _capture_directory(self, capture_id: str) -> Path:
        return self._persistence.capture_directory(_identifier(capture_id))

    @staticmethod
    def _ingestion_snapshot(record: _IngestionRecord) -> IngestionV2:
        return record.snapshot()

    def _persist_ingestion(self, record: _IngestionRecord) -> None:
        self._persistence.persist_ingestion(record)

    def _persist_capture(self, record: _CaptureRecord) -> None:
        self._persistence.persist_capture(record)

    def _load_ingestions(self) -> list[Path]:
        records, invalid_directories = self._persistence.load_ingestions(
            _identifier,
            datetime_parser=datetime_from_text,
        )
        for record in records:
            self._ingestions[record.ingestion_id] = record
            self._ingestion_idempotency[record.request.client_request_id] = record.ingestion_id

        return invalid_directories

    def _load_captures(self) -> bool:
        """Load captures; returns whether every capture directory could be loaded."""
        records, complete = self._persistence.load_captures(self._ingestions)
        for record in records:
            try:
                ingestion_id = _identifier(record.operation.ingestion_id)
            except StreamingRecordNotFoundError:
                ingestion_id = record.operation.ingestion_id
            update: dict[str, object] = {"ingestion_id": ingestion_id}
            # An event written just before its metadata save failed is on disk: the
            # next event continues after it instead of reusing its sequence.
            try:
                logged = self._persistence.last_event_sequence(
                    self._capture_directory(record.operation.capture_id) / "events.jsonl"
                )
            except OSError:
                logged = None
            if logged is not None and logged > record.operation.last_event_sequence:
                update["last_event_sequence"] = logged
            record.operation = record.operation.model_copy(update=update)
            self._captures[record.operation.capture_id] = record
            self._capture_idempotency[record.request.client_request_id] = (
                record.operation.capture_id
            )
        return complete


__all__ = [
    "StreamingIdempotencyConflictError",
    "StreamingPartialNotFoundError",
    "StreamingRecordNotFoundError",
    "StreamingRepository",
    "StreamingTransitionError",
]
