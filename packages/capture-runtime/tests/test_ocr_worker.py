from __future__ import annotations

from pathlib import Path

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


def test_model_worker_pyinstaller_specs_include_contract_manifest_data() -> None:
    pyinstaller_root = Path(__file__).resolve().parents[1] / "pyinstaller"

    for name in ("capture-engine-ocr.spec", "capture-engine-whisper.spec"):
        spec = (pyinstaller_root / name).read_text(encoding="utf-8")
        assert 'collect_data_files("capture_contracts")' in spec
