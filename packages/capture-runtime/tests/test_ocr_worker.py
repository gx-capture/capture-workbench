from __future__ import annotations

import capture_runtime.workers.ocr_main as ocr_main
from capture_runtime.worker_contracts import WorkerRequest


def _request(operation: str) -> WorkerRequest:
    return WorkerRequest(
        request_id="ocr-prepare-test",
        operation=operation,  # type: ignore[arg-type]
        payload={},
    )


def test_ocr_run_prepares_native_runtime_before_cancellation_listener(monkeypatch) -> None:
    calls: list[str] = []
    monkeypatch.setattr(ocr_main, "_import_ocr_runtime", lambda: calls.append("prepared"))

    ocr_main.prepare(_request("run"))
    ocr_main.prepare(_request("probe"))

    assert calls == ["prepared"]
