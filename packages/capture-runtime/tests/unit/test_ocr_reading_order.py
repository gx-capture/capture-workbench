import math
import random
from dataclasses import dataclass

import pytest

from capture_runtime.ocr_reading_order import MAX_REGIONS, estimate_page_skew, plan_reading_order


@dataclass(frozen=True)
class Region:
    text: str
    polygon: tuple[tuple[float, float], ...]


def region(text: str, x: float, y: float, width: float, height: float) -> Region:
    return Region(text, ((x, y), (x + width, y), (x + width, y + height), (x, y + height)))


def test_article_ruby_precedes_question_from_one_complete_permutation() -> None:
    regions = (
        region("見出し", 0, 0, 300, 20),
        region("左の本文", 190, 70, 20, 160),
        region("右の本文", 230, 70, 20, 160),
        region("ふりがな", 247, 85, 9, 37),
        region("問１", 0, 280, 300, 20),
    )
    plan = plan_reading_order(regions)
    assert plan.applied
    assert plan.order == (0, 2, 1, 3, 4)
    assert plan.ruby == frozenset({3})
    assert plan.articles[0].ruby_owners == ((3, 2),)
    assert plan.text == "見出し\n右の本文\n左の本文\n\nふりがな\n\n問１"


@pytest.mark.parametrize("dy", [0, 300])
def test_independent_articles_keep_their_own_ruby(dy: int) -> None:
    dx = 300 if dy == 0 else 0
    regions = (
        region("A左", 190 + dx, 70, 20, 160),
        region("B右", 230, 70 + dy, 20, 160),
        region("B左", 190, 70 + dy, 20, 160),
        region("A右", 230 + dx, 70, 20, 160),
        region("びい", 247, 95 + dy, 9, 35),
        region("えい", 247 + dx, 95, 9, 35),
    )
    plan = plan_reading_order(regions)
    assert plan.order == (3, 0, 5, 1, 2, 4)
    assert plan.text == "A右\nA左\n\nえい\n\nB右\nB左\n\nびい"
    assert len(plan.articles) == 2


def test_indentation_short_column_signature_and_horizontal_choices() -> None:
    regions = (
        region("短", 190, 72, 20, 25),
        region("（出典）", 150, 190, 20, 60),
        region("本文左", 230, 70, 20, 180),
        region("本文右", 270, 90, 20, 160),
        region("A", 280, 40, 16, 20),
        region("問", 100, 300, 200, 20),
        region("選択肢", 135, 340, 170, 20),
        region("1", 100, 340, 12, 20),
        region("2", 100, 380, 12, 20),
        region("次の選択肢", 135, 380, 170, 20),
    )
    plan = plan_reading_order(regions)
    assert plan.order == (4, 3, 2, 0, 1, 5, 7, 6, 8, 9)
    assert plan.ruby == frozenset()
    assert plan.articles[0].signatures == (1,)


@pytest.mark.parametrize(
    "ruby_text, expected", [("1", False), ("注1", False), ("きちょうめん", True), ("¥4", True)]
)
def test_kana_is_supporting_evidence_and_numeric_labels_are_protected(
    ruby_text: str, expected: bool
) -> None:
    items = (
        region("右本文", 100, 0, 20, 200),
        region("左本文", 60, 0, 20, 200),
        region(ruby_text, 117, 50, 10, 30),
    )
    assert (2 in plan_reading_order(items).ruby) is expected


def test_competing_ruby_owners_abstain_independent_of_input_enumeration() -> None:
    items = (
        region("甲本文", 100, 0, 20, 200),
        region("乙本文", 103, 0, 20, 200),
        region("左本文", 60, 0, 20, 200),
        region("かな", 119, 50, 8, 30),
    )
    for values in (items, tuple(reversed(items))):
        plan = plan_reading_order(values)
        assert not plan.ruby
        assert any(reason.startswith("competing_ruby_owner:") for reason in plan.diagnostics)


def test_same_lane_continuation_does_not_bridge_separate_bands() -> None:
    items = (
        region("下右", 100, 140, 20, 100),
        region("上左", 60, 0, 20, 100),
        region("上右", 100, 0, 20, 100),
        region("下左", 60, 140, 20, 100),
        region("等", 60, 250, 20, 20),
    )
    plan = plan_reading_order(items)
    assert plan.order == (2, 1, 0, 3, 4)
    assert plan.articles[1].body == (0, 3, 4)


def test_composite_spanning_two_bands_is_preserved_and_flagged() -> None:
    items = (
        region("上右下右合框", 100, 0, 20, 260),
        region("上左", 60, 0, 20, 100),
        region("下中", 80, 150, 20, 110),
        region("下左", 40, 150, 20, 110),
    )
    plan = plan_reading_order(items)
    assert sorted(plan.order) == [0, 1, 2, 3]
    assert "possible_cross_band_composite:0" in plan.diagnostics
    assert items[0].text == "上右下右合框"


