"""Use cases for structuring and model installation."""

from __future__ import annotations

import hashlib
import json
from typing import TYPE_CHECKING

from capture_runtime.capture.domain.operation.models import (
    CaptureTransitionError as StreamingTransitionError,
)
from capture_runtime.contract_set import SCHEMA_DIALECT, canonical_json_bytes
from capture_runtime.contracts import (
    CaptureDocument,
    OpenStructuringSessionV2,
    RawCapture,
    RuntimeModelInstallationV2,
    StructuringSessionV2,
    SubmitStructuringBatchV2,
)
from capture_runtime.structuring.domain.session import StructuringSemanticBlock
from capture_runtime.structuring.domain.session.models import (
    StructuringSession,
    StructuringSessionDigestConflictError,
    StructuringValidationError,
)

if TYPE_CHECKING:
    from capture_runtime.structuring.application.model_installation_service import (
        ModelInstallationService,
    )
    from capture_runtime.structuring.application.structuring_session_service import (
        StructuringSessionService,
    )


class OpenStructuringSession:
    """Open a durable pull-based structuring session for host-mode capture."""

    def __init__(self, service: StructuringSessionService) -> None:
        self._service = service

    def execute(self, request: OpenStructuringSessionV2) -> StructuringSessionV2:
        if request.schema_dialect != SCHEMA_DIALECT:
            raise StreamingTransitionError("unsupported structuring schema dialect")
        existing = self._service.repository.get_by_client_request(request)
        if existing is not None:
            return existing
        operation = self._service.streaming_repository.get_capture(request.capture_id)
        capture_request = self._service.streaming_repository.capture_request(request.capture_id)
        if capture_request.structuring_mode.value != "host":
            raise StreamingTransitionError("pull structuring requires host capture mode")
        if operation.status.value not in {"awaiting_structuring", "structuring"}:
            raise StreamingTransitionError("capture is not awaiting pull structuring")
        raw = self._service.streaming_repository.read_raw(request.capture_id)
        planned = self._service._planned_batches(raw, request)
        return self._service.repository.create_or_get(
            request,
            raw_source_sha256=raw.source.sha256,
            contract_set_sha256=self._service._contract_set_sha256,
            batches=planned,
        )[0]


class SubmitStructuringBatch:
    """Submit a batch of semantic blocks to an open structuring session."""

    def __init__(self, service: StructuringSessionService) -> None:
        self._service = service

    def execute(
        self,
        session_id: str,
        batch_index: int,
        payload: SubmitStructuringBatchV2,
        *,
        idempotency_key: str,
    ) -> StructuringSessionV2:
        session = self._service.repository.get(session_id)
        try:
            return self._submit_session(
                session,
                batch_index,
                payload,
                idempotency_key=idempotency_key,
            )
        except Exception:
            self._service._discard_host_result(session.capture_id)
            raise

    def _submit_session(
        self,
        session: StructuringSessionV2,
        batch_index: int,
        payload: SubmitStructuringBatchV2,
        *,
        idempotency_key: str,
    ) -> StructuringSessionV2:
        session_id = session.session_id
        batch = self._service.repository.batch(session_id, batch_index)
        submission_fingerprint = hashlib.sha256(
            canonical_json_bytes(payload.model_dump(mode="json", by_alias=True))
        ).hexdigest()
        replay = self._service.repository.replay_submission(
            session_id,
            batch_index=batch_index,
            idempotency_key=idempotency_key,
            submission_fingerprint=submission_fingerprint,
        )
        if replay is not None:
            self._service._recover_completed_sessions()
            return replay
        if payload.batch_digest != batch.batch_digest:
            raise StructuringSessionDigestConflictError(payload.batch_digest)
        # Reject an out-of-order final batch before assembling a document from
        # an incomplete prefix. The repository rechecks under its write lock.
        StructuringSession.require_next_batch(
            session.status,
            session.next_batch_index,
            batch_index,
        )
        raw = self._service.streaming_repository.read_raw(session.capture_id)
        segments_by_id = {segment.segment_id: segment for segment in raw.segments}
        segments = []
        for segment_id in batch.source_segment_ids:
            segment = segments_by_id.get(segment_id)
            if segment is None:
                raise StructuringValidationError(
                    "persisted structuring batch references an unknown raw segment"
                )
            segments.append(segment)
        domain_blocks = [
            StructuringSemanticBlock(
                source_segment_id=block.source_segment_id,
                type=block.type,
                target_text=block.target_text,
            )
            for block in payload.blocks
        ]
        semantic_blocks = [block.dump() for block in domain_blocks]
        accepted_before = self._service.repository.accepted_blocks(session_id)
        candidate = json.dumps(
            {"blocks": semantic_blocks}, ensure_ascii=False, separators=(",", ":")
        )
        self._service.validate_batch(
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
                current_blocks=domain_blocks,
            )
        updated_session, _ = self._service.repository.submit(
            session_id,
            batch_index=batch_index,
            batch_digest=payload.batch_digest,
            idempotency_key=idempotency_key,
            submission_fingerprint=submission_fingerprint,
            blocks=domain_blocks,
            completed_document=completed_document,
        )
        if completed_document is not None:
            self._service._commit_completed_capture(
                session.capture_id, session.session_id, completed_document
            )
        return updated_session

    def _assemble_final_document(
        self,
        session: StructuringSessionV2,
        raw: RawCapture,
        *,
        current_blocks: list[StructuringSemanticBlock],
    ) -> CaptureDocument:
        all_semantics = [
            b.dump()
            for b in [
                *self._service.repository.accepted_blocks(session.session_id),
                *current_blocks,
            ]
        ]
        segments_by_id = {segment.segment_id: segment for segment in raw.segments}
        blocks: list[dict[str, object]] = []
        cursor = 0
        offset = 0
        for batch_index in range(session.batch_count):
            batch = self._service.repository.batch(session.session_id, batch_index)
            count = len(batch.source_segment_ids)
            segments = tuple(segments_by_id[segment_id] for segment_id in batch.source_segment_ids)
            blocks.extend(
                self._service.validate_batch(
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
        completed_at = self._service._clock.now()
        return CaptureDocument.model_validate(
            self._service.assemble_document(
                raw,
                blocks,
                engine_identity=session.provider_capability.provider,
                completed_at=completed_at,
            )
        )


class GetStructuringSession:
    """Retrieve an existing structuring session."""

    def __init__(self, service: StructuringSessionService) -> None:
        self._service = service

    def execute(self, capture_id: str) -> StructuringSessionV2:
        return self._service.repository.for_capture(capture_id)


class InstallModelOption:
    """Start asynchronous installation for an allowlisted model option."""

    def __init__(self, service: ModelInstallationService) -> None:
        self._service = service

    def execute(
        self,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        option_id: str,
    ) -> RuntimeModelInstallationV2:
        return self._service.create(
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            option_id=option_id,
        )


class CancelModelInstallation:
    """Cancel an ongoing model installation job."""

    def __init__(self, service: ModelInstallationService) -> None:
        self._service = service

    async def execute(self, installation_id: str) -> RuntimeModelInstallationV2:
        return await self._service.cancel(installation_id)


class GetModelInstallation:
    """Retrieve the status and progress of a model option installation."""

    def __init__(self, service: ModelInstallationService) -> None:
        self._service = service

    def execute(self, installation_id: str) -> RuntimeModelInstallationV2:
        return self._service.get(installation_id)


__all__ = [
    "CancelModelInstallation",
    "GetModelInstallation",
    "GetStructuringSession",
    "InstallModelOption",
    "OpenStructuringSession",
    "SubmitStructuringBatch",
]
