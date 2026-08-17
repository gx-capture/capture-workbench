"""Private transport construction and request invocation helpers."""

from __future__ import annotations

from typing import Any

import httpx

from ._error_mapping import map_http_request_error
from .transport import HttpRuntimeTransport, RuntimeTransport


def create_http_runtime_transport(
    *,
    base_url: str | int,
    bearer_token: str,
    timeout_seconds: float,
) -> RuntimeTransport:
    """Build the authenticated loopback transport without changing its policy."""
    return HttpRuntimeTransport(
        base_url=base_url,
        bearer_token=bearer_token,
        timeout_seconds=timeout_seconds,
    )


def request(transport: RuntimeTransport, method: str, path: str, **kwargs: Any) -> httpx.Response:
    """Invoke a transport and map only unclassified HTTPX request failures."""
    try:
        return transport.request(method, path, **kwargs)
    except httpx.HTTPError as error:
        raise map_http_request_error(error) from error


__all__ = ["create_http_runtime_transport", "request"]