def rotate(item: Region, degrees: float) -> Region:
    angle = math.radians(degrees)
    c, s = math.cos(angle), math.sin(angle)
    return Region(item.text, tuple((x * c + y * s, -x * s + y * c) for x, y in item.polygon))


@pytest.mark.parametrize("degrees", [-3, -1.5, -0.8, 0.8, 1.5, 3])
def test_analysis_rotation_preserves_permutation_and_original_polygons(degrees: float) -> None:
    items = (
        region("見出し", 0, 0, 300, 20),
        region("本文左", 190, 70, 20, 160),
        region("本文右", 230, 90, 20, 140),
        region("かな", 247, 115, 9, 35),
        region("問題", 0, 280, 300, 20),
    )
    rotated = tuple(rotate(item, degrees) for item in items)
    original = tuple(rotated)
    plan = plan_reading_order(rotated)
    assert plan.order == (0, 2, 1, 3, 4)
    assert plan.skew_degrees == pytest.approx(degrees, abs=0.1)
    assert rotated == original


def test_sub_epsilon_skew_and_insufficient_samples() -> None:
    items = tuple(rotate(region("文", x, 0, 20, 200), 0.02) for x in (0, 40, 80))
    estimate = estimate_page_skew(tuple(item.polygon for item in items))
    assert estimate is not None and estimate.degrees == 0
    assert estimate.lines == 3 and estimate.consistency == 1
    assert estimate_page_skew((items[0].polygon,)) is None


@pytest.mark.parametrize("columns", [1, 2])
def test_horizontal_page_keeps_input_order_and_embedded_text_exactly(columns: int) -> None:
    items = tuple(
        region(f"文 {x}\n行 {y}", x * 220, y * 30, 180, 20)
        for x in range(columns)
        for y in (3, 1, 2)
    )
    plan = plan_reading_order(items)
    assert not plan.applied
    assert plan.order == tuple(range(len(items)))
    assert plan.text == "\n".join(item.text for item in items)


def furigana_page() -> tuple[Region, ...]:
    return (
        region("header", 600, 0, 120, 20),
        region("ばん", 40, 60, 40, 22),
        region("3番", 20, 78, 70, 40),
        region("としょかん", 60, 130, 110, 18),
        region("ほん", 300, 128, 40, 20),
        region("1 図書館で新しい本を借りる", 20, 145, 430, 32),
        region("てがみ", 250, 190, 80, 18),
        region("2 友人に長い手紙を書く", 20, 205, 430, 32),
        region("ばん", 40, 600, 40, 22),
        region("4番", 20, 618, 70, 40),
        region("えき", 60, 668, 40, 18),
        region("1 駅までの近い道", 20, 683, 220, 32),
        region("- 3 -", 300, 900, 80, 24),
    )


def test_furigana_on_a_horizontal_page_follows_the_block_it_annotates() -> None:
    items = furigana_page()
    before = tuple(items)
    plan = plan_reading_order(items, raw_source_slots=tuple((0, 2 * i) for i in range(len(items))))
    assert plan.applied
    assert plan.order == (0, 2, 5, 7, 1, 3, 4, 6, 9, 11, 8, 10, 12)
    assert plan.ruby == frozenset({1, 3, 4, 6, 8, 10})
    assert plan.horizontal_ruby_owners == ((1, 2), (3, 5), (4, 5), (6, 7), (8, 9), (10, 11))
    assert not plan.articles
    assert plan.raw_source_slots == tuple((0, 2 * i) for i in plan.order)
    assert plan.text == (
        "header\n3番\n1 図書館で新しい本を借りる\n2 友人に長い手紙を書く\n\n"
        "ばん\nとしょかん\nほん\nてがみ\n\n"
        "4番\n1 駅までの近い道\n\nばん\nえき\n\n- 3 -"
    )
    assert items == before


@pytest.mark.parametrize(
    "above",
    [
        region("ふはい", 60, 96, 110, 32),  # same height as the line below: an answer line
        region("としょ", 60, 40, 110, 18),  # too far above the line
        region("としょ", 600, 110, 110, 18),  # beside the line, not above it
        region("12", 60, 110, 30, 18),  # not kana
        region("ABC", 60, 110, 60, 18),  # not kana
    ],
)
def test_lines_that_are_not_furigana_leave_a_horizontal_page_unchanged(above: Region) -> None:
    items = (
        region("見出しの行", 20, 0, 300, 32),
        above,
        region("1 図書館で新しい本を借りる", 20, 125, 430, 32),
        region("2 つぎの行", 20, 170, 430, 32),
    )
    plan = plan_reading_order(items)
    assert not plan.applied
    assert plan.order == (0, 1, 2, 3)
    assert plan.text == "\n".join(item.text for item in items)


