"""File-backed storage for the v2 streaming ingestion and event seams."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from pydantic import ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocumentV1,
    CaptureEventV2,
    CaptureFailureV2,
    CaptureOperationV2,
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


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


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
    commit_idempotency_key: str | None = None
    commit_fingerprint: str | None = None
    failure_idempotency_key: str | None = None
    failure_fingerprint: str | None = None


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
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            (self.root / "ingestions").mkdir(exist_ok=True)
            (self.root / "captures").mkdir(exist_ok=True)
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
            directory = self._ingestion_directory(ingestion_id)
            directory.mkdir(parents=True, exist_ok=False)
            (directory / "source.bin").touch()
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
            with (self._ingestion_directory(ingestion_id) / "source.bin").open("ab") as source:
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
                record.operation = record.operation.model_copy(
                    update={
                        "status": StreamingCaptureStatus.EXTRACTING,
                        "kind": ingestion.request.kind,
                        "source": self._source_for(ingestion),
                        "progress": 0.1,
                        "updated_at": now,
                    }
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
                progress=(
                    record.operation.progress if progress is None else progress
                ),
                partial_revision=partial_revision,
                covered_until_ms=covered_until_ms,
                segments=segments or [],
                error=error,
                created_at=self._clock.now(),
            )
            with (self._capture_directory(capture_id) / "events.jsonl").open(
                "a", encoding="utf-8"
            ) as events:
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
            self._persist_capture(record)
            return event

    def read_events(self, capture_id: str, *, after_sequence: int) -> list[CaptureEventV2]:
        with self._lock:
            record = self._get_capture(capture_id)
            if after_sequence < -1:
                raise ValueError("event cursor must not be less than -1")
            path = self._capture_directory(capture_id) / "events.jsonl"
            events: list[CaptureEventV2] = []
            for line in path.read_text(encoding="utf-8").splitlines():
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

    def write_raw(self, capture_id: str, raw: RawCaptureV1) -> None:
        with self._lock:
            self._get_capture(capture_id)
            _atomic_json(
                self._capture_directory(capture_id) / "raw.json",
                raw.model_dump(mode="json", by_alias=True),
            )

    def read_raw(self, capture_id: str) -> RawCaptureV1:
        with self._lock:
            self._get_capture(capture_id)
            try:
                return RawCaptureV1.model_validate_json(
                    (self._capture_directory(capture_id) / "raw.json").read_text(encoding="utf-8")
                )
            except (OSError, ValidationError) as error:
                raise StreamingPartialNotFoundError(capture_id) from error

    def write_result(self, capture_id: str, result: CaptureDocumentV1) -> None:
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
        result: CaptureDocumentV1,
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
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.COMPLETED,
                    "progress": 1.0,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
            self._persist_capture(record)
            self.append_event(
                capture_id,
                event_type=StreamingEventType.COMPLETED,
                stage="completed",
            )
            return record.operation

    def read_result(self, capture_id: str) -> CaptureDocumentV1:
        with self._lock:
            self._get_capture(capture_id)
            try:
                return CaptureDocumentV1.model_validate_json(
                    (self._capture_directory(capture_id) / "result.json").read_text(
                        encoding="utf-8"
                    )
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
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.AWAITING_STRUCTURING,
                    "progress": 0.9,
                    "updated_at": now,
                }
            )
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
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.STRUCTURING,
                    "progress": 0.95,
                    "updated_at": now,
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
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.COMPLETED,
                    "progress": 1.0,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
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
        if record.operation.status in {
            StreamingCaptureStatus.COMPLETED,
            StreamingCaptureStatus.FAILED,
            StreamingCaptureStatus.CANCELLED,
        }:
            return record.operation
        now = self._clock.now()
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
            terminal = {
                StreamingCaptureStatus.COMPLETED,
                StreamingCaptureStatus.FAILED,
                StreamingCaptureStatus.CANCELLED,
            }
            if record.operation.status in terminal:
                return record.operation
            now = self._clock.now()
            record.operation = record.operation.model_copy(
                update={
                    "status": StreamingCaptureStatus.CANCELLED,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
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
            if directory.parent.resolve() != (self.root / "captures").resolve():
                raise RuntimeError("capture directory escaped repository root")
            shutil.rmtree(directory, ignore_errors=True)

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
                and operation.status
                not in {
                    StreamingCaptureStatus.COMPLETED,
                    StreamingCaptureStatus.FAILED,
                    StreamingCaptureStatus.CANCELLED,
                }
                for operation in (capture.operation for capture in self._captures.values())
            ):
                raise StreamingTransitionError("ingestion has an active capture")
            self._ingestions.pop(normalized, None)
            self._ingestion_idempotency.pop(record.request.client_request_id, None)
            directory = self._ingestion_directory(normalized)
            if directory.parent.resolve() != (self.root / "ingestions").resolve():
                raise RuntimeError("ingestion directory escaped repository root")
            shutil.rmtree(directory, ignore_errors=True)

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
        return self.root / "ingestions" / _identifier(ingestion_id)

    def _capture_directory(self, capture_id: str) -> Path:
        return self.root / "captures" / _identifier(capture_id)

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
        _atomic_json(
            self._ingestion_directory(record.ingestion_id) / "metadata.json",
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
        _atomic_json(
            self._capture_directory(record.operation.capture_id) / "metadata.json",
            {
                "request": record.request.model_dump(mode="json", by_alias=True),
                "operation": record.operation.model_dump(mode="json", by_alias=True),
                "commitIdempotencyKey": record.commit_idempotency_key,
                "commitFingerprint": record.commit_fingerprint,
                "failureIdempotencyKey": record.failure_idempotency_key,
                "failureFingerprint": record.failure_fingerprint,
            },
        )

    def _load_ingestions(self) -> None:
        for directory in (self.root / "ingestions").iterdir():
            try:
                payload = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                request = OpenIngestionV2.model_validate(payload["request"])
                record = _IngestionRecord(
                    request=request,
                    ingestion_id=_identifier(str(payload["ingestionId"])),
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
            except (
                OSError,
                KeyError,
                TypeError,
                ValueError,
                ValidationError,
                json.JSONDecodeError,
            ):
                continue
            self._ingestions[record.ingestion_id] = record
            self._ingestion_idempotency[record.request.client_request_id] = record.ingestion_id

    def _load_captures(self) -> None:
        for directory in (self.root / "captures").iterdir():
            try:
                payload = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
                request = StartCaptureV2.model_validate(payload["request"])
                operation_payload = payload["operation"]
                operation = CaptureOperationV2.model_validate(operation_payload)
                if "kind" not in operation_payload:
                    ingestion = self._ingestions.get(operation.ingestion_id)
                    if ingestion is not None:
                        operation = operation.model_copy(update={"kind": ingestion.request.kind})
                record = _CaptureRecord(
                    operation=operation,
                    request=request,
                    commit_idempotency_key=payload.get("commitIdempotencyKey"),
                    commit_fingerprint=payload.get("commitFingerprint"),
                    failure_idempotency_key=payload.get("failureIdempotencyKey"),
                    failure_fingerprint=payload.get("failureFingerprint"),
                )
            except (
                OSError,
                KeyError,
                TypeError,
                ValueError,
                ValidationError,
                json.JSONDecodeError,
            ):
                continue
            self._captures[operation.capture_id] = record
            self._capture_idempotency[request.client_request_id] = operation.capture_id


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
