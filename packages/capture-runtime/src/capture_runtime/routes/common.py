"""Shared route validation helpers and API problem type."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from fastapi.responses import JSONResponse

from capture_runtime.contracts import ErrorBodyV2, ErrorEnvelopeV2


class ApiProblem(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details


def error_response(
    status_code: int,
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    envelope = ErrorEnvelopeV2(error=ErrorBodyV2(code=code, message=message, details=details))
    return JSONResponse(
        status_code=status_code,
        content=envelope.model_dump(mode="json", by_alias=True, exclude_none=True),
        headers=headers,
    )


def safe_filename(value: str | None) -> str:
    candidate = Path(value or "upload.bin").name
    candidate = "".join(
        character for character in candidate if character >= " " and character != "\x7f"
    )
    candidate = candidate.strip()[:255]
    return candidate or "upload.bin"


def request_fingerprint(payload: object) -> str:
    canonical = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


__all__ = ["ApiProblem", "error_response", "request_fingerprint", "safe_filename"]
