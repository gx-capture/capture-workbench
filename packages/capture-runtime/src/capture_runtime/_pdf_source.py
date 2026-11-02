"""PDF source helpers for OCR extraction: page selection, page manifest and rasterization."""

from __future__ import annotations

import asyncio
import math
from io import BytesIO

from capture_runtime.ocr_projection import OcrPageManifest
from capture_runtime.pdf_page_selection import is_pdf_page_selection


class PdfPageSelectionError(ValueError):
    """The requested PDF pages are not all in the source, or are too many to read.

    The message names only page numbers and counts, so it is safe to report.
    """


def checkpoint(cancel_event: asyncio.Event) -> None:
    if cancel_event.is_set():
        raise InterruptedError("Capture extraction was cancelled.")


def pdf_page_count(content: bytes) -> int:
    import pypdfium2 as pdfium  # type: ignore[import-untyped]

    document = None
    try:
        document = pdfium.PdfDocument(BytesIO(content))
        page_count = len(document)
    except Exception as error:
        raise ValueError("Uploaded PDF is not readable.") from error
    finally:
        if document is not None:
            document.close()
    if page_count < 1:
        raise ValueError("Uploaded PDF has no pages.")
    return page_count


def selected_pdf_pages(
    page_count: int,
    page_numbers: tuple[int, ...] | None,
    limit: int,
) -> tuple[int, ...]:
    """The source pages OCR reads: every page, or the requested selection.

    The page limit bounds the pages that are read. Without a selection that
    is every page of the source; with one, the source may be longer.
    """

    if page_numbers is None:
        if page_count > limit:
            raise ValueError(f"PDF has {page_count} pages; limit is {limit}.")
        return tuple(range(1, page_count + 1))
    if not is_pdf_page_selection(page_numbers):
        raise PdfPageSelectionError(
            "PDF page selection must list source pages in ascending order without duplicates."
        )
    if len(page_numbers) > limit:
        raise PdfPageSelectionError(
            f"PDF page selection has {len(page_numbers)} pages; limit is {limit}."
        )
    if page_numbers[-1] > page_count:
        raise PdfPageSelectionError(
            f"PDF page selection includes page {page_numbers[-1]}, "
            f"but the PDF has {page_count} pages."
        )
    return tuple(page_numbers)


def pdf_page_raster_dimensions(
    content: bytes,
    cancel_event: asyncio.Event,
    page_numbers: tuple[int, ...],
) -> tuple[tuple[float, float], ...]:
    """Read PDFium's effective page sizes without creating raster bytes.

    ``get_size`` is the size PDFium will use for a default render.  It
    already reflects the page's crop box and intrinsic rotation, so the
    metadata path must not reconstruct geometry from the media box.
    """

    import pypdfium2 as pdfium

    document = None
    try:
        document = pdfium.PdfDocument(BytesIO(content))
        dimensions: list[tuple[float, float]] = []
        for page_number in page_numbers:
            checkpoint(cancel_event)
            page = None
            try:
                page = document[page_number - 1]
                width, height = page.get_size()
                dimensions.append((width, height))
            finally:
                if page is not None:
                    page.close()
            checkpoint(cancel_event)
        return tuple(dimensions)
    finally:
        if document is not None:
            document.close()


def pdf_page_manifest(
    selected_page_numbers: tuple[int, ...],
    raster_dimensions: tuple[tuple[float, float], ...],
    cancel_event: asyncio.Event,
    render_scale: float,
) -> tuple[OcrPageManifest, ...]:
    if len(raster_dimensions) != len(selected_page_numbers):
        raise ValueError("OCR PDF page metadata cardinality is invalid.")
    pages: list[OcrPageManifest] = []
    for page_number, (width, height) in zip(selected_page_numbers, raster_dimensions, strict=True):
        checkpoint(cancel_event)
        if (
            isinstance(width, bool)
            or isinstance(height, bool)
            or not isinstance(width, int | float)
            or not isinstance(height, int | float)
            or not math.isfinite(float(width))
            or not math.isfinite(float(height))
            or width <= 0
            or height <= 0
        ):
            raise ValueError(f"OCR raster metadata is invalid for PDF page {page_number}.")
        try:
            raster_width = math.ceil(float(width) * render_scale)
            raster_height = math.ceil(float(height) * render_scale)
        except (OverflowError, ValueError) as error:
            raise ValueError(
                f"OCR raster metadata is invalid for PDF page {page_number}."
            ) from error
        if raster_width <= 0 or raster_height <= 0:
            raise ValueError(f"OCR raster metadata is invalid for PDF page {page_number}.")
        pages.append(
            OcrPageManifest(
                page=page_number,
                raster_width=raster_width,
                raster_height=raster_height,
                raster_scale=render_scale,
            )
        )
    return tuple(pages)


def render_pdf_page(content: bytes, page_index: int, scale: float) -> bytes:
    import pypdfium2 as pdfium

    document = None
    bitmap = None
    image = None
    output = None
    try:
        document = pdfium.PdfDocument(BytesIO(content))
        bitmap = document[page_index].render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
        output = BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()
    except Exception as error:
        raise ValueError(f"Could not render PDF page {page_index + 1}.") from error
    finally:
        # Clear conversion locals as well as native handles so a raised
        # traceback cannot retain a completed page buffer.
        image = None
        output = None
        try:
            if bitmap is not None:
                bitmap.close()
        finally:
            bitmap = None
            try:
                if document is not None:
                    document.close()
            finally:
                document = None