def test_kana_end_of_a_sentence_above_a_heading_is_not_furigana() -> None:
    # The last line of a paragraph is as tall as the line it continues.
    items = (
        region("本製品を使用する前に必ず電源を切って", 20, 100, 420, 20),
        region("ください。", 20, 128, 100, 20),
        region("注意事項について", 20, 156, 208, 26),
        region("以下の点に注意して作業を行います。", 20, 190, 400, 20),
    )
    plan = plan_reading_order(items)
    assert not plan.applied
    assert plan.order == (0, 1, 2, 3)


def test_full_size_kana_above_a_slightly_taller_line_is_not_furigana() -> None:
    # An answer option in kana, detected a little shorter than the option below it.
    items = (
        region("問1 次の語の読みを選びなさい。", 20, 20, 400, 24),
        region("ア　さくら", 40, 52, 110, 19),
        region("イ　桜の花が咲く", 40, 74, 200, 24),
        region("ウ　うめ", 40, 104, 90, 19),
    )
    plan = plan_reading_order(items)
    assert not plan.applied
    assert plan.order == (0, 1, 2, 3)


def test_kana_above_a_line_without_ideographs_is_not_furigana() -> None:
    items = (
        region("ひらがな", 60, 110, 110, 18),
        region("1 かなだけのぎょう", 20, 125, 430, 32),
    )
    assert not plan_reading_order(items).applied


def test_one_character_reading_is_furigana() -> None:
    items = (
        region("き", 300, 110, 17, 18),
        region("3 午後は木の下で休む", 20, 125, 430, 32),
    )
    plan = plan_reading_order(items)
    assert plan.order == (1, 0)
    assert plan.ruby == frozenset({0})


def test_furigana_step_does_not_touch_vertical_pages() -> None:
    items = (
        region("右本文", 100, 0, 20, 300),
        region("左本文", 60, 0, 20, 300),
        region("ふりがな", 117, 50, 9, 40),
        region("よこのふりがな", 200, 395, 110, 18),
        region("1 横書きの設問文", 200, 410, 300, 32),
    )
    plan = plan_reading_order(items)
    assert plan.articles
    assert plan.ruby == frozenset({2})
    assert not plan.horizontal_ruby_owners


def test_cap_and_seeded_source_preservation() -> None:
    items = tuple(region("同文", index * 40, 0, 20, 200) for index in range(MAX_REGIONS + 1))
    plan = plan_reading_order(items)
    assert not plan.applied and plan.order == tuple(range(len(items)))
    rng = random.Random(991)
    for _ in range(15):
        layout = tuple(
            region(
                "重複文字",
                rng.randrange(600),
                rng.randrange(800),
                rng.randrange(8, 40),
                rng.randrange(20, 400),
            )
            for _ in range(35)
        )
        before = tuple(layout)
        output = plan_reading_order(layout)
        assert sorted(output.order) == list(range(len(layout)))
        assert output.source_slots == output.order
        assert layout == before


def test_invalid_geometry_fails_instead_of_a_successful_fallback() -> None:
    with pytest.raises(ValueError, match="Nonfinite"):
        plan_reading_order((Region("文", ((0, 0), (math.nan, 0), (1, 1), (0, 1))),))


def test_neighboring_articles_use_their_own_font_scale_before_ruby_classification() -> None:
    items = (
        region("大左", 400, 0, 40, 400),
        region("大右", 460, 0, 40, 400),
        region("小左", 100, 0, 20, 160),
        region("小右", 140, 0, 20, 160),
        region("かな", 157, 20, 8, 40),
    )
    plan = plan_reading_order(items)
    assert plan.order == (1, 0, 3, 2, 4)
    assert plan.ruby == frozenset({4})
    assert len(plan.articles) == 2


def test_long_ruby_columns_do_not_establish_a_second_body_band() -> None:
    items = (
        region("右本文", 100, 0, 20, 200),
        region("左本文", 60, 0, 20, 200),
        region("みぎふりがな", 117, 50, 8, 60),
        region("ひだりふりがな", 77, 50, 8, 60),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3)
    assert plan.ruby == frozenset({2, 3})
    assert len(plan.articles) == 1
    assert plan.articles[0].ruby_owners == ((2, 0), (3, 1))


