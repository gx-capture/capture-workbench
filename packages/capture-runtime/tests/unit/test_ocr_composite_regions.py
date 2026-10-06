from dataclasses import dataclass, replace
from types import SimpleNamespace

import pytest

from capture_runtime.ocr_composite_regions import plan_composite_splits


@dataclass(frozen=True)
class Region:
    text: str
    polygon: tuple[tuple[float, float], ...]
    confidence: float = 0.91


def box(text: str, x: float, y: float, h: float) -> Region:
    return Region(text, ((x, y), (x + 20, y), (x + 20, y + h), (x, y + h)))


def evidence(*, gaps=((180, 220),), path=None, padded=False):
    path = path or [0] * 2 + [1] * 2 + [0] * 12 + [2] * 2 + [0] * 2
    chars = {0: "", 1: "甲", 2: "乙", 3: "丙"}
    runs = []
    start = 0
    while start < len(path):
        end = start + 1
        while end < len(path) and path[end] == path[start]:
            end += 1
        runs.append(
            SimpleNamespace(start=start, end=end, token_id=path[start], token=chars[path[start]])
        )
        start = end
    parent = box("".join(run.token for run in runs), 100, 50, 400)
    record = SimpleNamespace(
        detector_slot=7,
        polygon=parent.polygon,
        crop_width=400,
        crop_height=20,
        raster_width=1000,
        raster_height=1000,
        pre_rotation_width=20,
        pre_rotation_height=400,
        rotated_90=True,
        source_to_rect=((1.0, 0.0, -100.0), (0.0, 1.0, -50.0), (0.0, 0.0, 1.0)),
        blank_intervals=gaps,
        resize_content_width=800,
        normalized_width=800,
        batch_width=1600 if padded else 800,
        time_steps=len(path),
        text=parent.text,
        confidence=parent.confidence,
        runs=tuple(runs),
    )
    neighbors = tuple(box("隣の本文", x, y, 180) for y in (50, 270) for x in (140, 180, 220))
    return (parent, *neighbors), record


def test_split_requires_neighbor_bands_ink_and_ctc_agreeing_on_one_boundary():
    regions, record = evidence()
    splits = plan_composite_splits(regions, {0: record})
    assert len(splits) == 1
    split = splits[0]
    assert split.source_index == 0
    assert split.text_boundary == 1
    assert tuple(child.text for child in split.children) == ("甲", "乙")
    assert tuple(child.text_span for child in split.children) == ((0, 1), (1, 2))
    assert all(child.confidence == regions[0].confidence for child in split.children)
    assert split.children[0].polygon[2][1] == pytest.approx(249.5)
    assert split.children[1].polygon[0][1] == pytest.approx(249.5)
    assert sum(child.area for child in split.children) == pytest.approx(8000)


@pytest.mark.parametrize("mutation", ["no_neighbors", "no_ink_gap", "ink_only", "padding"])
def test_no_split_from_only_one_source_of_evidence(mutation):
    regions, record = evidence()
    if mutation == "no_neighbors":
        regions = regions[:1]
    elif mutation == "no_ink_gap":
        record.blank_intervals = ()
    elif mutation == "ink_only":
        regions, record = evidence(path=[1] * 10 + [2] * 10)
    else:
        regions, record = evidence(padded=True)
    assert plan_composite_splits(regions, {0: record}) == ()


def test_repeated_character_separated_by_ctc_blank_is_preserved_twice():
    regions, record = evidence(path=[0] * 2 + [1] * 2 + [0] * 12 + [1] * 2 + [0] * 2)
    split = plan_composite_splits(regions, {0: record})[0]
    assert tuple(child.text for child in split.children) == ("甲", "甲")


def test_ambiguous_ctc_boundaries_inside_band_gap_reject_whole_parent():
    regions, record = evidence(
        path=[1] * 3 + [0] * 6 + [2] + [0] * 6 + [3] * 4,
        gaps=((180, 190), (200, 210)),
    )
    assert plan_composite_splits(regions, {0: record}) == ()


