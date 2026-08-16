from __future__ import annotations

from pathlib import Path
from threading import Event

import pytest

import capture_runtime.workers.ocr_main as ocr_main
from capture_runtime.engine_adapters import OcrTextResult
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


def test_model_worker_pyinstaller_specs_do_not_collect_public_contract_package_data() -> None:
    pyinstaller_root = Path(__file__).resolve().parents[1] / "pyinstaller"

    for name in ("capture-engine-ocr.spec", "capture-engine-whisper.spec"):
        spec = (pyinstaller_root / name).read_text(encoding="utf-8")
        retired_package = "capture_" + "contracts"
        assert f'collect_data_files("{retired_package}")' not in spec


def test_ocr_pdf_renders_one_page_at_a_time(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    source = tmp_path / "public-fixture.pdf"
    source.write_bytes(b"public test fixture")
    resident_pages = 0
    peak_resident_pages = 0

    def render_page(_source: Path, page_index: int, _scale: float) -> bytes:
        nonlocal resident_pages, peak_resident_pages
        resident_pages += 1
        peak_resident_pages = max(peak_resident_pages, resident_pages)
        return f"page-{page_index}".encode()

    class TestAdapter:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def extract_png(self, _image: bytes) -> OcrTextResult:
            nonlocal resident_pages
            resident_pages -= 1
            return OcrTextResult(
                text="public fixture text",
                model="test-model",
                digest="0" * 64,
                device="windowsml-dml",
                warning=None,
            )

    monkeypatch.setattr(ocr_main, "_render_page", render_page)
    monkeypatch.setattr(ocr_main, "WindowsMLOcrAdapter", TestAdapter)

    result = ocr_main.handle(
        WorkerRequest(
            request_id="ocr-streaming-test",
            operation="run",
            payload={
                "requirementId": "windowsml-ocr",
                "artifactVersion": "0.4.1",
                "modelPath": str(model_path),
                "sourcePath": str(source),
                "mediaType": "application/pdf",
                "options": {
                    "deviceId": 0,
                    "pages": [1, 2, 3],
                    "renderScale": 2,
                },
            },
        ),
        Event(),
    )

    assert peak_resident_pages == 1
    assert resident_pages == 0
    assert [segment["page"] for segment in result["segments"]] == [1, 2, 3]


def test_ocr_run_reports_empty_output_stage(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    source = tmp_path / "public-fixture.pdf"
    source.write_bytes(b"public test fixture")
    stages: list[str] = []

    monkeypatch.setattr(ocr_main, "_report_stage", stages.append)
    monkeypatch.setattr(ocr_main, "_render_page", lambda *_args: b"page")

    class EmptyAdapter:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            pass

        def extract_png(self, _image: bytes) -> OcrTextResult:
            return OcrTextResult(
                text="   ",
                model="test-model",
                digest="0" * 64,
                device="windowsml-dml",
                warning=None,
            )

    monkeypatch.setattr(ocr_main, "WindowsMLOcrAdapter", EmptyAdapter)

    with pytest.raises(ValueError, match="non-empty segments"):
        ocr_main.handle(
            WorkerRequest(
                request_id="ocr-empty-output-test",
                operation="run",
                payload={
                    "requirementId": "windowsml-ocr",
                    "artifactVersion": "0.4.1",
                    "modelPath": str(model_path),
                    "sourcePath": str(source),
                    "mediaType": "application/pdf",
                    "options": {
                        "deviceId": 0,
                        "pages": [1],
                        "renderScale": 2,
                    },
                },
            ),
            Event(),
        )

    assert "ocr-output-empty" in stages
