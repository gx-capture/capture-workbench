"""Limited, evidence-based splitting of a detector box spanning two body bands.

This module does no recognition or image processing. A split requires neighboring
body bands, actual crop whitespace and an unambiguous same-inference CTC blank.
Unsupported evidence leaves the parent whole; corrupt source lineage raises.
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from itertools import pairwise
from statistics import median
from typing import Protocol

Point = tuple[float, float]
Polygon = tuple[Point, ...]
Matrix = tuple[tuple[float, ...], ...]
COMPOSITE_POLICY = "neighbor-bands-ink-ctc-v1"


class RegionLike(Protocol):
    @property
    def text(self) -> str: ...

    @property
    def polygon(self) -> Polygon: ...

    @property
    def confidence(self) -> float | None: ...


class RunLike(Protocol):
    @property
    def start(self) -> int: ...

    @property
    def end(self) -> int: ...

    @property
    def token_id(self) -> int: ...

    @property
    def token(self) -> str: ...


class AlignmentLike(RegionLike, Protocol):
    @property
    def crop_width(self) -> int: ...

    @property
    def crop_height(self) -> int: ...

    @property
    def pre_rotation_width(self) -> int: ...

    @property
    def rotated_90(self) -> bool: ...

    @property
    def source_to_rect(self) -> Matrix: ...

    @property
    def blank_intervals(self) -> tuple[tuple[int, int], ...]: ...

    @property
    def resize_content_width(self) -> int: ...

    @property
    def normalized_width(self) -> int: ...

    @property
    def batch_width(self) -> int: ...

    @property
    def time_steps(self) -> int: ...

    @property
    def runs(self) -> Sequence[RunLike]: ...

    @property
    def raster_width(self) -> int: ...

    @property
    def raster_height(self) -> int: ...


@dataclass(frozen=True, slots=True)
class CompositeChild:
    text: str
    text_span: tuple[int, int]
    polygon: Polygon
    # Inherited parent mean, not a calibrated per-child recognition confidence.
    confidence: float | None
    area: float


@dataclass(frozen=True, slots=True)
class CompositeSplit:
    source_index: int
    text_boundary: int
    children: tuple[CompositeChild, CompositeChild]
    crop_cut_x: float
    supporting_band_gaps: tuple[tuple[float, float], ...]
    raster_intervals: tuple[tuple[int, int], ...]
    policy: str = COMPOSITE_POLICY


def _bbox(polygon: Polygon) -> tuple[float, float, float, float]:
    return (
        min(x for x, _ in polygon),
        min(y for _, y in polygon),
        max(x for x, _ in polygon),
        max(y for _, y in polygon),
    )


def _column_width(polygon: Polygon) -> float:
    if len(polygon) == 4:
        edges = tuple(math.dist(p, q) for p, q in pairwise((*polygon, polygon[0])))
        return min((edges[0] + edges[2]) / 2, (edges[1] + edges[3]) / 2)
    box = _bbox(polygon)
    return min(box[2] - box[0], box[3] - box[1])


def _area(polygon: Polygon) -> float:
    return abs(sum(p[0] * q[1] - q[0] * p[1] for p, q in pairwise((*polygon, polygon[0])))) / 2


def _convex(polygon: Polygon) -> bool:
    if len(polygon) < 4 or _area(polygon) <= 0:
        return False
    cross_products = [
        (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        for p, q in pairwise((*polygon, polygon[0]))
        for r in polygon
    ]
    return all(value >= 0 for value in cross_products) or all(
        value <= 0 for value in cross_products
    )


def _inverse(matrix: Matrix) -> Matrix:
    if len(matrix) != 3 or any(len(row) != 3 for row in matrix):
        raise ValueError("composite crop homography must be 3 by 3")
    if not all(math.isfinite(value) for row in matrix for value in row):
        raise ValueError("composite crop homography must be finite")
    a, b, c = matrix[0]
    d, e, f = matrix[1]
    g, h, i = matrix[2]
    cofactors = (
        (e * i - f * h, c * h - b * i, b * f - c * e),
        (f * g - d * i, a * i - c * g, c * d - a * f),
        (d * h - e * g, b * g - a * h, a * e - b * d),
    )
    determinant = a * cofactors[0][0] + b * cofactors[1][0] + c * cofactors[2][0]
    if not math.isfinite(determinant) or abs(determinant) < 1e-12:
        raise ValueError("composite crop homography is singular")
    return tuple(tuple(value / determinant for value in row) for row in cofactors)


def _project(matrix: Matrix, point: Point) -> Point:
    values = tuple(row[0] * point[0] + row[1] * point[1] + row[2] for row in matrix)
    if abs(values[2]) < 1e-12 or not all(math.isfinite(value) for value in values):
        raise ValueError("composite crop homography has no finite point mapping")
    return values[0] / values[2], values[1] / values[2]


def _to_crop(record: AlignmentLike, point: Point) -> Point:
    x, y = _project(record.source_to_rect, point)
    return (y, record.pre_rotation_width - 1 - x) if record.rotated_90 else (x, y)


def _from_crop(record: AlignmentLike, inverse: Matrix, point: Point) -> Point:
    x, y = point
    unrotated = (record.pre_rotation_width - 1 - y, x) if record.rotated_90 else point
    return _project(inverse, unrotated)


def _validate(record: AlignmentLike, source: RegionLike) -> tuple[RunLike, ...]:
    if (record.text, record.polygon, record.confidence) != (
        source.text,
        source.polygon,
        source.confidence,
    ):
        raise ValueError("composite alignment does not match the complete parent tuple")
    if not 0 < record.resize_content_width <= record.normalized_width <= record.batch_width:
        raise ValueError("composite resize/padding lineage is invalid")
    if (
        min(record.crop_width, record.crop_height, record.pre_rotation_width, record.time_steps)
        <= 0
    ):
        raise ValueError("composite crop/CTC dimensions must be positive")
    position, previous = 0, -1
    tokens: list[RunLike] = []
    for run in record.runs:
        if (
            run.start != position
            or run.end <= run.start
            or run.token_id < 0
            or run.token_id == previous
            or (run.token_id == 0) != (run.token == "")
        ):
            raise ValueError("composite CTC runs do not form a canonical complete path")
        position, previous = run.end, run.token_id
        if run.token_id:
            tokens.append(run)
    if position != record.time_steps or "".join(run.token for run in tokens) != record.text:
        raise ValueError("composite CTC path does not reconstruct the exact source text")
    previous_end = -1
    for start, end in record.blank_intervals:
        if not 0 <= start < end <= record.crop_width or start < previous_end:
            raise ValueError("composite raster whitespace intervals are invalid")
        previous_end = end
    return tuple(tokens)


def _connected_band(
    group: list[tuple[float, float, float, float]],
    nearby: list[tuple[float, float, float, float]],
    center: float,
    em: float,
) -> list[tuple[float, float, float, float]]:
    """Short columns may bridge a real pitch, but remote blocks cannot vote."""
    top = median(box[1] for box in group)
    bottom = median(box[3] for box in group)
    nodes = [box for box in nearby if abs(box[1] - top) <= em and box[3] <= bottom + em]
    reachable = {center}
    remaining = {(box[0] + box[2]) / 2 for box in nodes}
    while remaining:
        connected = {x for x in remaining if any(abs(x - y) <= 2.5 * em for y in reachable)}
        if not connected:
            break
        reachable.update(connected)
        remaining.difference_update(connected)
    return [box for box in group if (box[0] + box[2]) / 2 in reachable]


def _band_gaps(source_index: int, regions: Sequence[RegionLike]) -> tuple[tuple[float, float], ...]:
    target = _bbox(regions[source_index].polygon)
    width, height = _column_width(regions[source_index].polygon), target[3] - target[1]
    if width <= 0 or height < 6 * width:
        return ()
    center = (target[0] + target[2]) / 2
    nearby = []
    widths = {}
    for index, region in enumerate(regions):
        if index == source_index:
            continue
        box = _bbox(region.polygon)
        other_width = _column_width(region.polygon)
        if (
            0.67 * width <= other_width <= 1.5 * width
            and box[3] - box[1] >= 1.5 * other_width
            and abs((box[0] + box[2]) / 2 - center) <= 8 * width
        ):
            nearby.append(box)
            widths[box] = other_width
    nearby = list(dict.fromkeys(nearby))
    neighbors = [box for box in nearby if box[3] - box[1] >= 6 * widths[box]]
    if len(neighbors) < 6:
        return ()
    em = median(widths[box] for box in neighbors)
    groups: list[list[tuple[float, float, float, float]]] = []
    for box in sorted(neighbors, key=lambda item: item[1]):
        if not groups or box[1] - groups[-1][0][1] > em:
            groups.append([])
        groups[-1].append(box)
    connected = [_connected_band(group, nearby, center, em) for group in groups if len(group) >= 3]
    stable = [group for group in connected if len(group) >= 3]
    gaps = []
    for upper, lower in pairwise(stable):
        # Two bands must share a substantive horizontal domain, not merely have
        # separate columns within the same page-wide neighborhood radius.
        overlap = min(max(b[2] for b in upper), max(b[2] for b in lower)) - max(
            min(b[0] for b in upper), min(b[0] for b in lower)
        )
        if overlap < em:
            continue
        bottom, top = median(box[3] for box in upper), median(box[1] for box in lower)
        if target[1] + 2 * em < bottom < top < target[3] - 2 * em:
            gaps.append((bottom, top))
    return tuple(gaps)


def _raster_gaps(
    record: AlignmentLike, inverse: Matrix, bands: tuple[tuple[float, float], ...]
) -> tuple[tuple[int, int], ...]:
    supported: list[tuple[int, int]] = []
    for start, end in record.blank_intervals:
        current: int | None = None
        for x in range(start, end + 1):
            y = _from_crop(record, inverse, (x, (record.crop_height - 1) / 2))[1]
            inside = x < end and any(bottom <= y <= top for bottom, top in bands)
            if inside and current is None:
                current = x
            if not inside and current is not None:
                if x - current >= 2 and 0 < current < x < record.crop_width:
                    supported.append((current, x))
                current = None
    return tuple(supported)


def _boundary(
    record: AlignmentLike, tokens: tuple[RunLike, ...], gaps: tuple[tuple[int, int], ...]
) -> int | None:
    scale = record.batch_width / record.time_steps * record.crop_width / record.resize_content_width
    # A real character decoded from padded model input has no source-pixel support.
    if any(run.start * scale < 0 or run.end * scale > record.crop_width + 1e-7 for run in tokens):
        return None
    boundaries: set[int] = set()
    for start, end in gaps:
        left = [run for run in tokens if run.end * scale <= start]
        right = [run for run in tokens if run.start * scale >= end]
        if not left or not right or (*left, *right) != tokens:
            return None
        t0, t1 = left[-1].end, right[0].start
        blanks = [
            run for run in record.runs if run.token_id == 0 and run.start <= t0 and run.end >= t1
        ]
        if t1 <= t0 or len(blanks) != 1:
            return None
        boundaries.add(sum(len(run.token) for run in left))
    if len(boundaries) != 1:
        return None
    boundary = next(iter(boundaries))
    pieces = (record.text[:boundary], record.text[boundary:])
    # Worker/projection box normalization strips outer whitespace. A new outer
    # edge must not turn existing internal parent whitespace into lost content.
    if any(not piece or piece != piece.strip() for piece in pieces):
        return None
    return boundary


def _clip(polygon: Polygon, cut: float, before: bool) -> Polygon:
    points = []
    for p, q in pairwise((*polygon, polygon[0])):
        p_in, q_in = (p[0] <= cut, q[0] <= cut) if before else (p[0] >= cut, q[0] >= cut)
        if p_in:
            points.append(p)
        if p_in != q_in:
            ratio = (cut - p[0]) / (q[0] - p[0])
            points.append((cut, p[1] + ratio * (q[1] - p[1])))
    return tuple(points)


def _children(
    record: AlignmentLike, inverse: Matrix, boundary: int, cut: float
) -> tuple[CompositeChild, CompositeChild] | None:
    crop_parent = tuple(_to_crop(record, point) for point in record.polygon)
    children = []
    for before, span in ((True, (0, boundary)), (False, (boundary, len(record.text)))):
        clipped = _clip(crop_parent, cut, before)
        if len(clipped) < 4:
            return None  # Preserve the existing public polygon cardinality contract.
        polygon = tuple(_from_crop(record, inverse, point) for point in clipped)
        if any(
            not (0 <= x <= record.raster_width and 0 <= y <= record.raster_height)
            for x, y in polygon
        ):
            return None
        area = _area(polygon)
        if area <= 0 or not math.isfinite(area):
            return None
        for point in polygon:
            if math.dist(point, _from_crop(record, inverse, _to_crop(record, point))) > 1e-7:
                raise ValueError("composite child coordinate roundtrip failed")
        children.append(
            CompositeChild(record.text[span[0] : span[1]], span, polygon, record.confidence, area)
        )
    area = _area(record.polygon)
    if abs(sum(child.area for child in children) - area) > max(1e-7, area * 1e-10):
        raise ValueError("composite children do not conserve parent polygon area")
    return children[0], children[1]


def plan_composite_splits(
    regions: Sequence[RegionLike], alignments: Mapping[int, AlignmentLike]
) -> tuple[CompositeSplit, ...]:
    """Return only supported two-part splits; untouched inputs retain their identity.

    Alignment keys identify normalized source regions. The caller separately retains
    the original raw slot and combines it with each half-open text span. There is no
    general character-box inference, missing-text repair or confidence recalibration.
    """
    if len(regions) > 1000:
        return ()
    splits = []
    for index, record in sorted(alignments.items()):
        if type(index) is not int or not 0 <= index < len(regions):
            raise ValueError("composite alignment source index is invalid")
        tokens = _validate(record, regions[index])
        inverse = _inverse(record.source_to_rect)
        if not record.rotated_90 or len(tokens) < 2 or not _convex(record.polygon):
            continue
        start_point = _from_crop(record, inverse, (0, (record.crop_height - 1) / 2))
        end_point = _from_crop(
            record, inverse, (record.crop_width - 1, (record.crop_height - 1) / 2)
        )
        dx, dy = end_point[0] - start_point[0], end_point[1] - start_point[1]
        if dy <= 0 or abs(dx) >= dy:
            continue  # Only a downward source axis supports a vertical prefix.
        bands = _band_gaps(index, regions)
        if not bands:
            continue
        gaps = _raster_gaps(record, inverse, bands)
        boundary = _boundary(record, tokens, gaps)
        if boundary is None:
            continue
        start, end = min(gaps, key=lambda gap: (-(gap[1] - gap[0]), gap[0]))
        cut = (start + end - 1) / 2
        children = _children(record, inverse, boundary, cut)
        if children is not None:
            splits.append(CompositeSplit(index, boundary, children, cut, bands, gaps))
    # Never introduce enough children to bypass the reading policy's region guard.
    return tuple(splits) if len(regions) + len(splits) <= 1000 else ()
