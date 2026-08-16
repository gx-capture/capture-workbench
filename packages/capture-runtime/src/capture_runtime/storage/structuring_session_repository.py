"""Durable pull-session checkpoints for provider-backed structuring."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import threading
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from uuid import UUID, uuid4

from pydantic import ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contract_set import canonical_json_bytes
from capture_runtime.contracts import (
    CaptureDocument,
    OpenStructuringSessionV2,
    StructuringBatchStatus,
    StructuringBatchV2,
    StructuringSemanticBlockV2,
    StructuringSessionStatus,
    StructuringSessionV2,
)
from capture_runtime.storage.common import _atomic_json


class StructuringSessionRecordNotFoundError(KeyError):
    """A pull-session record does not exist."""


class StructuringSessionIdempotencyConflictError(ValueError):
    """A pull-session idempotency key was reused with different input."""


class StructuringSessionDigestConflictError(ValueError):
    """A submission did not match the advertised provider batch digest."""


class StructuringSessionTransitionError(ValueError):
    """A pull-session transition is not valid for its durable state."""


class StructuringSessionRecordCorruptError(RuntimeError):
    """A persisted pull-session record failed strict recovery validation."""


def _digest(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _session_digest(session: StructuringSessionV2) -> str:
    return _digest(session.model_dump(mode="json", by_alias=True, exclude={"session_digest"}))


def _batch_digest(batch: StructuringBatchV2) -> str:
    return _digest(
        batch.model_dump(
            mode="json",
            by_alias=True,
            exclude={"batch_digest", "status"},
        )
    )


def _request_fingerprint(
    request: OpenStructuringSessionV2,
    *,
    raw_source_sha256: str,
    contract_set_sha256: str,
    batches: list[StructuringBatchV2],
) -> str:
    """Hash stable open-session inputs without session-assigned state."""

    return _digest(
        {
            "request": request.model_dump(mode="json", by_alias=True),
            "rawSourceSha256": raw_source_sha256,
            "contractSetSha256": contract_set_sha256,
            "batches": [
                batch.model_dump(
                    mode="json",
                    by_alias=True,
                    exclude={"session_id", "batch_digest", "status"},
                )
                for batch in batches
            ],
        }
    )


def _uuid(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise StructuringSessionRecordNotFoundError(value) from error
    normalized = str(parsed)
    if normalized != value.lower():
        raise StructuringSessionRecordNotFoundError(value)
    return normalized


@dataclass(slots=True)
class StructuringBatchRecord:
    batch: StructuringBatchV2
    accepted_blocks: list[dict[str, object]] | None = None
    idempotency_key: str | None = None
    submission_fingerprint: str | None = None
    response: StructuringSessionV2 | None = None

    def dump(self) -> dict[str, object]:
        return {
            "batch": self.batch.model_dump(mode="json", by_alias=True),
            "acceptedBlocks": self.accepted_blocks,
            "idempotencyKey": self.idempotency_key,
            "submissionFingerprint": self.submission_fingerprint,
            "response": (
                None
                if self.response is None
                else self.response.model_dump(mode="json", by_alias=True)
            ),
        }


@dataclass(slots=True)
class StructuringSessionRecord:
    request: OpenStructuringSessionV2
    session: StructuringSessionV2
    batches: list[StructuringBatchRecord]
    request_fingerprint: str
    completed_document: CaptureDocument | None = None

    def dump(self) -> dict[str, object]:
        return {
            "request": self.request.model_dump(mode="json", by_alias=True),
            "session": self.session.model_dump(mode="json", by_alias=True),
            "batches": [batch.dump() for batch in self.batches],
            "requestFingerprint": self.request_fingerprint,
            "completedDocument": (
                None
                if self.completed_document is None
                else self.completed_document.model_dump(mode="json", by_alias=True)
            ),
        }


class StructuringSessionRepository:
    """Recoverable, atomic file repository for pull-session state."""

    def __init__(
        self,
        root: Path,
        *,
        clock: Clock,
        retention_hours: int = 24,
    ) -> None:
        self.root = root
        self._clock = clock
        self._retention = timedelta(hours=retention_hours)
        self._records: dict[str, StructuringSessionRecord] = {}
        self._idempotency: dict[str, str] = {}
        self._lock = threading.RLock()

    def initialize(self) -> None:
        """Load only strictly valid records; malformed state fails closed."""

        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            self._records.clear()
            self._idempotency.clear()
            for directory in sorted(self.root.iterdir(), key=lambda path: path.name):
                if not directory.is_dir():
                    continue
                if directory.is_symlink():
                    raise StructuringSessionRecordCorruptError(
                        f"structuring session directory is a symlink: {directory.name}"
                    )
                try:
                    record = self._load(directory)
                except (
                    OSError,
                    KeyError,
                    TypeError,
                    ValueError,
                    ValidationError,
                    json.JSONDecodeError,
                ) as error:
                    raise StructuringSessionRecordCorruptError(
                        f"structuring session record is malformed: {directory.name}"
                    ) from error
                session_id = _uuid(record.session.session_id)
                if session_id in self._records or (
                    record.request.client_request_id in self._idempotency
                ):
                    raise StructuringSessionRecordCorruptError(
                        f"structuring session record is duplicated: {directory.name}"
                    )
                self._records[session_id] = record
                self._idempotency[record.request.client_request_id] = session_id
            self.prune_expired()

    def create_or_get(
        self,
        request: OpenStructuringSessionV2,
        *,
        raw_source_sha256: str,
        contract_set_sha256: str,
        batches: list[StructuringBatchV2],
    ) -> tuple[StructuringSessionV2, bool]:
        with self._lock:
            request_fingerprint = _request_fingerprint(
                request,
                raw_source_sha256=raw_source_sha256,
                contract_set_sha256=contract_set_sha256,
                batches=batches,
            )
            existing_id = self._idempotency.get(request.client_request_id)
            if existing_id is not None:
                existing = self._records[existing_id]
                if existing.request_fingerprint != request_fingerprint:
                    raise StructuringSessionIdempotencyConflictError(request.client_request_id)
                return existing.session, False
            for existing in self._records.values():
                if existing.session.capture_id == request.capture_id:
                    raise StructuringSessionIdempotencyConflictError(request.client_request_id)
            if not batches:
                raise StructuringSessionTransitionError("structuring session has no batches")
            now = self._clock.now()
            session_id = str(uuid4())
            session = StructuringSessionV2(
                session_id=session_id,
                capture_id=request.capture_id,
                raw_source_sha256=raw_source_sha256,
                contract_set_sha256=contract_set_sha256,
                target_language=request.target_language,
                provider_capability=request.provider_capability,
                schema_dialect=request.schema_dialect,
                batch_count=len(batches),
                next_batch_index=0,
                session_digest="0" * 64,
                status=StructuringSessionStatus.OPEN,
                created_at=now,
                updated_at=now,
            )
            session = session.model_copy(update={"session_digest": _session_digest(session)})
            records = []
            for batch in batches:
                rebound = batch.model_copy(update={"session_id": session_id})
                rebound = rebound.model_copy(update={"batch_digest": _batch_digest(rebound)})
                records.append(StructuringBatchRecord(batch=rebound))
            record = StructuringSessionRecord(
                request=request,
                session=session,
                batches=records,
                request_fingerprint=request_fingerprint,
            )
            self._persist(record)
            self._records[session_id] = record
            self._idempotency[request.client_request_id] = session_id
            return session, True

    def get(self, session_id: str) -> StructuringSessionV2:
        with self._lock:
            return self._record(session_id).session

    def get_by_client_request(
        self, request: OpenStructuringSessionV2
    ) -> StructuringSessionV2 | None:
        """Return an idempotent open response, or reject key reuse with new input."""

        with self._lock:
            session_id = self._idempotency.get(request.client_request_id)
            if session_id is None:
                return None
            record = self._records.get(session_id)
            if record is None:
                raise StructuringSessionRecordCorruptError(
                    "structuring session idempotency index is dangling"
                )
            if record.request != request:
                raise StructuringSessionIdempotencyConflictError(request.client_request_id)
            return record.session

    def for_capture(self, capture_id: str) -> StructuringSessionV2:
        with self._lock:
            for record in self._records.values():
                if record.session.capture_id == capture_id:
                    return record.session
        raise StructuringSessionRecordNotFoundError(capture_id)

    def list_sessions(self) -> list[StructuringSessionV2]:
        with self._lock:
            return [record.session for record in self._records.values()]

    def batch(self, session_id: str, batch_index: int) -> StructuringBatchV2:
        with self._lock:
            record = self._record(session_id)
            if batch_index < 0 or batch_index >= len(record.batches):
                raise StructuringSessionRecordNotFoundError(str(batch_index))
            return record.batches[batch_index].batch

    def accepted_blocks(self, session_id: str) -> list[dict[str, object]]:
        with self._lock:
            record = self._record(session_id)
            accepted: list[dict[str, object]] = []
            for batch in record.batches:
                if batch.accepted_blocks is None:
                    break
                accepted.extend(batch.accepted_blocks)
            return accepted

    def completed_document(self, session_id: str) -> CaptureDocument | None:
        with self._lock:
            return self._record(session_id).completed_document

    def replay_submission(
        self,
        session_id: str,
        *,
        batch_index: int,
        idempotency_key: str,
        submission_fingerprint: str,
    ) -> StructuringSessionV2 | None:
        """Return an identical accepted response before semantic revalidation."""

        with self._lock:
            record = self._record(session_id)
            if batch_index < 0 or batch_index >= len(record.batches):
                raise StructuringSessionRecordNotFoundError(str(batch_index))
            batch = record.batches[batch_index]
            if batch.idempotency_key is None:
                return None
            if (
                batch.idempotency_key != idempotency_key
                or batch.submission_fingerprint != submission_fingerprint
            ):
                raise StructuringSessionIdempotencyConflictError(idempotency_key)
            if batch.response is None:
                raise StructuringSessionRecordCorruptError(
                    "accepted structuring batch is missing its replay response"
                )
            return batch.response

    def submit(
        self,
        session_id: str,
        *,
        batch_index: int,
        batch_digest: str,
        idempotency_key: str,
        submission_fingerprint: str,
        blocks: list[dict[str, object]],
        completed_document: CaptureDocument | None = None,
    ) -> tuple[StructuringSessionV2, bool]:
        with self._lock:
            record = self._record(session_id)
            if batch_index < 0 or batch_index >= len(record.batches):
                raise StructuringSessionRecordNotFoundError(str(batch_index))
            batch = record.batches[batch_index]
            if batch.idempotency_key is not None:
                if (
                    batch.idempotency_key != idempotency_key
                    or batch.submission_fingerprint != submission_fingerprint
                ):
                    raise StructuringSessionIdempotencyConflictError(idempotency_key)
                if batch.response is None:
                    raise StructuringSessionRecordCorruptError(
                        "accepted structuring batch is missing its replay response"
                    )
                return batch.response, False
            if batch.batch.batch_digest != batch_digest:
                raise StructuringSessionDigestConflictError(batch_digest)
            if record.session.status is not StructuringSessionStatus.OPEN:
                raise StructuringSessionTransitionError("structuring session is not open")
            if batch_index != record.session.next_batch_index:
                raise StructuringSessionTransitionError(
                    "structuring batches must be submitted in order"
                )

            now = self._clock.now()
            is_final = batch_index + 1 == record.session.batch_count
            updated_batch = batch.batch.model_copy(
                update={"status": StructuringBatchStatus.ACCEPTED},
            )
            updated_session = record.session.model_copy(
                update={
                    "next_batch_index": batch_index + 1,
                    "updated_at": now,
                    "status": (
                        StructuringSessionStatus.COMPLETED
                        if is_final
                        else StructuringSessionStatus.OPEN
                    ),
                    "completed_at": now if is_final else None,
                }
            )
            updated_session = updated_session.model_copy(
                update={"session_digest": _session_digest(updated_session)}
            )
            updated_batches = list(record.batches)
            updated_batches[batch_index] = StructuringBatchRecord(
                batch=updated_batch,
                accepted_blocks=blocks,
                idempotency_key=idempotency_key,
                submission_fingerprint=submission_fingerprint,
                response=updated_session,
            )
            updated_record = StructuringSessionRecord(
                request=record.request,
                session=updated_session,
                batches=updated_batches,
                request_fingerprint=record.request_fingerprint,
                completed_document=completed_document if is_final else record.completed_document,
            )
            # Persist the accepted body/checkpoint before mutating in-memory
            # state or advancing nextBatchIndex.
            self._persist(updated_record)
            self._records[updated_session.session_id] = updated_record
            return updated_session, True

    def prune_expired(self) -> None:
        with self._lock:
            cutoff = self._clock.now() - self._retention
            expired = [
                session_id
                for session_id, record in self._records.items()
                if record.session.status
                in {
                    StructuringSessionStatus.COMPLETED,
                    StructuringSessionStatus.FAILED,
                    StructuringSessionStatus.CANCELLED,
                }
                and record.session.updated_at < cutoff
            ]
            for session_id in expired:
                record = self._records.pop(session_id)
                self._idempotency.pop(record.request.client_request_id, None)
                directory = self._directory(session_id)
                if directory.is_symlink() or directory.parent.resolve() != self.root.resolve():
                    raise RuntimeError("structuring session directory escaped repository root")
                shutil.rmtree(directory, ignore_errors=True)

    def _record(self, session_id: str) -> StructuringSessionRecord:
        normalized = _uuid(session_id)
        try:
            return self._records[normalized]
        except KeyError as error:
            raise StructuringSessionRecordNotFoundError(session_id) from error

    def _directory(self, session_id: str) -> Path:
        return self.root / _uuid(session_id)

    def _persist(self, record: StructuringSessionRecord) -> None:
        directory = self._directory(record.session.session_id)
        if directory.exists() and (
            directory.is_symlink() or directory.resolve().parent != self.root.resolve()
        ):
            raise StructuringSessionRecordCorruptError(
                "structuring session directory escaped repository root"
            )
        _atomic_json(directory / "metadata.json", record.dump())

    def _load(self, directory: Path) -> StructuringSessionRecord:
        session_id = _uuid(directory.name)
        payload = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        request = OpenStructuringSessionV2.model_validate(payload["request"])
        session = StructuringSessionV2.model_validate(payload["session"])
        if (
            session.session_id != session_id
            or session.capture_id != request.capture_id
            or session.target_language != request.target_language
            or session.provider_capability != request.provider_capability
            or session.schema_dialect != request.schema_dialect
            or _session_digest(session) != session.session_digest
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        batches_payload = payload["batches"]
        if not isinstance(batches_payload, list) or len(batches_payload) != session.batch_count:
            raise StructuringSessionRecordCorruptError(directory.name)
        batches: list[StructuringBatchRecord] = []
        for expected_index, entry in enumerate(batches_payload):
            if not isinstance(entry, dict):
                raise StructuringSessionRecordCorruptError(directory.name)
            batch = StructuringBatchV2.model_validate(entry["batch"])
            if (
                batch.session_id != session.session_id
                or batch.capture_id != session.capture_id
                or batch.batch_index != expected_index
                or batch.batch_count != session.batch_count
                or _batch_digest(batch) != batch.batch_digest
            ):
                raise StructuringSessionRecordCorruptError(directory.name)
            accepted = entry.get("acceptedBlocks")
            accepted_blocks = None
            if accepted is not None:
                if not isinstance(accepted, list):
                    raise StructuringSessionRecordCorruptError(directory.name)
                accepted_blocks = [
                    StructuringSemanticBlockV2.model_validate(item).model_dump(
                        mode="json", by_alias=True, exclude_none=True
                    )
                    for item in accepted
                ]
            response_payload = entry.get("response")
            response = (
                None
                if response_payload is None
                else StructuringSessionV2.model_validate(response_payload)
            )
            idempotency_key = entry.get("idempotencyKey")
            submission_fingerprint = entry.get("submissionFingerprint")
            if (idempotency_key is None) != (accepted_blocks is None):
                raise StructuringSessionRecordCorruptError(directory.name)
            if accepted_blocks is None:
                if response is not None or submission_fingerprint is not None:
                    raise StructuringSessionRecordCorruptError(directory.name)
            else:
                if (
                    not isinstance(idempotency_key, str)
                    or not 1 <= len(idempotency_key) <= 128
                    or not isinstance(submission_fingerprint, str)
                    or re.fullmatch(r"[0-9a-f]{64}", submission_fingerprint) is None
                    or response is None
                ):
                    raise StructuringSessionRecordCorruptError(directory.name)
                if (
                    batch.status is not StructuringBatchStatus.ACCEPTED
                    or response.session_id != session.session_id
                    or response.capture_id != session.capture_id
                    or response.next_batch_index != expected_index + 1
                    or _session_digest(response) != response.session_digest
                ):
                    raise StructuringSessionRecordCorruptError(directory.name)
            if accepted_blocks is None and batch.status is not StructuringBatchStatus.READY:
                raise StructuringSessionRecordCorruptError(directory.name)
            batches.append(
                StructuringBatchRecord(
                    batch=batch,
                    accepted_blocks=accepted_blocks,
                    idempotency_key=idempotency_key,
                    submission_fingerprint=submission_fingerprint,
                    response=response,
                )
            )
        completed_payload = payload.get("completedDocument")
        completed_document = (
            None if completed_payload is None else CaptureDocument.model_validate(completed_payload)
        )
        request_fingerprint = payload.get("requestFingerprint")
        if (
            not isinstance(request_fingerprint, str)
            or re.fullmatch(r"[0-9a-f]{64}", request_fingerprint) is None
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        if request_fingerprint != _request_fingerprint(
            request,
            raw_source_sha256=session.raw_source_sha256,
            contract_set_sha256=session.contract_set_sha256,
            batches=[entry.batch for entry in batches],
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        accepted_count = sum(batch.accepted_blocks is not None for batch in batches)
        if accepted_count != session.next_batch_index:
            raise StructuringSessionRecordCorruptError(directory.name)
        if (
            session.status is StructuringSessionStatus.COMPLETED
            and accepted_count != session.batch_count
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        if (
            session.status is StructuringSessionStatus.OPEN
            and accepted_count == session.batch_count
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        if session.status is StructuringSessionStatus.COMPLETED and completed_document is None:
            raise StructuringSessionRecordCorruptError(directory.name)
        if (
            session.status is not StructuringSessionStatus.COMPLETED
            and completed_document is not None
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        return StructuringSessionRecord(
            request=request,
            session=session,
            batches=batches,
            request_fingerprint=request_fingerprint,
            completed_document=completed_document,
        )


__all__ = [
    "StructuringSessionDigestConflictError",
    "StructuringSessionIdempotencyConflictError",
    "StructuringSessionRecordCorruptError",
    "StructuringSessionRecordNotFoundError",
    "StructuringSessionRepository",
    "StructuringSessionTransitionError",
]
