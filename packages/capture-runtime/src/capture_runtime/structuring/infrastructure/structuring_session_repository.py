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
    OpenStructuringSession,
    StructuringBatchStatus,
    StructuringSessionStatus,
)
from capture_runtime.contracts import (
    StructuringBatch as StructuringBatchContract,
)
from capture_runtime.contracts import (
    StructuringSemanticBlock as StructuringSemanticBlockContract,
)
from capture_runtime.contracts import (
    StructuringSession as StructuringSessionContract,
)
from capture_runtime.storage.common import atomic_json, project_stored_capture
from capture_runtime.structuring.domain.session import StructuringSemanticBlock
from capture_runtime.structuring.domain.session.models import (
    SessionTransitionError,
    StructuringBatch,
    StructuringSession,
    StructuringSessionDigestConflictError,
)


class StructuringSessionRecordNotFoundError(KeyError):
    """A pull-session record does not exist."""


class StructuringSessionIdempotencyConflictError(ValueError):
    """A pull-session idempotency key was reused with different input."""


StructuringSessionTransitionError = SessionTransitionError


class StructuringSessionRecordCorruptError(RuntimeError):
    """A persisted pull-session record failed strict recovery validation."""


def _digest(value: object) -> str:
    return hashlib.sha256(canonical_json_bytes(value)).hexdigest()


def _session_digest(session: StructuringSessionContract) -> str:
    return _digest(session.model_dump(mode="json", by_alias=True, exclude={"session_digest"}))


def _batch_digest(batch: StructuringBatchContract) -> str:
    return _digest(
        batch.model_dump(
            mode="json",
            by_alias=True,
            exclude={"batch_digest", "status"},
        )
    )


def _fingerprinted_batches(batches: list[StructuringBatchContract]) -> list[object]:
    return [
        batch.model_dump(
            mode="json",
            by_alias=True,
            exclude={"session_id", "batch_digest", "status"},
        )
        for batch in batches
    ]


def _request_fingerprint(
    request: OpenStructuringSession,
    *,
    capture_id: str,
    client_request_id: str,
    source_sha256: str,
    contract_set_sha256: str,
    batches: list[StructuringBatchContract],
) -> str:
    """Hash stable open-session inputs without session-assigned state."""

    return _digest(
        {
            "request": request.model_dump(mode="json", by_alias=True),
            "captureId": capture_id,
            "clientRequestId": client_request_id,
            "sourceSha256": source_sha256,
            "contractSetSha256": contract_set_sha256,
            "batches": _fingerprinted_batches(batches),
        }
    )


@dataclass(frozen=True, slots=True)
class _HistoricalForm:
    """How a record written before 0.11.0 spelled what its digests cover.

    0.10.x put the capture and the idempotency key in the request body, named
    the provider capability, and keyed the source digest `rawSourceSha256`.
    Its digests are verified in that form; the API sees the current form.
    """

    request_payload: dict[str, object]
    capability: str
    source_key: str


_HISTORICAL_REQUEST_KEYS = frozenset(
    {
        "protocolVersion",
        "captureId",
        "targetLanguage",
        "providerCapability",
        "schemaDialect",
        "clientRequestId",
    }
)


