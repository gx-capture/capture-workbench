"""The PDF page selection rule and its shared golden case.

``tests/fixtures/ocr-page-selection-v3.json`` is read by the runtime, the
Python, TypeScript and Java clients alike: pages 3, 7, 8 and 20 of a 46-page
source keep those numbers everywhere, and the invalid cases fail everywhere.
"""

from __future__ import annotations

import json
from copy import deepcopy
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.contracts import (
    CaptureOcrProjectionV3,
    CaptureSource,
    OcrPageScopeV2,
    OcrProvenanceV3,
    StartCaptureV2,
    StructuringMode,
)
from capture_runtime.ocr_projection import OcrBoxInput, OcrPageInput, OcrPipeline
from capture_runtime.pdf_page_selection import (
    MAX_PDF_PAGE_SELECTION,
    is_ascending_page_numbers,
    is_pdf_page_selection,
)

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "ocr-page-selection-v3.json"
CONTRACT_SHA256 = "d" * 64


def _fixture() -> dict[str, Any]:
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    projection = fixture["projection"]
    projection["contractSha256"] = CONTRACT_SHA256
    projection["runtimeVersion"] = RUNTIME_VERSION
    return fixture


@pytest.mark.parametrize(
    "pages",
    [[1], (1, 2, 3), [3, 7, 8, 20], list(range(2, 1_001, 2))],
)
def test_a_selection_is_any_ascending_list_of_source_pages(pages: list[int]) -> None:
    assert is_pdf_page_selection(pages)


@pytest.mark.parametrize(
    "pages",
    [[], [0], [-3], [3, 3], [7, 3], [True], [1.0], "13", None, list(range(1, 502))],
)
def test_anything_else_is_not_a_selection(pages: object) -> None:
    assert not is_pdf_page_selection(pages)


def test_the_selection_limit_and_the_ascending_rule() -> None:
    assert MAX_PDF_PAGE_SELECTION == 500
    assert is_ascending_page_numbers([])
    assert not is_ascending_page_numbers([2, 1])


def test_golden_selection_is_what_the_producer_builds() -> None:
    fixture = _fixture()
    expected = fixture["projection"]
    provenance = OcrProvenanceV3.model_validate(expected["provenance"])
    pages = [
        OcrPageInput(
            page=page["page"],
            text=page["text"],
            raster_width=page["raster"]["width"],
            raster_height=page["raster"]["height"],
            raster_scale=page["raster"]["scale"],
            boxes=tuple(
                OcrBoxInput(
                    polygon=tuple((point["x"], point["y"]) for point in box["polygon"]),
                    text=box["text"],
                    confidence=box["confidence"],
                )
                for box in page["boxes"]
            ),
            region_confidences=tuple(box["confidence"] for box in page["boxes"]),
            provenance=provenance,
        )
        for page in expected["pages"]
    ]

    built = OcrPipeline(contract_sha256=CONTRACT_SHA256).build(
        capture_id=expected["captureId"],
        source=CaptureSource.model_validate(expected["source"]),
        pages=pages,
        provenance=provenance,
        created_at=datetime.fromisoformat(expected["createdAt"]),
    )

    assert built.model_dump(mode="json", by_alias=True) == expected
    assert [page.page for page in built.pages] == fixture["pdfPageNumbers"]


def test_golden_selection_crosses_the_wire_models_with_its_page_numbers() -> None:
    fixture = _fixture()

    request = StartCaptureV2(
        client_request_id="golden-selection",
        ingestion_id="ingestion-1",
        structuring_mode=StructuringMode.HOST,
        pdf_page_numbers=fixture["pdfPageNumbers"],
    )
    scope = OcrPageScopeV2.model_validate(fixture["ocrPageScope"])
    projection = CaptureOcrProjectionV3.model_validate(fixture["projection"])

    assert request.model_dump(by_alias=True)["pdfPageNumbers"] == [3, 7, 8, 20]
    assert scope.requested_page_numbers == scope.processed_page_numbers == [3, 7, 8, 20]
    assert scope.source_page_count == 46
    assert projection.page_count == 4
    assert [page.page for page in projection.pages] == [3, 7, 8, 20]
    assert [page.status.value for page in projection.pages] == [
        "recognized",
        "recognized",
        "empty",
        "recognized",
    ]


def test_golden_invalid_selections_are_rejected() -> None:
    fixture = _fixture()

    for pages in fixture["invalidPdfPageNumbers"]:
        assert not is_pdf_page_selection(pages)
        with pytest.raises(ValidationError):
            StartCaptureV2(
                client_request_id="golden-invalid-selection",
                ingestion_id="ingestion-1",
                structuring_mode=StructuringMode.HOST,
                pdf_page_numbers=pages,
            )
    for order in fixture["invalidProjectionPageOrders"]:
        projection = deepcopy(fixture["projection"])
        for page, number in zip(projection["pages"], order, strict=True):
            page["page"] = number
        with pytest.raises(ValidationError, match="ascending source page order"):
            CaptureOcrProjectionV3.model_validate(projection)
