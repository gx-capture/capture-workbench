"""Private response and transport error-mapping seams for the client facade."""

from __future__ import annotations

from typing import Any

import httpx
from pydantic import ValidationError

from .codec import decode_json, decode_model
from .contracts import CaptureDocument, CaptureOperation, RawCapture
from .errors import CaptureRuntimeProtocolError, CaptureTransportError


def decode_response(response: httpx.Response) -> Any:
    """Keep client responses on the stable codec and redaction path."""
    return decode_json(response)


def map_http_request_error(error: httpx.HTTPError) -> CaptureTransportError:
    """Map an HTTPX request failure without exposing credentials in diagnostics."""
    return CaptureTransportError("Capture Runtime transport request failed.", str(error))


def decode_capture_operation(
    response: httpx.Response, requested_capture_id: str
) -> CaptureOperation:
    """Decode an operation and enforce the route/request identity invariant."""
    operation = decode_model(response, CaptureOperation)
    if operation.capture_id != requested_capture_id:
        raise CaptureRuntimeProtocolError("Capture Runtime returned an invalid capture identity.")
    return operation


def decode_streaming_result(
    response: httpx.Response, requested_capture_id: str
) -> tuple[CaptureOperation, RawCapture, CaptureDocument]:
    """Decode a result while preserving operation, source, and result identity."""
    payload = decode_response(response)
    try:
        operation = CaptureOperation.model_validate(payload["operation"])
        raw = RawCapture.model_validate(payload["raw"])
        result = CaptureDocument.model_validate(payload["result"])
        if operation.capture_id != requested_capture_id:
            raise ValueError("capture identity mismatch")
        if raw.source != result.source or (
            operation.source is not None and operation.source != raw.source
        ):
            raise ValueError("source identity mismatch")
        return operation, raw, result
    except (KeyError, TypeError, ValueError, ValidationError) as error:
        raise CaptureRuntimeProtocolError(
            "Capture Runtime returned an invalid streaming result."
        ) from error


__all__ = [
    "decode_capture_operation",
    "decode_response",
    "decode_streaming_result",
    "map_http_request_error",
]
