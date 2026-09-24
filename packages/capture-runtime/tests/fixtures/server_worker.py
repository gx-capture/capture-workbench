from __future__ import annotations

import threading

from capture_runtime.worker_contracts import WorkerRequest
from capture_runtime.workers.server import serve

prepared_on_main_thread = False


def prepare(_request: WorkerRequest) -> None:
    global prepared_on_main_thread
    prepared_on_main_thread = threading.current_thread() is threading.main_thread()


def handle(
    request: WorkerRequest,
    _cancellation: threading.Event,
    progress: object,
) -> dict[str, object]:
    if request.operation == "preflight":
        return {
            "contractSha256": request.payload["contractSha256"],
            "mode": "gpu-dml",
            "adapterClass": "dedicated",
            "userNoticeRequired": False,
        }
    if request.operation == "run" and request.payload.get("mode") == "progress":
        assert callable(progress)
        progress({"type": "progress-fixture", "completed": 1})
    return {
        "mainThread": threading.current_thread() is threading.main_thread(),
        "operation": request.operation,
        "preparedOnMainThread": prepared_on_main_thread,
    }


serve(handle, prepare=prepare)