def test_short_top_column_bridges_anchors_without_bridging_separate_bands() -> None:
    items = (
        region("上左", 0, 0, 20, 290),
        region("上中左", 26, 0, 20, 290),
        region("上中右", 52, 0, 20, 290),
        region("短", 100, 0, 20, 40),
        region("上右", 126, 0, 20, 310),
        region("下左", 0, 330, 20, 290),
        region("下右", 126, 330, 20, 290),
    )
    plan = plan_reading_order(items)
    assert plan.order == (4, 3, 2, 1, 0, 6, 5)
    assert any(article.body == (4, 3, 2, 1, 0) for article in plan.articles)


def test_padding_and_indentation_do_not_fracture_a_lower_band() -> None:
    items = tuple(
        region(f"下{index}", x, top, 20, 620 - top)
        for index, (x, top) in enumerate(
            ((0, 340), (26, 327), (52, 327), (78, 327), (104, 327), (130, 309.8))
        )
    )
    plan = plan_reading_order(items)
    assert plan.order == (5, 4, 3, 2, 1, 0)
    assert len(plan.articles) == 1
    assert plan.articles[0].body == (5, 4, 3, 2, 1, 0)


def test_slanted_parent_cut_small_bbox_overlap_preserves_band_order() -> None:
    items = (
        region("上左", 0, 0, 20, 290),
        region("上右", 40, 0, 20, 310.2),
        region("下左", 0, 327, 20, 293),
        region("下右", 40, 309.8, 20.4, 310.2),
    )
    plan = plan_reading_order(items)
    assert plan.order == (1, 0, 3, 2)


@pytest.mark.parametrize("overlap", [0, 6, 14])
def test_stacked_bands_stay_in_order_beside_a_page_number(overlap: int) -> None:
    def band(name: str, top: int, shift: int) -> tuple[Region, ...]:
        return tuple(region(f"{name}{i}", 100 + shift - 26 * i, top, 20, 340) for i in range(4))

    # Lower bands sit slightly to the right, as on a leaning page.
    items = (
        *band("上", 0, 0),
        *band("中", 340 - overlap, 3),
        *band("下", 680 - 2 * overlap, 6),
        region("18", 60, 1000 - 2 * overlap, 20, 18),
    )
    plan = plan_reading_order(items)
    assert plan.order == tuple(range(13))
    assert [article.body for article in plan.articles] == [
        (0, 1, 2, 3),
        (4, 5, 6, 7),
        (8, 9, 10, 11),
    ]


def test_heading_column_beside_two_bands_is_read_before_both() -> None:
    def band(name: str, top: int) -> tuple[Region, ...]:
        return tuple(region(f"{name}{i}", 400 - 26 * i, top, 20, 300) for i in range(4))

    # The heading column reaches 8 px into the lower band. Beside the bands that
    # keeps all of them in one row, so the heading and its byline come first.
    items = (
        region("見出しの列", 440, 0, 40, 330),
        region("著者名", 450, 430, 20, 100),
        *band("上", 0),
        *band("下", 322),
    )
    plan = plan_reading_order(items)
    assert plan.order == tuple(range(10))


def test_optional_raw_source_slots_follow_the_same_emitted_permutation() -> None:
    items = (region("左", 0, 0, 20, 200), region("右", 40, 0, 20, 200))
    assert plan_reading_order(items).raw_source_slots == ()
    plan = plan_reading_order(items, raw_source_slots=((0, 4), (1, 8)))
    assert plan.source_slots == (1, 0)
    assert plan.raw_source_slots == ((1, 8), (0, 4))
    horizontal = (region("a", 0, 0, 200, 20), region("b", 0, 30, 200, 20))
    identity = plan_reading_order(horizontal, raw_source_slots=((2, 5), (2, 9)))
    assert identity.raw_source_slots == ((2, 5), (2, 9))


@pytest.mark.parametrize(
    "slots",
    [
        ((0, 1),),
        ((0, 1), (0, 1)),
        ((True, 1), (0, 2)),
        ((0, False), (0, 2)),
        ((-1, 0), (0, 2)),
        ((0, -1), (0, 2)),
        ((0.0, 1), (0, 2)),
        ((0, "1"), (0, 2)),
        ((0, 1, 2), (0, 2)),
        (None, (0, 2)),
    ],
)
def test_invalid_raw_source_identity_fails_before_planning(slots: object) -> None:
    items = (region("左", 0, 0, 20, 200), region("右", 40, 0, 20, 200))
    with pytest.raises(ValueError, match="raw source"):
        plan_reading_order(items, raw_source_slots=slots)  # type: ignore[arg-type]


def front_matter_page(*, horizontal_title: bool = False, name_x: float = 130) -> tuple[Region, ...]:
    title = region("見出し", 200, 50, 50, 160)
    if horizontal_title:
        title = region("横見出し", 100, 50, 160, 30)
    return (
        region("header", 0, -40, 300, 20),
        title,
        *(region(f"上{x}", x, 0, 20, 200) for x in (0, 26, 52)),
        *(region(f"下{x}", x, 240, 20, 200) for x in (0, 26, 52)),
        *(
            region(text, name_x, y, 25, 25)
            for text, y in zip("山本仁", (240, 310, 380), strict=True)
        ),
        region("footer", 0, 500, 300, 20),
    )


