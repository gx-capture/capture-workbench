from dataclasses import dataclass, replace

import pytest

from capture_runtime.ocr_region_lineage import (
    RegionLineageError,
    RegionSource,
    validate_region_sources,
)


@dataclass(frozen=True)
class Region:
    text: str
    polygon: tuple[tuple[float, float], ...]
    confidence: float | None = 0.8


PARENT = ((0, 0), (20, 0), (20, 10), (0, 10))
LEFT = ((0, 0), (10, 0), (10, 10), (0, 10))
RIGHT = ((10, 0), (20, 0), (20, 10), (10, 10))


def test_source_ledger_accepts_reordered_complete_text_and_geometry_partitions() -> None:
    parents = [Region("ABCD", PARENT), Region("same", PARENT, None)]
    outputs = [parents[1], Region("CD", RIGHT), Region("AB", LEFT)]
    sources = [
        RegionSource((3, 8), (0, 4), 4),
        RegionSource((3, 7), (2, 4), 4),
        RegionSource((3, 7), (0, 2), 4),
    ]
    assert validate_region_sources(parents, [(3, 7), (3, 8)], outputs, sources) is None


@pytest.mark.parametrize(
    "case",
    [
        "missing-parent",
        "duplicate-parent",
        "output-count",
        "unknown-slot",
        "text",
        "score",
        "whole-polygon",
        "gap",
        "overlap",
        "length",
        "empty-child",
        "bool-slot",
        "bool-span",
        "bool-length",
    ],
)
def test_source_ledger_rejects_missing_or_changed_source_evidence(case: str) -> None:
    parents = [Region("ABCD", PARENT)]
    slots = [(0, 5)]
    emitted = [Region("AB", LEFT), Region("CD", RIGHT)]
    sources = [RegionSource((0, 5), (0, 2), 4), RegionSource((0, 5), (2, 4), 4)]
    if case == "missing-parent":
        parents.append(Region("EF", PARENT))
        slots.append((0, 6))
    elif case == "duplicate-parent":
        parents.append(parents[0])
        slots.append(slots[0])
    elif case == "output-count":
        sources.pop()
    elif case == "unknown-slot":
        sources[0] = replace(sources[0], raw_slot=(0, 99))
    elif case == "text":
        emitted[0] = replace(emitted[0], text="changed")
    elif case == "score":
        emitted[0] = replace(emitted[0], confidence=0.9)
    elif case == "whole-polygon":
        emitted = [Region("ABCD", LEFT)]
        sources = [RegionSource((0, 5), (0, 4), 4)]
    elif case == "gap":
        emitted[0] = replace(emitted[0], text="A")
        sources[0] = replace(sources[0], text_span=(0, 1))
    elif case == "overlap":
        emitted[0] = replace(emitted[0], text="ABC")
        sources[0] = replace(sources[0], text_span=(0, 3))
    elif case == "length":
        sources[0] = replace(sources[0], parent_text_length=5)
    elif case == "empty-child":
        emitted[0] = replace(emitted[0], text="")
        sources[0] = replace(sources[0], text_span=(0, 0))
    elif case == "bool-slot":
        sources[0] = replace(sources[0], raw_slot=(False, 5))
    elif case == "bool-span":
        sources[0] = replace(sources[0], text_span=(False, 2))
    elif case == "bool-length":
        parents = [Region("A", PARENT)]
        emitted = parents
        sources = [RegionSource((0, 5), (0, 1), True)]
    with pytest.raises(RegionLineageError):
        validate_region_sources(parents, slots, emitted, sources)


def test_equal_text_from_different_slots_cannot_exchange_parent_geometry() -> None:
    parents = [Region("same", LEFT), Region("same", RIGHT)]
    sources = [RegionSource((0, 1), (0, 4), 4), RegionSource((0, 0), (0, 4), 4)]
    with pytest.raises(RegionLineageError, match="original polygon"):
        validate_region_sources(parents, [(0, 0), (0, 1)], parents, sources)


@pytest.mark.parametrize(
    "polygons",
    [
        [LEFT, LEFT],
        [LEFT, ((11, 0), (20, 0), (20, 10), (11, 10))],
        [LEFT, ((10, -1), (20, -1), (20, 9), (10, 9))],
        [LEFT, ((10, 0), (20, 0), (20, float("nan")), (10, 10))],
        [LEFT, ((10, 0), (20, 0), (20, 10))],
        [LEFT, ((10, 0), (20, 0), (11, 2), (10, 10))],
    ],
)
def test_split_geometry_rejects_overlap_gap_outside_nonfinite_or_nonconvex(polygons) -> None:
    emitted = [Region("AB", polygons[0]), Region("CD", polygons[1])]
    sources = [RegionSource((0, 0), (0, 2), 4), RegionSource((0, 0), (2, 4), 4)]
    with pytest.raises(RegionLineageError):
        validate_region_sources([Region("ABCD", PARENT)], [(0, 0)], emitted, sources)


@pytest.mark.parametrize(
    "polygon",
    [
        ((0, 0), (20, 0), (5, 5), (0, 10)),
        ((0, 0), (10, 0), (20, 0), (30, 0)),
    ],
)
def test_whole_region_preserves_existing_normalized_geometry_contract(polygon) -> None:
    parent = Region("text", polygon)
    validate_region_sources([parent], [(0, 0)], [parent], [RegionSource((0, 0), (0, 4), 4)])


def test_nonconvex_parent_cannot_be_split() -> None:
    parent = Region("ABCD", ((0, 0), (20, 0), (5, 5), (0, 10)))
    with pytest.raises(RegionLineageError, match="convex"):
        validate_region_sources(
            [parent],
            [(0, 0)],
            [Region("AB", LEFT), Region("CD", RIGHT)],
            [RegionSource((0, 0), (0, 2), 4), RegionSource((0, 0), (2, 4), 4)],
        )


def test_clockwise_parent_and_tiny_split_roundoff_are_valid() -> None:
    parent = Region("ABCD", tuple(reversed(PARENT)))
    left = Region("AB", ((0, 0), (10.00000001, 0), (10.00000001, 10), (0, 10)))
    right = Region("CD", RIGHT)
    validate_region_sources(
        [parent],
        [(0, 0)],
        [right, left],
        [RegionSource((0, 0), (2, 4), 4), RegionSource((0, 0), (0, 2), 4)],
    )
