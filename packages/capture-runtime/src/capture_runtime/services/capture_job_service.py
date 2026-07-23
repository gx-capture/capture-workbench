"""Asynchronous capture and runtime-installation job orchestration."""

from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import suppress
from pathlib import Path

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocumentV1,
    CaptureFailureV1,
    CaptureJobStage,
    CaptureJobStatus,
    CaptureJobV1,
    CaptureSourceV1,
    RawCaptureV1,
    StructuringMode,
)
from capture_runtime.extractors import (
    CaptureExtractor,
    ExtractionRuntimeUnavailableError,
)
from capture_runtime.ollama import (
    RuntimeUnavailableError,
)
from capture_runtime.storage import (
    CaptureRepository,
    IdempotencyConflictError,
    RecordNotFoundError,
    TransitionRejectedError,
)
from capture_runtime.structuring import (
    CaptureStructuringProvider,
    StructuringValidationError,
    validate_structuring_candidate,
)

TERMINAL_CAPTURE_STATUSES = {
    CaptureJobStatus.COMPLETED,
    CaptureJobStatus.FAILED,
    CaptureJobStatus.CANCELLED,
}


class InvalidJobStateError(ValueError):
    pass


class RawUnavailableError(RecordNotFoundError):
    pass


class ResultUnavailableError(RecordNotFoundError):
    pass


