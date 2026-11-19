"""Durable repository for runtime installation jobs."""

from __future__ import annotations

import hashlib
import json
import shutil
import threading
from dataclasses import dataclass
from datetime import timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

from pydantic import ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contract_set import canonical_json_bytes
from capture_runtime.contracts import (
    OperationFailure,
    RuntimeInstallation,
    RuntimeInstallationStatus,
)
from capture_runtime.storage.common import (
    IdempotencyConflictError,
    RecordNotFoundError,
    atomic_json,
    dump_model,
    project_stored_requirement_id,
    record_identifier,
)


def _installation_fingerprint(requirement_id: str) -> str:
    return hashlib.sha256(
        canonical_json_bytes({"requirementId": requirement_id, "consent": True})
    ).hexdigest()


@dataclass(slots=True)
class InstallationRecord:
    job: RuntimeInstallation
    idempotency_key: str
    request_fingerprint: str
    historical_requirement_id: str | None = None

    def dump(self) -> dict[str, object]:
        job = dump_model(self.job)
        if self.historical_requirement_id is not None:
            job["requirementId"] = self.historical_requirement_id
        return {
            "job": job,
            "idempotencyKey": self.idempotency_key,
            "requestFingerprint": self.request_fingerprint,
        }

    @classmethod
    def load(cls, payload: dict[str, Any]) -> InstallationRecord:
        job = payload["job"]
        historical_requirement_id = None
        if isinstance(job, dict):
            stored_id = job.get("requirementId")
            current_id = project_stored_requirement_id(stored_id)
            if current_id != stored_id:
                historical_requirement_id = stored_id
                job = {**job, "requirementId": current_id}
        return cls(
            job=RuntimeInstallation.model_validate(job),
            idempotency_key=str(payload["idempotencyKey"]),
            request_fingerprint=str(payload["requestFingerprint"]),
            historical_requirement_id=historical_requirement_id,
        )


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
                    installation_id = record_identifier(record.job.installation_id)
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
                if existing.job.requirement_id != requirement_id or not (
                    existing.request_fingerprint == request_fingerprint
                    or (
                        existing.historical_requirement_id is not None
                        and existing.request_fingerprint
                        == _installation_fingerprint(existing.historical_requirement_id)
                        and request_fingerprint == _installation_fingerprint(requirement_id)
                    )
                ):
                    raise IdempotencyConflictError(idempotency_key)
                return existing, False
            now = self._clock.now()
            installation_id = str(uuid4())
            job = RuntimeInstallation(
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
        normalized = record_identifier(installation_id)
        with self._lock:
            try:
                return self._records[normalized]
            except KeyError as error:
                raise RecordNotFoundError(installation_id) from error

    def list(self) -> list[RuntimeInstallation]:
        with self._lock:
            return sorted(
                (record.job for record in self._records.values()),
                key=lambda job: job.created_at,
                reverse=True,
            )

    def update_job(self, installation_id: str, job: RuntimeInstallation) -> InstallationRecord:
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
                        "error": OperationFailure(
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
        return self.root / record_identifier(installation_id)

    def _persist(self, record: InstallationRecord) -> None:
        atomic_json(self._directory(record.job.installation_id) / "metadata.json", record.dump())


__all__ = ["InstallationRecord", "InstallationRepository"]
