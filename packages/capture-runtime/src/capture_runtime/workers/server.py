"""Minimal JSON-lines worker server: one run per process, or runs until stdin closes."""

from __future__ import annotations

import json
import os
import queue
import sys
import threading
import time
from collections.abc import Callable
from functools import partial
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


def serve(
    handler: WorkerHandler,
    *,
    prepare: WorkerPreparer | None = None,
    persistent: bool = False,
) -> None:
    """Serve one run, or with `persistent` one run after another until stdin closes."""

    if persistent:
        _serve_persistent(handler, prepare)
        return
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


_MALFORMED = object()


class _Inbox:
    """Reads stdin on one thread: cancel frames reach the active run, requests queue.

    Like the one-run listener it waits with PeekNamedPipe before each read, so
    no read is pending while a run's native libraries touch stdin.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active: tuple[str, threading.Event] | None = None
        self._requests: queue.Queue[object] = queue.Queue()

    def activate(self, request_id: str) -> threading.Event:
        cancellation = threading.Event()
        with self._lock:
            self._active = (request_id, cancellation)
        return cancellation

    def deactivate(self) -> None:
        with self._lock:
            self._active = None

    def next(self) -> object:
        """The next request, _MALFORMED, or None once stdin has closed."""

        return self._requests.get()

    def read(self) -> None:
        while _wait_for_input():
            line = sys.stdin.buffer.readline(MAX_WORKER_INPUT_BYTES + 2)
            if not line:
                break
            try:
                if len(line) > MAX_WORKER_INPUT_BYTES or not line.endswith(b"\n"):
                    raise WorkerProtocolError("worker request framing is invalid")
                message = WorkerRequest.from_dict(json.loads(line.decode("utf-8")))
            except (UnicodeDecodeError, json.JSONDecodeError, WorkerProtocolError):
                with self._lock:
                    active = self._active
                if active is not None:
                    active[1].set()
                else:
                    self._requests.put(_MALFORMED)
                continue
            if message.operation == "cancel":
                with self._lock:
                    active = self._active
                # A cancel that arrives after its run finished is stale.
                if active is not None and message.payload == {"requestId": active[0]}:
                    active[1].set()
                continue
            self._requests.put(message)
        self._requests.put(None)


def _serve_persistent(handler: WorkerHandler, prepare: WorkerPreparer | None) -> None:
    """Runs one after another, so a warm worker keeps its loaded models.

    A failed or cancelled run ends the process as in one-run mode: what it left
    loaded is not trusted for the next run.
    """

    inbox = _Inbox()
    threading.Thread(target=inbox.read, name="capture-worker-input", daemon=True).start()
    prepared = False
    while True:
        message = inbox.next()
        if message is None:
            os._exit(0)
        if message is _MALFORMED:
            _failure("invalid", "malformed_request", "Worker request is invalid.", retryable=False)
            os._exit(0)
        assert isinstance(message, WorkerRequest)
        request = message
        if request.operation in {"probe", "preflight"}:
            try:
                result = handler(request, threading.Event(), lambda _payload: None)
            except Exception:
                _failure(request.request_id, "probe_failed", "Worker probe failed.", retryable=True)
            else:
                _write(WorkerResponse(request.request_id, True, result, None))
            continue
        if prepare is not None and not prepared:
            try:
                prepare(request)
            except Exception:
                _failure(
                    request.request_id,
                    "worker_failed",
                    "Worker preparation failed.",
                    retryable=True,
                )
                os._exit(0)
            prepared = True
        cancellation = inbox.activate(request.request_id)
        try:
            result = handler(
                request,
                cancellation,
                partial(_progress, request.request_id),
            )
        except InterruptedError:
            _failure(
                request.request_id,
                "worker_cancelled",
                "Worker operation was cancelled.",
                retryable=True,
            )
            os._exit(0)
        except Exception:
            _failure(
                request.request_id,
                "worker_failed",
                "Worker operation failed.",
                retryable=True,
            )
            os._exit(1)
        inbox.deactivate()
        _write(WorkerResponse(request.request_id, True, result, None))


__all__ = ["permille_reporter", "serve"]
