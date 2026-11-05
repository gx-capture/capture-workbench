"""Application use cases for document OCR."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

from capture_runtime.ocr.domain.compute_plan import (
    ComputeCandidate,
    ComputePlanPolicy,
    ComputePlanSelection,
)
from capture_runtime.ocr.domain.evidence import DirectMlExecutionEvidence
from capture_runtime.ocr.domain.evidence.models import has_dml_execution
from capture_runtime.ocr.domain.page import (
    OcrPage,
    PageReadingOrder,
    PageRegion,
)
from capture_runtime.ocr.domain.page.reading_order import ReadingPlan, RegionLike


class PageTextResult(Protocol):
    @property
    def text(self) -> str: ...
    @property
    def regions(self) -> tuple[PageRegion, ...]: ...
    @property
    def raster_width(self) -> int | None: ...
    @property
    def raster_height(self) -> int | None: ...
    @property
    def raster_scale(self) -> float: ...


class PageOcrAdapter[Result: PageTextResult](Protocol):
    """An OCR port expressed in domain values, independent of adapter implementation."""

    def extract_png(self, image_png: bytes) -> Result: ...


@dataclass(frozen=True, slots=True)
class ExtractedPage[Result: PageTextResult]:
    domain_page: OcrPage
    result: Result

    @property
    def text(self) -> str:
        return self.domain_page.text

    @property
    def regions(self) -> tuple[PageRegion, ...]:
        return self.domain_page.regions

    @property
    def raster_width(self) -> int | None:
        return self.domain_page.raster_width

    @property
    def raster_height(self) -> int | None:
        return self.domain_page.raster_height

    @property
    def raster_scale(self) -> float:
        return self.domain_page.raster_scale

    def __getattr__(self, name: str) -> object:
        # Adapter-only audit metadata remains opaque to the application.
        return getattr(self.result, name)


class SelectComputePlan:
    """Evaluate GPU hardware capability and select DirectML or CPU fallback."""

    def __init__(self, policy: ComputePlanPolicy | None = None) -> None:
        self._policy = policy or ComputePlanPolicy()

    def execute(
        self,
        candidates: tuple[ComputeCandidate, ...],
        *,
        dml_available: bool,
        require_identity: bool = False,
    ) -> ComputePlanSelection | None:
        return self._policy.evaluate(
            candidates, dml_available=dml_available, require_identity=require_identity
        )


class ExtractPageText[Result: PageTextResult]:
    """Read a document page image through OCR adapter and return an OcrPage aggregate."""

    def __init__(self, adapter: PageOcrAdapter[Result]) -> None:
        self._adapter = adapter

    def execute(self, image_png: bytes, page_number: int = 1) -> ExtractedPage[Result]:
        result = self._adapter.extract_png(image_png)
        regions = tuple(
            PageRegion(text=r.text, confidence=r.confidence, polygon=r.polygon)
            for r in result.regions
        )
        for r in regions:
            _ = r.box
        page = OcrPage(
            page_number=page_number,
            regions=regions,
            text=result.text,
            raster_width=result.raster_width,
            raster_height=result.raster_height,
            raster_scale=result.raster_scale,
        )
        return ExtractedPage(domain_page=page, result=result)


class OrderPageRegions:
    """Order page text regions according to reading flow direction."""

    def __init__(self, reading_order: PageReadingOrder | None = None) -> None:
        self._reading_order = reading_order or PageReadingOrder()

    def execute(
        self,
        regions: Sequence[RegionLike],
        *,
        raw_source_slots: Sequence[tuple[int, int]] | None = None,
    ) -> ReadingPlan:
        return self._reading_order.plan(regions, raw_source_slots=raw_source_slots)


class VerifyExecutionEvidence:
    """Verify that an OCR run produced valid hardware DirectML execution evidence."""

    def execute(
        self,
        evidence: DirectMlExecutionEvidence,
    ) -> bool:
        return has_dml_execution(evidence)


__all__ = [
    "ExtractPageText",
    "OrderPageRegions",
    "SelectComputePlan",
    "VerifyExecutionEvidence",
]
