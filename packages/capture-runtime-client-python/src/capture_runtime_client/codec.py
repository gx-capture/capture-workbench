"""Private wire codecs shared by HTTP and in-memory adapters."""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import httpx
from pydantic import BaseModel, ValidationError

from .errors import (
    CaptureAuthenticationError,
    CaptureRemoteError,
    CaptureRuntimeProtocolError,
)


def decode_model[ModelT: BaseModel](response: httpx.Response, model: type[ModelT]) -> ModelT:
    payload = decode_json(response)
    try:
        return model.model_validate(payload)
    except ValidationError as error:
        raise CaptureRuntimeProtocolError(
            f"Capture Runtime returned invalid {model.__name__} data.",
            error.errors(include_url=False),
        ) from error


def decode_json(response: httpx.Response) -> Any:
    if response.status_code >= 400:
        try:
            envelope = response.json()
        except ValueError:
            envelope = None
        error = envelope.get("error") if isinstance(envelope, dict) else None
        error_map = error if isinstance(error, dict) else {}
        code = str(error_map.get("code", f"http_{response.status_code}"))
        message = str(
            error_map.get("message", f"Capture Runtime request failed ({response.status_code}).")
        )
        details = error_map.get("details")
        details_map = details if isinstance(details, dict) else {}
        category = error_map.get("category", details_map.get("category"))
        retryable = error_map.get(
            "retryable", details_map.get("retryable", response.status_code >= 500)
        )
        issues = error_map.get("issues", details_map.get("issues"))
        request_id = (
            response.headers.get("x-request-id")
            or response.headers.get("x-correlation-id")
            or _optional_text(error_map.get("requestId", details_map.get("requestId")))
        )
        if response.status_code in {401, 403} or code in {"unauthorized", "authentication_failed"}:
            raise CaptureAuthenticationError(
                message,
                status_code=response.status_code,
                details=details,
                request_id=request_id,
            )
        raise CaptureRemoteError(
            status_code=response.status_code,
            code=code,
            message=message,
            category=_optional_text(category),
            retryable=bool(retryable),
            details=details,
            issues=issues if isinstance(issues, list) else None,
            request_id=request_id,
        )
    if response.status_code == 204:
        return None
    try:
        return response.json()
    except ValueError as error:
        raise CaptureRuntimeProtocolError("Capture Runtime returned invalid JSON.") from error


def iter_sse(lines: Iterator[bytes]) -> Iterator[dict[str, str]]:
    event: dict[str, str] = {}
    data: list[str] = []
    buffer = ""

    def consume(line: str) -> dict[str, str] | None:
        nonlocal event, data
        if not line:
            if data:
                result = {**event, "data": "\n".join(data)}
                event = {}
                data = []
                return result
            event = {}
            data = []
            return None
        if line.startswith(":"):
            return None
        key, separator, value = line.partition(":")
        if separator and value.startswith(" "):
            value = value[1:]
        if key == "data":
            data.append(value)
        elif key in {"id", "event"}:
            event[key] = value
        return None

    for raw in lines:
        buffer += raw.decode("utf-8")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            result = consume(line[:-1] if line.endswith("\r") else line)
            if result is not None:
                yield result
    if buffer:
        result = consume(buffer[:-1] if buffer.endswith("\r") else buffer)
        if result is not None:
            yield result
    if data:
        yield {**event, "data": "\n".join(data)}


__all__ = ["decode_json", "decode_model", "iter_sse"]


def _optional_text(value: Any) -> str | None:
    return value if isinstance(value, str) and value else None
