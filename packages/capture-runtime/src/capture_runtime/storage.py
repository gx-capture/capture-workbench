"""Atomic file-backed job repositories with recovery and retention."""

from __future__ import annotations

import json
import os
import shutil
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID, uuid4

from pydantic import ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocumentV1,
    CaptureFailureV1,
    CaptureJobStage,
    CaptureJobStatus,
    CaptureJobV1,
    CaptureSourceV1,
    RawCaptureV1,
    RuntimeInstallationStatus,
    RuntimeInstallationV1,
    StructuringMode,
)


class RecordNotFoundError(KeyError):
    pass


class IdempotencyConflictError(ValueError):
    pass


class TransitionRejectedError(ValueError):
    pass


def _identifier(value: str) -> str:
    try:
        parsed = UUID(value)
    except ValueError as error:
        raise RecordNotFoundError(value) from error
    if str(parsed) != value.lower():
        raise RecordNotFoundError(value)
    return str(parsed)


def _dump_model(model: Any) -> Any:
    return model.model_dump(mode="json", by_alias=True)


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


@dataclass(slots=True)
class CaptureRecord:
    job: CaptureJobV1
    idempotency_key: str
    request_fingerprint: str
    target_language: str | None
    commit_idempotency_key: str | None = None
    commit_fingerprint: str | None = None

    def dump(self) -> dict[str, object]:
        return {
            "job": _dump_model(self.job),
            "idempotencyKey": self.idempotency_key,
            "requestFingerprint": self.request_fingerprint,
            "targetLanguage": self.target_language,
            "commitIdempotencyKey": self.commit_idempotency_key,
            "commitFingerprint": self.commit_fingerprint,
        }

    @classmethod
    def load(cls, payload: dict[str, Any]) -> CaptureRecord:
        return cls(
            job=CaptureJobV1.model_validate(payload["job"]),
            idempotency_key=str(payload["idempotencyKey"]),
            request_fingerprint=str(payload["requestFingerprint"]),
            target_language=(
                None if payload.get("targetLanguage") is None else str(payload["targetLanguage"])
            ),
            commit_idempotency_key=(
                None
                if payload.get("commitIdempotencyKey") is None
                else str(payload["commitIdempotencyKey"])
            ),
            commit_fingerprint=(
                None
                if payload.get("commitFingerprint") is None
                else str(payload["commitFingerprint"])
            ),
        )


@dataclass(slots=True)
class InstallationRecord:
    job: RuntimeInstallationV1
    idempotency_key: str
    request_fingerprint: str

    def dump(self) -> dict[str, object]:
        return {
            "job": _dump_model(self.job),
            "idempotencyKey": self.idempotency_key,
            "requestFingerprint": self.request_fingerprint,
        }

    @classmethod
    def load(cls, payload: dict[str, Any]) -> InstallationRecord:
        return cls(
            job=RuntimeInstallationV1.model_validate(payload["job"]),
            idempotency_key=str(payload["idempotencyKey"]),
            request_fingerprint=str(payload["requestFingerprint"]),
        )