def test_spaced_front_matter_name_belongs_after_its_complete_body_flow() -> None:
    items = front_matter_page()
    plan = plan_reading_order(items)
    body, name = (4, 3, 2, 7, 6, 5), (8, 9, 10)
    assert tuple(i for i in plan.order if i in body) == body
    assert max(plan.order.index(i) for i in body) < min(plan.order.index(i) for i in name)
    assert plan.order[0] == 0 and plan.order[-1] == 11
    assert plan.articles[-1].signatures == name
    assert len(plan.front_matter_signatures) == 1
    owner = plan.front_matter_signatures[0]
    assert owner.signatures == name
    assert owner.body == body
    assert owner.supporting_titles == (1,)
    assert items == front_matter_page()


def test_horizontal_heading_does_not_authorize_relocating_vertical_short_text() -> None:
    plan = plan_reading_order(front_matter_page(horizontal_title=True))
    assert not plan.front_matter_signatures
    assert all(not set((8, 9, 10)) & set(a.signatures) for a in plan.articles)
    assert plan.order[0] == 0
    assert plan.order.index(1) < plan.order.index(11)


def test_short_body_lane_is_not_captured_as_a_front_matter_author() -> None:
    plan = plan_reading_order(front_matter_page(name_x=52))
    assert not plan.front_matter_signatures
    assert all(not set((8, 9, 10)) & set(a.signatures) for a in plan.articles)


def test_competing_front_matter_chains_abstain() -> None:
    items = (
        *front_matter_page(),
        *(region(t, 100, y, 25, 25) for t, y in zip("田中義", (240, 310, 380), strict=True)),
    )
    plan = plan_reading_order(items)
    assert not plan.front_matter_signatures
    assert "competing_front_matter_signature" in plan.diagnostics


def test_body_flow_with_its_own_heading_is_not_globally_owned_by_front_matter() -> None:
    items = (*front_matter_page(), region("B", 60, 205, 15, 20))
    plan = plan_reading_order(items)
    assert not plan.front_matter_signatures


@pytest.mark.parametrize(
    "top, height, signed",
    [
        (150, 245, True),  # starts in the upper half, ends at the band bottom
        (220, 100, True),  # starts in the lower half
        (100, 100, False),  # indented, but neither low nor bottom-aligned
    ],
)
def test_long_bottom_aligned_signature_precedes_the_ruby_of_its_article(
    top: int, height: int, signed: bool
) -> None:
    items = (
        region("右本文", 100, 0, 20, 400),
        region("左本文", 60, 0, 20, 400),
        region("（著者『長い書名のある出典』による）", 20, top, 20, height),
        region("ふりがな", 117, 50, 9, 40),
    )
    plan = plan_reading_order(items)
    assert plan.ruby == frozenset({3})
    assert plan.articles[0].signatures == ((2,) if signed else ())
    if signed:
        assert plan.order == (0, 1, 2, 3)
        assert plan.text == "右本文\n左本文\n（著者『長い書名のある出典』による）\n\nふりがな"


@pytest.mark.parametrize(
    "text, x, width, expected",
    [
        ("みきわ", 114, 15, True),  # padded into its owner; right edge stays in the gap
        ("rÉ iu è", 115, 13, True),  # unreadable, overlapping, right edge in the gap
        ("みきわ", 124, 15, False),  # same width standing clear of the owner
        ("保", 120, 14, False),  # unsupported text reaching too far into the gap
    ],
)
def test_ruby_reach_is_measured_from_the_owner_right_edge(
    text: str, x: int, width: int, expected: bool
) -> None:
    items = (
        region("右本文", 100, 0, 20, 200),
        region("左本文", 60, 0, 20, 200),
        region(text, x, 50, width, 40),
    )
    plan = plan_reading_order(items)
    assert (2 in plan.ruby) is expected
    assert plan.articles[0].body == (0, 1)


def test_ruby_on_the_first_characters_is_not_taken_for_a_narrow_column() -> None:
    items = (
        region("右本文", 100, 0, 20, 200),
        region("左本文", 60, 0, 20, 200),
        region("ふり", 117, 2, 14, 30),
    )
    plan = plan_reading_order(items)
    assert plan.articles[0].body == (0, 1)
    assert plan.articles[0].ruby_owners == ((2, 0),)


