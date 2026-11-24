"""Authenticated HTTP and SSE adapters for streaming audio v2."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Annotated

from fastapi import APIRouter, Header, Path, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from capture_runtime.capture.application.streaming_capture_service import (
    StructuringProviderUnavailableError,
)
from capture_runtime.capture.domain.size_policy import (
    SOURCE_SIZE_EXCEEDED_MESSAGE,
    IngestionSourceSizeExceededError,
)
from capture_runtime.capture.infrastructure.streaming_repository import (
    StreamingIdempotencyConflictError,
    StreamingPartialNotFoundError,
    StreamingRecordNotFoundError,
    StreamingTransitionError,
    partial_wire_payload,
)
from capture_runtime.contracts import (
    CaptureDocument,
    CaptureOcrProjection,
    CaptureOperation,
    CaptureResult,
    FinalizeIngestion,
    Ingestion,
    OpenIngestion,
    OpenStructuringSession,
    PartialCapture,
    RawCapture,
    ReportStructuringFailure,
    StartCapture,
    StructuringBatch,
    StructuringSession,
    SubmitStructuringBatch,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.routes.common import ApiProblem
from capture_runtime.structuring.domain.session.models import RetiredStructuringProfileError
from capture_runtime.structuring.infrastructure.contracts import StructuringValidationError
from capture_runtime.structuring.infrastructure.structuring_session_repository import (
    StructuringSessionDigestConflictError,
    StructuringSessionIdempotencyConflictError,
    StructuringSessionRecordCorruptError,
    StructuringSessionRecordNotFoundError,
    StructuringSessionTransitionError,
)

_CONTENT_RANGE = re.compile(r"^bytes ([0-9]+)-([0-9]+)/([0-9]+)$")
_DIGEST = re.compile(r"^sha-256=([0-9a-f]{64})$")


def register_streaming_routes(router: APIRouter, dependencies: RuntimeDependencies) -> None:
    service = dependencies.streaming_capture_service
    open_ingestion_use_case = service.open_ingestion_use_case
    append_chunk_use_case = service.append_chunk_use_case
    finalize_ingestion_use_case = service.finalize_ingestion_use_case
    start_capture_use_case = service.start_capture_use_case
    cancel_capture_use_case = service.cancel_capture_use_case
    events_use_case = service.events_use_case
    commit_host_result_use_case = service.commit_host_result_use_case
    structuring_session_service = dependencies.structuring_session_service
    open_session = structuring_session_service.open_use_case
    submit_batch = structuring_session_service.submit_use_case
    get_session = structuring_session_service.get_use_case

    @router.post(
        "/ingestions",
        response_model=Ingestion,
        status_code=status.HTTP_201_CREATED,
    )
    async def open_ingestion(
        request: OpenIngestion,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> Ingestion:
        _require_matching_idempotency_key(idempotency_key, request.client_request_id)
        try:
            return open_ingestion_use_case.execute(request)
        except IngestionSourceSizeExceededError as error:
            raise ApiProblem(422, "validation_error", SOURCE_SIZE_EXCEEDED_MESSAGE) from error
        except StreamingIdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Ingestion request id was already used with different metadata.",
            ) from error

    @router.get("/ingestions/{ingestion_id}", response_model=Ingestion)
    async def get_ingestion(ingestion_id: str) -> Ingestion:
        try:
            return service.get_ingestion(ingestion_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error

    @router.put(
        "/ingestions/{ingestion_id}/chunks/{chunk_index}",
        response_model=Ingestion,
    )
    async def append_chunk(
        request: Request,
        ingestion_id: str,
        chunk_index: Annotated[int, Path(ge=0)],
        content_range: Annotated[str, Header(alias="Content-Range")],
        digest: Annotated[str, Header(alias="Digest")],
        _idempotency_key: Annotated[str, Header(alias="X-Idempotency-Key")],
    ) -> Ingestion:
        match = _CONTENT_RANGE.fullmatch(content_range)
        digest_match = _DIGEST.fullmatch(digest)
        if match is None or digest_match is None:
            raise ApiProblem(
                422,
                "invalid_chunk_headers",
                "Content-Range and Digest headers are invalid.",
            )
        byte_offset, end_offset, total_bytes = (int(value) for value in match.groups())
        if total_bytes <= 0:
            raise ApiProblem(422, "invalid_chunk_headers", "Content-Range total is invalid.")
        if end_offset >= total_bytes:
            raise ApiProblem(
                422,
                "invalid_chunk_headers",
                "Content-Range end must be less than its total.",
            )
        if end_offset < byte_offset or end_offset - byte_offset + 1 > service.max_chunk_bytes:
            raise ApiProblem(413, "chunk_too_large", "Chunk exceeds the configured size limit.")
        try:
            ingestion = service.get_ingestion(ingestion_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error
        if int(total_bytes) != ingestion.total_bytes:
            raise ApiProblem(
                409,
                "chunk_total_conflict",
                "Content-Range total does not match the ingestion source size.",
            )
        data = await _read_bounded_body(request, service.max_chunk_bytes)
        if end_offset - byte_offset + 1 != len(data):
            raise ApiProblem(
                422,
                "chunk_length_mismatch",
                "Chunk length does not match Content-Range.",
            )
        try:
            return append_chunk_use_case.execute(
                ingestion_id,
                chunk_index=chunk_index,
                byte_offset=byte_offset,
                data=data,
                sha256=digest_match.group(1),
                declared_total_bytes=int(total_bytes),
            )
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error
        except StreamingTransitionError as error:
            raise ApiProblem(
                409,
                _chunk_error_code(str(error)),
                _safe_message(str(error)),
            ) from error

    @router.post("/ingestions/{ingestion_id}/finalize", response_model=Ingestion)
    async def finalize_ingestion(
        ingestion_id: str,
        request: FinalizeIngestion,
    ) -> Ingestion:
        try:
            return finalize_ingestion_use_case.execute(ingestion_id, request)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error
        except StreamingTransitionError as error:
            raise ApiProblem(
                409,
                "ingestion_finalize_rejected",
                _safe_message(str(error)),
            ) from error

    @router.delete("/ingestions/{ingestion_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_ingestion(ingestion_id: str) -> Response:
        try:
            await service.delete_ingestion(ingestion_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error
        except StreamingTransitionError as error:
            raise ApiProblem(409, "ingestion_delete_rejected", _safe_message(str(error))) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/captures",
        response_model=CaptureOperation,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def start_capture(
        request: StartCapture,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> CaptureOperation:
        _require_matching_idempotency_key(idempotency_key, request.client_request_id)
        try:
            return start_capture_use_case.execute(request)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error
        except StreamingIdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Capture request id was already used with different metadata.",
            ) from error

    @router.get("/captures/{capture_id}", response_model=CaptureOperation)
    async def get_capture(capture_id: str) -> CaptureOperation:
        try:
            return service.get_capture(capture_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.get("/captures/{capture_id}/events")
    async def capture_events(
        capture_id: str,
        last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ) -> StreamingResponse:
        after_sequence = _event_cursor(last_event_id)
        try:
            events = events_use_case.execute(capture_id, after_sequence=after_sequence)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

        async def stream() -> AsyncIterator[str]:
            cursor = after_sequence
            initial_replay = True
            heartbeat_seconds = service.heartbeat_interval_ms / 1000
            heartbeat_deadline = time.monotonic() + heartbeat_seconds
            while True:
                current_events = (
                    events
                    if initial_replay
                    else events_use_case.execute(capture_id, after_sequence=cursor)
                )
                initial_replay = False
                for event in current_events:
                    payload = json.dumps(
                        event.model_dump(mode="json", by_alias=True),
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    yield (
                        f"id: {event.sequence}\nevent: {event.event_type.value}"
                        f"\ndata: {payload}\n\n"
                    )
                    cursor = max(cursor, event.sequence)
                    heartbeat_deadline = time.monotonic() + heartbeat_seconds

                if service.event_stream_should_close(capture_id):
                    # A repository transition persists the terminal snapshot
                    # immediately before appending its terminal event. Flush
                    # the durable tail before closing so a fast consumer never
                    # observes an EOF after only the initial replay.
                    for event in events_use_case.execute(capture_id, after_sequence=cursor):
                        payload = json.dumps(
                            event.model_dump(mode="json", by_alias=True),
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        yield (
                            f"id: {event.sequence}\nevent: {event.event_type.value}"
                            f"\ndata: {payload}\n\n"
                        )
                        cursor = max(cursor, event.sequence)
                    return
                if time.monotonic() >= heartbeat_deadline:
                    yield ": heartbeat\n\n"
                    heartbeat_deadline = time.monotonic() + heartbeat_seconds
                await asyncio.sleep(0.05)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @router.get("/captures/{capture_id}/partial", response_model=PartialCapture)
    async def capture_partial(capture_id: str) -> Response:
        try:
            return JSONResponse(partial_wire_payload(service.partial(capture_id)))
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409,
                "partial_unavailable",
                "Progressive partial capture is not available yet.",
            ) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.get("/captures/{capture_id}/raw", response_model=RawCapture)
    async def capture_raw(capture_id: str) -> RawCapture:
        try:
            return service.raw(capture_id)
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409, "raw_unavailable", "Raw extraction is not available yet."
            ) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.get("/captures/{capture_id}/ocr", response_model=CaptureOcrProjection)
    async def capture_ocr(capture_id: str) -> CaptureOcrProjection:
        try:
            return service.ocr(capture_id)
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409, "ocr_unavailable", "Canonical OCR projection is not available yet."
            ) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.post("/captures/{capture_id}/cancel", response_model=CaptureOperation)
    async def cancel_capture(capture_id: str) -> CaptureOperation:
        try:
            return cancel_capture_use_case.execute(capture_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.post("/captures/{capture_id}/structure", response_model=CaptureDocument)
    async def structure_capture(capture_id: str) -> CaptureDocument:
        try:
            return await service.structure(capture_id)
        except StructuringProviderUnavailableError as error:
            raise ApiProblem(
                503,
                "requirement_unavailable",
                "The structuring provider is unavailable.",
            ) from error
        except StructuringValidationError as error:
            # Issues can quote the provider document, including source text.
            raise ApiProblem(
                422,
                "structuring_invalid_output",
                "Structuring output failed strict schema or provenance validation.",
            ) from error
        except StreamingTransitionError as error:
            raise ApiProblem(409, "invalid_capture_state", _safe_message(str(error))) from error
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409, "raw_unavailable", "Raw progressive capture is not available."
            ) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.post(
        "/captures/{capture_id}/structure/session",
        response_model=StructuringSession,
        status_code=status.HTTP_201_CREATED,
    )
    async def open_structuring_session(
        capture_id: str,
        request: OpenStructuringSession,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> StructuringSession:
        # The key is stored beside the session, and a stored blank key fails
        # the record's recovery check, so a blank key is rejected here.
        if not idempotency_key.strip():
            raise ApiProblem(422, "validation_error", "X-Idempotency-Key must not be blank.")
        try:
            return open_session.execute(capture_id, request, client_request_id=idempotency_key)
        except RetiredStructuringProfileError as error:
            raise ApiProblem(422, "validation_error", str(error)) from error
        except StructuringSessionIdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Structuring session request conflicts with an existing session.",
            ) from error
        except StructuringSessionTransitionError as error:
            raise ApiProblem(409, "invalid_capture_state", _safe_message(str(error))) from error
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409, "raw_unavailable", "Raw extraction is not available yet."
            ) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.get(
        "/captures/{capture_id}/structure/session",
        response_model=StructuringSession,
    )
    async def get_structuring_session(capture_id: str) -> StructuringSession:
        try:
            session = get_session.execute(capture_id)
            return session
        except StructuringSessionRecordNotFoundError as error:
            raise ApiProblem(
                404, "structuring_session_not_found", "Structuring session was not found."
            ) from error

    @router.get(
        "/captures/{capture_id}/structure/session/batches/{batch_index}",
        response_model=StructuringBatch,
    )
    async def get_structuring_batch(
        capture_id: str,
        batch_index: Annotated[int, Path(ge=0)],
    ) -> StructuringBatch:
        try:
            session = get_session.execute(capture_id)
        except StructuringSessionRecordNotFoundError as error:
            raise ApiProblem(
                404, "structuring_session_not_found", "Structuring session was not found."
            ) from error
        try:
            return structuring_session_service.batch(session.session_id, batch_index)
        except StructuringSessionRecordNotFoundError as error:
            raise ApiProblem(
                404, "structuring_batch_not_found", "Structuring batch was not found."
            ) from error

    @router.put(
        "/captures/{capture_id}/structure/session/batches/{batch_index}",
        response_model=StructuringSession,
    )
    async def submit_structuring_batch(
        capture_id: str,
        batch_index: Annotated[int, Path(ge=0)],
        payload: SubmitStructuringBatch,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> StructuringSession:
        try:
            session = get_session.execute(capture_id)
        except StructuringSessionRecordNotFoundError as error:
            raise ApiProblem(
                404, "structuring_session_not_found", "Structuring session was not found."
            ) from error
        try:
            return submit_batch.execute(
                session.session_id,
                batch_index,
                payload,
                idempotency_key=idempotency_key,
            )
        except StructuringSessionIdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Structuring batch idempotency key conflicts.",
            ) from error
        except StructuringSessionDigestConflictError as error:
            raise ApiProblem(
                409,
                "structuring_batch_digest_conflict",
                "Structuring batch digest does not match the advertised batch.",
            ) from error
        except StructuringSessionTransitionError as error:
            raise ApiProblem(409, "invalid_capture_state", _safe_message(str(error))) from error
        except StructuringSessionRecordNotFoundError as error:
            raise ApiProblem(
                404, "structuring_batch_not_found", "Structuring batch was not found."
            ) from error
        except StructuringSessionRecordCorruptError as error:
            raise ApiProblem(
                500, "structuring_session_corrupt", "Structuring session state is corrupt."
            ) from error
        except StructuringValidationError as error:
            raise ApiProblem(
                422,
                "structuring_invalid_output",
                "Structuring batch failed strict semantic validation.",
                details={"issues": error.issues},
            ) from error
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409, "raw_unavailable", "Raw extraction is not available yet."
            ) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.post("/captures/{capture_id}/structure/commit", response_model=CaptureOperation)
    async def commit_host_structure(
        capture_id: str,
        candidate: CaptureDocument,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> CaptureOperation:
        try:
            return commit_host_result_use_case.execute(
                capture_id, candidate, idempotency_key=idempotency_key
            )
        except StructuringValidationError as error:
            try:
                service.fail_invalid_host_structure(capture_id, idempotency_key=idempotency_key)
            except (StreamingRecordNotFoundError, StreamingTransitionError):
                pass
            raise ApiProblem(
                422,
                "invalid_structure",
                "Candidate failed strict schema or provenance validation.",
                details={"issues": error.issues},
            ) from error
        except StreamingIdempotencyConflictError as error:
            raise ApiProblem(
                409, "idempotency_conflict", "Commit idempotency key conflicts."
            ) from error
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409, "raw_unavailable", "Raw progressive capture is not available."
            ) from error
        except StreamingTransitionError as error:
            raise ApiProblem(409, "invalid_capture_state", _safe_message(str(error))) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.post("/captures/{capture_id}/structure/failure", response_model=CaptureOperation)
    async def report_host_structure_failure(
        capture_id: str,
        payload: ReportStructuringFailure,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> CaptureOperation:
        try:
            return service.report_host_failure(
                capture_id,
                code=payload.code,
                message=payload.message,
                idempotency_key=idempotency_key,
            )
        except StreamingIdempotencyConflictError as error:
            raise ApiProblem(
                409, "idempotency_conflict", "Failure idempotency key conflicts."
            ) from error
        except StreamingTransitionError as error:
            raise ApiProblem(409, "invalid_capture_state", _safe_message(str(error))) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.get("/captures/{capture_id}/result", response_model=CaptureResult)
    async def capture_result(capture_id: str) -> CaptureResult:
        try:
            return service.terminal_result(capture_id)
        except StreamingPartialNotFoundError as error:
            raise ApiProblem(
                409, "result_unavailable", "Structured progressive result is not available."
            ) from error
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.delete("/captures/{capture_id}", status_code=status.HTTP_204_NO_CONTENT)
    async def delete_capture(capture_id: str) -> Response:
        try:
            await service.delete_capture(capture_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)


async def _read_bounded_body(request: Request, maximum: int) -> bytes:
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > maximum:
            raise ApiProblem(413, "chunk_too_large", "Chunk exceeds the configured size limit.")
    return bytes(body)


def _event_cursor(value: str | None) -> int:
    if value is None or value == "":
        return -1
    try:
        cursor = int(value)
    except ValueError as error:
        raise ApiProblem(
            422, "invalid_event_cursor", "Last-Event-ID must be an integer."
        ) from error
    if cursor < -1:
        raise ApiProblem(422, "invalid_event_cursor", "Last-Event-ID must not be negative.")
    return cursor


def _chunk_error_code(message: str) -> str:
    lowered = message.casefold()
    if "checksum" in lowered:
        return "chunk_checksum_mismatch"
    if "conflict" in lowered:
        return "chunk_conflict"
    if "contiguous" in lowered or "ordered" in lowered:
        return "chunk_out_of_order"
    return "chunk_rejected"


def _safe_message(message: str) -> str:
    return message[:200]


def _require_matching_idempotency_key(idempotency_key: str, client_request_id: str) -> None:
    if idempotency_key != client_request_id:
        raise ApiProblem(
            409,
            "idempotency_conflict",
            "X-Idempotency-Key must match clientRequestId.",
        )


__all__ = ["register_streaming_routes"]
