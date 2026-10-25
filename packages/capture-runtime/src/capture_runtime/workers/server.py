"""Minimal one-run JSON-lines worker server."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections.abc import Callable
from typing import Any

from capture_runtime.worker_contracts import (
    MAX_WORKER_INPUT_BYTES,
    WORKER_PROTOCOL_VERSION,
    WorkerError,
    WorkerProtocolError,
    WorkerRequest,
    WorkerResponse,
)

WorkerProgressReporter = Callable[[dict[str, Any]], None]
WorkerHandler = Callable[[WorkerRequest, threading.Event, WorkerProgressReporter], dict[str, Any]]
WorkerPreparer = Callable[[WorkerRequest], None]
INPUT_POLL_SECONDS = 0.05


def _write(response: WorkerResponse) -> None:
    encoded = json.dumps(response.to_dict(), ensure_ascii=False, separators=(",", ":")).encode(
        "utf-8"
    )
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def _progress(request_id: str, payload: dict[str, Any]) -> None:
    encoded = json.dumps(
        {
            "protocolVersion": WORKER_PROTOCOL_VERSION,
            "requestId": request_id,
            "kind": "progress",
            "payload": payload,
        },
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    sys.stdout.buffer.write(encoded + b"\n")
    sys.stdout.buffer.flush()


def permille_reporter(progress: WorkerProgressReporter) -> Callable[[int, int], None]:
    """Report completed/total as a 0-1000 progress frame, at most once per percent."""

    last = -1

    def report(completed: int, total: int) -> None:
        nonlocal last
        value = 1000 if total <= 0 else max(0, min(1000, completed * 1000 // total))
        if value >= last + 10 or (value == 1000 and last != 1000):
            last = value
            progress({"permille": value})

    return report


def _failure(request_id: str, code: str, message: str, *, retryable: bool) -> None:
    _write(
        WorkerResponse(
            request_id=request_id,
            ok=False,
            result=None,
            error=WorkerError(code, message[:500], retryable),
        )
    )


def _wait_for_input() -> bool:
    """Wait until stdin has data without a pending read; False once the pipe is closed.

    On Windows a blocked read of stdin holds the C runtime's lock on that file
    descriptor, and any other use of it waits. Loading TEA-ASR's processor and
    model hung that way beside a cancellation listener blocked in readline.
    """

    if os.name != "nt":
        return True
    import ctypes
    import msvcrt
    from ctypes import wintypes

    try:
        handle = msvcrt.get_osfhandle(sys.stdin.fileno())
    except (OSError, ValueError):
        return False
    available = wintypes.DWORD()
    peek = ctypes.windll.kernel32.PeekNamedPipe
    while True:
        if not peek(wintypes.HANDLE(handle), None, 0, None, ctypes.byref(available), None):
            return False
        if available.value:
            return True
        time.sleep(INPUT_POLL_SECONDS)


def serve(handler: WorkerHandler, *, prepare: WorkerPreparer | None = None) -> None:
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
    if request.operation in {"probe", "preflight"}:
        try:
            _write(
                WorkerResponse(
                    request.request_id,
                    True,
                    handler(request, cancellation, lambda _payload: None),
                    None,
                )
            )
        except Exception:
            _failure(
                request.request_id,
                "probe_failed",
                "Worker probe failed.",
                retryable=True,
            )
        return

    if prepare is not None:
        try:
            prepare(request)
        except Exception:
            _failure(
                request.request_id,
                "worker_failed",
                "Worker preparation failed.",
                retryable=True,
            )
            return

    def listen_for_cancellation() -> None:
        while True:
            if not _wait_for_input():
                return
            line = sys.stdin.buffer.readline(MAX_WORKER_INPUT_BYTES + 2)
            if not line:
                return
            try:
                message = WorkerRequest.from_dict(json.loads(line.decode("utf-8")))
            except (UnicodeDecodeError, json.JSONDecodeError, WorkerProtocolError):
                cancellation.set()
                continue
            if message.operation == "cancel" and message.payload == {
                "requestId": request.request_id
            }:
                cancellation.set()
                return

    threading.Thread(
        target=listen_for_cancellation,
        name="capture-worker-cancellation",
        daemon=True,
    ).start()
    try:
        result = handler(
            request,
            cancellation,
            lambda payload: _progress(request.request_id, payload),
        )
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


__all__ = ["permille_reporter", "serve"]
