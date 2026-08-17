"""Private retry policy for idempotent Capture Runtime requests."""

from __future__ import annotations

import time
from typing import Any

import httpx

from ._transport import request as transport_request
from .errors import CaptureTransportError
from .transport import RuntimeTransport


class RetryPolicy:
    """Apply the existing idempotency-aware retry rules to one transport port."""

    def __init__(self, max_retries: int, backoff_seconds: float) -> None:
        if max_retries < 0:
            raise ValueError("max_retries must be non-negative")
        if backoff_seconds < 0:
            raise ValueError("retry_backoff_seconds must be non-negative")
        self._max_retries = max_retries
        self._backoff_seconds = backoff_seconds

    def request(
        self,
        transport: RuntimeTransport,
        method: str,
        path: str,
        **kwargs: Any,
    ) -> httpx.Response:
        """Retry only safe or explicitly idempotent requests."""
        normalized_method = method.upper()
        headers = kwargs.get("headers") or {}
        has_idempotency_key = any(
            str(key).lower() == "x-idempotency-key" and bool(value)
            for key, value in dict(headers).items()
        )
        retryable_request = normalized_method in {"GET", "HEAD", "DELETE"} or has_idempotency_key
        retries = self._max_retries if retryable_request else 0
        for attempt in range(retries + 1):
            try:
                response = transport_request(transport, method, path, **kwargs)
            except CaptureTransportError:
                if attempt >= retries:
                    raise
                self._sleep_before_retry(attempt)
                continue
            except httpx.HTTPError as error:
                if attempt >= retries:
                    raise CaptureTransportError(
                        "Capture Runtime transport request failed.", str(error)
                    ) from error
                self._sleep_before_retry(attempt)
                continue
            if response.status_code in {408, 425, 429, 500, 502, 503, 504} and attempt < retries:
                retry_after = retry_after_seconds(response)
                response.close()
                self._sleep_before_retry(attempt, retry_after)
                continue
            return response
        raise AssertionError("retry loop must return or raise")

    def _sleep_before_retry(self, attempt: int, retry_after: float | None = None) -> None:
        delay = retry_after if retry_after is not None else self._backoff_seconds * (2**attempt)
        if delay > 0:
            time.sleep(delay)


def retry_after_seconds(response: httpx.Response) -> float | None:
    """Read a bounded retry hint while preserving invalid-header fallback behavior."""
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


__all__ = ["RetryPolicy", "retry_after_seconds"]
