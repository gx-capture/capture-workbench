"""File-backed storage for the v2 streaming ingestion and event seams."""

from __future__ import annotations

import hashlib
import json
import re
import threading
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from pydantic import ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEventV2,
    CaptureFailureV2,
    CaptureOperationV2,
    CaptureSource,
    IngestionV2,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCapture,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StreamingIngestionStatus,
    StructuringMode,
)
from capture_runtime.storage._streaming_persistence import (
    _atomic_json,
    _file_sha256,
    _StreamingRepositoryPersistence,
    datetime_from_text,
)
from capture_runtime.storage._streaming_records import _CaptureRecord, _IngestionRecord
from capture_runtime.storage._streaming_transitions import (
    _TERMINAL_CAPTURE_STATUSES,
    _cancel_capture,
    _complete_capture,
    _create_capture_operation,
    _fail_capture,
    _mark_awaiting_structuring,
    _mark_ingestion_ready,
    _mark_structuring,
)


class StreamingRecordNotFoundError(KeyError):
    pass


class StreamingIdempotencyConflictError(ValueError):
    pass


class StreamingTransitionError(ValueError):
    pass


class StreamingPartialNotFoundError(StreamingRecordNotFoundError):
    pass


_SAFE_ID = re.compile(r"^[0-9a-f-]{36}$")
_MAX_EVENT_REPLAY = 1_024


def _identifier(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise StreamingRecordNotFoundError(value) from error
    normalized = str(parsed)
    if normalized != value.lower() or _SAFE_ID.fullmatch(normalized) is None:
        raise StreamingRecordNotFoundError(value)
    return normalized


class StreamingRepository:
    """A bounded, recoverable repository behind the streaming service seam."""

    def __init__(self, root: Path, *, clock: Clock, retention_hours: int) -> None:
        self.root = root
        self._clock = clock
        self._retention = timedelta(hours=retention_hours)
        self._ingestions: dict[str, _IngestionRecord] = {}
        self._ingestion_idempotency: dict[str, str] = {}
        self._captures: dict[str, _CaptureRecord] = {}
        self._capture_idempotency: dict[str, str] = {}
        self._persistence = _StreamingRepositoryPersistence(root)
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            self._persistence.initialize()
            self._ingestions.clear()
            self._ingestion_idempotency.clear()
            self._captures.clear()
            self._capture_idempotency.clear()
            self._load_ingestions()
            self._load_captures()
            self.prune_expired()

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
            if record.status is not StreamingIngestionStatus.OPEN:
                raise StreamingTransitionError("ingestion is not open")
            if chunk_index < 0 or byte_offset < 0 or not data:
                raise StreamingTransitionError("chunk metadata is invalid")
            if len(data) > max_chunk_bytes:
                raise StreamingTransitionError("chunk exceeds the configured limit")
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
            self._persistence.append_source(
                self._ingestion_directory(ingestion_id) / "source.bin", data
            )
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
            if total_bytes != record.request.total_bytes or total_bytes != record.next_offset:
                raise StreamingTransitionError("final byte count does not match upload")
            actual_sha256 = _file_sha256(self._ingestion_directory(ingestion_id) / "source.bin")
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
    ) -> CaptureEventV2:
        with self._lock:
            record = self._get_capture(capture_id)
            sequence = record.operation.last_event_sequence + 1
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
                created_at=self._clock.now(),
            )
            self._persistence.append_event(
                self._capture_directory(capture_id) / "events.jsonl", event
            )
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
            if (
                record.request.structuring_mode is not StructuringMode.HOST
                or record.operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING
            ):
                raise StreamingTransitionError("capture is no longer awaiting host structuring")
            _atomic_json(
                self._capture_directory(capture_id) / "result.json",
                result.model_dump(mode="json", by_alias=True),
            )
            record.commit_idempotency_key = idempotency_key
            record.commit_fingerprint = fingerprint
            now = result.completed_at
            record.operation = _complete_capture(record.operation, now=now)
            self._persist_capture(record)
            self.append_event(
                capture_id,
                event_type=StreamingEventType.COMPLETED,
                stage="completed",
            )
            return record.operation

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
            if record.operation.status is StreamingCaptureStatus.STRUCTURING:
                return record.operation
            if record.operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING:
                raise StreamingTransitionError("capture is not awaiting structuring")
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
            if (
                record.request.structuring_mode is not StructuringMode.HOST
                or record.operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING
            ):
                raise StreamingTransitionError("capture is no longer awaiting host structuring")
            record.failure_idempotency_key = idempotency_key
            record.failure_fingerprint = fingerprint
            return self._fail_capture_locked(record, failure)

    def complete_capture(self, capture_id: str) -> CaptureOperationV2:
        with self._lock:
            record = self._get_capture(capture_id)
            if record.operation.status is StreamingCaptureStatus.COMPLETED:
                return record.operation
            if record.operation.status is StreamingCaptureStatus.CANCELLED:
                return record.operation
            now = self._clock.now()
            record.operation = _complete_capture(record.operation, now=now)
            self._persist_capture(record)
            self.append_event(
                capture_id,
                event_type=StreamingEventType.COMPLETED,
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
        record.operation = _fail_capture(record.operation, failure, now=now)
        self._persist_capture(record)
        self.append_event(
            record.operation.capture_id,
            event_type=StreamingEventType.FAILED,
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
                stage="cancelled",
            )
            return record.operation

    def delete_capture(self, capture_id: str) -> None:
        with self._lock:
            record = self._get_capture(capture_id)
            self._captures.pop(capture_id, None)
            self._capture_idempotency.pop(record.request.client_request_id, None)
            directory = self._capture_directory(capture_id)
            self._persistence.delete_capture_directory(directory)

    def prune_expired(self) -> None:
        with self._lock:
            now = self._clock.now()
            cutoff = now - self._retention
            expired_captures = [
                capture_id
                for capture_id, record in self._captures.items()
                if (
                    record.operation.status in _TERMINAL_CAPTURE_STATUSES
                    and record.operation.updated_at < cutoff
                )
            ]
            for capture_id in expired_captures:
                self.delete_capture(capture_id)

            active_ingestions = {
                record.operation.ingestion_id
                for record in self._captures.values()
                if record.operation.status not in _TERMINAL_CAPTURE_STATUSES
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
            self._ingestions.pop(normalized, None)
            self._ingestion_idempotency.pop(record.request.client_request_id, None)
            directory = self._ingestion_directory(normalized)
            self._persistence.delete_ingestion_directory(directory)

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

    def _load_ingestions(self) -> None:
        for record in self._persistence.load_ingestions(
            _identifier,
            datetime_parser=datetime_from_text,
        ):
            self._ingestions[record.ingestion_id] = record
            self._ingestion_idempotency[record.request.client_request_id] = record.ingestion_id

    def _load_captures(self) -> None:
        for record in self._persistence.load_captures(self._ingestions):
            self._captures[record.operation.capture_id] = record
            self._capture_idempotency[record.request.client_request_id] = (
                record.operation.capture_id
            )


__all__ = [
    "StreamingIdempotencyConflictError",
    "StreamingPartialNotFoundError",
    "StreamingRecordNotFoundError",
    "StreamingRepository",
    "StreamingTransitionError",
]
