"""Stable, credential-safe client exception types."""

from __future__ import annotations

import re
from typing import Any

_BEARER = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_SECRET_FIELD = re.compile(r"(?:token|authorization|credential|secret|password)", re.I)


def redact_text(value: str) -> str:
    return _BEARER.sub("Bearer [redacted]", value)[:500]


def redact_value(value: Any, *, depth: int = 0) -> Any:
    if depth > 4:
        return "[redacted]"
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [redact_value(item, depth=depth + 1) for item in value]
    if isinstance(value, dict):
        return {
            str(key)[:128]: "[redacted]"
            if _SECRET_FIELD.search(str(key))
            else redact_value(item, depth=depth + 1)
            for key, item in value.items()
        }
    return value


class CaptureRuntimeError(RuntimeError):
    """Base error with stable, redacted wire diagnostics.

    ``CaptureRemoteError`` and the narrower taxonomy subclasses below preserve
    the fields emitted by a runtime error envelope.  The historical
    ``CaptureRuntime*`` names remain available as compatibility aliases.
    """

    category = "runtime"

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        details: Any = None,
        category: str | None = None,
        retryable: bool = False,
        issues: list[dict[str, Any]] | None = None,
        request_id: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.code = code
        self.runtime_message = redact_text(message)
        self.details = redact_value(details)
        self.category = category or self.category
        self.retryable = retryable
        self.issues = redact_value(issues) if issues is not None else []
        self.request_id = request_id
        super().__init__(f"Capture Runtime request failed ({code}): {self.runtime_message}")


class CaptureTransportError(CaptureRuntimeError):
    category = "transport"

    def __init__(self, message: str, details: Any = None, *, code: str = "transport_error") -> None:
        super().__init__(
            status_code=0,
            code=code,
            message=message,
            details=details,
            category=self.category,
            retryable=True,
        )


class CaptureAuthenticationError(CaptureRuntimeError):
    category = "authentication"

    def __init__(
        self,
        message: str = "Capture Runtime authentication failed.",
        *,
        status_code: int = 401,
        details: Any = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            code="unauthorized",
            message=message,
            details=details,
            category=self.category,
            request_id=request_id,
        )


class CaptureCompatibilityError(CaptureRuntimeError):
    category = "compatibility"

    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(
            status_code=0,
            code="incompatible_runtime",
            message=message,
            details=details,
            category=self.category,
        )


class CaptureProtocolError(CaptureRuntimeError):
    category = "protocol"

    def __init__(self, message: str, details: Any = None) -> None:
        super().__init__(
            status_code=0,
            code="protocol_error",
            message=message,
            details=details,
            category=self.category,
        )


class CaptureRemoteError(CaptureRuntimeError):
    category = "remote"

    def __init__(
        self,
        *,
        status_code: int,
        code: str,
        message: str,
        category: str | None = None,
        retryable: bool = False,
        details: Any = None,
        issues: list[dict[str, Any]] | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(
            status_code=status_code,
            code=code,
            message=message,
            details=details,
            category=category or self.category,
            retryable=retryable,
            issues=issues,
            request_id=request_id,
        )


# Compatibility names used by the first SDK preview.
CaptureRuntimeProtocolError = CaptureProtocolError
CaptureRuntimeCompatibilityError = CaptureCompatibilityError


__all__ = [
    "CaptureAuthenticationError",
    "CaptureCompatibilityError",
    "CaptureProtocolError",
    "CaptureRemoteError",
    "CaptureTransportError",
    "CaptureRuntimeCompatibilityError",
    "CaptureRuntimeError",
    "CaptureRuntimeProtocolError",
    "redact_text",
    "redact_value",
]