def _non_empty_text(value: object, record_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StructuringSessionRecordCorruptError(record_name)
    return value


def _project_historical_request(
    payload: dict[str, object], record_name: str
) -> tuple[OpenStructuringSession, str, str, str]:
    """The current request, capture, idempotency key and capability of a 0.10.x request."""

    if set(payload) != _HISTORICAL_REQUEST_KEYS:
        raise StructuringSessionRecordCorruptError(record_name)
    capability_payload = payload["providerCapability"]
    if not isinstance(capability_payload, dict):
        raise StructuringSessionRecordCorruptError(record_name)
    capability = _non_empty_text(capability_payload.get("capability"), record_name)
    provider = capability_payload.get("provider")
    if not isinstance(provider, dict):
        raise StructuringSessionRecordCorruptError(record_name)
    request = OpenStructuringSession.model_validate(
        {
            "protocolVersion": payload["protocolVersion"],
            "targetLanguage": payload["targetLanguage"],
            # 0.10.x planned its batches for the profile named by the
            # provider's model.
            "profileId": provider.get("model"),
            "providerCapability": {
                key: value for key, value in capability_payload.items() if key != "capability"
            },
            "schemaDialect": payload["schemaDialect"],
        }
    )
    return (
        request,
        _non_empty_text(payload["captureId"], record_name),
        _non_empty_text(payload["clientRequestId"], record_name),
        capability,
    )


def _historical_request_fingerprint(
    historical: _HistoricalForm,
    *,
    source_sha256: str,
    contract_set_sha256: str,
    batches: list[StructuringBatchContract],
) -> str:
    """Hash open-session inputs the way a 0.10.x runtime did."""

    return _digest(
        {
            "request": historical.request_payload,
            historical.source_key: source_sha256,
            "contractSetSha256": contract_set_sha256,
            "batches": _fingerprinted_batches(batches),
        }
    )


def _historical_session_digest(
    session: StructuringSessionContract, historical: _HistoricalForm
) -> str:
    payload = session.model_dump(mode="json", by_alias=True, exclude={"session_digest"})
    payload[historical.source_key] = payload.pop("sourceSha256")
    capability = dict(payload["providerCapability"])
    capability["capability"] = historical.capability
    payload["providerCapability"] = capability
    return _digest(payload)


def _decode_stored_session(
    raw_payload: object,
    *,
    historical: _HistoricalForm | None,
    record_name: str,
) -> StructuringSessionContract:
    if not isinstance(raw_payload, dict):
        raise StructuringSessionRecordCorruptError(record_name)
    if historical is None:
        session = StructuringSessionContract.model_validate(raw_payload)
        if _session_digest(session) != session.session_digest:
            raise StructuringSessionRecordCorruptError(record_name)
        return session
    other_key = "sourceSha256" if historical.source_key == "rawSourceSha256" else "rawSourceSha256"
    capability_payload = raw_payload.get("providerCapability")
    if (
        historical.source_key not in raw_payload
        or other_key in raw_payload
        or not isinstance(capability_payload, dict)
        or capability_payload.get("capability") != historical.capability
    ):
        raise StructuringSessionRecordCorruptError(record_name)
    normalized = dict(raw_payload)
    normalized["sourceSha256"] = normalized.pop(historical.source_key)
    normalized["providerCapability"] = {
        key: value for key, value in capability_payload.items() if key != "capability"
    }
    session = StructuringSessionContract.model_validate(normalized)
    if _historical_session_digest(session, historical) != session.session_digest:
        raise StructuringSessionRecordCorruptError(record_name)
    return session


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
    batch: StructuringBatchContract
    accepted_blocks: list[StructuringSemanticBlock] | None = None
    idempotency_key: str | None = None
    submission_fingerprint: str | None = None
    response: StructuringSessionContract | None = None

    def dump(self) -> dict[str, object]:
        return {
            "batch": self.batch.model_dump(mode="json", by_alias=True),
            "acceptedBlocks": (
                [b.dump() for b in self.accepted_blocks]
                if self.accepted_blocks is not None
                else None
            ),
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
    request: OpenStructuringSession
    # The route's capture and the X-Idempotency-Key, kept beside the body.
    capture_id: str
    client_request_id: str
    session: StructuringSessionContract
    batches: list[StructuringBatchRecord]
    request_fingerprint: str
    completed_document: CaptureDocument | None = None
    # Set for a record read in its 0.10.x form. Reads never rewrite it; the
    # next accepted batch saves the record in the current form.
    historical: _HistoricalForm | None = None

    def current_fingerprint(self) -> str:
        """The request fingerprint in the current form, for comparing a new request."""

        if self.historical is None:
            return self.request_fingerprint
        return _request_fingerprint(
            self.request,
            capture_id=self.capture_id,
            client_request_id=self.client_request_id,
            source_sha256=self.session.source_sha256,
            contract_set_sha256=self.session.contract_set_sha256,
            batches=[entry.batch for entry in self.batches],
        )

    def dump(self) -> dict[str, object]:
        if self.historical is not None:
            raise RuntimeError("a historical structuring session record is never rewritten as is")
        return {
            "request": self.request.model_dump(mode="json", by_alias=True),
            "captureId": self.capture_id,
            "clientRequestId": self.client_request_id,
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
                if session_id in self._records or record.client_request_id in self._idempotency:
                    raise StructuringSessionRecordCorruptError(
                        f"structuring session record is duplicated: {directory.name}"
                    )
                self._records[session_id] = record
                self._idempotency[record.client_request_id] = session_id
            self.prune_expired()

    def create_or_get(
        self,
        request: OpenStructuringSession,
        *,
        capture_id: str,
        client_request_id: str,
        source_sha256: str,
        contract_set_sha256: str,
        batches: list[StructuringBatchContract],
    ) -> tuple[StructuringSessionContract, bool]:
        with self._lock:
            request_fingerprint = _request_fingerprint(
                request,
                capture_id=capture_id,
                client_request_id=client_request_id,
                source_sha256=source_sha256,
                contract_set_sha256=contract_set_sha256,
                batches=batches,
            )
            existing_id = self._idempotency.get(client_request_id)
            if existing_id is not None:
                existing = self._records[existing_id]
                if existing.current_fingerprint() != request_fingerprint:
                    raise StructuringSessionIdempotencyConflictError(client_request_id)
                return existing.session, False
            for existing in self._records.values():
                if existing.session.capture_id == capture_id:
                    raise StructuringSessionIdempotencyConflictError(client_request_id)
            if not batches:
                raise StructuringSessionTransitionError("structuring session has no batches")
            now = self._clock.now()
            session_id = str(uuid4())
            session = StructuringSessionContract(
                session_id=session_id,
                capture_id=capture_id,
                source_sha256=source_sha256,
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
                capture_id=capture_id,
                client_request_id=client_request_id,
                session=session,
                batches=records,
                request_fingerprint=request_fingerprint,
            )
            self._persist(record)
            self._records[session_id] = record
            self._idempotency[client_request_id] = session_id
            return session, True

    def get(self, session_id: str) -> StructuringSessionContract:
        with self._lock:
            return self._record(session_id).session

    def get_by_client_request(
        self,
        request: OpenStructuringSession,
        *,
        capture_id: str,
        client_request_id: str,
    ) -> StructuringSessionContract | None:
        """Return an idempotent open response, or reject key reuse with new input."""

        with self._lock:
            session_id = self._idempotency.get(client_request_id)
            if session_id is None:
                return None
            record = self._records.get(session_id)
            if record is None:
                raise StructuringSessionRecordCorruptError(
                    "structuring session idempotency index is dangling"
                )
            if record.request != request or record.capture_id != capture_id:
                raise StructuringSessionIdempotencyConflictError(client_request_id)
            return record.session

    def for_capture(self, capture_id: str) -> StructuringSessionContract:
        with self._lock:
            for record in self._records.values():
                if record.session.capture_id == capture_id:
                    return record.session
        raise StructuringSessionRecordNotFoundError(capture_id)

    def list_sessions(self) -> list[StructuringSessionContract]:
        with self._lock:
            return [record.session for record in self._records.values()]

    def batch(self, session_id: str, batch_index: int) -> StructuringBatchContract:
        with self._lock:
            record = self._record(session_id)
            if batch_index < 0 or batch_index >= len(record.batches):
                raise StructuringSessionRecordNotFoundError(str(batch_index))
            return record.batches[batch_index].batch

    def accepted_blocks(self, session_id: str) -> list[StructuringSemanticBlock]:
        with self._lock:
            record = self._record(session_id)
            accepted: list[StructuringSemanticBlock] = []
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
    ) -> StructuringSessionContract | None:
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
        blocks: list[StructuringSemanticBlock],
        completed_document: CaptureDocument | None = None,
    ) -> tuple[StructuringSessionContract, bool]:
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
            value = batch.batch
            domain_batch = StructuringBatch(
                session_id=value.session_id,
                capture_id=value.capture_id,
                batch_index=value.batch_index,
                batch_count=value.batch_count,
                source_segment_ids=tuple(value.source_segment_ids),
                provider_prompt=value.provider_prompt,
                provider_schema=value.provider_schema,
                num_ctx=value.num_ctx,
                num_predict=value.num_predict,
                batch_digest=value.batch_digest,
                status=value.status,
            )
            domain_batch.verify_digest(batch_digest)
            current = record.session
            domain = StructuringSession(
                session_id=current.session_id,
                capture_id=current.capture_id,
                source_sha256=current.source_sha256,
                contract_set_sha256=current.contract_set_sha256,
                schema_dialect=current.schema_dialect,
                batch_count=current.batch_count,
                next_batch_index=current.next_batch_index,
                status=current.status,
            ).accept_batch(batch_index)
            now = self._clock.now()
            is_final = domain.status is StructuringSessionStatus.COMPLETED
            updated_batch = batch.batch.model_copy(
                update={"status": domain_batch.accept().status},
            )
            updated_session = record.session.model_copy(
                update={
                    "next_batch_index": domain.next_batch_index,
                    "updated_at": now,
                    "status": domain.status,
                    "completed_at": now if is_final else None,
                }
            )
            updated_session = updated_session.model_copy(
                update={"session_digest": _session_digest(updated_session)}
            )
            updated_batches = list(record.batches)
            if record.historical is not None:
                updated_batches = [
                    StructuringBatchRecord(
                        batch=entry.batch,
                        accepted_blocks=entry.accepted_blocks,
                        idempotency_key=entry.idempotency_key,
                        submission_fingerprint=entry.submission_fingerprint,
                        response=(
                            None
                            if entry.response is None
                            else entry.response.model_copy(
                                update={"session_digest": _session_digest(entry.response)}
                            )
                        ),
                    )
                    for entry in updated_batches
                ]
            updated_batches[batch_index] = StructuringBatchRecord(
                batch=updated_batch,
                accepted_blocks=blocks,
                idempotency_key=idempotency_key,
                submission_fingerprint=submission_fingerprint,
                response=updated_session,
            )
            updated_record = StructuringSessionRecord(
                request=record.request,
                capture_id=record.capture_id,
                client_request_id=record.client_request_id,
                session=updated_session,
                batches=updated_batches,
                request_fingerprint=record.current_fingerprint(),
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
                self._idempotency.pop(record.client_request_id, None)
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
        atomic_json(directory / "metadata.json", record.dump())

    def _load(self, directory: Path) -> StructuringSessionRecord:
        session_id = _uuid(directory.name)
        payload = json.loads((directory / "metadata.json").read_text(encoding="utf-8"))
        request_payload = payload["request"]
        session_payload = payload["session"]
        if not isinstance(request_payload, dict) or not isinstance(session_payload, dict):
            raise StructuringSessionRecordCorruptError(directory.name)
        historical: _HistoricalForm | None = None
        if "clientRequestId" in request_payload:
            # Written by 0.10.x: the transport ids are in the body.
            if "captureId" in payload or "clientRequestId" in payload:
                raise StructuringSessionRecordCorruptError(directory.name)
            request, capture_id, client_request_id, capability = _project_historical_request(
                request_payload, directory.name
            )
            historical = _HistoricalForm(
                request_payload=request_payload,
                capability=capability,
                source_key=(
                    "rawSourceSha256" if "rawSourceSha256" in session_payload else "sourceSha256"
                ),
            )
        else:
            request = OpenStructuringSession.model_validate(request_payload)
            capture_id = _non_empty_text(payload.get("captureId"), directory.name)
            client_request_id = _non_empty_text(payload.get("clientRequestId"), directory.name)
            if not 1 <= len(client_request_id) <= 128:
                raise StructuringSessionRecordCorruptError(directory.name)
        session = _decode_stored_session(
            session_payload,
            historical=historical,
            record_name=directory.name,
        )
        if (
            session.session_id != session_id
            or session.capture_id != capture_id
            or session.target_language != request.target_language
            or session.provider_capability != request.provider_capability
            or session.schema_dialect != request.schema_dialect
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        batches_payload = payload["batches"]
        if not isinstance(batches_payload, list) or len(batches_payload) != session.batch_count:
            raise StructuringSessionRecordCorruptError(directory.name)
        batches: list[StructuringBatchRecord] = []
        for expected_index, entry in enumerate(batches_payload):
            if not isinstance(entry, dict):
                raise StructuringSessionRecordCorruptError(directory.name)
            batch = StructuringBatchContract.model_validate(entry["batch"])
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
                    StructuringSemanticBlock(
                        source_segment_id=block_model.source_segment_id,
                        type=block_model.type,
                        target_text=block_model.target_text,
                    )
                    for item in accepted
                    for block_model in [StructuringSemanticBlockContract.model_validate(item)]
                ]
            response_payload = entry.get("response")
            response = (
                None
                if response_payload is None
                else _decode_stored_session(
                    response_payload,
                    historical=historical,
                    record_name=directory.name,
                )
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
        request_fingerprint = payload.get("requestFingerprint")
        if (
            not isinstance(request_fingerprint, str)
            or re.fullmatch(r"[0-9a-f]{64}", request_fingerprint) is None
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        expected_fingerprint = (
            _request_fingerprint(
                request,
                capture_id=capture_id,
                client_request_id=client_request_id,
                source_sha256=session.source_sha256,
                contract_set_sha256=session.contract_set_sha256,
                batches=[entry.batch for entry in batches],
            )
            if historical is None
            else _historical_request_fingerprint(
                historical,
                source_sha256=session.source_sha256,
                contract_set_sha256=session.contract_set_sha256,
                batches=[entry.batch for entry in batches],
            )
        )
        if request_fingerprint != expected_fingerprint:
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
        completed_payload = payload.get("completedDocument")
        completed_document = (
            None
            if completed_payload is None
            else CaptureDocument.model_validate(project_stored_capture(completed_payload))
        )
        if session.status is StructuringSessionStatus.COMPLETED and completed_document is None:
            raise StructuringSessionRecordCorruptError(directory.name)
        if (
            session.status is not StructuringSessionStatus.COMPLETED
            and completed_document is not None
        ):
            raise StructuringSessionRecordCorruptError(directory.name)
        return StructuringSessionRecord(
            request=request,
            capture_id=capture_id,
            client_request_id=client_request_id,
            session=session,
            batches=batches,
            request_fingerprint=request_fingerprint,
            completed_document=completed_document,
            historical=historical,
        )


__all__ = [
    "StructuringSessionDigestConflictError",
    "StructuringSessionIdempotencyConflictError",
    "StructuringSessionRecordCorruptError",
    "StructuringSessionRecordNotFoundError",
    "StructuringSessionRepository",
    "StructuringSessionTransitionError",
]
