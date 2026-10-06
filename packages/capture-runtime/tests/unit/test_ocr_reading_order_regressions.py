"""Real OCR observations paired with independently reviewed image reading order."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from capture_runtime.engine_adapters import OcrRegion
from capture_runtime.ocr_reading_order import plan_reading_order

FIXTURE = Path(__file__).parents[1] / "fixtures/vertical-ocr/reading-order-real-pages.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
FRAGMENT_CASES = json.loads(
    FIXTURE.with_name("reading-order-real-fragments.json").read_text(encoding="utf-8")
)["cases"]
# Rendered pages: expected order comes from where the renderer placed each glyph.
RENDERED_CASES = json.loads(
    FIXTURE.with_name("reading-order-synthetic-pages.json").read_text(encoding="utf-8")
)["cases"]
# One scan of two facing pages that lean differently; reviewed body relations only.
FACING_CASES = json.loads(
    FIXTURE.with_name("reading-order-facing-pages.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", CASES, ids=[case["id"] for case in CASES])
def test_reviewed_real_page_reading_order_and_unchanged_tuples(case: dict) -> None:
    regions = tuple(
        OcrRegion(
            text=region["text"],
            polygon=tuple(tuple(point) for point in region["polygon"]),
            confidence=region["confidence"],
        )
        for region in case["regions"]
    )
    before = tuple((region.text, region.polygon, region.confidence) for region in regions)
    plan = plan_reading_order(regions)
    assert sorted(plan.order) == list(range(len(regions)))
    assert tuple((region.text, region.polygon, region.confidence) for region in regions) == before
    assert list(plan.order) in case["allowedOrders"]
    assert plan.ruby == frozenset(case["ruby"])
    assert sorted(pair for article in plan.articles for pair in article.ruby_owners) == sorted(
        tuple(pair) for pair in case["rubyOwners"]
    )
    if case.get("horizontalIdentity"):
        assert not plan.applied
        assert plan.text.encode("utf-8") == case["baselineText"].encode("utf-8")
    else:
        assert plan.applied
        text = ""
        previous = None
        for index in plan.order:
            if previous is not None:
                text += "\n\n" if (previous in plan.ruby) != (index in plan.ruby) else "\n"
            text += regions[index].text
            previous = index
        assert plan.text == text


@pytest.mark.parametrize("case", FRAGMENT_CASES, ids=[case["id"] for case in FRAGMENT_CASES])
def test_reviewed_same_column_body_fragments_stay_together_on_complete_pages(case: dict) -> None:
    regions = tuple(
        OcrRegion(
            text=region["text"],
            polygon=tuple(tuple(point) for point in region["polygon"]),
            confidence=region["confidence"],
        )
        for region in case["regions"]
    )
    plan = plan_reading_order(regions)
    assert plan.applied
    assert sorted(plan.order) == list(range(len(regions)))
    for first, second in case["bodyFragmentPairs"]:
        assert plan.order.index(second) == plan.order.index(first) + 1
        assert first not in plan.ruby and second not in plan.ruby
        assert any(first in article.body and second in article.body for article in plan.articles)


@pytest.mark.parametrize("case", RENDERED_CASES, ids=[case["id"] for case in RENDERED_CASES])
def test_rendered_page_reading_order_follows_the_rendered_glyph_positions(case: dict) -> None:
    regions = tuple(
        OcrRegion(
            text=region["text"],
            polygon=tuple(tuple(point) for point in region["polygon"]),
            confidence=region["confidence"],
        )
        for region in case["regions"]
    )
    before = tuple((region.text, region.polygon, region.confidence) for region in regions)
    plan = plan_reading_order(regions)
    assert tuple((region.text, region.polygon, region.confidence) for region in regions) == before
    assert list(plan.order) == case["order"]
    assert plan.ruby == frozenset(case["ruby"])
    assert sorted(pair for article in plan.articles for pair in article.ruby_owners) == sorted(
        tuple(pair) for pair in case["rubyOwners"]
    )
    if case.get("horizontalIdentity"):
        assert not plan.applied
        assert plan.text.encode("utf-8") == case["baselineText"].encode("utf-8")
    else:
        assert plan.applied


@pytest.mark.parametrize("case", FACING_CASES, ids=[case["id"] for case in FACING_CASES])
def test_facing_pages_with_different_lean_keep_reviewed_body_column_order(case: dict) -> None:
    regions = tuple(
        OcrRegion(
            text=region["text"],
            polygon=tuple(tuple(point) for point in region["polygon"]),
            confidence=region["confidence"],
        )
        for region in case["regions"]
    )
    plan = plan_reading_order(regions)
    assert plan.applied
    assert sorted(plan.order) == list(range(len(regions)))
    body = set(case["bodyOrder"])
    assert [index for index in plan.order if index in body] == case["bodyOrder"]
    assert not plan.ruby


# Horizontal questions around one boxed vertical passage; single-reader relations.
MIXED_CASES = json.loads(
    FIXTURE.with_name("reading-order-mixed-pages.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", MIXED_CASES, ids=[case["id"] for case in MIXED_CASES])
def test_questions_above_a_boxed_vertical_passage_keep_their_order(case: dict) -> None:
    regions = tuple(
        OcrRegion(
            text=region["text"],
            polygon=tuple(tuple(point) for point in region["polygon"]),
            confidence=region["confidence"],
        )
        for region in case["regions"]
    )
    plan = plan_reading_order(regions)
    assert plan.applied
    assert sorted(plan.order) == list(range(len(regions)))
    assert len(plan.articles) == 1
    assert list(plan.articles[0].body) == case["bodyOrder"]
    assert plan.articles[0].labels == (case["label"],)
    above = set(case["aboveInInputOrder"])
    assert [index for index in plan.order if index in above] == case["aboveInInputOrder"]
    assert max(plan.order.index(index) for index in above) < plan.order.index(case["label"])
    # The label is read directly before the passage; lines below it keep their order after it.
    assert plan.order.index(case["bodyOrder"][0]) == plan.order.index(case["label"]) + 1
    below = set(case["belowInInputOrder"])
    assert [index for index in plan.order if index in below] == case["belowInInputOrder"]
    assert min(plan.order.index(index) for index in below) > plan.order.index(case["bodyOrder"][-1])


# One scan of two facing pages with three stacked bands each; single-reader band limits.
STACKED_CASES = json.loads(
    FIXTURE.with_name("reading-order-stacked-bands.json").read_text(encoding="utf-8")
)["cases"]


@pytest.mark.parametrize("case", STACKED_CASES, ids=[case["id"] for case in STACKED_CASES])
def test_stacked_bands_on_facing_pages_are_read_top_to_bottom(case: dict) -> None:
    regions = tuple(
        OcrRegion(
            text=region["text"],
            polygon=tuple(tuple(point) for point in region["polygon"]),
            confidence=region["confidence"],
        )
        for region in case["regions"]
    )
    plan = plan_reading_order(regions)
    assert plan.applied
    assert sorted(plan.order) == list(range(len(regions)))
    body = set(case["bodyOrder"])
    assert [index for index in plan.order if index in body] == case["bodyOrder"]
