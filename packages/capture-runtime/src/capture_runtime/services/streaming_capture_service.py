"""Application service for authenticated v2 streaming capture routes."""

from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import suppress
from pathlib import Path

from pydantic import ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureDocument,
    CaptureEventV2,
    CaptureFailureV2,
    CaptureOperationV2,
    CaptureSource,
    CaptureSourceKind,
    CaptureStreamingResult,
    FinalizeIngestionV2,
    IngestionV2,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCapture,
    StartCaptureV2,
    StreamingCaptureStatus,
    StreamingEventType,
    StructuringMode,
)
from capture_runtime.extractors import (
    CaptureExtractor,
    ExtractionRuntimeUnavailableError,
    UnsupportedMediaError,
)
from capture_runtime.ollama.lifecycle_impl import RuntimeUnavailableError
from capture_runtime.progressive_audio import ProgressiveAudioError, ProgressiveSessionEvent
from capture_runtime.progressive_capture import (
    ProgressiveCaptureError,
    ProgressiveCaptureProcessor,
)
from capture_runtime.progressive_decoder import ProgressiveDecoderError
from capture_runtime.storage import (
    StreamingPartialNotFoundError,
    StreamingRecordNotFoundError,
    StreamingRepository,
    StreamingTransitionError,
)
from capture_runtime.streaming import MAX_STREAM_CHUNK_BYTES
from capture_runtime.structuring import StructuringValidationError, validate_structuring_candidate
from capture_runtime.structuring_provider import CaptureStructuringProvider