class CaptureRepository:
    def __init__(self, root: Path, *, clock: Clock, retention_hours: int) -> None:
        self.root = root
        self._clock = clock
        self._retention = timedelta(hours=retention_hours)
        self._records: dict[str, CaptureRecord] = {}
        self._idempotency: dict[str, str] = {}
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            self._records.clear()
            self._idempotency.clear()
            for directory in self.root.iterdir():
                metadata = directory / "metadata.json"
                if not directory.is_dir() or not metadata.is_file():
                    continue
                try:
                    payload = json.loads(metadata.read_text(encoding="utf-8"))
                    record = CaptureRecord.load(payload)
                    capture_id = _identifier(record.job.capture_id)
                except (
                    OSError,
                    KeyError,
                    TypeError,
                    ValueError,
                    ValidationError,
                    json.JSONDecodeError,
                ):
                    continue
                self._records[capture_id] = record
                self._idempotency[record.idempotency_key] = capture_id
            self.prune_expired()
            self.recover_interrupted()

    def create_or_get(
        self,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        source: CaptureSourceV1,
        structuring_mode: StructuringMode,
        target_language: str | None,
        staged_upload: Path,
    ) -> tuple[CaptureRecord, bool]:
        with self._lock:
            existing_id = self._idempotency.get(idempotency_key)
            if existing_id is not None:
                existing = self._records[existing_id]
                if existing.request_fingerprint != request_fingerprint:
                    raise IdempotencyConflictError(idempotency_key)
                return existing, False
            now = self._clock.now()
            capture_id = str(uuid4())
            job = CaptureJobV1(
                capture_id=capture_id,
                status=CaptureJobStatus.QUEUED,
                stage=CaptureJobStage.QUEUED,
                structuring_mode=structuring_mode,
                progress=0,
                source=source,
                created_at=now,
                updated_at=now,
            )
            record = CaptureRecord(
                job=job,
                idempotency_key=idempotency_key,
                request_fingerprint=request_fingerprint,
                target_language=target_language,
            )
            directory = self._directory(capture_id)
            directory.mkdir(parents=True, exist_ok=False)
            try:
                os.replace(staged_upload, directory / "source.bin")
            except OSError:
                directory.rmdir()
                raise
            self._records[capture_id] = record
            self._idempotency[idempotency_key] = capture_id
            self._persist(record)
            return record, True

    def get(self, capture_id: str) -> CaptureRecord:
        normalized = _identifier(capture_id)
        with self._lock:
            try:
                return self._records[normalized]
            except KeyError as error:
                raise RecordNotFoundError(capture_id) from error

    def update_job(self, capture_id: str, job: CaptureJobV1) -> CaptureRecord:
        with self._lock:
            record = self.get(capture_id)
            record.job = job
            self._persist(record)
            return record

    def transition_job(
        self,
        capture_id: str,
        *,
        allowed_statuses: set[CaptureJobStatus],
        updates: dict[str, object],
        allowed_stages: set[CaptureJobStage] | None = None,
    ) -> CaptureJobV1:
        with self._lock:
            record = self.get(capture_id)
            if record.job.status not in allowed_statuses or (
                allowed_stages is not None and record.job.stage not in allowed_stages
            ):
                raise TransitionRejectedError(capture_id)
            record.job = record.job.model_copy(update=updates)
            self._persist(record)
            return record.job

    def commit_host_result(
        self,
        capture_id: str,
        *,
        idempotency_key: str,
        fingerprint: str,
        result: CaptureDocumentV1,
    ) -> CaptureJobV1:
        with self._lock:
            record = self.get(capture_id)
            if record.job.status is CaptureJobStatus.COMPLETED:
                if (
                    record.commit_idempotency_key == idempotency_key
                    and record.commit_fingerprint == fingerprint
                ):
                    return record.job
                raise IdempotencyConflictError(idempotency_key)
            if (
                record.job.status is not CaptureJobStatus.RUNNING
                or record.job.stage is not CaptureJobStage.AWAITING_STRUCTURING
                or record.job.structuring_mode is not StructuringMode.HOST
            ):
                raise TransitionRejectedError(capture_id)
            _atomic_json(self._directory(capture_id) / "result.json", _dump_model(result))
            record.commit_idempotency_key = idempotency_key
            record.commit_fingerprint = fingerprint
            record.job = record.job.model_copy(
                update={
                    "status": CaptureJobStatus.COMPLETED,
                    "stage": CaptureJobStage.COMPLETED,
                    "progress": 1.0,
                    "updated_at": result.completed_at,
                    "completed_at": result.completed_at,
                }
            )
            (self._directory(capture_id) / "source.bin").unlink(missing_ok=True)
            self._persist(record)
            return record.job

    def fail_host_structure(
        self,
        capture_id: str,
        *,
        failure: CaptureFailureV1,
        completed_at: datetime,
    ) -> CaptureJobV1:
        with self._lock:
            record = self.get(capture_id)
            if (
                record.job.status is not CaptureJobStatus.RUNNING
                or record.job.stage is not CaptureJobStage.AWAITING_STRUCTURING
                or record.job.structuring_mode is not StructuringMode.HOST
            ):
                raise TransitionRejectedError(capture_id)
            record.job = record.job.model_copy(
                update={
                    "status": CaptureJobStatus.FAILED,
                    "stage": CaptureJobStage.FAILED,
                    "error": failure,
                    "updated_at": completed_at,
                    "completed_at": completed_at,
                }
            )
            (self._directory(capture_id) / "source.bin").unlink(missing_ok=True)
            self._persist(record)
            return record.job

    def complete_runtime_result(
        self, capture_id: str, *, result: CaptureDocumentV1
    ) -> CaptureJobV1:
        with self._lock:
            record = self.get(capture_id)
            if (
                record.job.status is not CaptureJobStatus.RUNNING
                or record.job.stage is not CaptureJobStage.STRUCTURING
            ):
                raise TransitionRejectedError(capture_id)
            _atomic_json(self._directory(capture_id) / "result.json", _dump_model(result))
            record.job = record.job.model_copy(
                update={
                    "status": CaptureJobStatus.COMPLETED,
                    "stage": CaptureJobStage.COMPLETED,
                    "progress": 1.0,
                    "updated_at": result.completed_at,
                    "completed_at": result.completed_at,
                }
            )
            (self._directory(capture_id) / "source.bin").unlink(missing_ok=True)
            self._persist(record)
            return record.job

    def read_upload(self, capture_id: str) -> bytes:
        self.get(capture_id)
        try:
            return (self._directory(capture_id) / "source.bin").read_bytes()
        except OSError as error:
            raise RecordNotFoundError(f"upload for {capture_id}") from error

    def delete_upload(self, capture_id: str) -> None:
        self.get(capture_id)
        (self._directory(capture_id) / "source.bin").unlink(missing_ok=True)

    def write_raw(self, capture_id: str, raw: RawCaptureV1) -> None:
        self.get(capture_id)
        _atomic_json(self._directory(capture_id) / "raw.json", _dump_model(raw))

    def read_raw(self, capture_id: str) -> RawCaptureV1:
        self.get(capture_id)
        try:
            return RawCaptureV1.model_validate_json(
                (self._directory(capture_id) / "raw.json").read_text(encoding="utf-8")
            )
        except (OSError, ValidationError) as error:
            raise RecordNotFoundError(f"raw for {capture_id}") from error

    def read_result(self, capture_id: str) -> CaptureDocumentV1:
        self.get(capture_id)
        try:
            return CaptureDocumentV1.model_validate_json(
                (self._directory(capture_id) / "result.json").read_text(encoding="utf-8")
            )
        except (OSError, ValidationError) as error:
            raise RecordNotFoundError(f"result for {capture_id}") from error

    def delete(self, capture_id: str) -> None:
        normalized = _identifier(capture_id)
        with self._lock:
            record = self.get(normalized)
            self._records.pop(normalized, None)
            self._idempotency.pop(record.idempotency_key, None)
            directory = self._directory(normalized)
            if directory.parent.resolve() != self.root.resolve():
                raise RuntimeError("capture directory escaped repository root")
            shutil.rmtree(directory, ignore_errors=True)

    def recover_interrupted(self) -> None:
        with self._lock:
            now = self._clock.now()
            for record in self._records.values():
                if record.job.status not in {CaptureJobStatus.QUEUED, CaptureJobStatus.RUNNING}:
                    continue
                record.job = record.job.model_copy(
                    update={
                        "status": CaptureJobStatus.FAILED,
                        "stage": CaptureJobStage.FAILED,
                        "progress": record.job.progress,
                        "error": CaptureFailureV1(
                            code="runtime_restarted",
                            message="Capture Runtime restarted before the job completed.",
                            stage="runtime",
                            retryable=True,
                        ),
                        "updated_at": now,
                        "completed_at": now,
                    }
                )
                self._persist(record)
                (self._directory(record.job.capture_id) / "source.bin").unlink(missing_ok=True)

    def prune_expired(self) -> None:
        with self._lock:
            cutoff = self._clock.now() - self._retention
            terminal = {
                CaptureJobStatus.COMPLETED,
                CaptureJobStatus.FAILED,
                CaptureJobStatus.CANCELLED,
            }
            expired = [
                capture_id
                for capture_id, record in self._records.items()
                if record.job.status in terminal and record.job.updated_at < cutoff
            ]
            for capture_id in expired:
                self.delete(capture_id)

    def _directory(self, capture_id: str) -> Path:
        return self.root / _identifier(capture_id)

    def _persist(self, record: CaptureRecord) -> None:
        _atomic_json(self._directory(record.job.capture_id) / "metadata.json", record.dump())


