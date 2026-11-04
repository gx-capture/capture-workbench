"""OCR page aggregate package."""

from __future__ import annotations

from capture_runtime.ocr.domain.page.models import (
    BoundingBox,
    OcrPage,
    PageReadingOrder,
    PageRegion,
)

__all__ = [
    "BoundingBox",
    "OcrPage",
    "PageReadingOrder",
    "PageRegion",
]
