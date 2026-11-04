"""Application use cases for document OCR."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from capture_runtime.ocr.domain.compute_plan import (
    ComputePlanPolicy,
    ComputePlanSelection,
)
from capture_runtime.ocr.domain.evidence import DirectMlExecutionEvidence
from capture_runtime.ocr.domain.page import (
    OcrPage,
    PageReadingOrder,
    PageRegion,
)

if TYPE_CHECKING:
    from capture_runtime.ocr.infrastructure.ocr_page_result import OcrTextResult


class PageOcrAdapter(Protocol):
    """Protocol for reading a page raster with an OCR model."""

    def extract_png(self, image_png: bytes) -> OcrTextResult: ...


class SelectComputePlan:
    """Evaluate GPU hardware capability and select DirectML or CPU fallback."""

    def __init__(self, policy: ComputePlanPolicy | None = None) -> None:
        self._policy = policy or ComputePlanPolicy()

    def execute(
        self,
        has_compatible_gpu: bool,
        dml_available: bool,
        adapter_class: str = "dedicated",
        device_name: str | None = None,
        device_id: int | None = None,
    ) -> ComputePlanSelection:
        return self._policy.evaluate(
            has_compatible_gpu,
            dml_available,
            adapter_class=adapter_class,
            device_name=device_name,
            device_id=device_id,
        )


class ExtractPageText:
    """Read a document page image through OCR adapter and return an OcrPage aggregate."""

    def __init__(self, adapter: PageOcrAdapter) -> None:
        self._adapter = adapter

    def execute(self, image_png: bytes, page_number: int = 1) -> OcrPage:
        result = self._adapter.extract_png(image_png)
        regions = tuple(
            PageRegion(text=r.text, confidence=r.confidence, polygon=r.polygon)
            for r in result.regions
        )
        for r in regions:
            _ = r.box
        return OcrPage(
            page_number=page_number,
            regions=regions,
            text=result.text,
            raster_width=result.raster_width,
            raster_height=result.raster_height,
            raster_scale=result.raster_scale,
        )


class OrderPageRegions:
    """Order page text regions according to reading flow direction."""

    def __init__(self, reading_order: PageReadingOrder | None = None) -> None:
        self._reading_order = reading_order or PageReadingOrder()

    def execute(
        self,
        regions: tuple[PageRegion, ...],
        *,
        vertical: bool = False,
    ) -> tuple[PageRegion, ...]:
        return self._reading_order.order_regions(regions, vertical=vertical)


class VerifyExecutionEvidence:
    """Verify that an OCR run produced valid hardware DirectML execution evidence."""

    def execute(
        self,
        evidence: DirectMlExecutionEvidence,
    ) -> bool:
        return evidence.is_pure_dml


__all__ = [
    "ExtractPageText",
    "OrderPageRegions",
    "SelectComputePlan",
    "VerifyExecutionEvidence",
]