class InstallationRepository:
    def __init__(self, root: Path, *, clock: Clock, retention_hours: int) -> None:
        self.root = root
        self._clock = clock
        self._retention = timedelta(hours=retention_hours)
        self._records: dict[str, InstallationRecord] = {}
        self._idempotency: dict[str, str] = {}
        self._lock = threading.RLock()

    def initialize(self) -> None:
        with self._lock:
            self.root.mkdir(parents=True, exist_ok=True)
            self._records.clear()
            self._idempotency.clear()
            for directory in self.root.iterdir():
                metadata = directory / "metadata.json"
                if not directory.is_dir() or not metadata.is_file():
                    continue
                try:
                    payload = json.loads(metadata.read_text(encoding="utf-8"))
                    record = InstallationRecord.load(payload)
                    installation_id = _identifier(record.job.installation_id)
                except (
                    OSError,
                    KeyError,
                    TypeError,
                    ValueError,
                    ValidationError,
                    json.JSONDecodeError,
                ):
                    continue
                self._records[installation_id] = record
                self._idempotency[record.idempotency_key] = installation_id
            self.prune_expired()
            self.recover_interrupted()

    def create_or_get(
        self,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        requirement_id: str,
    ) -> tuple[InstallationRecord, bool]:
        with self._lock:
            existing_id = self._idempotency.get(idempotency_key)
            if existing_id is not None:
                existing = self._records[existing_id]
                if existing.request_fingerprint != request_fingerprint:
                    raise IdempotencyConflictError(idempotency_key)
                return existing, False
            now = self._clock.now()
            installation_id = str(uuid4())
            job = RuntimeInstallationV1(
                installation_id=installation_id,
                requirement_id=requirement_id,
                status=RuntimeInstallationStatus.QUEUED,
                progress=0,
                created_at=now,
                updated_at=now,
            )
            record = InstallationRecord(job, idempotency_key, request_fingerprint)
            self._records[installation_id] = record
            self._idempotency[idempotency_key] = installation_id
            self._persist(record)
            return record, True

    def get(self, installation_id: str) -> InstallationRecord:
        normalized = _identifier(installation_id)
        with self._lock:
            try:
                return self._records[normalized]
            except KeyError as error:
                raise RecordNotFoundError(installation_id) from error

    def list(self) -> list[RuntimeInstallationV1]:
        with self._lock:
            return sorted(
                (record.job for record in self._records.values()),
                key=lambda job: job.created_at,
                reverse=True,
            )

    def update_job(self, installation_id: str, job: RuntimeInstallationV1) -> InstallationRecord:
        with self._lock:
            record = self.get(installation_id)
            record.job = job
            self._persist(record)
            return record

    def recover_interrupted(self) -> None:
        with self._lock:
            now = self._clock.now()
            for record in self._records.values():
                if record.job.status not in {
                    RuntimeInstallationStatus.QUEUED,
                    RuntimeInstallationStatus.RUNNING,
                }:
                    continue
                record.job = record.job.model_copy(
                    update={
                        "status": RuntimeInstallationStatus.FAILED,
                        "error": CaptureFailureV1(
                            code="runtime_restarted",
                            message="Capture Runtime restarted before installation completed.",
                            stage="runtime",
                            retryable=True,
                        ),
                        "updated_at": now,
                        "completed_at": now,
                    }
                )
                self._persist(record)

    def prune_expired(self) -> None:
        with self._lock:
            cutoff = self._clock.now() - self._retention
            terminal = {
                RuntimeInstallationStatus.COMPLETED,
                RuntimeInstallationStatus.FAILED,
                RuntimeInstallationStatus.CANCELLED,
                RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
            }
            expired = [
                installation_id
                for installation_id, record in self._records.items()
                if record.job.status in terminal and record.job.updated_at < cutoff
            ]
            for installation_id in expired:
                record = self._records.pop(installation_id)
                self._idempotency.pop(record.idempotency_key, None)
                directory = self._directory(installation_id)
                if directory.parent.resolve() != self.root.resolve():
                    raise RuntimeError("installation directory escaped repository root")
                shutil.rmtree(directory, ignore_errors=True)

    def _directory(self, installation_id: str) -> Path:
        return self.root / _identifier(installation_id)

    def _persist(self, record: InstallationRecord) -> None:
        _atomic_json(self._directory(record.job.installation_id) / "metadata.json", record.dump())