# Known limitation: lane spacing comes from the closest pair of full-width columns.
# When full-width columns only stand on both sides of a narrow one, the narrow
# column is left unassigned. Counting narrow boxes fixed this but let ruby at
# column tops pass for columns, which is the worse error.
@pytest.mark.xfail(strict=True, reason="narrow column between the only anchors")
def test_narrow_columns_in_their_own_lanes_are_body_in_reading_order() -> None:
    items = (
        region("右本文", 78, 0, 20, 300),
        region("狭い本文", 54, 0, 15, 300),
        region("中本文", 26, 0, 20, 300),
        region("あろう", 3, 0, 15, 60),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3)
    assert plan.articles[0].body == (0, 1, 2, 3)
    assert not plan.ruby


def test_narrow_columns_beside_adjacent_full_columns_are_body() -> None:
    items = (
        region("右本文", 130, 0, 20, 300),
        region("右中本文", 104, 0, 20, 300),
        region("狭い本文", 80, 0, 15, 300),
        region("中本文", 52, 0, 20, 300),
        region("あろう", 29, 0, 15, 60),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3, 4)
    assert plan.articles[0].body == (0, 1, 2, 3, 4)


@pytest.mark.xfail(strict=True, reason="narrow column between the only anchors")
def test_dense_band_with_every_other_column_narrow_reads_right_to_left() -> None:
    items = tuple(region(f"列{i}", 240 - 24 * i, 0, 15 if i % 2 else 20, 300) for i in range(9))
    plan = plan_reading_order(items)
    assert plan.order == tuple(range(9))
    assert plan.articles[0].body == tuple(range(9))


def test_long_ruby_at_a_column_top_stays_ruby() -> None:
    items = (
        region("右本文", 140, 0, 20, 300),
        region("中本文", 100, 0, 20, 300),
        region("左本文", 60, 0, 20, 300),
        region("きちょうめん", 118, 3, 14, 70),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3)
    assert plan.articles[0].ruby_owners == ((3, 1),)


def test_ruby_at_the_top_of_every_column_stays_ruby() -> None:
    items = (
        *(region(f"本文{i}", 600 - 36 * i, 0, 20, 300) for i in range(5)),
        *(region(f"ふり{i}", 620 - 36 * i, 4, 14, 30) for i in range(5)),
    )
    plan = plan_reading_order(items)
    assert plan.articles[0].body == (0, 1, 2, 3, 4)
    assert plan.ruby == frozenset({5, 6, 7, 8, 9})
    assert plan.order == tuple(range(10))


def test_nearly_square_single_character_column_keeps_its_place() -> None:
    items = (
        region("右本文", 100, 0, 20, 300),
        region("序", 66, 0, 28, 20),
        region("左本文", 40, 0, 20, 300),
        region("左々", 10, 0, 20, 300),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3)


@pytest.mark.parametrize("text", ["以上", "図1"])
def test_two_character_horizontal_line_is_not_body_or_signature(text: str) -> None:
    items = (
        region("右本文", 100, 0, 20, 400),
        region("左本文", 60, 0, 20, 400),
        region(text, 20, 0, 30, 16),
        region(text, 20, 380, 30, 16),
        region("ふりがな", 117, 50, 9, 40),
    )
    plan = plan_reading_order(items)
    assert plan.articles[0].body == (0, 1)
    assert plan.articles[0].signatures == ()
    assert plan.ruby == frozenset({4})


@pytest.mark.parametrize("x", [82, 121])
def test_ruby_at_a_column_top_standing_clear_of_its_owner_stays_ruby(x: int) -> None:
    items = (
        region("右本文", 100, 0, 20, 200),
        region("左本文", 60, 0, 20, 200),
        region("ふり", x, 4, 13, 30),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2)
    assert plan.ruby == frozenset({2})
    assert plan.articles[0].body == (0, 1)


@pytest.mark.parametrize(
    "text, x, width", [("18", 63, 14), ("18", 61, 18), ("- 18 -", 61, 18), ("１８", 61, 18)]
)
def test_page_number_below_a_column_is_not_a_body_continuation(
    text: str, x: int, width: int
) -> None:
    items = (
        region("右本文", 100, 0, 20, 400),
        region("中本文", 60, 0, 20, 400),
        region("左本文", 20, 0, 20, 400),
        region(text, x, 420, width, 14),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3)
    assert plan.articles[0].body == (0, 1, 2)


def test_narrow_text_fragment_below_a_column_continues_it() -> None:
    items = (
        region("右本文", 100, 0, 20, 300),
        region("中本文", 60, 0, 20, 300),
        region("左本文", 20, 0, 20, 400),
        region("隆", 62, 310, 15, 20),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 3, 2)
    assert plan.articles[0].body == (0, 1, 3, 2)


