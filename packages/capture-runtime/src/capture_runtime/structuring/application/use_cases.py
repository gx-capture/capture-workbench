"""Use cases for structuring and model installation."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Awaitable, Callable

from capture_runtime.capture.application.ports import CaptureRepository
from capture_runtime.capture.domain.operation import (
    CaptureOperation,
    CaptureTransitionError,
)
from capture_runtime.clock import Clock
from capture_runtime.contract_set import SCHEMA_DIALECT, canonical_json_bytes
from capture_runtime.contracts import (
    CaptureDocument,
    OpenStructuringSessionV2,
    RawCapture,
    RuntimeModelInstallationV2,
    StructuringBatchV2,
    StructuringSessionV2,
    SubmitStructuringBatchV2,
)
from capture_runtime.structuring.application.ports import ModelInstallationJobs, SessionRepository
from capture_runtime.structuring.domain.installation.models import TERMINAL_STATUSES
from capture_runtime.structuring.domain.session import StructuringSemanticBlock
from capture_runtime.structuring.domain.session.models import (
    SessionTransitionError,
    StructuringSession,
    StructuringSessionDigestConflictError,
    StructuringValidationError,
)


class OpenStructuringSession:
    """Open a durable pull-based structuring session for host-mode capture."""

    def __init__(
        self,
        repository: SessionRepository,
        captures: CaptureRepository,
        *,
        plan_batches: Callable[[RawCapture, OpenStructuringSessionV2], list[StructuringBatchV2]],
        contract_set_sha256: str,
    ) -> None:
        self._repository = repository
        self._captures = captures
        self._plan_batches = plan_batches
        self._contract_set_sha256 = contract_set_sha256

    def execute(self, request: OpenStructuringSessionV2) -> StructuringSessionV2:
        if request.schema_dialect != SCHEMA_DIALECT:
            raise SessionTransitionError("unsupported structuring schema dialect")
        existing = self._repository.get_by_client_request(request)
        if existing is not None:
            return existing
        operation = self._captures.get_capture(request.capture_id)
        capture_request = self._captures.capture_request(request.capture_id)
        try:
            CaptureOperation.from_contract(operation).require_pull_structuring(
                capture_request.structuring_mode
            )
        except CaptureTransitionError as error:
            raise SessionTransitionError(str(error)) from error
        raw = self._captures.read_raw(request.capture_id)
        planned = self._plan_batches(raw, request)
        return self._repository.create_or_get(
            request,
            raw_source_sha256=raw.source.sha256,
            contract_set_sha256=self._contract_set_sha256,
            batches=planned,
        )[0]


class SubmitStructuringBatch:
    """Submit a batch of semantic blocks to an open structuring session."""

    def __init__(
        self,
        repository: SessionRepository,
        captures: CaptureRepository,
        *,
        clock: Clock,
        validate_batch: Callable[..., list[dict[str, object]]],
        assemble_document: Callable[..., dict[str, object]],
        discard_result: Callable[[str], None],
        recover: Callable[[], None],
        commit_result: Callable[[str, str, CaptureDocument], None],
    ) -> None:
        self._repository = repository
        self._captures = captures
        self._clock = clock
        self._validate_batch = validate_batch
        self._assemble_document = assemble_document
        self._discard_result = discard_result
        self._recover = recover
        self._commit_result = commit_result

    def execute(
        self,
        session_id: str,
        batch_index: int,
        payload: SubmitStructuringBatchV2,
        *,
        idempotency_key: str,
    ) -> StructuringSessionV2:
        session = self._repository.get(session_id)
        try:
            return self._submit_session(
                session,
                batch_index,
                payload,
                idempotency_key=idempotency_key,
            )
        except Exception:
            self._discard_result(session.capture_id)
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
        batch = self._repository.batch(session_id, batch_index)
        submission_fingerprint = hashlib.sha256(
            canonical_json_bytes(payload.model_dump(mode="json", by_alias=True))
        ).hexdigest()
        replay = self._repository.replay_submission(
            session_id,
            batch_index=batch_index,
            idempotency_key=idempotency_key,
            submission_fingerprint=submission_fingerprint,
        )
        if replay is not None:
            self._recover()
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
        raw = self._captures.read_raw(session.capture_id)
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
        accepted_before = self._repository.accepted_blocks(session_id)
        candidate = json.dumps(
            {"blocks": semantic_blocks}, ensure_ascii=False, separators=(",", ":")
        )
        self._validate_batch(
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
        updated_session, _ = self._repository.submit(
            session_id,
            batch_index=batch_index,
            batch_digest=payload.batch_digest,
            idempotency_key=idempotency_key,
            submission_fingerprint=submission_fingerprint,
            blocks=domain_blocks,
            completed_document=completed_document,
        )
        if completed_document is not None:
            self._commit_result(session.capture_id, session.session_id, completed_document)
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
                *self._repository.accepted_blocks(session.session_id),
                *current_blocks,
            ]
        ]
        segments_by_id = {segment.segment_id: segment for segment in raw.segments}
        blocks: list[dict[str, object]] = []
        cursor = 0
        offset = 0
        for batch_index in range(session.batch_count):
            batch = self._repository.batch(session.session_id, batch_index)
            count = len(batch.source_segment_ids)
            segments = tuple(segments_by_id[segment_id] for segment_id in batch.source_segment_ids)
            blocks.extend(
                self._validate_batch(
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
            self._assemble_document(
                raw,
                blocks,
                engine_identity=session.provider_capability.provider,
                completed_at=completed_at,
            )
        )


class GetStructuringSession:
    """Retrieve an existing structuring session."""

    def __init__(self, repository: SessionRepository) -> None:
        self._repository = repository

    def execute(self, capture_id: str) -> StructuringSessionV2:
        return self._repository.for_capture(capture_id)


class InstallModelOption:
    """Create once before scheduling a model download."""

    def __init__(
        self, repository: ModelInstallationJobs, *, schedule: Callable[[str], None]
    ) -> None:
        self._repository = repository
        self._schedule = schedule

    def execute(
        self, *, idempotency_key: str, request_fingerprint: str, option_id: str
    ) -> RuntimeModelInstallationV2:
        record, created = self._repository.create_or_get(
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            option_id=option_id,
        )
        if created:
            self._schedule(record.job.installation_id)
        return record.job


class CancelModelInstallation:
    """Stop the owned task before persisting its cancellation checkpoint."""

    def __init__(
        self,
        repository: ModelInstallationJobs,
        *,
        stop: Callable[[str], Awaitable[None]],
        cancelled: Callable[[RuntimeModelInstallationV2], RuntimeModelInstallationV2],
    ) -> None:
        self._repository = repository
        self._stop = stop
        self._cancelled = cancelled

    async def execute(self, installation_id: str) -> RuntimeModelInstallationV2:
        job = self._repository.get(installation_id).job
        if job.status in TERMINAL_STATUSES:
            return job
        await self._stop(installation_id)
        current = self._repository.get(installation_id).job
        if current.status not in TERMINAL_STATUSES:
            self._repository.update_job(installation_id, self._cancelled(current))
        return self._repository.get(installation_id).job


class GetModelInstallation:
    def __init__(self, repository: ModelInstallationJobs) -> None:
        self._repository = repository

    def execute(self, installation_id: str) -> RuntimeModelInstallationV2:
        return self._repository.get(installation_id).job


__all__ = [
    "CancelModelInstallation",
    "GetModelInstallation",
    "GetStructuringSession",
    "InstallModelOption",
    "OpenStructuringSession",
    "SubmitStructuringBatch",
]
