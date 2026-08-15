"""Internal JSON-lines worker protocol contracts.

These types are intentionally not exported through the public v2 models.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

WORKER_PROTOCOL_VERSION = "1"
MAX_WORKER_INPUT_BYTES = 64 * 1024
MAX_WORKER_OUTPUT_BYTES = 8 * 1024 * 1024
MAX_WORKER_ERROR_MESSAGE = 500
REQUEST_ID_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")

type WorkerOperation = Literal["probe", "run", "cancel"]


class WorkerProtocolError(ValueError):
    """Raised when an untrusted worker frame violates the protocol."""


def _object(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise WorkerProtocolError(f"{label} must be a JSON object with string keys")
    return value


def _exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise WorkerProtocolError(
            f"{label} fields must be {sorted(expected)}; found {sorted(actual)}"
        )


def _request_id(value: object) -> str:
    if not isinstance(value, str) or REQUEST_ID_PATTERN.fullmatch(value) is None:
        raise WorkerProtocolError("requestId must contain 1-64 safe ASCII characters")
    return value


@dataclass(frozen=True, slots=True)
class WorkerRequest:
    request_id: str
    operation: WorkerOperation
    payload: dict[str, Any]
    protocol_version: str = WORKER_PROTOCOL_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocolVersion": self.protocol_version,
            "requestId": self.request_id,
            "operation": self.operation,
            "payload": self.payload,
        }

    @classmethod
    def from_dict(cls, value: object) -> WorkerRequest:
        payload = _object(value, "worker request")
        _exact_keys(
            payload,
            {"protocolVersion", "requestId", "operation", "payload"},
            "worker request",
        )
        protocol_version = payload["protocolVersion"]
        if protocol_version != WORKER_PROTOCOL_VERSION:
            raise WorkerProtocolError(
                f"worker protocol mismatch: expected {WORKER_PROTOCOL_VERSION!r}"
            )
        operation = payload["operation"]
        if operation not in {"probe", "run", "cancel"}:
            raise WorkerProtocolError("worker operation is unsupported")
        return cls(
            request_id=_request_id(payload["requestId"]),
            operation=operation,
            payload=_object(payload["payload"], "worker request payload"),
            protocol_version=protocol_version,
        )


@dataclass(frozen=True, slots=True)
class WorkerError:
    code: str
    message: str
    retryable: bool

    @classmethod
    def from_dict(cls, value: object) -> WorkerError:
        payload = _object(value, "worker error")
        _exact_keys(payload, {"code", "message", "retryable"}, "worker error")
        code = payload["code"]
        message = payload["message"]
        retryable = payload["retryable"]
        if not isinstance(code, str) or re.fullmatch(r"^[a-z][a-z0-9_]{1,63}$", code) is None:
            raise WorkerProtocolError("worker error code is invalid")
        if not isinstance(message, str) or not 1 <= len(message) <= MAX_WORKER_ERROR_MESSAGE:
            raise WorkerProtocolError("worker error message is invalid")
        if not isinstance(retryable, bool):
            raise WorkerProtocolError("worker error retryable must be boolean")
        return cls(code, message, retryable)

    def to_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": self.message, "retryable": self.retryable}


@dataclass(frozen=True, slots=True)
class WorkerResponse:
    request_id: str
    ok: bool
    result: dict[str, Any] | None
    error: WorkerError | None
    protocol_version: str = WORKER_PROTOCOL_VERSION

    def to_dict(self) -> dict[str, Any]:
        return {
            "protocolVersion": self.protocol_version,
            "requestId": self.request_id,
            "ok": self.ok,
            "result": self.result,
            "error": None if self.error is None else self.error.to_dict(),
        }

    @classmethod
    def from_dict(cls, value: object) -> WorkerResponse:
        payload = _object(value, "worker response")
        _exact_keys(
            payload,
            {"protocolVersion", "requestId", "ok", "result", "error"},
            "worker response",
        )
        if payload["protocolVersion"] != WORKER_PROTOCOL_VERSION:
            raise WorkerProtocolError(
                f"worker protocol mismatch: expected {WORKER_PROTOCOL_VERSION!r}"
            )
        ok = payload["ok"]
        if not isinstance(ok, bool):
            raise WorkerProtocolError("worker response ok must be boolean")
        result = payload["result"]
        error = payload["error"]
        if ok:
            if error is not None:
                raise WorkerProtocolError("successful worker response must not contain error")
            parsed_result = _object(result, "worker result")
            parsed_error = None
        else:
            if result is not None:
                raise WorkerProtocolError("failed worker response must not contain result")
            parsed_result = None
            parsed_error = WorkerError.from_dict(error)
        return cls(
            request_id=_request_id(payload["requestId"]),
            ok=ok,
            result=parsed_result,
            error=parsed_error,
            protocol_version=payload["protocolVersion"],
        )


__all__ = [
    "MAX_WORKER_INPUT_BYTES",
    "MAX_WORKER_OUTPUT_BYTES",
    "WORKER_PROTOCOL_VERSION",
    "WorkerError",
    "WorkerProtocolError",
    "WorkerRequest",
    "WorkerResponse",
]