def test_lower_fragment_inside_an_article_is_not_an_article_of_its_own() -> None:
    items = (
        region("右本文", 300, 0, 20, 400),
        region("名前", 270, 0, 20, 60),
        region("左本文", 240, 0, 20, 400),
        region("所属の長い続き", 270, 80, 20, 300),
        region("別右", 80, 80, 20, 300),
        region("別左", 50, 80, 20, 300),
    )
    plan = plan_reading_order(items)
    assert plan.order[:4] == (0, 1, 3, 2)
    assert any(article.body == (0, 1, 3, 2) for article in plan.articles)


def test_bare_option_number_above_a_passage_is_not_its_label() -> None:
    items = (
        region("3", 0, 0, 12, 20),
        region("三番目の選択肢", 30, 0, 300, 20),
        region("4", 0, 30, 12, 20),
        region("四番目の選択肢", 30, 30, 300, 20),
        region("(4)", 0, 60, 30, 20),
        region("左本文", 60, 100, 20, 400),
        region("右本文", 100, 100, 20, 400),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3, 4, 6, 5)
    assert plan.articles[0].labels == (4,)


def test_single_column_block_beside_another_article_keeps_its_ruby() -> None:
    items = (
        region("A右", 400, 0, 20, 400),
        region("A左", 370, 0, 20, 400),
        region("B本文", 100, 0, 20, 400),
        region("ふりがな", 118, 50, 9, 40),
    )
    plan = plan_reading_order(items)
    assert plan.order == (0, 1, 2, 3)
    assert plan.ruby == frozenset({3})
    assert plan.text == "A右\nA左\nB本文\n\nふりがな"


def test_horizontal_block_starting_above_the_article_top_is_not_split() -> None:
    items = (
        region("右本文", 440, 40, 20, 400),
        region("左本文", 400, 40, 20, 400),
        *(region(f"横{i}", 0, y, 300, 20) for i, y in enumerate((10, 50, 90, 130))),
    )
    plan = plan_reading_order(items)
    assert [i for i in plan.order if i >= 2] == [2, 3, 4, 5]
    assert abs(plan.order.index(2) - plan.order.index(5)) == 3


def test_vertical_page_facing_a_horizontal_page_keeps_each_page_whole() -> None:
    items = (
        region("右頁見出し", 300, 0, 100, 20),
        region("右頁左", 320, 60, 20, 400),
        region("右頁右", 360, 60, 20, 400),
        region("-1-", 330, 500, 40, 20),
        region("左頁見出し", 0, 0, 100, 20),
        *(region(f"左頁横{i}", 0, y, 200, 20) for i, y in enumerate((60, 100, 140))),
        region("-2-", 30, 500, 40, 20),
    )
    assert plan_reading_order(items).order == (0, 2, 1, 3, 4, 5, 6, 7, 8)


@pytest.mark.parametrize("ideograph_cells", [1, 2, 3])
def test_sideways_scan_of_digits_and_latin_lines_keeps_the_input_order(
    ideograph_cells: int,
) -> None:
    items = (
        *(region(f"AB12340{i}", 300 + 25 * i, 100, 24, 100) for i in range(8)),
        *(region("合計", 250 - 25 * i, 100, 24, 100) for i in range(ideograph_cells)),
        region("12,345", 300, 300, 24, 60),
    )
    plan = plan_reading_order(items)
    assert not plan.applied
    assert plan.order == tuple(range(len(items)))
    assert plan.text == "\n".join(item.text for item in items)


@dataclass(frozen=True)
class ScoredRegion:
    text: str
    polygon: tuple[tuple[float, float], ...]
    confidence: float


def scored(
    text: str, x: float, y: float, width: float, height: float, score: float
) -> ScoredRegion:
    return ScoredRegion(text, region(text, x, y, width, height).polygon, score)


@pytest.mark.parametrize("score", [0.0, 0.4, 0.59])
def test_chart_marks_read_as_low_score_ideographs_do_not_make_a_page_vertical(
    score: float,
) -> None:
    items = (
        scored("7番", 0, 0, 60, 20, 0.99),
        *(scored("家民房导务会", 300 + 170 * i, 100, 19, 106, score) for i in range(4)),
        *(scored(f"選択肢{i}", 300 + 170 * i, 60, 100, 20, 0.98) for i in range(4)),
        scored("8番", 0, 300, 60, 20, 0.99),
    )
    plan = plan_reading_order(items)
    assert not plan.applied
    assert plan.order == tuple(range(len(items)))
    assert plan.diagnostics == ("fewer_than_two_readable_vertical_lines",)


def test_low_score_columns_among_readable_ones_are_still_ordered() -> None:
    items = (
        scored("右本文", 100, 0, 20, 300, 0.99),
        scored("让业供", 70, 0, 20, 300, 0.3),
        scored("中本文", 40, 0, 20, 300, 0.98),
        scored("部星分", 10, 0, 20, 300, 0.2),
    )
    plan = plan_reading_order(items)
    assert plan.applied
    assert plan.order == (0, 1, 2, 3)


