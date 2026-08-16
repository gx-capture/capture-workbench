"""Application service for durable pull-based structuring sessions."""

from __future__ import annotations

import hashlib
import json

from capture_runtime.clock import Clock
from capture_runtime.contract_set import SCHEMA_DIALECT, canonical_json_bytes
from capture_runtime.contracts import (
    CaptureDocument,
    OpenStructuringSessionV2,
    RawCapture,
    StructuringBatchV2,
    StructuringSessionV2,
    SubmitStructuringBatchV2,
)
from capture_runtime.storage import (
    StreamingRecordNotFoundError,
    StreamingRepository,
    StreamingTransitionError,
    StructuringSessionDigestConflictError,
    StructuringSessionRepository,
)
from capture_runtime.structuring import (
    StructuringCoordinator,
    StructuringValidationError,
    assemble_structuring_document,
    validate_structuring_batch,
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
    ) -> None:
        self.repository = repository
        self.streaming_repository = streaming_repository
        self._coordinator = coordinator
        self._clock = clock
        self._contract_set_sha256 = contract_set_sha256

    def initialize(self) -> None:
        self.repository.initialize()
        self._recover_completed_sessions()

    def open(self, request: OpenStructuringSessionV2) -> StructuringSessionV2:
        if request.schema_dialect != SCHEMA_DIALECT:
            raise StreamingTransitionError("unsupported structuring schema dialect")
        existing = self.repository.get_by_client_request(request)
        if existing is not None:
            return existing
        operation = self.streaming_repository.get_capture(request.capture_id)
        capture_request = self.streaming_repository.capture_request(request.capture_id)
        if capture_request.structuring_mode.value != "host":
            raise StreamingTransitionError("pull structuring requires host capture mode")
        if operation.status.value not in {"awaiting_structuring", "structuring"}:
            raise StreamingTransitionError("capture is not awaiting pull structuring")
        raw = self.streaming_repository.read_raw(request.capture_id)
        planned = self._planned_batches(raw, request)
        return self.repository.create_or_get(
            request,
            raw_source_sha256=raw.source.sha256,
            contract_set_sha256=self._contract_set_sha256,
            batches=planned,
        )[0]

    def get(self, session_id: str) -> StructuringSessionV2:
        return self.repository.get(session_id)

    def get_for_capture(self, capture_id: str) -> StructuringSessionV2:
        return self.repository.for_capture(capture_id)

    def batch(self, session_id: str, batch_index: int) -> StructuringBatchV2:
        return self.repository.batch(session_id, batch_index)

    def submit(
        self,
        session_id: str,
        batch_index: int,
        payload: SubmitStructuringBatchV2,
        *,
        idempotency_key: str,
    ) -> StructuringSessionV2:
        session = self.repository.get(session_id)
        batch = self.repository.batch(session_id, batch_index)
        submission_fingerprint = hashlib.sha256(
            canonical_json_bytes(payload.model_dump(mode="json", by_alias=True))
        ).hexdigest()
        replay = self.repository.replay_submission(
            session_id,
            batch_index=batch_index,
            idempotency_key=idempotency_key,
            submission_fingerprint=submission_fingerprint,
        )
        if replay is not None:
            self._recover_completed_sessions()
            return replay
        if payload.batch_digest != batch.batch_digest:
            raise StructuringSessionDigestConflictError(payload.batch_digest)
        raw = self.streaming_repository.read_raw(session.capture_id)
        segments_by_id = {segment.segment_id: segment for segment in raw.segments}
        segments = []
        for segment_id in batch.source_segment_ids:
            segment = segments_by_id.get(segment_id)
            if segment is None:
                raise StructuringValidationError(
                    "persisted structuring batch references an unknown raw segment"
                )
            segments.append(segment)
        semantic_blocks = [
            block.model_dump(mode="json", by_alias=True, exclude_none=True)
            for block in payload.blocks
        ]
        accepted_before = self.repository.accepted_blocks(session_id)
        candidate = json.dumps(
            {"blocks": semantic_blocks}, ensure_ascii=False, separators=(",", ":")
        )
        validate_structuring_batch(
            candidate,
            tuple(segments),
            target_language=session.target_language,
            order_offset=len(accepted_before),
        )
        completed_document: CaptureDocument | None = None
        if batch_index + 1 == session.batch_count:
            completed_document = self._assemble_final_document(
                session,
                raw,
                current_blocks=semantic_blocks,
            )
        updated_session, _ = self.repository.submit(
            session_id,
            batch_index=batch_index,
            batch_digest=payload.batch_digest,
            idempotency_key=idempotency_key,
            submission_fingerprint=submission_fingerprint,
            blocks=semantic_blocks,
            completed_document=completed_document,
        )
        if completed_document is not None:
            self.streaming_repository.write_result(session.capture_id, completed_document)
            self.streaming_repository.complete_capture(session.capture_id)
        return updated_session

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

    def _assemble_final_document(
        self,
        session: StructuringSessionV2,
        raw: RawCapture,
        *,
        current_blocks: list[dict[str, object]],
    ) -> CaptureDocument:
        all_semantics = [*self.repository.accepted_blocks(session.session_id), *current_blocks]
        segments_by_id = {segment.segment_id: segment for segment in raw.segments}
        blocks: list[dict[str, object]] = []
        cursor = 0
        offset = 0
        for batch_index in range(session.batch_count):
            batch = self.repository.batch(session.session_id, batch_index)
            count = len(batch.source_segment_ids)
            segments = tuple(segments_by_id[segment_id] for segment_id in batch.source_segment_ids)
            blocks.extend(
                validate_structuring_batch(
                    json.dumps(
                        {"blocks": all_semantics[cursor : cursor + count]},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    segments,
                    target_language=session.target_language,
                    order_offset=offset,
                )
            )
            cursor += count
            offset += count
        if cursor != len(all_semantics):
            raise StructuringValidationError(
                "submitted structuring batches do not cover raw capture"
            )
        completed_at = self._clock.now()
        return CaptureDocument.model_validate(
            assemble_structuring_document(
                raw,
                blocks,
                engine_identity=session.provider_capability.provider,
                completed_at=completed_at,
            )
        )

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
            self.streaming_repository.write_result(session.capture_id, document)
            self.streaming_repository.complete_capture(session.capture_id)


__all__ = ["StructuringSessionService"]
