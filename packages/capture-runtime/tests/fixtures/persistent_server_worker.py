from __future__ import annotations

import os
import threading

from capture_runtime.worker_contracts import WorkerRequest
from capture_runtime.workers.server import serve

prepared = 0


def prepare(_request: WorkerRequest) -> None:
    global prepared
    prepared += 1


def handle(
    request: WorkerRequest,
    cancellation: threading.Event,
    progress: object,
) -> dict[str, object]:
    mode = request.payload.get("mode")
    if request.operation == "preflight":
        return {"pid": os.getpid()}
    if mode == "fail":
        raise ValueError("fixture failure")
    if mode == "stdin-free":
        # A native library touching stdin mid-run must not wait on the reader.
        done = threading.Event()
        threading.Thread(target=lambda: (os.close(os.dup(0)), done.set()), daemon=True).start()
        return {"pid": os.getpid(), "stdinFree": done.wait(2)}
    if mode == "cancel":
        assert callable(progress)
        progress({"type": "waiting-for-cancel"})
        if cancellation.wait(5):
            raise InterruptedError
        return {"cancelled": False}
    if mode == "progress":
        assert callable(progress)
        progress({"type": "progress-fixture", "completed": 1})
    return {
        "pid": os.getpid(),
        "mainThread": threading.current_thread() is threading.main_thread(),
        "prepared": prepared,
    }


serve(handle, prepare=prepare, persistent=True)
