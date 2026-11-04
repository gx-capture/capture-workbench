from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path

import pypdfium2 as pdfium  # type: ignore[import-untyped]
import pytest

from capture_runtime.capture_extraction import (
    OcrSourcePreflightError,
    PdfPageSelectionError,
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig

_UNSORTED = "PDF page selection must list source pages in ascending order without duplicates."


def _extractor(tmp_path: Path, *, max_pdf_pages: int = 3) -> StandaloneRuntimeCaptureExtractor:
    return StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        ExtractionRuntimeConfig(
            windowsml_model_dir=tmp_path / "windowsml",
            whisper_models_dir=tmp_path / "whisper",
            temp_dir=tmp_path / "temp",
            max_pdf_pages=max_pdf_pages,
            max_image_pixels=100_000,
            ocr_render_scale=2,
            max_audio_duration_ms=60_000,
            whisper_prefer_gpu=True,
        ),
    )


def _pdf(sizes: list[tuple[int, int]]) -> bytes:
    document = pdfium.PdfDocument.new()
    for width, height in sizes:
        document.new_page(width, height)
    output = BytesIO()
    document.save(output)
    document.close()
    return output.getvalue()


def test_without_a_selection_every_page_is_read_with_one_based_numbers(tmp_path: Path) -> None:
    extractor = _extractor(tmp_path)

    assert extractor._selected_pdf_pages(3, None) == (1, 2, 3)


def test_a_selection_keeps_its_source_page_numbers_even_when_the_source_is_longer(
    tmp_path: Path,
) -> None:
    extractor = _extractor(tmp_path, max_pdf_pages=2)

    assert extractor._selected_pdf_pages(50, (4, 49)) == (4, 49)


def test_an_unselected_source_over_the_limit_is_a_plain_value_error(tmp_path: Path) -> None:
    extractor = _extractor(tmp_path)

    with pytest.raises(ValueError, match=r"^PDF has 4 pages; limit is 3\.$") as raised:
        extractor._selected_pdf_pages(4, None)

    assert type(raised.value) is ValueError


@pytest.mark.parametrize(
    ("page_count", "page_numbers", "message"),
    [
        (5, (2, 2), _UNSORTED),
        (5, (3, 1), _UNSORTED),
        (5, (0, 1), _UNSORTED),
        (9, (1, 2, 3, 4), "PDF page selection has 4 pages; limit is 3."),
        (3, (2, 4), "PDF page selection includes page 4, but the PDF has 3 pages."),
    ],
)
def test_invalid_selections_fail_with_exact_messages(
    tmp_path: Path, page_count: int, page_numbers: tuple[int, ...], message: str
) -> None:
    extractor = _extractor(tmp_path)

    with pytest.raises(PdfPageSelectionError) as raised:
        extractor._selected_pdf_pages(page_count, page_numbers)

    assert str(raised.value) == message


def test_page_count_counts_real_pages_and_rejects_unreadable_input(tmp_path: Path) -> None:
    extractor = _extractor(tmp_path)

    assert extractor._pdf_page_count(_pdf([(10, 10), (10, 10)])) == 2
    with pytest.raises(ValueError, match=r"^Uploaded PDF is not readable\.$"):
        extractor._pdf_page_count(b"not a pdf")


def test_manifest_numbers_pages_from_one_and_scales_rasters(tmp_path: Path) -> None:
    extractor = _extractor(tmp_path)
    content = _pdf([(60, 40), (30, 20), (11, 7)])

    full = extractor._ocr_pdf_page_manifest(content, asyncio.Event())
    chosen = extractor._ocr_pdf_page_manifest(content, asyncio.Event(), page_numbers=(1, 3))

    assert [(p.page, p.raster_width, p.raster_height, p.raster_scale) for p in full] == [
        (1, 120, 80, 2),
        (2, 60, 40, 2),
        (3, 22, 14, 2),
    ]
    assert [(p.page, p.raster_width, p.raster_height) for p in chosen] == [
        (1, 120, 80),
        (3, 22, 14),
    ]


def test_preflight_keeps_selection_errors_but_wraps_other_failures(tmp_path: Path) -> None:
    extractor = _extractor(tmp_path)

    with pytest.raises(
        PdfPageSelectionError,
        match=r"^PDF page selection includes page 3, but the PDF has 2 pages\.$",
    ):
        extractor._preflight_pdf_manifest(
            _pdf([(10, 10), (10, 10)]), asyncio.Event(), page_numbers=(3,)
        )
    with pytest.raises(OcrSourcePreflightError, match=r"^OCR source preflight failed\.$"):
        extractor._preflight_pdf_manifest(b"not a pdf", asyncio.Event())


def test_cancellation_before_rasterization_stops_the_manifest(tmp_path: Path) -> None:
    extractor = _extractor(tmp_path)
    cancelled = asyncio.Event()
    cancelled.set()
    content = _pdf([(10, 10)])

    with pytest.raises(InterruptedError, match=r"^Capture extraction was cancelled\.$"):
        extractor._ocr_pdf_page_manifest(content, cancelled)
    with pytest.raises(InterruptedError):
        extractor._preflight_pdf_manifest(content, cancelled)


def test_cancellation_between_pages_closes_the_page_and_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []
    cancel = asyncio.Event()

    class Page:
        def get_size(self) -> tuple[float, float]:
            events.append("size")
            cancel.set()
            return (1.0, 1.0)

        def close(self) -> None:
            events.append("page-close")

    class Document:
        def __init__(self, _source: object) -> None:
            events.append("open")

        def __getitem__(self, index: int) -> Page:
            events.append(f"page-{index}")
            return Page()

        def close(self) -> None:
            events.append("document-close")

    monkeypatch.setattr(pdfium, "PdfDocument", Document)
    extractor = _extractor(tmp_path)

    with pytest.raises(InterruptedError):
        extractor._pdf_page_raster_dimensions(b"x", cancel, (2, 3))

    assert events == ["open", "page-1", "size", "page-close", "document-close"]


def test_render_returns_png_for_a_zero_based_index_and_closes_the_document(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from PIL import Image

    extractor = _extractor(tmp_path)
    content = _pdf([(60, 40), (30, 20)])
    closed: list[str] = []
    real_document = pdfium.PdfDocument

    class TrackedDocument(real_document):  # type: ignore[misc]
        def close(self) -> None:
            closed.append("document")
            super().close()

    monkeypatch.setattr(pdfium, "PdfDocument", TrackedDocument)

    png = extractor._render_pdf_page(content, 1)

    with Image.open(BytesIO(png)) as image:
        assert image.format == "PNG"
        assert image.size == (60, 40)  # second page, 30x20 at scale 2
    assert closed == ["document"]


def test_render_failure_reports_one_based_page_and_releases_resources(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []

    class Bitmap:
        def to_pil(self) -> None:
            raise ValueError("pixel conversion failed")

        def close(self) -> None:
            events.append("bitmap-close")

    class Page:
        def render(self, **kwargs: object) -> Bitmap:
            events.append(f"scale-{kwargs['scale']}")
            return Bitmap()

    class Document:
        def __getitem__(self, _index: int) -> Page:
            return Page()

        def close(self) -> None:
            events.append("document-close")

    monkeypatch.setattr(pdfium, "PdfDocument", lambda _source: Document())
    extractor = _extractor(tmp_path)

    with pytest.raises(ValueError, match=r"^Could not render PDF page 3\.$"):
        extractor._render_pdf_page(b"x", 2)

    assert events == ["scale-2", "bitmap-close", "document-close"]