class StreamingCaptureService:
    def __init__(
        self,
        repository: StreamingRepository,
        *,
        clock: Clock,
        processor: ProgressiveCaptureProcessor | None = None,
        extractor: CaptureExtractor | None = None,
        structurer: CaptureStructuringProvider | None = None,
        max_chunk_bytes: int = MAX_STREAM_CHUNK_BYTES,
    ) -> None:
        self.repository = repository
        self._clock = clock
        self.max_chunk_bytes = max_chunk_bytes
        self._processor = processor
        self._extractor = extractor
        self._structurer = structurer
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancellations: dict[str, asyncio.Event] = {}
        self._shutting_down = False

    def open_ingestion(self, request: OpenIngestionV2) -> IngestionV2:
        return self.repository.create_ingestion(request)

    def get_ingestion(self, ingestion_id: str) -> IngestionV2:
        return self.repository.get_ingestion(ingestion_id)

    def delete_ingestion(self, ingestion_id: str) -> None:
        self.repository.delete_ingestion(ingestion_id)

    def append_chunk(
        self,
        ingestion_id: str,
        *,
        chunk_index: int,
        byte_offset: int,
        data: bytes,
        sha256: str,
        declared_total_bytes: int,
    ) -> IngestionV2:
        before = self.repository.get_ingestion(ingestion_id)
        snapshot = self.repository.append_chunk(
            ingestion_id,
            chunk_index=chunk_index,
            byte_offset=byte_offset,
            data=data,
            sha256=sha256,
            max_chunk_bytes=self.max_chunk_bytes,
            declared_total_bytes=declared_total_bytes,
        )
        if snapshot.next_chunk_index > before.next_chunk_index:
            for operation in self._captures_for(ingestion_id):
                if operation.status in {
                    StreamingCaptureStatus.WAITING_INPUT,
                    StreamingCaptureStatus.EXTRACTING,
                }:
                    self.repository.append_event(
                        operation.capture_id,
                        event_type=StreamingEventType.INPUT_CHECKPOINT,
                        stage="extracting",
                    )
        return snapshot

    def finalize_ingestion(
        self,
        ingestion_id: str,
        request: FinalizeIngestionV2,
    ) -> IngestionV2:
        snapshot = self.repository.finalize_ingestion(
            ingestion_id,
            total_bytes=request.total_bytes,
            sha256=request.sha256,
        )
        changed = self.repository.mark_ingestion_ready(ingestion_id)
        for operation in changed:
            self._schedule(operation.capture_id)
        return snapshot

    def start_capture(self, request: StartCaptureV2) -> CaptureOperationV2:
        operation = self.repository.create_capture(request)
        if operation.status is StreamingCaptureStatus.EXTRACTING:
            self._schedule(operation.capture_id)
        return operation

    def get_capture(self, capture_id: str) -> CaptureOperationV2:
        return self.repository.get_capture(capture_id)

    def events(self, capture_id: str, *, after_sequence: int) -> list[CaptureEventV2]:
        return self.repository.read_events(capture_id, after_sequence=after_sequence)

    def event_stream_should_close(self, capture_id: str) -> bool:
        operation = self.repository.get_capture(capture_id)
        if operation.status in {
            StreamingCaptureStatus.COMPLETED,
            StreamingCaptureStatus.FAILED,
            StreamingCaptureStatus.CANCELLED,
        }:
            return True
        return (
            operation.status is StreamingCaptureStatus.AWAITING_STRUCTURING
            and self.repository.capture_request(capture_id).structuring_mode is StructuringMode.HOST
        )

    def partial(self, capture_id: str) -> PartialCaptureV2:
        return self.repository.read_partial(capture_id)

    def raw(self, capture_id: str) -> RawCapture:
        return self.repository.read_raw(capture_id)

    def terminal_result(self, capture_id: str) -> CaptureStreamingResult:
        operation = self.repository.get_capture(capture_id)
        if operation.status is not StreamingCaptureStatus.COMPLETED:
            raise StreamingPartialNotFoundError(capture_id)
        return CaptureStreamingResult(
            operation=operation,
            raw=self.repository.read_raw(capture_id),
            result=self.repository.read_result(capture_id),
        )

    async def structure(self, capture_id: str) -> CaptureDocument:
        operation = self.repository.get_capture(capture_id)
        if operation.status is StreamingCaptureStatus.COMPLETED:
            return self.repository.read_result(capture_id)
        request = self.repository.capture_request(capture_id)
        if request.structuring_mode is not StructuringMode.RUNTIME:
            raise StreamingTransitionError("host structuring requires a host-owned candidate")
        raw = self.repository.read_raw(capture_id)
        if self._structurer is None:
            raise StreamingTransitionError("runtime structuring provider is unavailable")
        self.repository.mark_structuring(capture_id)
        candidate = await self._structurer.structure(
            raw,
            target_language=request.target_language,
            cancel_event=self._cancellations.setdefault(capture_id, asyncio.Event()),
        )
        document = _validate_runtime_document(candidate, raw)
        expected_engine = self._structurer.engine_identity
        if expected_engine is None or document.structuring_engine != expected_engine:
            raise StructuringValidationError(
                "structuring provider provenance is invalid", issues=[]
            )
        completed = CaptureDocument.model_validate(
            {
                **document.model_dump(mode="json", by_alias=True),
                "completedAt": self._clock.now().isoformat(),
            }
        )
        self.repository.write_result(capture_id, completed)
        self.repository.complete_capture(capture_id)
        return completed

    def commit_host_result(
        self,
        capture_id: str,
        candidate: CaptureDocument,
        *,
        idempotency_key: str,
    ) -> CaptureOperationV2:
        operation = self.repository.get_capture(capture_id)
        fingerprint = _candidate_fingerprint(candidate)
        if operation.status is StreamingCaptureStatus.COMPLETED:
            return self.repository.commit_host_result(
                capture_id,
                idempotency_key=idempotency_key,
                fingerprint=fingerprint,
                result=candidate,
            )
        request = self.repository.capture_request(capture_id)
        if (
            request.structuring_mode is not StructuringMode.HOST
            or operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING
        ):
            raise StreamingTransitionError("capture is not awaiting host structuring")
        raw = self.repository.read_raw(capture_id)
        validated = _validate_runtime_document(candidate, raw)
        completed = CaptureDocument.model_validate(
            {
                **validated.model_dump(mode="json", by_alias=True),
                "completedAt": self._clock.now().isoformat(),
            }
        )
        return self.repository.commit_host_result(
            capture_id,
            idempotency_key=idempotency_key,
            fingerprint=fingerprint,
            result=completed,
        )

    def report_host_failure(
        self,
        capture_id: str,
        *,
        code: str,
        message: str,
        idempotency_key: str,
    ) -> CaptureOperationV2:
        operation = self.repository.get_capture(capture_id)
        request = self.repository.capture_request(capture_id)
        if (
            request.structuring_mode is not StructuringMode.HOST
            or operation.status is not StreamingCaptureStatus.AWAITING_STRUCTURING
        ):
            raise StreamingTransitionError("capture is not awaiting host structuring")
        return self.repository.fail_host_structure(
            capture_id,
            idempotency_key=idempotency_key,
            fingerprint=_failure_fingerprint(code, message),
            failure=CaptureFailureV2(
                code=code,
                message=message,
                stage="structuring",
                retryable=False,
            ),
        )

    def fail_invalid_host_structure(
        self, capture_id: str, *, idempotency_key: str
    ) -> CaptureOperationV2:
        return self.report_host_failure(
            capture_id,
            code="structuring_invalid_output",
            message="Host structuring output failed strict schema or provenance validation.",
            idempotency_key=idempotency_key,
        )

    def cancel_capture(self, capture_id: str) -> CaptureOperationV2:
        cancellation = self._cancellations.setdefault(capture_id, asyncio.Event())
        cancellation.set()
        return self.repository.cancel_capture(capture_id)

    def delete_capture(self, capture_id: str) -> None:
        task = self._tasks.pop(capture_id, None)
        if task is not None and not task.done():
            task.cancel()
        self._cancellations.pop(capture_id, None)
        self.repository.delete_capture(capture_id)

    async def shutdown(self) -> None:
        self._shutting_down = True
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()
        self._cancellations.clear()

    def _schedule(self, capture_id: str) -> None:
        if (
            (self._processor is None and self._extractor is None)
            or capture_id in self._tasks
            or self._shutting_down
        ):
            return
        cancellation = self._cancellations.setdefault(capture_id, asyncio.Event())
        task = asyncio.create_task(
            self._process(capture_id, cancellation),
            name=f"progressive-capture-{capture_id}",
        )
        self._tasks[capture_id] = task
        task.add_done_callback(lambda _completed: self._tasks.pop(capture_id, None))

    async def _process(self, capture_id: str, cancellation: asyncio.Event) -> None:
        raw_written = False
        try:
            operation = self.repository.get_capture(capture_id)
            if operation.status is StreamingCaptureStatus.CANCELLED:
                return
            if operation.source is None:
                raise ProgressiveCaptureError("finalized streaming source is unavailable")
            source_path = self.repository.source_path(operation.ingestion_id)
            processor = self._processor
            if operation.kind is CaptureSourceKind.AUDIO and processor is not None:
                raw = await processor.process(
                    capture_id=capture_id,
                    source=operation.source,
                    source_path=source_path,
                    cancellation=cancellation,
                    sink=lambda events, session: self._persist_events(capture_id, events, session),
                )
            elif operation.kind is not CaptureSourceKind.AUDIO and self._extractor is not None:
                raw = await self._extract_buffered_source(
                    capture_id,
                    operation.source,
                    operation.kind,
                    source_path,
                    cancellation,
                )
            else:
                raise ProgressiveCaptureError(
                    "The selected capture kind is unavailable in this runtime.",
                    code="requirement_unavailable",
                    retryable=True,
                )
            self.repository.write_raw(capture_id, raw)
            raw_written = True
            if cancellation.is_set():
                return
            request = self.repository.capture_request(capture_id)
            if request.structuring_mode is StructuringMode.RUNTIME:
                self.repository.mark_awaiting_structuring(capture_id)
                await self.structure(capture_id)
            else:
                self.repository.mark_awaiting_structuring(capture_id)
        except asyncio.CancelledError:
            if not cancellation.is_set() and not self._shutting_down:
                self._fail(
                    capture_id,
                    "progressive_interrupted",
                    "Progressive capture was interrupted.",
                )
        except ProgressiveCaptureError as error:
            self._fail(
                capture_id,
                error.code,
                _safe_failure_message(error),
                stage=error.stage,
                retryable=error.retryable,
            )
        except StructuringValidationError:
            self._fail(
                capture_id,
                "structuring_invalid_output" if raw_written else "progressive_failed",
                (
                    "Structuring output failed strict schema or provenance validation."
                    if raw_written
                    else "Progressive audio processing failed."
                ),
                stage="structuring" if raw_written else "extraction",
            )
        except (RuntimeUnavailableError, ExtractionRuntimeUnavailableError) as error:
            self._fail(
                capture_id,
                "requirement_unavailable",
                _safe_failure_message(error),
                stage="structuring" if raw_written else "extraction",
            )
        except ProgressiveDecoderError as error:
            self._fail(
                capture_id,
                "progressive_decode_failed",
                _safe_failure_message(error),
                stage="extraction",
            )
        except ValidationError:
            self._fail(
                capture_id,
                "structuring_invalid_output" if raw_written else "progressive_output_invalid",
                (
                    "Structuring output failed strict schema or provenance validation."
                    if raw_written
                    else "Progressive audio output failed strict schema validation."
                ),
                stage="structuring" if raw_written else "extraction",
            )
        except ProgressiveAudioError as error:
            self._fail(
                capture_id,
                "progressive_session_failed",
                _safe_failure_message(error),
                stage="extraction",
            )
        except StreamingTransitionError as error:
            self._fail(
                capture_id,
                "structuring_failed" if raw_written else "progressive_failed",
                _safe_failure_message(error),
                stage="structuring" if raw_written else "extraction",
            )
        except Exception:
            self._fail(
                capture_id,
                "structuring_failed" if raw_written else "progressive_failed",
                (
                    "Capture structuring failed."
                    if raw_written
                    else "Progressive audio processing failed."
                ),
                stage="structuring" if raw_written else "extraction",
            )

    async def _extract_buffered_source(
        self,
        capture_id: str,
        source: CaptureSource,
        declared_kind: CaptureSourceKind,
        source_path: Path,
        cancellation: asyncio.Event,
    ) -> RawCapture:
        extractor = self._extractor
        if extractor is None:
            raise ProgressiveCaptureError(
                "The capture extractor is unavailable.",
                code="extraction_runtime_unavailable",
                retryable=False,
            )
        if cancellation.is_set():
            raise asyncio.CancelledError
        try:
            content = await asyncio.to_thread(source_path.read_bytes)
            sniffed = extractor.sniff(content[:64])
        except UnsupportedMediaError as error:
            raise ProgressiveCaptureError(
                "Uploaded source content is not a supported capture kind.",
                code="unsupported_media_type",
                retryable=False,
            ) from error
        except OSError as error:
            raise ProgressiveCaptureError(
                "Streaming source content could not be opened.",
                code="streaming_source_unavailable",
            ) from error
        if sniffed.kind is not declared_kind:
            raise ProgressiveCaptureError(
                "Uploaded source content does not match its declared capture kind.",
                code="source_kind_mismatch",
                retryable=False,
            )
        raw = await extractor.extract(content, source, cancellation)
        if not raw.segments:
            raise ProgressiveCaptureError(
                "Extraction produced no non-empty content.",
                code="progressive_no_text_at_sample",
                retryable=False,
            )
        partial = PartialCaptureV2(
            capture_id=capture_id,
            source=raw.source,
            revision=1,
            covered_until_ms=0,
            segments=raw.segments,
            source_text=raw.source_text,
            extraction_engine=raw.extraction_engine,
            updated_at=raw.created_at,
        )
        self.repository.write_partial(partial)
        self.repository.append_event(
            capture_id,
            event_type=StreamingEventType.SEGMENT,
            stage="extracting",
            partial_revision=partial.revision,
            segments=list(raw.segments),
        )
        return raw

    async def _persist_events(
        self,
        capture_id: str,
        events: tuple[ProgressiveSessionEvent, ...],
        partial: PartialCaptureV2 | None,
    ) -> None:
        if partial is not None:
            self.repository.write_partial(partial)
        for event in events:
            self.repository.append_event(
                capture_id,
                event_type=event.event_type,
                stage=event.stage,
                partial_revision=event.partial_revision,
                covered_until_ms=event.covered_until_ms,
                segments=list(event.segments),
                error=event.error,
            )

    def _fail(
        self,
        capture_id: str,
        code: str,
        message: str,
        *,
        stage: str = "extraction",
        retryable: bool = True,
    ) -> None:
        with suppress(StreamingRecordNotFoundError):
            self.repository.fail_capture(
                capture_id,
                CaptureFailureV2(
                    code=code,
                    message=message,
                    stage=stage,
                    retryable=retryable,
                ),
            )

    def _captures_for(self, ingestion_id: str) -> list[CaptureOperationV2]:
        return [
            self.repository.get_capture(capture_id)
            for capture_id in self.repository.capture_ids_for_ingestion(ingestion_id)
        ]


def _validate_runtime_document(candidate: object, raw: RawCapture) -> CaptureDocument:
    try:
        return CaptureDocument.model_validate(validate_structuring_candidate(candidate, raw))
    except ValidationError as error:
        raise StructuringValidationError(
            "structuring output does not satisfy CaptureDocument",
            issues=[
                {
                    "location": [str(part) for part in issue["loc"]],
                    "message": issue["msg"],
                    "type": issue["type"],
                }
                for issue in error.errors()
            ],
        ) from error


def _safe_failure_message(error: BaseException) -> str:
    if isinstance(error, ProgressiveCaptureError):
        return str(error)[:500] or "Progressive audio processing failed."
    return "Progressive audio processing failed at a bounded runtime boundary."


def _candidate_fingerprint(candidate: CaptureDocument) -> str:
    canonical = json.dumps(
        candidate.model_dump(mode="json", by_alias=True),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def _failure_fingerprint(code: str, message: str) -> str:
    canonical = json.dumps(
        {"code": code, "message": message},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


__all__ = ["StreamingCaptureService", "StreamingTransitionError"]
