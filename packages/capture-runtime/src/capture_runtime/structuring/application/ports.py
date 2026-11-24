from __future__ import annotations

from typing import Protocol

from capture_runtime.contracts import (
    CaptureDocument,
    OpenStructuringSession,
    StructuringBatch,
    StructuringModelInstallation,
    StructuringSession,
)
from capture_runtime.structuring.domain.session import StructuringSemanticBlock


class SessionRepository(Protocol):
    def create_or_get(
        self,
        request: OpenStructuringSession,
        *,
        capture_id: str,
        client_request_id: str,
        source_sha256: str,
        contract_set_sha256: str,
        batches: list[StructuringBatch],
    ) -> tuple[StructuringSession, bool]: ...
    def get(self, session_id: str) -> StructuringSession: ...
    def get_by_client_request(
        self,
        request: OpenStructuringSession,
        *,
        capture_id: str,
        client_request_id: str,
    ) -> StructuringSession | None: ...
    def for_capture(self, capture_id: str) -> StructuringSession: ...
    def batch(self, session_id: str, batch_index: int) -> StructuringBatch: ...
    def accepted_blocks(self, session_id: str) -> list[StructuringSemanticBlock]: ...
    def replay_submission(
        self,
        session_id: str,
        *,
        batch_index: int,
        idempotency_key: str,
        submission_fingerprint: str,
    ) -> StructuringSession | None: ...
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
    ) -> tuple[StructuringSession, bool]: ...


class ModelInstallationRecordView(Protocol):
    @property
    def job(self) -> StructuringModelInstallation: ...


class ModelInstallationJobs(Protocol):
    def create_or_get(
        self, *, idempotency_key: str, request_fingerprint: str, option_id: str
    ) -> tuple[ModelInstallationRecordView, bool]: ...
    def get(self, installation_id: str) -> ModelInstallationRecordView: ...
    def update_job(
        self, installation_id: str, job: StructuringModelInstallation
    ) -> ModelInstallationRecordView: ...