class CaptureService:
    def __init__(
        self,
        repository: CaptureRepository,
        *,
        extractor: CaptureExtractor,
        structurer: CaptureStructuringProvider,
        clock: Clock,
    ) -> None:
        self.repository = repository
        self._extractor = extractor
        self._structurer = structurer
        self._clock = clock
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancellations: dict[str, asyncio.Event] = {}

    def create(
        self,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        source: CaptureSourceV1,
        structuring_mode: StructuringMode,
        target_language: str | None,
        staged_upload: Path,
    ) -> CaptureJobV1:
        record, created = self.repository.create_or_get(
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            source=source,
            structuring_mode=structuring_mode,
            target_language=target_language,
            staged_upload=staged_upload,
        )
        if created:
            cancellation = asyncio.Event()
            self._cancellations[record.job.capture_id] = cancellation
            task = asyncio.create_task(
                self._process(record.job.capture_id, cancellation),
                name=f"capture-{record.job.capture_id}",
            )
            self._tasks[record.job.capture_id] = task
            task.add_done_callback(self._capture_done)
        return record.job

    def get(self, capture_id: str) -> CaptureJobV1:
        return self.repository.get(capture_id).job

    def raw(self, capture_id: str) -> RawCaptureV1:
        self.get(capture_id)
        try:
            return self.repository.read_raw(capture_id)
        except RecordNotFoundError as error:
            raise RawUnavailableError(capture_id) from error

    def result(self, capture_id: str) -> CaptureDocumentV1:
        job = self.get(capture_id)
        if job.status is not CaptureJobStatus.COMPLETED:
            raise ResultUnavailableError(capture_id)
        try:
            return self.repository.read_result(capture_id)
        except RecordNotFoundError as error:
            raise ResultUnavailableError(capture_id) from error

    async def cancel(self, capture_id: str) -> CaptureJobV1:
        job = self.get(capture_id)
        if job.status in TERMINAL_CAPTURE_STATUSES:
            return job
        try:
            current = self.repository.transition_job(
                capture_id,
                allowed_statuses={CaptureJobStatus.QUEUED, CaptureJobStatus.RUNNING},
                updates=self._cancelled_updates(job),
            )
            self.repository.delete_upload(capture_id)
        except TransitionRejectedError:
            return self.get(capture_id)
        cancellation = self._cancellations.setdefault(capture_id, asyncio.Event())
        cancellation.set()
        task = self._tasks.get(capture_id)
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        return current

    async def delete(self, capture_id: str) -> None:
        await self.cancel(capture_id)
        self.repository.delete(capture_id)
        self._cancellations.pop(capture_id, None)

    def commit_host_result(
        self,
        capture_id: str,
        candidate: CaptureDocumentV1,
        *,
        idempotency_key: str,
    ) -> CaptureJobV1:
        record = self.repository.get(capture_id)
        fingerprint = hashlib.sha256(
            json.dumps(
                candidate.model_dump(mode="json", by_alias=True),
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        if record.job.status is CaptureJobStatus.COMPLETED:
            try:
                return self.repository.commit_host_result(
                    capture_id,
                    idempotency_key=idempotency_key,
                    fingerprint=fingerprint,
                    result=candidate,
                )
            except TransitionRejectedError as error:
                raise InvalidJobStateError("capture is already completed") from error
        if (
            record.job.structuring_mode is not StructuringMode.HOST
            or record.job.stage is not CaptureJobStage.AWAITING_STRUCTURING
        ):
            raise InvalidJobStateError("capture is not awaiting host structuring")
        raw = self.raw(capture_id)
        validated = validate_structuring_candidate(candidate, raw)
        completed_at = self._clock.now()
        committed = CaptureDocumentV1.model_validate(
            {
                **validated.model_dump(mode="json", by_alias=True),
                "completedAt": completed_at.isoformat(),
            }
        )
        try:
            return self.repository.commit_host_result(
                capture_id,
                idempotency_key=idempotency_key,
                fingerprint=fingerprint,
                result=committed,
            )
        except TransitionRejectedError as error:
            raise InvalidJobStateError("capture is no longer awaiting host structuring") from error

    def report_host_failure(self, capture_id: str, *, code: str, message: str) -> CaptureJobV1:
        record = self.repository.get(capture_id)
        if (
            record.job.structuring_mode is not StructuringMode.HOST
            or record.job.stage is not CaptureJobStage.AWAITING_STRUCTURING
        ):
            raise InvalidJobStateError("capture is not awaiting host structuring")
        now = self._clock.now()
        try:
            return self.repository.fail_host_structure(
                capture_id,
                failure=CaptureFailureV1(
                    code=code,
                    message=message,
                    stage="structuring",
                    retryable=False,
                ),
                completed_at=now,
            )
        except TransitionRejectedError as error:
            raise InvalidJobStateError("capture is no longer awaiting host structuring") from error

    def fail_invalid_host_structure(self, capture_id: str) -> CaptureJobV1:
        return self.report_host_failure(
            capture_id,
            code="structuring_invalid_output",
            message="Host structuring output failed strict schema or provenance validation.",
        )

    async def shutdown(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()

    def _capture_done(self, task: asyncio.Task[None]) -> None:
        capture_id = task.get_name().removeprefix("capture-")
        self._tasks.pop(capture_id, None)
        self._cancellations.pop(capture_id, None)

    async def _process(self, capture_id: str, cancellation: asyncio.Event) -> None:
        raw_written = False
        try:
            record = self.repository.get(capture_id)
            await asyncio.sleep(0)
            self._set_capture_state(
                record.job,
                status=CaptureJobStatus.RUNNING,
                stage=CaptureJobStage.EXTRACTING,
                progress=0.1,
            )
            content = self.repository.read_upload(capture_id)
            raw = await self._extractor.extract(content, record.job.source, cancellation)  # type: ignore[arg-type]
            self.repository.write_raw(capture_id, raw)
            raw_written = True
            current = self.get(capture_id)
            if current.structuring_mode is StructuringMode.HOST:
                self._set_capture_state(
                    current,
                    status=CaptureJobStatus.RUNNING,
                    stage=CaptureJobStage.AWAITING_STRUCTURING,
                    progress=0.55,
                )
                return
            self._set_capture_state(
                current,
                status=CaptureJobStatus.RUNNING,
                stage=CaptureJobStage.STRUCTURING,
                progress=0.65,
            )
            candidate = await self._structurer.structure(
                raw,
                target_language=record.target_language,
                cancel_event=cancellation,
            )
            document = validate_structuring_candidate(candidate, raw)
            expected_engine = self._structurer.engine_identity
            if expected_engine is None or document.structuring_engine != expected_engine:
                raise StructuringValidationError(
                    "structured output changed the runtime provider identity",
                    issues=[
                        {
                            "location": ["structuringEngine"],
                            "message": "must equal the active runtime provider identity",
                        }
                    ],
                )
            now = self._clock.now()
            document = CaptureDocumentV1.model_validate(
                {
                    **document.model_dump(mode="json", by_alias=True),
                    "completedAt": now.isoformat(),
                }
            )
            self.repository.complete_runtime_result(capture_id, result=document)
        except asyncio.CancelledError:
            if cancellation.is_set():
                current = self.get(capture_id)
                if current.status not in TERMINAL_CAPTURE_STATUSES:
                    self.repository.update_job(capture_id, self._cancelled_job(current))
                    self.repository.delete_upload(capture_id)
            raise
        except StructuringValidationError:
            self._fail_capture(
                capture_id,
                code="structuring_invalid_output",
                message="Structuring output failed strict schema or provenance validation.",
                stage="structuring",
                retryable=True,
            )
        except (RuntimeUnavailableError, ExtractionRuntimeUnavailableError):
            self._fail_capture(
                capture_id,
                code="requirement_unavailable",
                message="A required local capture runtime is unavailable.",
                stage="structuring" if raw_written else "extraction",
                retryable=True,
            )
        except TransitionRejectedError:
            return
        except Exception:
            self._fail_capture(
                capture_id,
                code="structuring_failed" if raw_written else "extraction_failed",
                message=(
                    "Capture structuring failed." if raw_written else "Source extraction failed."
                ),
                stage="structuring" if raw_written else "extraction",
                retryable=True,
            )

    def _set_capture_state(
        self,
        job: CaptureJobV1,
        *,
        status: CaptureJobStatus,
        stage: CaptureJobStage,
        progress: float,
    ) -> CaptureJobV1:
        return self.repository.transition_job(
            job.capture_id,
            allowed_statuses={CaptureJobStatus.QUEUED, CaptureJobStatus.RUNNING},
            updates={
                "status": status,
                "stage": stage,
                "progress": progress,
                "updated_at": self._clock.now(),
            },
        )

    def _fail_capture(
        self,
        capture_id: str,
        *,
        code: str,
        message: str,
        stage: str,
        retryable: bool,
    ) -> None:
        now = self._clock.now()
        try:
            self.repository.transition_job(
                capture_id,
                allowed_statuses={CaptureJobStatus.QUEUED, CaptureJobStatus.RUNNING},
                updates={
                    "status": CaptureJobStatus.FAILED,
                    "stage": CaptureJobStage.FAILED,
                    "error": CaptureFailureV1(
                        code=code,
                        message=message,
                        stage=stage,
                        retryable=retryable,
                    ),
                    "updated_at": now,
                    "completed_at": now,
                },
            )
            self.repository.delete_upload(capture_id)
        except TransitionRejectedError:
            return

    def _cancelled_job(self, job: CaptureJobV1) -> CaptureJobV1:
        return job.model_copy(update=self._cancelled_updates(job))

    def _cancelled_updates(self, job: CaptureJobV1) -> dict[str, object]:
        now = self._clock.now()
        return {
            "status": CaptureJobStatus.CANCELLED,
            "stage": CaptureJobStage.CANCELLED,
            "error": CaptureFailureV1(
                code="capture_cancelled",
                message="Capture was cancelled.",
                stage=job.stage.value,
                retryable=True,
            ),
            "updated_at": now,
            "completed_at": now,
        }


__all__ = [
    "CaptureService",
    "IdempotencyConflictError",
    "InvalidJobStateError",
    "RawUnavailableError",
    "RecordNotFoundError",
    "ResultUnavailableError",
    "StructuringValidationError",
]