@pytest.mark.parametrize("mutation", ["text", "score", "polygon", "nan_matrix", "run_gap"])
def test_mismatched_or_malformed_source_lineage_fails_explicitly(mutation):
    regions, record = evidence()
    if mutation == "text":
        regions = (replace(regions[0], text="別の文字"), *regions[1:])
    elif mutation == "score":
        record.confidence = 0.9
    elif mutation == "polygon":
        record.polygon = box("甲乙", 101, 50, 400).polygon
    elif mutation == "nan_matrix":
        record.source_to_rect = ((float("nan"), 0, 0), (0, 1, 0), (0, 0, 1))
    else:
        record.runs[1].start += 1
    with pytest.raises(ValueError):
        plan_composite_splits(regions, {0: record})


def test_no_record_is_ineligible_and_does_not_require_guessed_alignment():
    regions, _ = evidence()
    assert plan_composite_splits(regions, {}) == ()


def test_whitespace_only_child_cannot_be_discarded_by_later_normalization():
    regions, record = evidence()
    record.runs[3].token = " "
    record.text = "甲 "
    regions = (replace(regions[0], text=record.text), *regions[1:])
    assert plan_composite_splits(regions, {0: record}) == ()


def test_tokens_in_padding_are_rejected_even_when_a_gap_partitions_the_text():
    regions, record = evidence(padded=True, gaps=((180, 220),))
    # A ends at 160, B starts at 640 in a 400-pixel crop: apparent gap is false evidence.
    assert plan_composite_splits(regions, {0: record}) == ()


def test_child_geometry_must_be_valid_in_original_raster_without_clamping():
    regions, record = evidence()
    record.raster_height = 400
    assert plan_composite_splits(regions, {0: record}) == ()


@pytest.mark.parametrize(
    "matrix",
    [
        ((1.0, 0.0, -100.0), (0.0, -1.0, 450.0), (0.0, 0.0, 1.0)),
        ((-1.0, 0.0, 120.0), (0.0, -1.0, 450.0), (0.0, 0.0, 1.0)),
    ],
)
def test_prefix_must_map_to_upper_band_not_reversed_crop_axis(matrix):
    regions, record = evidence()
    record.source_to_rect = matrix
    assert plan_composite_splits(regions, {0: record}) == ()


@pytest.mark.parametrize("mutation", ["different_scale", "opposite_sides", "remote_gutter"])
def test_unrelated_neighbor_domains_cannot_support_a_split(mutation):
    regions, record = evidence()
    if mutation == "different_scale":
        neighbors = tuple(
            replace(
                r,
                polygon=(
                    r.polygon[0],
                    (r.polygon[0][0] + 5, r.polygon[0][1]),
                    (r.polygon[0][0] + 5, r.polygon[2][1]),
                    r.polygon[3],
                ),
            )
            for r in regions[1:]
        )
    elif mutation == "opposite_sides":
        neighbors = (*regions[1:4], *(box("隣の本文", x, 270, 180) for x in (0, 40, 60)))
    else:
        neighbors = tuple(box("隣の本文", x, y, 180) for y in (50, 270) for x in (220, 240, 260))
    assert plan_composite_splits((regions[0], *neighbors), {0: record}) == ()


def test_nonconvex_valid_source_polygon_is_preserved_without_attempting_a_split():
    regions, record = evidence()
    record.polygon = ((100, 50), (120, 50), (109, 180), (100, 450))
    regions = (replace(regions[0], polygon=record.polygon), *regions[1:])
    assert plan_composite_splits(regions, {0: record}) == ()


@pytest.mark.parametrize("side", ["prefix", "suffix"])
def test_split_must_not_expose_internal_whitespace_to_downstream_box_trimming(side):
    path = (
        [0] * 2 + [1] * 2 + [3] * 2 + [0] * 10 + [2] * 2 + [0] * 2
        if side == "prefix"
        else [0] * 2 + [1] * 2 + [0] * 10 + [3] * 2 + [2] * 2 + [0] * 2
    )
    regions, record = evidence(path=path)
    for run in record.runs:
        if run.token_id == 3:
            run.token = " "
    record.text = "甲 乙"
    regions = (replace(regions[0], text=record.text), *regions[1:])
    assert plan_composite_splits(regions, {0: record}) == ()
