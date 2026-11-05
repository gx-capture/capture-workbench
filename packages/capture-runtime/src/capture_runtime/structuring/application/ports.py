from __future__ import annotations

from typing import Protocol

from capture_runtime.contracts import (
    CaptureDocument,
    OpenStructuringSessionV2,
    RuntimeModelInstallationV2,
    StructuringBatchV2,
    StructuringSessionV2,
)
from capture_runtime.structuring.domain.session import StructuringSemanticBlock


class SessionRepository(Protocol):
    def create_or_get(
        self,
        request: OpenStructuringSessionV2,
        *,
        raw_source_sha256: str,
        contract_set_sha256: str,
        batches: list[StructuringBatchV2],
    ) -> tuple[StructuringSessionV2, bool]: ...
    def get(self, session_id: str) -> StructuringSessionV2: ...
    def get_by_client_request(
        self, request: OpenStructuringSessionV2
    ) -> StructuringSessionV2 | None: ...
    def for_capture(self, capture_id: str) -> StructuringSessionV2: ...
    def batch(self, session_id: str, batch_index: int) -> StructuringBatchV2: ...
    def accepted_blocks(self, session_id: str) -> list[StructuringSemanticBlock]: ...
    def replay_submission(
        self,
        session_id: str,
        *,
        batch_index: int,
        idempotency_key: str,
        submission_fingerprint: str,
    ) -> StructuringSessionV2 | None: ...
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
    ) -> tuple[StructuringSessionV2, bool]: ...


class ModelInstallationRecordView(Protocol):
    @property
    def job(self) -> RuntimeModelInstallationV2: ...


class ModelInstallationJobs(Protocol):
    def create_or_get(
        self, *, idempotency_key: str, request_fingerprint: str, option_id: str
    ) -> tuple[ModelInstallationRecordView, bool]: ...
    def get(self, installation_id: str) -> ModelInstallationRecordView: ...
    def update_job(
        self, installation_id: str, job: RuntimeModelInstallationV2
    ) -> ModelInstallationRecordView: ...
