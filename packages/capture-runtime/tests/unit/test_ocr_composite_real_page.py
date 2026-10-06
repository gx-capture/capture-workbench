"""Retained full-page OCR and scalar alignment; partial reviewed image gold.

The splitter receives all 120 observations and all same-inference alignments.
Only evaluation reads the expected boundary, 108 body columns and four author
fragments. These assertions are not full-page recognition or phase acceptance.
No image processing, inference, model files, or private temporary data is needed.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from itertools import pairwise
from pathlib import Path
from types import SimpleNamespace

import pytest

from capture_runtime.ocr_composite_regions import plan_composite_splits
from capture_runtime.ocr_reading_order import plan_reading_order

FIXTURE = Path(__file__).parents[1] / "fixtures/vertical-ocr/reading-order-bunka-composite.json"
DOCUMENT = json.loads(FIXTURE.read_text(encoding="utf-8"))
CASES = DOCUMENT["cases"]


@dataclass(frozen=True)
class Region:
    text: str
    polygon: tuple[tuple[float, float], ...]
    confidence: float


def _source_key(source: dict) -> tuple[tuple[int, int], tuple[int, int]]:
    return tuple(source["rawSourceSlot"]), tuple(source["textSpan"])


def _area(polygon: tuple[tuple[float, float], ...]) -> float:
    return abs(sum(a[0] * b[1] - b[0] * a[1] for a, b in pairwise((*polygon, polygon[0])))) / 2


def _inside_convex(point: tuple[float, float], polygon: tuple) -> bool:
    cross = [
        (b[0] - a[0]) * (point[1] - a[1]) - (b[1] - a[1]) * (point[0] - a[0])
        for a, b in pairwise((*polygon, polygon[0]))
    ]
    return all(value >= -1e-7 for value in cross) or all(value <= 1e-7 for value in cross)


def _replay(case: dict):
    regions = tuple(
        Region(item["text"], tuple(tuple(point) for point in item["polygon"]), item["confidence"])
        for item in case["regions"]
    )
    assert len({tuple(item["rawSourceSlot"]) for item in case["regions"]}) == len(regions)
    alignments = {}
    for item in case["alignments"]:
        index = item["sourceIndex"]
        parent = regions[index]
        assert index not in alignments
        assert case["regions"][index]["rawSourceSlot"] == [0, item["detectorSlot"]]
        alignments[index] = SimpleNamespace(
            text=parent.text,
            polygon=parent.polygon,
            confidence=parent.confidence,
            crop_width=item["crop_width"],
            crop_height=item["crop_height"],
            pre_rotation_width=item["pre_rotation_width"],
            rotated_90=item["rotated_90"],
            source_to_rect=tuple(tuple(row) for row in item["source_to_rect"]),
            blank_intervals=tuple(tuple(interval) for interval in item["blank_intervals"]),
            resize_content_width=item["resize_content_width"],
            normalized_width=item["normalized_width"],
            batch_width=item["batch_width"],
            time_steps=item["time_steps"],
            runs=tuple(SimpleNamespace(**run) for run in item["runs"]),
            raster_width=DOCUMENT["image"]["width"],
            raster_height=DOCUMENT["image"]["height"],
        )
    assert len(regions) == len(alignments) == 120
    assert set(alignments) == set(range(len(regions)))

    # No gold offset, body binding, author identity or expected order enters here.
    splits = plan_composite_splits(regions, alignments)
    by_parent = {split.source_index: split for split in splits}
    assert len(by_parent) == len(splits)
    expanded = []
    ledger = []
    for index, parent in enumerate(regions):
        raw_slot = tuple(case["regions"][index]["rawSourceSlot"])
        if index not in by_parent:
            expanded.append(parent)
            ledger.append((raw_slot, (0, len(parent.text))))
        else:
            for child in by_parent[index].children:
                expanded.append(Region(child.text, child.polygon, child.confidence))
                ledger.append((raw_slot, child.text_span))
    plan = plan_reading_order(expanded)
    return regions, splits, tuple(expanded), tuple(ledger), plan


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_real_composite_partition_preserves_all_parent_evidence(case: dict) -> None:
    regions, splits, expanded, ledger, plan = _replay(case)
    expected = case["expected"]
    assert [
        {
            "rawSourceSlot": case["regions"][split.source_index]["rawSourceSlot"],
            "textBoundary": split.text_boundary,
        }
        for split in splits
    ] == expected["splitParents"]
    for split in splits:
        for child in split.children:
            assert child.area == pytest.approx(_area(child.polygon), abs=1e-6)
    assert len(expanded) == len(ledger) == len(set(ledger)) == 121
    assert sorted(plan.order) == list(range(len(expanded)))
    assert plan.source_slots == plan.order
    # Duplicate real parent slots are retained in this test's private span ledger;
    # no fabricated unique slots are supplied to the whole-region planner API.
    assert plan.raw_source_slots == ()
    split_sources = {split.source_index for split in splits}
    for index, parent in enumerate(regions):
        raw_slot = tuple(case["regions"][index]["rawSourceSlot"])
        children = [
            (span, child)
            for (slot, span), child in zip(ledger, expanded, strict=True)
            if slot == raw_slot
        ]
        assert children
        assert children[0][0][0] == 0
        assert children[-1][0][1] == len(parent.text)
        assert all(a[0][1] == b[0][0] for a, b in pairwise(children))
        assert "".join(child.text for _, child in children) == parent.text
        for (start, end), child in children:
            assert 0 <= start < end <= len(parent.text)
            assert child.text == parent.text[start:end]
            assert child.confidence == parent.confidence
        if index not in split_sources:
            assert len(children) == 1
            assert children[0][1] is parent
        else:
            assert len(children) == 2
            polygons = [child.polygon for _, child in children]
            assert sum(_area(polygon) for polygon in polygons) == pytest.approx(
                _area(parent.polygon), abs=1e-6
            )
            for polygon in polygons:
                assert len(polygon) >= 4
                assert _area(polygon) > 0
                for point in polygon:
                    assert all(math.isfinite(value) for value in point)
                    assert 0 <= point[0] <= DOCUMENT["image"]["width"]
                    assert 0 <= point[1] <= DOCUMENT["image"]["height"]
                    assert _inside_convex(point, parent.polygon)
            assert (
                sum(
                    any(math.dist(point, other) < 1e-7 for other in polygons[1])
                    for point in polygons[0]
                )
                == 2
            )
    for parent, item in zip(regions, case["regions"], strict=True):
        assert parent.text == item["text"]
        assert parent.confidence == item["confidence"]
        assert parent.polygon == tuple(tuple(point) for point in item["polygon"])
    # Inherited child scores retain today's arithmetic-mean semantics; the
    # additional region really changes the rounded aggregate, rather than being
    # silently reweighted to the pre-split parent count.
    assert (
        round(sum(parent.confidence for parent in regions) / len(regions), 4)
        == expected["aggregateBeforeRounded"]
    )
    assert (
        round(sum(child.confidence for child in expanded) / len(expanded), 4)
        == expected["aggregateAfterRounded"]
    )


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_real_composite_partial_image_gold_body_and_author_order(case: dict) -> None:
    _, _, expanded, ledger, plan = _replay(case)
    expected = case["expected"]
    binding = {_source_key(item["source"]): item["goldId"] for item in expected["bodyBindings"]}
    assert len(binding) == len(set(binding.values())) == 108
    assert set(binding) <= set(ledger)
    emitted_keys = [ledger[index] for index in plan.order]
    body_order = [binding[key] for key in emitted_keys if key in binding]
    assert len(body_order) == 108
    assert body_order in expected["allowedBodyOrders"]
    assert plan.applied
    assert not plan.ruby
    assert plan.text == "\n".join(expanded[index].text for index in plan.order)

    author_keys = [_source_key(source) for source in expected["authorSources"]]
    assert len(author_keys) == 4
    assert [key for key in emitted_keys if key in author_keys] == author_keys
    last_body = max(emitted_keys.index(key) for key in binding)
    assert all(emitted_keys.index(key) > last_body for key in author_keys)
    assert len(plan.front_matter_signatures) == 1
    owner = plan.front_matter_signatures[0]
    assert [ledger[index] for index in owner.signatures] == author_keys
    assert set(ledger[index] for index in owner.body) == set(binding)
    assert [ledger[index] for index in owner.supporting_titles] == [
        _source_key(expected["titleSupportSource"])
    ]
