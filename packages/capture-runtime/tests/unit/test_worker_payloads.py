"""Parser-level pins for worker wire payloads (progress frames and OCR prefix checks)."""

from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from capture_runtime._worker_payloads import WorkerResultError
from capture_runtime.contracts import OcrProvenanceV3
from capture_runtime.ocr.infrastructure.ocr_worker_result import (
    OcrWorkerRunResult,
    WorkerOcrPage,
    _assert_ocr_progress_matches_final,
    _consecutive_progress_prefix,
    _OcrProgressConsistencyError,
    _safe_parse_ocr_progress,
    parse_ocr_progress,
)

RASTER = {"width": 120, "height": 80, "scale": 1, "coordinateSystem": "pixel"}


def _provenance() -> OcrProvenanceV3:
    return OcrProvenanceV3(
        status="resolved",
        engine="windowsml-ocr",
        model="test-model",
        model_digest="sha256:" + "1" * 64,
        device="windowsml-dml",
        profile_id="capture-workbench-ocr-pipeline-v1",
        profile_spec_sha256="c" * 64,
    )


def _header(pages: list[int]) -> dict[str, Any]:
    return {
        "type": "ocr-header",
        "pageCount": len(pages),
        "provenance": _provenance().model_dump(mode="json", by_alias=True),
        "pages": [{"page": page, "raster": dict(RASTER)} for page in pages],
    }


def _page(page: int, text: str = "hello") -> dict[str, Any]:
    return {
        "page": page,
        "status": "recognized",
        "text": text,
        "boxes": [],
        "regionConfidences": [],
        "confidence": None,
        "raster": dict(RASTER),
        "failure": None,
    }


def _frame(page: int, text: str = "hello") -> dict[str, Any]:
    return {"type": "ocr-page", "page": _page(page, text)}


def _final(pages: tuple[WorkerOcrPage, ...], **changes: Any) -> OcrWorkerRunResult:
    result = OcrWorkerRunResult(
        segments=(),
        engine="windowsml-ocr",
        model="test-model",
        digest="sha256:" + "1" * 64,
        device="windowsml-dml",
        warnings=(),
        pages=pages,
        ocr_provenance=_provenance(),
    )
    return replace(result, **changes)


def _two_page_progress(frames: int = 2):  # noqa: ANN202
    progress = parse_ocr_progress([_header([1, 2]), *[_frame(n) for n in range(1, frames + 1)]])
    assert progress is not None
    return progress


def test_empty_progress_is_none() -> None:
    assert parse_ocr_progress([]) is None
    assert _safe_parse_ocr_progress([]) is None


def test_progress_parses_header_and_pages() -> None:
    progress = parse_ocr_progress([_header([3, 7]), _frame(7)])
    assert progress is not None
    assert progress.page_count == 2
    assert [page.page for page in progress.page_manifest] == [3, 7]
    assert [page.page for page in progress.pages] == [7]
    assert progress.provenance == _provenance()


@pytest.mark.parametrize(
    ("payloads", "message"),
    [
        ([{"type": "ocr-page", "page": {}}], "OCR progress header is invalid"),
        ([{**_header([1]), "pageCount": 2}], "OCR progress page manifest is invalid"),
        ([_header([2, 1])], "OCR progress page manifest entry is invalid"),
        ([_header([1]), {"type": "ocr-page"}], "OCR progress page frame is invalid"),
        ([_header([1]), _frame(2)], "OCR progress page number is invalid"),
        ([_header([1]), _frame(1), _frame(1)], "OCR progress contains a duplicate page"),
        ([_header([1]), _frame(1, text="")], "recognized worker OCR pages require text"),
    ],
)
def test_malformed_progress_raises_worker_result_error(
    payloads: list[dict[str, Any]], message: str
) -> None:
    with pytest.raises(WorkerResultError) as error:
        parse_ocr_progress(payloads)
    assert type(error.value) is WorkerResultError
    assert str(error.value) == message
    assert _safe_parse_ocr_progress(payloads) is None


def test_progress_rejects_unavailable_provenance() -> None:
    header = _header([1])
    header["provenance"] = {
        "status": "unavailable",
        "profileId": "capture-workbench-ocr-pipeline-v1",
        "profileSpecSha256": "c" * 64,
        "reason": "protocol_failure",
    }
    with pytest.raises(WorkerResultError) as error:
        parse_ocr_progress([header, _frame(1)])
    assert str(error.value) == "OCR progress header requires resolved provenance"


def test_consecutive_prefix_stops_at_first_out_of_order_page() -> None:
    progress = parse_ocr_progress([_header([1, 2, 3]), _frame(1), _frame(3)])
    assert progress is not None
    assert [p.page for p in _consecutive_progress_prefix(progress).pages] == [1]
    full = _two_page_progress()
    assert _consecutive_progress_prefix(full) == full


def test_matching_final_is_accepted() -> None:
    progress = _two_page_progress()
    _assert_ocr_progress_matches_final(progress, _final(progress.pages))


def _assert_rejected(progress, final: OcrWorkerRunResult, message: str, trusted: int) -> None:  # noqa: ANN001
    with pytest.raises(_OcrProgressConsistencyError) as error:
        _assert_ocr_progress_matches_final(progress, final)
    assert isinstance(error.value, WorkerResultError)
    assert str(error.value) == message
    assert [p.page for p in error.value.progress.pages] == list(range(1, trusted + 1))


def test_content_equivocation_keeps_only_the_verified_prefix() -> None:
    progress = _two_page_progress()
    changed = replace(progress.pages[1], text="different")
    _assert_rejected(
        progress,
        _final((progress.pages[0], changed)),
        "OCR worker progress and final page content differ",
        1,
    )


def test_final_raster_mismatch_is_rejected() -> None:
    progress = _two_page_progress()
    changed = replace(progress.pages[0], raster_width=121)
    _assert_rejected(
        progress,
        _final((changed, progress.pages[1])),
        "OCR worker progress manifest and final raster differ",
        0,
    )


def test_final_page_order_mismatch_is_rejected() -> None:
    progress = _two_page_progress()
    swapped = (replace(progress.pages[0], page=2), progress.pages[1])
    _assert_rejected(
        progress, _final(swapped), "OCR worker progress and final page order differ", 0
    )


def test_short_final_is_rejected_with_comparable_prefix() -> None:
    progress = _two_page_progress(frames=1)
    _assert_rejected(
        progress, _final(progress.pages), "OCR worker progress and final page counts differ", 1
    )


def test_provenance_mismatch_trusts_no_pages() -> None:
    progress = _two_page_progress(frames=1)
    other = OcrProvenanceV3(**{**_provenance().model_dump(), "device": "other-device"})
    for provenance in (other, None):
        with pytest.raises(_OcrProgressConsistencyError) as error:
            _assert_ocr_progress_matches_final(
                progress, _final(progress.pages, ocr_provenance=provenance)
            )
        assert str(error.value) == "OCR worker progress and final provenance differ"
        assert error.value.progress.pages == ()
