"""Minimal one-run JSON-lines worker server."""

from __future__ import annotations

import json
import os
import sys
import threading
from collections.abc import Callable
from typing import Any

from capture_runtime.worker_contracts import (
    MAX_WORKER_INPUT_BYTES,
    WorkerError,
    WorkerProtocolError,
    WorkerRequest,
    WorkerResponse,
)

WorkerHandler = Callable[[WorkerRequest, threading.Event], dict[str, Any]]


def _write(response: WorkerResponse) -> None:
    encoded = json.dumps(response.to_dict(), ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def _failure(request_id: str, code: str, message: str, *, retryable: bool) -> None:
    _write(
        WorkerResponse(
            request_id=request_id,
            ok=False,
            result=None,
            error=WorkerError(code, message[:500], retryable),
        )
    )


def serve(handler: WorkerHandler) -> None:
    first = sys.stdin.buffer.readline(MAX_WORKER_INPUT_BYTES + 2)
    if not first or len(first) > MAX_WORKER_INPUT_BYTES or not first.endswith(b"\n"):
        _failure(
            "invalid",
            "malformed_request",
            "Worker request framing is invalid.",
            retryable=False,
        )
        return
    try:
        request = WorkerRequest.from_dict(json.loads(first.decode("utf-8")))
    except (UnicodeDecodeError, json.JSONDecodeError, WorkerProtocolError):
        _failure("invalid", "malformed_request", "Worker request is invalid.", retryable=False)
        return
    cancellation = threading.Event()
    if request.operation == "cancel":
        _failure(
            request.request_id,
            "invalid_operation",
            "No worker operation is active.",
            retryable=False,
        )
        return
    if request.operation == "probe":
        try:
            _write(WorkerResponse(request.request_id, True, handler(request, cancellation), None))
        except Exception:
            _failure(
                request.request_id,
                "probe_failed",
                "Worker probe failed.",
                retryable=True,
            )
        return

    def run_and_exit() -> None:
        try:
            result = handler(request, cancellation)
            _write(WorkerResponse(request.request_id, True, result, None))
            code = 0
        except InterruptedError:
            _failure(
                request.request_id,
                "worker_cancelled",
                "Worker operation was cancelled.",
                retryable=True,
            )
            code = 0
        except Exception:
            _failure(
                request.request_id,
                "worker_failed",
                "Worker operation failed.",
                retryable=True,
            )
            code = 1
        os._exit(code)

    thread = threading.Thread(target=run_and_exit, name="capture-worker-run", daemon=False)
    thread.start()
    while thread.is_alive():
        line = sys.stdin.buffer.readline(MAX_WORKER_INPUT_BYTES + 2)
        if not line:
            thread.join()
            return
        try:
            message = WorkerRequest.from_dict(json.loads(line.decode("utf-8")))
        except (UnicodeDecodeError, json.JSONDecodeError, WorkerProtocolError):
            cancellation.set()
            continue
        if message.operation == "cancel" and message.payload == {"requestId": request.request_id}:
            cancellation.set()
    thread.join()


__all__ = ["serve"]
