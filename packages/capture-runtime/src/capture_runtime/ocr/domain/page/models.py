"""OCR page aggregate, bounding boxes, text regions, and reading order policy."""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class BoundingBox:
    """A rectangular pixel bounding box."""

    left: int
    top: int
    width: int
    height: int

    def __post_init__(self) -> None:
        if self.left < 0 or self.top < 0:
            raise ValueError("bounding box coordinates must be non-negative")
        if self.width <= 0 or self.height <= 0:
            raise ValueError("bounding box dimensions must be positive")

    @property
    def right(self) -> int:
        return self.left + self.width

    @property
    def bottom(self) -> int:
        return self.top + self.height


@dataclass(frozen=True, slots=True)
class PageRegion:
    """A recognized text region with polygon coordinates and confidence."""

    text: str
    confidence: float | None = None
    polygon: tuple[tuple[float, float], ...] = ()

    def __post_init__(self) -> None:
        if self.confidence is not None and not (0.0 <= self.confidence <= 1.0):
            raise ValueError("confidence must be between 0.0 and 1.0")

    @property
    def box(self) -> tuple[int, int, int, int] | None:
        """Return compatibility (left, top, width, height) rectangle."""
        if not self.polygon:
            return None
        left = math.floor(min(point[0] for point in self.polygon))
        top = math.floor(min(point[1] for point in self.polygon))
        right = math.ceil(max(point[0] for point in self.polygon))
        bottom = math.ceil(max(point[1] for point in self.polygon))
        return left, top, max(1, right - left), max(1, bottom - top)


@dataclass(frozen=True, slots=True)
class PageReadingOrder:
    """Policy for ordering page text regions by reading direction."""

    def order_regions(
        self,
        regions: tuple[PageRegion, ...],
        *,
        vertical: bool = False,
    ) -> tuple[PageRegion, ...]:
        if len(regions) <= 1:
            return regions
        if vertical:
            # Vertical Japanese reading: columns right-to-left, lines top-to-bottom
            def v_key(r: PageRegion) -> tuple[float, float]:
                b = r.box
                if not b:
                    return (0.0, 0.0)
                return (-(b[0] + b[2]), float(b[1]))

            return tuple(sorted(regions, key=v_key))

        # Horizontal: top-to-bottom, left-to-right
        def h_key(r: PageRegion) -> tuple[float, float]:
            b = r.box
            if not b:
                return (0.0, 0.0)
            return (float(b[1]), float(b[0]))

        return tuple(sorted(regions, key=h_key))


@dataclass(frozen=True, slots=True)
class OcrPage:
    """Aggregate root representing one recognized document page."""

    page_number: int
    regions: tuple[PageRegion, ...]
    text: str
    confidence: float | None = None
    raster_width: int | None = None
    raster_height: int | None = None
    raster_scale: float = 1.0

    def __post_init__(self) -> None:
        if self.page_number < 1:
            raise ValueError("page number must be >= 1")
        if self.raster_scale <= 0:
            raise ValueError("raster scale must be positive")
        if self.raster_width is not None and self.raster_width <= 0:
            raise ValueError("raster width must be positive")
        if self.raster_height is not None and self.raster_height <= 0:
            raise ValueError("raster height must be positive")
        if self.confidence is not None and not (0.0 <= self.confidence <= 1.0):
            raise ValueError("confidence must be between 0.0 and 1.0")
