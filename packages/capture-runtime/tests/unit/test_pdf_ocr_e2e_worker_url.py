from __future__ import annotations

import pytest

from capture_runtime.provisioning.infrastructure._engine_installation_download import (
    pdf_ocr_e2e_local_worker_url,
)
from capture_runtime.provisioning.infrastructure.engine_installation import EngineInstallationError


def test_pdf_ocr_e2e_local_worker_url_requires_explicit_opt_in() -> None:
    assert (
        pdf_ocr_e2e_local_worker_url(
            {
                "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL": (
                    "http://127.0.0.1:43124/capture-engine-ocr-test.zip"
                )
            }
        )
        is None
    )


def test_pdf_ocr_e2e_local_worker_url_accepts_one_exact_loopback_file() -> None:
    assert (
        pdf_ocr_e2e_local_worker_url(
            {
                "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN": "1",
                "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL": (
                    "http://127.0.0.1:43124/capture-engine-ocr-test.zip"
                ),
            }
        )
        == "http://127.0.0.1:43124/capture-engine-ocr-test.zip"
    )


@pytest.mark.parametrize(
    "worker_url",
    [
        "https://127.0.0.1:43124/worker.zip",
        "http://localhost:43124/worker.zip",
        "http://127.0.0.1:43124/nested/worker.zip",
        "http://127.0.0.1:43124/worker.zip?token=secret",
    ],
)
def test_pdf_ocr_e2e_local_worker_url_rejects_unsafe_urls(worker_url: str) -> None:
    with pytest.raises(EngineInstallationError, match="numeric-loopback HTTP file URL"):
        pdf_ocr_e2e_local_worker_url(
            {
                "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN": "1",
                "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL": worker_url,
            }
        )