def test_vertical_page_with_a_few_unreadable_columns_is_still_ordered() -> None:
    items = (
        region("右本文", 100, 0, 20, 300),
        region("-·#E（", 70, 0, 20, 300),
        region("中本文", 40, 0, 20, 300),
        region("左本文", 10, 0, 20, 300),
    )
    plan = plan_reading_order(items)
    assert plan.applied
    assert plan.order == (0, 1, 2, 3)


def test_long_ruby_beside_an_indented_signature_does_not_found_a_band() -> None:
    items = (
        region("右本文", 100, 0, 20, 400),
        region("左本文", 60, 0, 20, 400),
        region("（著者『書名』による）", 20, 200, 20, 190),
        region("ながいふりがな", 77, 196, 9, 40),
    )
    plan = plan_reading_order(items)
    assert len(plan.articles) == 1
    assert plan.articles[0].signatures == (2,)
    assert plan.articles[0].ruby_owners == ((3, 1),)
    assert plan.order == (0, 1, 2, 3)


def test_corner_header_and_page_number_surround_a_single_article_domain() -> None:
    items = (
        region("N 1", 0, 0, 40, 25),
        region("左本文", 400, 60, 20, 400),
        region("右本文", 440, 60, 20, 400),
        region("-21-", 200, 520, 60, 25),
    )
    assert plan_reading_order(items).order == (0, 2, 1, 3)


def test_side_questions_follow_stacked_articles_and_only_the_footer_is_peeled() -> None:
    items = (
        region("上右", 440, 0, 20, 200),
        region("上左", 400, 0, 20, 200),
        region("下右", 440, 240, 20, 200),
        region("下左", 400, 240, 20, 200),
        region("問一", 0, 10, 200, 20),
        region("問二", 0, 210, 200, 20),
        region("問三", 0, 400, 200, 20),
        region("-3-", 200, 480, 60, 20),
    )
    assert plan_reading_order(items).order == (0, 1, 2, 3, 4, 5, 6, 7)


def test_each_facing_page_keeps_its_own_header_and_page_number() -> None:
    items = (
        region("左頁見出し", 0, 0, 100, 20),
        region("左頁左", 20, 60, 20, 400),
        region("左頁右", 60, 60, 20, 400),
        region("-2-", 30, 500, 40, 20),
        region("右頁見出し", 300, 0, 100, 20),
        region("右頁左", 320, 60, 20, 400),
        region("右頁右", 360, 60, 20, 400),
        region("-1-", 330, 500, 40, 20),
    )
    assert plan_reading_order(items).order == (4, 6, 5, 7, 0, 2, 1, 3)


def facing_pages(left_degrees: float) -> tuple[Region, ...]:
    left = tuple(rotate(region(f"左{i}", 100 + 30 * i, 0, 20, 600), left_degrees) for i in range(6))
    right = tuple(region(f"右{i}", 600 + 30 * i, 0, 20, 600) for i in range(6))
    return (*left, *right)


def test_facing_pages_leaning_differently_are_each_read_in_their_own_frame() -> None:
    items = facing_pages(1.7)
    before = tuple(items)
    estimate = estimate_page_skew(tuple(item.polygon for item in items))
    assert estimate is not None and estimate.consistency < 0.6
    plan = plan_reading_order(items)
    assert plan.applied
    assert plan.order == (11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0)
    assert [len(article.body) for article in plan.articles] == [6, 6]
    assert plan.diagnostics == ("facing_page_skew:1.70,0.00",)
    assert items == before


def test_inconsistent_skew_without_a_gutter_keeps_the_input_order() -> None:
    items = tuple(rotate(region(f"文{i}", 100 + 30 * i, 0, 20, 600), 2 * (i % 2)) for i in range(8))
    plan = plan_reading_order(items)
    assert not plan.applied
    assert plan.order == tuple(range(8))
    assert plan.diagnostics == ("inconsistent_page_skew",)


@pytest.mark.parametrize("heading_top", [194, 210, 226])
def test_intervening_horizontal_heading_blocks_front_matter_owner_extension(
    heading_top: int,
) -> None:
    items = (*front_matter_page(), region("別の文章", 0, heading_top, 72, 20))
    plan = plan_reading_order(items)
    assert not plan.front_matter_signatures


def test_another_large_vertical_heading_blocks_a_single_front_matter_owner() -> None:
    items = (*front_matter_page(), region("別稿", -80, 260, 40, 160))
    plan = plan_reading_order(items)
    assert not plan.front_matter_signatures
