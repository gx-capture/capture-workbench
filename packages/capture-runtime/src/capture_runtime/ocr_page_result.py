"""One OCR page as an OCR adapter returns it, and the adapter ports.

``OcrTextResult`` carries the recognized text and regions of one page image
with its provenance; the layout evidence and page route are internal audit
records that no public contract projects.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Protocol

from capture_runtime.contracts import OcrProvenanceV3
from capture_runtime.ocr_composite_regions import CompositeSplit
from capture_runtime.ocr_reading_order import ReadingPlan
from capture_runtime.ocr_region_lineage import RegionSource
from capture_runtime.ocr_vertical_routing import PageRoute
from capture_runtime.worker_probe import EngineProbe


@dataclass(frozen=True, slots=True)
class OcrTextResult:
    text: str
    device: str
    model: str
    digest: str
    warning: str | None = None
    regions: tuple[OcrRegion, ...] = ()
    raster_width: int | None = None
    raster_height: int | None = None
    raster_scale: float = 1
    region_confidences: tuple[float, ...] = ()
    profile_id: str | None = None
    profile_spec_sha256: str | None = None
    provenance: OcrProvenanceV3 | None = None
    # Internal source/span audit only; worker/projection public schemas are unchanged.
    layout_evidence: OcrLayoutEvidence | None = None
    # Internal: which reader produced the page and why. Absent when no reader is installed.
    page_route: PageRoute | None = None


@dataclass(frozen=True, slots=True)
class OcrRegion:
    text: str
    confidence: float | None = None
    polygon: tuple[tuple[float, float], ...] = ()

    @property
    def box(self) -> tuple[int, int, int, int] | None:
        """Return a compatibility bounding rectangle without replacing polygon."""

        if not self.polygon:
            return None
        left = math.floor(min(point[0] for point in self.polygon))
        top = math.floor(min(point[1] for point in self.polygon))
        right = math.ceil(max(point[0] for point in self.polygon))
        bottom = math.ceil(max(point[1] for point in self.polygon))
        return left, top, max(1, right - left), max(1, bottom - top)


@dataclass(frozen=True, slots=True)
class OcrLayoutEvidence:
    reading_plan: ReadingPlan
    sources: tuple[RegionSource, ...]
    splits: tuple[CompositeSplit, ...]
    parent_regions: tuple[OcrRegion, ...]
    parent_slots: tuple[tuple[int, int], ...]


class VerticalReaderLine(Protocol):
    @property
    def text(self) -> str: ...

    @property
    def polygon(self) -> tuple[tuple[float, float], ...]: ...

    @property
    def confidence(self) -> float: ...


class VerticalReader(Protocol):
    def read_png(self, image_png: bytes) -> tuple[VerticalReaderLine, ...]: ...


class OcrAdapter(Protocol):
    def probe(self) -> EngineProbe: ...

    def extract_png(self, image_png: bytes) -> OcrTextResult: ...


__all__ = [
    "OcrAdapter",
    "OcrLayoutEvidence",
    "OcrRegion",
    "OcrTextResult",
    "VerticalReader",
    "VerticalReaderLine",
]
