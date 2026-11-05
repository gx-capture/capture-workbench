"""Application service for durable pull-based structuring sessions."""

from __future__ import annotations

import hashlib
from collections.abc import Callable

from capture_runtime.capture.infrastructure.streaming_repository import (
    StreamingRecordNotFoundError,
    StreamingRepository,
)
from capture_runtime.clock import Clock
from capture_runtime.contract_set import canonical_json_bytes
from capture_runtime.contracts import (
    CaptureDocument,
    CaptureOperationV2,
    OpenStructuringSessionV2,
    RawCapture,
    StructuringBatchV2,
)
from capture_runtime.structuring.application.use_cases import (
    GetStructuringSession,
    OpenStructuringSession,
    SubmitStructuringBatch,
)
from capture_runtime.structuring.infrastructure.coordinator import StructuringCoordinator
from capture_runtime.structuring.infrastructure.structuring import (
    assemble_structuring_document,
    validate_structuring_batch,
)
from capture_runtime.structuring.infrastructure.structuring_session_repository import (
    StructuringSessionRepository,
)


def _batch_digest(batch: StructuringBatchV2) -> str:
    payload = batch.model_dump(
        mode="json",
        by_alias=True,
        exclude={"batch_digest", "status"},
    )
    return hashlib.sha256(canonical_json_bytes(payload)).hexdigest()


class StructuringSessionService:
    """Coordinate canonical planning, strict submissions, and v2 completion."""

    def __init__(
        self,
        repository: StructuringSessionRepository,
        streaming_repository: StreamingRepository,
        *,
        coordinator: StructuringCoordinator,
        clock: Clock,
        contract_set_sha256: str,
        host_result_committer: Callable[..., CaptureOperationV2] | None = None,
        host_result_discarder: Callable[[str], None] | None = None,
    ) -> None:
        self.validate_batch = validate_structuring_batch
        self.assemble_document = assemble_structuring_document
        self.repository = repository
        self.streaming_repository = streaming_repository
        self._coordinator = coordinator
        self._clock = clock
        self._contract_set_sha256 = contract_set_sha256
        self._host_result_committer = host_result_committer
        self._host_result_discarder = host_result_discarder

        self.open_use_case = OpenStructuringSession(self)
        self.submit_use_case = SubmitStructuringBatch(self)
        self.get_use_case = GetStructuringSession(self)

    def initialize(self) -> None:
        self.repository.initialize()
        self._recover_completed_sessions()

    def batch(self, session_id: str, batch_index: int) -> StructuringBatchV2:
        return self.repository.batch(session_id, batch_index)

    def _discard_host_result(self, capture_id: str) -> None:
        if self._host_result_discarder is not None:
            self._host_result_discarder(capture_id)

    def _commit_completed_capture(
        self,
        capture_id: str,
        session_id: str,
        document: CaptureDocument,
    ) -> None:
        committer = self._host_result_committer
        if committer is None:
            self.streaming_repository.write_result(capture_id, document)
            self.streaming_repository.complete_capture(capture_id)
            return
        committer(
            capture_id,
            document,
            idempotency_key=f"pull-structuring-{session_id}",
        )

    def _planned_batches(
        self,
        raw: RawCapture,
        request: OpenStructuringSessionV2,
    ) -> list[StructuringBatchV2]:
        plans = self._coordinator.plan_requests(
            raw,
            target_language=request.target_language,
            profile_id=request.provider_capability.provider.model,
        )
        batches: list[StructuringBatchV2] = []
        batch_count = len(plans)
        for index, planned in enumerate(plans):
            batch = StructuringBatchV2(
                session_id="pending",
                capture_id=request.capture_id,
                batch_index=index,
                batch_count=batch_count,
                source_segment_ids=[
                    str(getattr(segment, "segment_id", "")) for segment in planned.plan.segments
                ],
                provider_prompt=planned.prompt,
                provider_schema=planned.schema,
                num_ctx=planned.num_ctx,
                num_predict=planned.num_predict,
                batch_digest="0" * 64,
                status="ready",
            )
            batch = batch.model_copy(update={"batch_digest": _batch_digest(batch)})
            # Session ID participates in the digest, so create the real session
            # ID first and rebind descriptors in the repository create call.
            batches.append(batch)
        # The repository assigns the session identifier; use a stable placeholder
        # only while deriving the plan, then replace it in create_or_get.
        return batches

    def _recover_completed_sessions(self) -> None:
        for session in self.repository.list_sessions():
            document = self.repository.completed_document(session.session_id)
            if document is None:
                continue
            try:
                operation = self.streaming_repository.get_capture(session.capture_id)
            except StreamingRecordNotFoundError:
                continue
            if operation.status.value == "completed":
                continue
            self._commit_completed_capture(session.capture_id, session.session_id, document)


__all__ = ["StructuringSessionService"]
