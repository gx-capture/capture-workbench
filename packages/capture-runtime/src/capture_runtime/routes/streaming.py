"""Authenticated HTTP and SSE adapters for streaming audio v2."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Annotated

from capture_structuring import StructuringValidationError
from fastapi import APIRouter, Header, Path, Request, Response, status
from fastapi.responses import StreamingResponse

from capture_runtime.contracts import (
    CaptureDocumentV1,
    CaptureOperationV2,
    FinalizeIngestionV2,
    IngestionV2,
    OpenIngestionV2,
    PartialCaptureV2,
    ReportStructuringFailureV2,
    RuntimeStreamingCapabilitiesV2,
    StartCaptureV2,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.progressive_audio import DEFAULT_CHECKPOINT_MS
from capture_runtime.progressive_decoder import progressive_decoder_ready
from capture_runtime.routes.common import ApiProblem
from capture_runtime.storage import (
    StreamingIdempotencyConflictError,
    StreamingPartialNotFoundError,
    StreamingRecordNotFoundError,
    StreamingTransitionError,
)

_CONTENT_RANGE = re.compile(r"^bytes ([0-9]+)-([0-9]+)/([0-9]+)$")
_DIGEST = re.compile(r"^sha-256=([0-9a-f]{64})$")


def register_streaming_routes(router: APIRouter, dependencies: RuntimeDependencies) -> None:
    service = dependencies.streaming_capture_service

    @router.get("/health/ready", response_model=RuntimeStreamingCapabilitiesV2)
    async def streaming_ready() -> RuntimeStreamingCapabilitiesV2:
        return RuntimeStreamingCapabilitiesV2(
            supports_progressive_audio=progressive_decoder_ready(),
            max_chunk_bytes=service.max_chunk_bytes,
            checkpoint_interval_ms=DEFAULT_CHECKPOINT_MS,
            heartbeat_interval_ms=5_000,
            stall_timeout_ms=90_000,
        )

    @router.post(
        "/ingestions",
        response_model=IngestionV2,
        status_code=status.HTTP_201_CREATED,
    )
    async def open_ingestion(request: OpenIngestionV2) -> IngestionV2:
        try:
            return service.open_ingestion(request)
        except StreamingIdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Ingestion request id was already used with different metadata.",
            ) from error

    @router.get("/ingestions/{ingestion_id}", response_model=IngestionV2)
    async def get_ingestion(ingestion_id: str) -> IngestionV2:
        try:
            return service.get_ingestion(ingestion_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error

    @router.put(
        "/ingestions/{ingestion_id}/chunks/{chunk_index}",
        response_model=IngestionV2,
    )
    async def append_chunk(
        request: Request,
        ingestion_id: str,
        chunk_index: Annotated[int, Path(ge=0)],
        content_range: Annotated[str, Header(alias="Content-Range")],
        digest: Annotated[str, Header(alias="Digest")],
        _idempotency_key: Annotated[str, Header(alias="X-Idempotency-Key")],
    ) -> IngestionV2:
        match = _CONTENT_RANGE.fullmatch(content_range)
        digest_match = _DIGEST.fullmatch(digest)
        if match is None or digest_match is None:
            raise ApiProblem(
                422,
                "invalid_chunk_headers",
                "Content-Range and Digest headers are invalid.",
            )
        byte_offset, end_offset, total_bytes = (int(value) for value in match.groups())
        if end_offset < byte_offset or end_offset - byte_offset + 1 > service.max_chunk_bytes:
            raise ApiProblem(413, "chunk_too_large", "Chunk exceeds the configured size limit.")
        if int(total_bytes) <= 0:
            raise ApiProblem(422, "invalid_chunk_headers", "Content-Range total is invalid.")
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
            return service.append_chunk(
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

    @router.post("/ingestions/{ingestion_id}/finalize", response_model=IngestionV2)
    async def finalize_ingestion(
        ingestion_id: str,
        request: FinalizeIngestionV2,
    ) -> IngestionV2:
        try:
            return service.finalize_ingestion(ingestion_id, request)
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
            service.delete_ingestion(ingestion_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error
        except StreamingTransitionError as error:
            raise ApiProblem(409, "ingestion_delete_rejected", _safe_message(str(error))) from error
        return Response(status_code=status.HTTP_204_NO_CONTENT)

    @router.post(
        "/captures",
        response_model=CaptureOperationV2,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def start_capture(request: StartCaptureV2) -> CaptureOperationV2:
        try:
            return service.start_capture(request)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(404, "ingestion_not_found", "Ingestion was not found.") from error
        except StreamingIdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Capture request id was already used with different metadata.",
            ) from error

    @router.get("/captures/{capture_id}", response_model=CaptureOperationV2)
    async def get_capture(capture_id: str) -> CaptureOperationV2:
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
            events = service.events(capture_id, after_sequence=after_sequence)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

        async def stream() -> AsyncIterator[str]:
            cursor = after_sequence
            initial_replay = True
            heartbeat_deadline = time.monotonic() + 5
            while True:
                current_events = (
                    events if initial_replay else service.events(capture_id, after_sequence=cursor)
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
                    heartbeat_deadline = time.monotonic() + 5

                if service.event_stream_should_close(capture_id):
                    # A repository transition persists the terminal snapshot
                    # immediately before appending its terminal event. Flush
                    # the durable tail before closing so a fast consumer never
                    # observes an EOF after only the initial replay.
                    for event in service.events(capture_id, after_sequence=cursor):
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
                    heartbeat_deadline = time.monotonic() + 5
                await asyncio.sleep(0.05)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @router.get("/captures/{capture_id}/partial", response_model=PartialCaptureV2)
    async def capture_partial(capture_id: str) -> PartialCaptureV2:
        try:
            return service.partial(capture_id)
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

    @router.post("/captures/{capture_id}/cancel", response_model=CaptureOperationV2)
    async def cancel_capture(capture_id: str) -> CaptureOperationV2:
        try:
            return service.cancel_capture(capture_id)
        except StreamingRecordNotFoundError as error:
            raise ApiProblem(
                404, "capture_not_found", "Streaming capture was not found."
            ) from error

    @router.post("/captures/{capture_id}/structure", response_model=CaptureDocumentV1)
    async def structure_capture(capture_id: str) -> CaptureDocumentV1:
        try:
            return await service.structure(capture_id)
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

    @router.post("/captures/{capture_id}/structure/commit", response_model=CaptureOperationV2)
    async def commit_host_structure(
        capture_id: str,
        candidate: CaptureDocumentV1,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> CaptureOperationV2:
        try:
            return service.commit_host_result(
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

    @router.post("/captures/{capture_id}/structure/failure", response_model=CaptureOperationV2)
    async def report_host_structure_failure(
        capture_id: str,
        payload: ReportStructuringFailureV2,
        idempotency_key: Annotated[
            str, Header(alias="X-Idempotency-Key", min_length=1, max_length=128)
        ],
    ) -> CaptureOperationV2:
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

    @router.get("/captures/{capture_id}/result")
    async def capture_result(capture_id: str) -> dict[str, object]:
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
            service.delete_capture(capture_id)
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
    if "exceed" in lowered:
        return "chunk_too_large"
    return "chunk_rejected"


def _safe_message(message: str) -> str:
    return message[:200]


__all__ = ["register_streaming_routes"]
