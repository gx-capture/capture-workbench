"""Validate internal OCR region lineage without adding fields to the wire format."""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol

Point = tuple[float, float]


class RegionLike(Protocol):
    @property
    def text(self) -> str: ...

    @property
    def polygon(self) -> tuple[Point, ...]: ...

    @property
    def confidence(self) -> float | None: ...


@dataclass(frozen=True, slots=True)
class RegionSource:
    raw_slot: tuple[int, int]
    text_span: tuple[int, int]
    parent_text_length: int


class RegionLineageError(ValueError):
    """Emitted regions do not exactly partition their declared source parents."""


def _integers(value: tuple[int, int], label: str) -> tuple[int, int]:
    if (
        not isinstance(value, tuple)
        or len(value) != 2
        or any(type(item) is not int for item in value)
    ):
        raise RegionLineageError(f"{label} must contain exactly two integer values.")
    return value


def validate_region_sources(
    parents: Sequence[RegionLike],
    parent_slots: Sequence[tuple[int, int]],
    emitted: Sequence[RegionLike],
    sources: Sequence[RegionSource],
) -> None:
    """Require each parent once, whole or partitioned, including its geometry.

    Output order may change. A source slot never derives from recognized text,
    so repeated strings from different parents retain independent identities.
    """
    if len(parents) != len(parent_slots) or len(emitted) != len(sources):
        raise RegionLineageError("Every parent/output must have exactly one source identity.")
    by_slot: dict[tuple[int, int], RegionLike] = {}
    grouped: dict[tuple[int, int], list[tuple[RegionSource, RegionLike]]] = {}
    for parent, candidate_slot in zip(parents, parent_slots, strict=True):
        slot = _integers(candidate_slot, "Parent slot")
        if min(slot) < 0 or slot in by_slot:
            raise RegionLineageError("Parent slots must be nonnegative and unique.")
        if not isinstance(parent.text, str):
            raise RegionLineageError("Parent text must be a string.")
        by_slot[slot] = parent
        grouped[slot] = []
    for output, source in zip(emitted, sources, strict=True):
        slot = _integers(source.raw_slot, "Source slot")
        span = _integers(source.text_span, "Text span")
        found_parent = by_slot.get(slot)
        if found_parent is None:
            raise RegionLineageError("Output references an unknown parent slot.")
        parent = found_parent
        if type(source.parent_text_length) is not int or source.parent_text_length != len(
            parent.text
        ):
            raise RegionLineageError("Declared parent text length differs from its source.")
        start, end = span
        if not 0 <= start < end <= len(parent.text):
            raise RegionLineageError("Text spans must be nonempty and inside their parent.")
        if output.text != parent.text[start:end] or not output.text.strip():
            raise RegionLineageError("Output text differs from its exact nonempty source span.")
        if (
            type(output.confidence) is not type(parent.confidence)
            or output.confidence != parent.confidence
        ):
            raise RegionLineageError("Output confidence differs from its parent.")
        grouped[slot].append((source, output))
    for slot, parent in by_slot.items():
        children = sorted(grouped[slot], key=lambda child: child[0].text_span)
        if not children:
            raise RegionLineageError("A parent region was omitted.")
        cursor = 0
        for source, _ in children:
            if source.text_span[0] != cursor:
                raise RegionLineageError("Source spans have a gap or overlap.")
            cursor = source.text_span[1]
        if cursor != len(parent.text):
            raise RegionLineageError("Source spans do not cover their parent text.")
        if len(children) == 1:
            # Whole parents already passed the normalizer's geometry contract.
            # Convexity/positive area are additional requirements for a split,
            # not new reasons to reject unchanged existing OCR regions.
            if children[0][1].polygon != parent.polygon:
                raise RegionLineageError("A whole parent must retain its original polygon.")
            continue
        _validate_partition_geometry(parent.polygon, [child.polygon for _, child in children])


def _cross(first: Point, second: Point, third: Point) -> float:
    return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (
        third[0] - first[0]
    )


def _signed_area(polygon: Sequence[Point]) -> float:
    # A local origin avoids cancellation for polygons far from raster origin.
    origin = polygon[0]
    return (
        sum(
            _cross(origin, polygon[index], polygon[index + 1])
            for index in range(1, len(polygon) - 1)
        )
        / 2
    )


def _polygon(value: Sequence[Point], tolerance: float) -> tuple[Point, ...]:
    if len(value) < 4 or any(len(point) != 2 for point in value):
        raise RegionLineageError("Split polygons must contain at least four coordinate pairs.")
    for point in value:
        if any(
            isinstance(coordinate, bool)
            or not isinstance(coordinate, (int, float))
            or not math.isfinite(coordinate)
            for coordinate in point
        ):
            raise RegionLineageError("Split polygon coordinates must be finite numbers.")
    polygon = tuple(value)
    area = _signed_area(polygon)
    if not math.isfinite(area) or abs(area) <= tolerance:
        raise RegionLineageError("Split polygons must have positive area.")
    orientation = 1 if area > 0 else -1
    if any(
        orientation * _cross(start, end, point) < -tolerance
        for start, end in zip(polygon, (*polygon[1:], polygon[0]), strict=True)
        for point in polygon
    ):
        raise RegionLineageError("Split polygons must be convex.")
    return polygon


def _overlap(first: tuple[Point, ...], second: tuple[Point, ...], tolerance: float) -> bool:
    # Separating-axis test: touching boundaries have zero interior overlap.
    for polygon in (first, second):
        for start, end in zip(polygon, (*polygon[1:], polygon[0]), strict=True):
            dx, dy = end[0] - start[0], end[1] - start[1]
            length = math.hypot(dx, dy)
            if length <= tolerance:
                continue
            axis = (-dy / length, dx / length)
            first_projection = [point[0] * axis[0] + point[1] * axis[1] for point in first]
            second_projection = [point[0] * axis[0] + point[1] * axis[1] for point in second]
            if (
                min(max(first_projection), max(second_projection))
                - max(min(first_projection), min(second_projection))
                <= tolerance
            ):
                return False
    return True


def _validate_partition_geometry(
    parent: tuple[Point, ...], children: Sequence[tuple[Point, ...]]
) -> None:
    # Validate coordinates before using them to derive scale/tolerance.
    parent = _polygon(parent, 0.0)
    scale = max(
        1.0,
        max(point[0] for point in parent) - min(point[0] for point in parent),
        max(point[1] for point in parent) - min(point[1] for point in parent),
    )
    distance_tolerance = scale * 1e-8
    cross_tolerance = distance_tolerance * scale
    parent_area = _signed_area(parent)
    orientation = 1 if parent_area > 0 else -1
    polygons = [_polygon(child, cross_tolerance) for child in children]
    for polygon in polygons:
        for start, end in zip(parent, (*parent[1:], parent[0]), strict=True):
            if any(orientation * _cross(start, end, point) < -cross_tolerance for point in polygon):
                raise RegionLineageError("Child polygon extends outside its parent.")
    if not math.isclose(
        sum(abs(_signed_area(child)) for child in polygons),
        abs(parent_area),
        rel_tol=1e-7,
        abs_tol=1e-8,
    ):
        raise RegionLineageError("Child polygon areas do not cover their parent area.")
    for index, polygon in enumerate(polygons):
        if any(_overlap(polygon, other, distance_tolerance) for other in polygons[index + 1 :]):
            raise RegionLineageError("Child polygon interiors overlap.")
