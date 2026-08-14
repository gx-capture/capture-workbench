"""Authenticated HTTP and deterministic in-memory transports."""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Protocol, cast
from urllib.parse import urlsplit

import httpx

from .errors import CaptureTransportError


def validate_loopback_base_url(value: str | int) -> str:
    candidate = f"http://127.0.0.1:{value}" if isinstance(value, int) else value
    parsed = urlsplit(candidate)
    if (
        parsed.scheme != "http"
        or parsed.hostname not in {"127.0.0.1", "::1"}
        or not parsed.port
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise CaptureTransportError(
            "Capture Runtime URL must be an HTTP loopback origin with an explicit port.",
            code="unsafe_base_url",
        )
    return f"http://{parsed.hostname}:{parsed.port}"


class RuntimeTransport(Protocol):
    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response: ...

    def stream(self, method: str, path: str, **kwargs: Any) -> Any: ...


class HttpRuntimeTransport:
    def __init__(
        self,
        *,
        base_url: str | int,
        bearer_token: str,
        timeout_seconds: float = 30,
        client: httpx.Client | None = None,
    ) -> None:
        self.base_url = validate_loopback_base_url(base_url)
        if not bearer_token.strip():
            raise ValueError("Capture Runtime bearer token must not be empty")
        self._token = bearer_token
        self._client = client or httpx.Client(timeout=timeout_seconds, follow_redirects=False)
        self._owns_client = client is None

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}) or {})
        headers["Authorization"] = f"Bearer {self._token}"
        try:
            return self._client.request(method, f"{self.base_url}{path}", headers=headers, **kwargs)
        except httpx.HTTPError as error:
            raise CaptureTransportError(
                "Capture Runtime transport request failed.", str(error)
            ) from error

    def stream(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = dict(kwargs.pop("headers", {}) or {})
        headers["Authorization"] = f"Bearer {self._token}"
        try:
            context = self._client.stream(
                method, f"{self.base_url}{path}", headers=headers, **kwargs
            )
            return _HttpxStream(context)
        except httpx.HTTPError as error:
            raise CaptureTransportError(
                "Capture Runtime transport stream failed.", str(error)
            ) from error

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> HttpRuntimeTransport:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()


@dataclass(frozen=True, slots=True)
class InMemoryRoute:
    method: str
    path: str
    handler: Callable[[httpx.Request], httpx.Response]


class InMemoryRuntimeTransport:
    """Small adapter for client contract tests without sockets or credentials."""

    def __init__(
        self,
        routes: Mapping[tuple[str, str], Callable[[httpx.Request], httpx.Response]] | None = None,
    ) -> None:
        self._routes = dict(routes or {})

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        request = httpx.Request(method, f"http://capture.test{path}", **kwargs)
        handler = self._routes.get((method.upper(), path))
        if handler is None:
            return httpx.Response(
                404,
                json={"error": {"code": "not_found", "message": "Route not found."}},
                request=request,
            )
        return handler(request)

    def stream(self, method: str, path: str, **kwargs: Any) -> Any:
        response = self.request(method, path, **kwargs)
        return _InMemoryStream(response)


class _InMemoryStream:
    def __init__(self, response: httpx.Response) -> None:
        self.response = response

    def __enter__(self) -> httpx.Response:
        return self.response

    def __exit__(self, *_args: object) -> None:
        self.response.close()


class _HttpxStream:
    """Map deferred httpx stream failures to the SDK transport taxonomy."""

    def __init__(self, context: Any) -> None:
        self._context = context

    def __enter__(self) -> httpx.Response:
        try:
            return cast(httpx.Response, self._context.__enter__())
        except httpx.HTTPError as error:
            raise CaptureTransportError(
                "Capture Runtime transport stream failed.", str(error)
            ) from error

    def __exit__(self, *args: object) -> Any:
        return self._context.__exit__(*args)


__all__ = [
    "HttpRuntimeTransport",
    "InMemoryRoute",
    "InMemoryRuntimeTransport",
    "RuntimeTransport",
    "validate_loopback_base_url",
]
