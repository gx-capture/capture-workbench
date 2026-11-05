"""Bounded whole-region Japanese reading-order policy.

Only analysis coordinates move. This module neither recognizes text nor mutates
source tuples. Article/role diagnostics are private hypotheses, not wire fields
or a declaration that a page meets an image-gold acceptance gate.
"""

from __future__ import annotations

import math
import re
from bisect import bisect_left, bisect_right
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field, replace
from statistics import median
from typing import Protocol

ORIENTATION_RATIO = 1.5
LONG_LINE_RATIO = 4.0
MIN_LONG_VERTICAL_LINES = 2
MIN_COLUMN_CONFIDENCE = 0.6
MAX_REGIONS = 1000
SKEW_MIN_LINES = 3
SKEW_MIN_CONSISTENCY = 0.6
SKEW_EPSILON_DEGREES = 0.05
RUBY_MAX_WIDTH = 0.7
OWNER_MIN_WIDTH = 0.85
BODY_MIN_WIDTH = 0.6
OWN_LANE_PITCH = 0.75
BODY_MIN_ASPECT = 0.6
RUBY_GAP_MIN = -0.6
RUBY_GAP_MAX = 0.5
RUBY_Y_SLACK = 0.5
# How far a ruby may reach past its owner's right edge. Detector padding widens
# a ruby box into its owner; that does not move the ruby's own right edge.
RUBY_MAX_PROTRUSION = 0.7
RUBY_MAX_UNSUPPORTED_PROTRUSION = 0.6
POLICY = "whole-region-rules-v1"

# Scale-relative policy tolerances; changes require development replay.
TOP_BAND_EM = 1.25
ARTICLE_GAP_PITCH = 2.5
CONTINUATION_GAP_EM = 2.0
OWNER_COMPETITION_EM = 0.25
SIGNATURE_BOTTOM_EM = 1.5
ROW_OVERLAP_EM = 0.75
# Furigana on horizontal pages, relative to the height of the annotated line.
HORIZONTAL_RUBY_MAX_HEIGHT = 0.8
HORIZONTAL_RUBY_OVERLAP = 0.45
HORIZONTAL_RUBY_GAP = 0.35
HORIZONTAL_BLOCK_GAP = 1.5
HORIZONTAL_RUBY_MIN_ASPECT = 0.6  # a reading of one character is about square
# A reading's characters are smaller than the line they annotate, so each takes less
# width than that line is tall; full-size kana above a line are text, not a reading.
HORIZONTAL_RUBY_MAX_GLYPH = 1.0
# A kana-only line as tall as the line of text just above it continues that text.
HORIZONTAL_RUBY_SAME_SIZE = 0.15

Polygon = tuple[tuple[float, float], ...]


class RegionLike(Protocol):
    @property
    def text(self) -> str: ...

    @property
    def polygon(self) -> Polygon: ...


@dataclass(frozen=True, slots=True)
class SkewEstimate:
    degrees: float
    lines: int
    consistency: float


@dataclass(frozen=True, slots=True)
class _PageFrame:
    degrees: float
    x: float
    y: float


@dataclass(frozen=True, slots=True)
class ArticlePlan:
    body: tuple[int, ...]
    ruby: tuple[int, ...]
    labels: tuple[int, ...]
    signatures: tuple[int, ...]
    bbox: tuple[float, float, float, float]
    ruby_owners: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True, slots=True)
class FrontMatterSignaturePlan:
    signatures: tuple[int, ...]
    body: tuple[int, ...]
    supporting_titles: tuple[int, ...]


@dataclass(frozen=True, slots=True)
class ReadingPlan:
    order: tuple[int, ...]
    ruby: frozenset[int]
    text: str
    skew_degrees: float
    applied: bool
    policy: str = POLICY
    diagnostics: tuple[str, ...] = ()
    articles: tuple[ArticlePlan, ...] = ()
    # Input normalized ordinals, in emitted order. These are NOT raw Paddle slots.
    # The adapter/research lineage wrapper owns raw -> validated correspondence.
    source_slots: tuple[int, ...] = ()
    # Actual (Paddle result index, raw region index), only when supplied by the
    # validating adapter. Empty means unknown, never synthesized ordinals.
    raw_source_slots: tuple[tuple[int, int], ...] = ()
    front_matter_signatures: tuple[FrontMatterSignaturePlan, ...] = ()
    # (reading, annotated line) on a horizontal page; such a page has no articles.
    horizontal_ruby_owners: tuple[tuple[int, int], ...] = ()


@dataclass(frozen=True, slots=True)
class _Box:
    slot: int
    x0: float
    y0: float
    x1: float
    y1: float

    @property
    def w(self) -> float:
        return self.x1 - self.x0

    @property
    def h(self) -> float:
        return self.y1 - self.y0

    @property
    def cx(self) -> float:
        return (self.x0 + self.x1) / 2

    @property
    def vertical(self) -> bool:
        return self.h >= ORIENTATION_RATIO * self.w


@dataclass(slots=True)
class _Article:
    anchors: list[_Box]
    scale: float
    pitch: float
    body: list[_Box] = field(default_factory=list)
    labels: list[_Box] = field(default_factory=list)
    signatures: list[_Box] = field(default_factory=list)
    ruby: list[tuple[_Box, int]] = field(default_factory=list)

    @property
    def bounds(self) -> _Box:
        return _bounds(self.anchors)


@dataclass(frozen=True, slots=True)
class _Unit:
    box: _Box
    order: tuple[int, ...]
    article: ArticlePlan | None = None


def _bounds(boxes: Sequence[_Box]) -> _Box:
    return _Box(
        -1,
        min(b.x0 for b in boxes),
        min(b.y0 for b in boxes),
        max(b.x1 for b in boxes),
        max(b.y1 for b in boxes),
    )


def _weighted_median(values: list[tuple[float, float]]) -> float:
    total = sum(weight for _, weight in values)
    cumulative = 0.0
    for value, weight in sorted(values):
        cumulative += weight
        if cumulative >= total / 2:
            return value
    raise ValueError("Reading-order weighted median has no positive weight.")


def _long_edge(polygon: Polygon) -> tuple[float, float, float] | None:
    """Angle, long side and short side of a quadrilateral line, if it is long."""
    if len(polygon) != 4:
        return None
    if any(not math.isfinite(v) for point in polygon for v in point):
        raise ValueError("Nonfinite reading-order polygon.")
    edges = [(polygon[j + 1][0] - polygon[j][0], polygon[j + 1][1] - polygon[j][1]) for j in (0, 1)]
    edges.sort(key=lambda edge: math.hypot(*edge))
    short, long = (math.hypot(*edge) for edge in edges)
    if short <= 0 or long < LONG_LINE_RATIO * short:
        return None
    dx, dy = edges[1]
    return (math.degrees(math.atan2(-dy, dx)) + 45) % 90 - 45, long, short


def estimate_page_skew(polygons: Sequence[Polygon]) -> SkewEstimate | None:
    """Long-edge weighted median; positive is counter-clockwise on screen."""
    samples = [(edge[0], edge[1]) for edge in map(_long_edge, polygons) if edge is not None]
    if len(samples) < SKEW_MIN_LINES:
        return None
    angle = _weighted_median(samples)
    consistency = sum(w for a, w in samples if abs(a - angle) <= 0.5) / sum(w for _, w in samples)
    return SkewEstimate(
        0.0 if abs(angle) < SKEW_EPSILON_DEGREES else angle, len(samples), consistency
    )


def _center(polygon: Polygon) -> tuple[float, float]:
    return (
        sum(x for x, _ in polygon) / len(polygon),
        sum(y for _, y in polygon) / len(polygon),
    )


def _facing_page_frames(
    regions: Sequence[RegionLike],
) -> tuple[float, _PageFrame, _PageFrame] | None:
    """Facing pages of one scan can lean differently; each side then needs its own frame.

    The pages are separated at the widest gap between long lines, which must be
    a gutter rather than column spacing. Both sides must be consistent alone.
    """
    lines = sorted(
        (_center(region.polygon)[0], edge[2])
        for region in regions
        if (edge := _long_edge(region.polygon)) is not None
    )
    if len(lines) < 2 * SKEW_MIN_LINES:
        return None
    gap, index = max(
        (right[0] - left[0], i)
        for i, (left, right) in enumerate(zip(lines, lines[1:], strict=False))
    )
    if gap < 3 * median(short for _, short in lines):
        return None
    split = (lines[index][0] + lines[index + 1][0]) / 2
    frames: list[_PageFrame] = []
    for left in (True, False):
        side = [r.polygon for r in regions if (_center(r.polygon)[0] < split) is left]
        estimate = estimate_page_skew(side)
        if estimate is None or estimate.consistency < SKEW_MIN_CONSISTENCY:
            return None
        centers = [_center(polygon) for polygon in side]
        frames.append(
            _PageFrame(
                estimate.degrees,
                sum(x for x, _ in centers) / len(centers),
                sum(y for _, y in centers) / len(centers),
            )
        )
    return split, frames[0], frames[1]


def _analysis_boxes(
    regions: Sequence[RegionLike],
    skew: float,
    facing: tuple[float, _PageFrame, _PageFrame] | None = None,
) -> list[_Box]:
    boxes: list[_Box] = []
    for slot, region in enumerate(regions):
        if any(not math.isfinite(v) for point in region.polygon for v in point):
            raise ValueError("Nonfinite reading-order polygon.")
        frame = _PageFrame(skew, 0.0, 0.0)
        if facing is not None:
            frame = facing[1] if _center(region.polygon)[0] < facing[0] else facing[2]
        radians = math.radians(-frame.degrees)
        cosine, sine = math.cos(radians), math.sin(radians)
        points = [
            (
                frame.x + (x - frame.x) * cosine + (y - frame.y) * sine,
                frame.y - (x - frame.x) * sine + (y - frame.y) * cosine,
            )
            for x, y in region.polygon
        ]
        box = _Box(
            slot,
            min(p[0] for p in points),
            min(p[1] for p in points),
            max(p[0] for p in points),
            max(p[1] for p in points),
        )
        if box.w <= 0 or box.h <= 0:
            raise ValueError("Degenerate reading-order polygon.")
        boxes.append(box)
    return boxes


_KANA = re.compile(r"[\u3041-\u3096\u30a1-\u30fa]")
_FURIGANA = re.compile(r"[\u3041-\u3096\u30a1-\u30fa\u30fc\u3001\u3002\u30fb,.]+")
_IDEOGRAPH = re.compile(r"[\u3005\u3400-\u9fff]")
_CJK = re.compile(r"[々ぁ-ゖァ-ヺ㐀-鿿]")


def _number_label(text: str) -> bool:
    compact = "".join(text.split())
    return bool(re.fullmatch(r"[注図表]?[\d０-９]+[.．、:：)）]?", compact))


def _page_number(text: str) -> bool:
    compact = "".join(text.split())
    return bool(re.fullmatch(r"[-‐–—―ー－]*[\d０-９]+[-‐–—―ー－]*", compact))


def _articles(long_boxes: list[_Box], eligible_boxes: list[_Box]) -> list[_Article]:
    # Top bands are established from long columns BEFORE ruby/continuation.
    # A tall source crossing a later band cannot join those two bands.
    bands: list[list[_Box]] = []
    for box in sorted(long_boxes, key=lambda b: (b.y0, -b.cx, b.slot)):
        if not bands or box.y0 - median(b.y0 for b in bands[-1]) > TOP_BAND_EM * max(
            box.w, median(b.w for b in bands[-1])
        ):
            bands.append([box])
        else:
            bands[-1].append(box)
    articles: list[_Article] = []
    for band in bands:
        if len(band) < MIN_LONG_VERTICAL_LINES:
            continue
        scale = _weighted_median([(b.w, b.h) for b in band])
        # First partition spatial domains, without discarding a different font
        # size using the other article's scale. Scale filtering is local below.
        anchors = sorted(band, key=lambda b: b.cx)
        gaps = [
            b.cx - a.cx
            for a, b in zip(anchors, anchors[1:], strict=False)
            if b.cx - a.cx > 0.6 * scale
        ]
        pitch = min(median(gaps), 2.5 * scale) if gaps else 2 * scale
        anchor_slots = {b.slot for b in anchors}
        top = median(b.y0 for b in band)
        # A short full-width body column can occupy a normal column position
        # between long anchors. Omitting it invents an article gutter. It only
        # bridges domains here; normal unique-owner attachment still assigns it.
        bridges = [
            b
            for b in eligible_boxes
            if b.slot not in anchor_slots
            and anchors[0].cx < b.cx < anchors[-1].cx
            and OWNER_MIN_WIDTH * scale <= b.w <= 1.6 * scale
            and 0.75 * scale <= b.h < LONG_LINE_RATIO * b.w
            and abs(b.y0 - top) <= TOP_BAND_EM * scale
        ]
        groups: list[list[_Box]] = [[]]
        for box in sorted([*anchors, *bridges], key=lambda b: b.cx):
            if groups[-1] and box.cx - groups[-1][-1].cx > max(
                3 * scale, ARTICLE_GAP_PITCH * pitch
            ):
                groups.append([])
            groups[-1].append(box)
        for spatial_group in groups:
            group = [b for b in spatial_group if b.slot in anchor_slots]
            if not group:
                continue
            local_scale = _weighted_median([(b.w, b.h) for b in group])
            local = [b for b in group if OWNER_MIN_WIDTH * local_scale <= b.w <= 1.6 * local_scale]
            if not local:
                continue
            local_gaps = [
                b.cx - a.cx
                for a, b in zip(local, local[1:], strict=False)
                if b.cx - a.cx > 0.6 * local_scale
            ]
            local_pitch = (
                min(median(local_gaps), 2.5 * local_scale) if local_gaps else 2 * local_scale
            )
            articles.append(_Article(local, local_scale, local_pitch, body=list(local)))
    # One long box inside the reach of a real article is its signature, a lower
    # fragment of one of its columns or a heading, not an article of its own.
    # An isolated single column still is one.
    real = [a for a in articles if len(a.anchors) >= MIN_LONG_VERTICAL_LINES]
    return [
        a
        for a in articles
        if len(a.anchors) >= MIN_LONG_VERTICAL_LINES
        or not any(
            other.bounds.x0 - 1.6 * other.pitch <= a.anchors[0].cx <= other.bounds.x1 + other.scale
            and a.anchors[0].y0 <= other.bounds.y1 + CONTINUATION_GAP_EM * other.scale
            and a.anchors[0].y1 >= other.bounds.y0 - other.scale
            for other in real
        )
    ]


def _body_order(boxes: Sequence[_Box], scale: float) -> tuple[int, ...]:
    lanes: list[list[_Box]] = []
    for box in sorted(boxes, key=lambda b: (-b.cx, b.y0, b.slot)):
        if not lanes or abs(box.cx - lanes[-1][0].cx) > 0.6 * scale:
            lanes.append([box])
        else:
            lanes[-1].append(box)
    return tuple(b.slot for lane in lanes for b in sorted(lane, key=lambda b: (b.y0, b.slot)))


def _demote_annotation_bands(articles: list[_Article]) -> list[_Article]:
    """Narrow embedded side columns cannot establish their own body scale.

    This only removes an article hypothesis; the later owner competition rule
    still decides whether each original source is ruby or remains unassigned.
    """
    result: list[_Article] = []
    for candidate in articles:
        embedded = any(
            parent is not candidate
            and candidate.scale <= RUBY_MAX_WIDTH * parent.scale
            and all(
                any(
                    RUBY_GAP_MIN * parent.scale <= small.x0 - body.x1 <= RUBY_GAP_MAX * parent.scale
                    and body.y0 - RUBY_Y_SLACK * parent.scale <= small.y0
                    and small.y1 <= body.y1 + RUBY_Y_SLACK * parent.scale
                    and small.h < body.h
                    for body in parent.anchors
                )
                for small in candidate.anchors
            )
            for parent in articles
        )
        if not embedded:
            result.append(candidate)
    return result


def _lane_spacing(article: _Article) -> float:
    """Closest pair of anchors: narrow columns between anchors widen the median.

    When the only anchors straddle a narrow column this is two lanes wide and
    that column stays unassigned. Counting narrow boxes instead lets ruby at
    column tops shrink the spacing until ruby passes for columns.
    """
    centers = sorted(b.cx for b in article.anchors)
    return min(
        (q - p for p, q in zip(centers, centers[1:], strict=False) if q - p > 0.6 * article.scale),
        default=article.pitch,
    )


def _attach_regions(
    regions: Sequence[RegionLike],
    boxes: list[_Box],
    articles: list[_Article],
    diagnostics: list[str],
) -> set[int]:
    used = {b.slot for article in articles for b in article.anchors}
    lanes = {id(article): _lane_spacing(article) for article in articles}
    for box in sorted(boxes, key=lambda b: (b.y0, -b.cx, b.slot)):
        if box.slot in used:
            continue
        candidates: list[tuple[_Article, str]] = []
        for article in articles:
            bounds, em = article.bounds, article.scale
            full_width = OWNER_MIN_WIDTH * em <= box.w <= 1.6 * em
            lane = lanes[id(article)]
            number = _number_label(regions[box.slot].text) or _page_number(regions[box.slot].text)
            # Small type gives narrower detector boxes. At the band top such a
            # box is a column when it stands a lane away from the column on its
            # left; ruby sits within a fraction of the pitch. Numbers stay out.
            own_lane = (
                BODY_MIN_WIDTH * em <= box.w < OWNER_MIN_WIDTH * em
                and not number
                and not any(
                    RUBY_GAP_MIN * em <= box.x0 - b.x1 <= RUBY_GAP_MAX * em
                    and box.cx - b.cx < OWN_LANE_PITCH * lane
                    for b in article.body
                )
            )
            in_x = bounds.x0 - 1.6 * article.pitch <= box.cx <= bounds.x1 + em
            in_top = bounds.y0 - 0.25 * em <= box.y0 <= bounds.y0 + TOP_BAND_EM * em
            upright = box.h >= BODY_MIN_ASPECT * box.w
            if (full_width or own_lane) and upright and in_x and in_top and box.h <= bounds.h + em:
                candidates.append((article, "body"))
                continue
            # A bare number above a passage is the last option of the question
            # before it; a passage label is a letter or is bracketed.
            label_like = not number and bool(
                re.fullmatch(
                    r"[（(]?[A-Za-zＡ-Ｚａ-ｚ0-9０-９]{1,3}[）)]?", regions[box.slot].text.strip()
                )
            )
            # Continuation requires a prior same-lane body source and stays inside
            # this band. Other bands' anchors were already assigned above.
            predecessors = [
                b
                for b in article.body
                if abs(b.cx - box.cx) <= 0.5 * em and 0 <= box.y0 - b.y1 <= CONTINUATION_GAP_EM * em
            ]
            # A fragment under a column is already in a lane, so small type
            # needs no lane test here. A number there is a page number.
            if (
                (
                    full_width
                    or (BODY_MIN_WIDTH * em <= box.w < OWNER_MIN_WIDTH * em and not label_like)
                )
                and not number
                and len(predecessors) == 1
                and box.y1 <= bounds.y1 + CONTINUATION_GAP_EM * em
            ):
                candidates.append((article, "body"))
                continue
            if (
                label_like
                and box.w <= 2 * em
                and box.h <= 2 * em
                and bounds.y0 - 4 * em <= box.y1 <= bounds.y0 + 0.5 * em
                and bounds.x0 - 8 * em <= box.cx <= bounds.x1 + 2 * em
            ):
                candidates.append((article, "label"))
                continue
            body_left = min(b.x0 for b in article.body)
            # A signature is indented from the band top. It either starts in
            # the lower half or, when long, is aligned to the band bottom.
            if (
                full_width
                and upright
                and body_left - 1.6 * article.pitch <= box.cx < body_left
                and box.y0 >= bounds.y0 + 2 * em
                and (
                    box.y0 >= bounds.y0 + 0.5 * bounds.h
                    or box.y1 >= bounds.y1 - SIGNATURE_BOTTOM_EM * em
                )
                and box.y1 <= bounds.y1 + em
                and not predecessors
            ):
                candidates.append((article, "signature"))
        if len(candidates) == 1:
            article, role = candidates[0]
            if role == "body":
                article.body.append(box)
            elif role == "label":
                article.labels.append(box)
            else:
                article.signatures.append(box)
                if not regions[box.slot].text.lstrip().startswith(("（", "(")):
                    diagnostics.append(f"unresolved_late_attachment:{box.slot}")
            used.add(box.slot)
        elif candidates:
            diagnostics.append(f"competing_article_attachment:{box.slot}")
    return used


def _attach_ruby(
    regions: Sequence[RegionLike],
    boxes: list[_Box],
    articles: list[_Article],
    used: set[int],
    diagnostics: list[str],
) -> None:
    owners = sorted(
        (
            (body.x1, body.slot, body, article)
            for article in articles
            for body in article.body
            if body.vertical
        ),
        key=lambda item: (item[0], item[1]),
    )
    ends = [item[0] for item in owners]
    max_scale = max((a.scale for a in articles), default=0)
    for box in boxes:
        if box.slot in used or _number_label(regions[box.slot].text):
            continue
        if box.w >= OWNER_MIN_WIDTH * max_scale:
            continue
        lower = bisect_left(ends, box.x0 - RUBY_GAP_MAX * max_scale)
        upper = bisect_right(ends, box.x0 - RUBY_GAP_MIN * max_scale)
        candidates: list[tuple[float, int, _Article]] = []
        kana = any(
            "ぁ" <= char <= "ゖ" or "ァ" <= char <= "ヺ" or char == "ー"
            for char in regions[box.slot].text
        )
        for _, _, body, article in owners[lower:upper]:
            em = article.scale
            gap = box.x0 - body.x1
            protrusion = box.x1 - body.x1
            if not (
                (
                    box.w <= RUBY_MAX_WIDTH * em
                    or (box.w < OWNER_MIN_WIDTH * em and protrusion <= RUBY_MAX_PROTRUSION * em)
                )
                and body.w >= OWNER_MIN_WIDTH * em
                and RUBY_GAP_MIN * em <= gap <= RUBY_GAP_MAX * em
                and body.y0 - RUBY_Y_SLACK * em <= box.y0
                and box.y1 <= body.y1 + RUBY_Y_SLACK * em
                and box.h < body.h
                and (box.h >= box.w or len(regions[box.slot].text) <= 2)
            ):
                continue
            # Kana is corroboration, not an absolute gate: overlap plus reduced
            # width also admits recognizer-corrupted ruby. Numeric labels stay out.
            if not kana and not (
                -RUBY_Y_SLACK * em <= gap <= 0
                and protrusion <= RUBY_MAX_UNSUPPORTED_PROTRUSION * em
            ):
                continue
            candidates.append((abs(gap) / em, body.slot, article))
        candidates.sort(key=lambda candidate: (candidate[0], candidate[1]))
        if len(candidates) > 1 and candidates[1][0] - candidates[0][0] <= OWNER_COMPETITION_EM:
            diagnostics.append(f"competing_ruby_owner:{box.slot}")
        elif candidates:
            _, owner, article = candidates[0]
            article.ruby.append((box, owner))
            used.add(box.slot)


def _axis_groups(units: list[_Unit], axis: str, gap: float = 0) -> list[list[_Unit]]:
    start: Callable[[_Unit], float] = (lambda u: u.box.y0) if axis == "y" else (lambda u: u.box.x0)
    end: Callable[[_Unit], float] = (lambda u: u.box.y1) if axis == "y" else (lambda u: u.box.x1)
    groups: list[list[_Unit]] = []
    right = -math.inf
    for unit in sorted(units, key=lambda u: (start(u), end(u), u.order)):
        if not groups or start(unit) >= right + gap:
            groups.append([unit])
            right = end(unit)
        else:
            groups[-1].append(unit)
            right = max(right, end(unit))
    return groups


def _rows(units: list[_Unit], scale: float) -> list[list[_Unit]]:
    """Split units into rows, letting two stacked tall units overlap a little.

    Scanned bands touch or overlap by a few pixels, more so on a leaning page.
    A unit starts a new row unless it overlaps a unit of the current row by
    more than that pair allows: a tenth of the shorter of the two, at most
    ROW_OVERLAP_EM when one stands above the other and a quarter em otherwise.
    A page number beside a band therefore cannot change how two bands are
    separated, and a heading column beside two bands still joins them.
    """
    rows: list[list[_Unit]] = []
    for unit in sorted(units, key=lambda u: (u.box.y0, u.box.y1, u.order)):
        box = unit.box
        if rows and any(
            box.y0
            < other.box.y1
            - min(
                (ROW_OVERLAP_EM if min(box.x1, other.box.x1) > max(box.x0, other.box.x0) else 0.25)
                * scale,
                0.1 * min(box.h, other.box.h),
            )
            for other in rows[-1]
        ):
            rows[-1].append(unit)
        else:
            rows.append([unit])
    return rows


def _clear_of(row: list[_Unit], others: list[_Unit]) -> bool:
    return not any(
        min(u.box.x1, other.box.x1) - max(u.box.x0, other.box.x0) > 0.25 * min(u.box.w, other.box.w)
        for u in row
        for other in others
    )


def _order_units(units: list[_Unit], scale: float) -> list[_Unit]:
    result: list[_Unit] = []
    stack = [units]
    while stack:
        current = stack.pop()
        if len(current) <= 1:
            result.extend(current)
            continue
        vertical = sum(
            u.box.w * u.box.h for u in current if u.article is not None or u.box.vertical
        ) > sum(u.box.w * u.box.h for u in current if u.article is None and not u.box.vertical)
        rows = _rows(current, scale)
        # Rows wholly above or below a single article domain are page furniture
        # or questions. A narrow one must not become a page-level column beside
        # the articles. Several article domains keep each page's own furniture.
        articles = [u for u in current if u.article is not None]
        if articles and len(_axis_groups(articles, "x", 3 * scale)) == 1:
            holds = [any(u.article is not None for u in row) for row in rows]
            first = holds.index(True)
            last = len(holds) - 1 - holds[::-1].index(True)
            # A row that shares its x-range with loose text beside the articles
            # belongs to that text (side questions, a horizontal facing page).
            beside = [u for row in rows[first : last + 1] for u in row if u.article is None]
            top = 0
            while top < first and _clear_of(rows[top], beside):
                top += 1
            bottom = len(rows)
            while bottom - 1 > last and _clear_of(rows[bottom - 1], beside):
                bottom -= 1
            if top > 0 or bottom < len(rows):
                core = [u for row in rows[top:bottom] for u in row]
                stack.extend(reversed([*rows[:top], core, *rows[bottom:]]))
                continue
        # Large page/paragraph gutters precede rows. Ordinary inter-column
        # whitespace does not turn every column into an article.
        domains = _axis_groups(current, "x", 3 * scale)
        if len(domains) > 1:
            ordered = list(reversed(domains)) if vertical else domains
            stack.extend(reversed(ordered))
            continue
        if len(rows) > 1:
            stack.extend(reversed(rows))
            continue
        columns = _axis_groups(current, "x")
        if len(columns) > 1:
            ordered = list(reversed(columns)) if vertical else columns
            stack.extend(reversed(ordered))
            continue
        key = (
            (lambda u: (-u.box.cx, u.box.y0, u.order))
            if vertical
            else (lambda u: (u.box.y0, u.box.x0, u.order))
        )
        result.extend(sorted(current, key=key))
    return result


def _front_matter_signature(
    regions: Sequence[RegionLike],
    boxes: list[_Box],
    ordered: list[_Unit],
    scale: float,
    diagnostics: list[str],
) -> tuple[list[_Unit], tuple[FrontMatterSignaturePlan, ...]]:
    """Recognize one spaced name in a vertical title pocket beside a body flow.

    A spatial group alone is not an article. This narrow rule also requires a
    larger vertical heading, an uninterrupted multi-band flow, and no competing
    labels, signatures, or ruby. Other layouts retain their existing emission.
    """
    flow = [u for u in ordered if u.article is not None and len(u.article.body) >= 3]
    if len(flow) < 2:
        return ordered, ()
    body_slots = tuple(slot for u in flow if u.article is not None for slot in u.article.body)
    body_bounds = _bounds([boxes[i] for i in body_slots])
    loose = [boxes[u.order[0]] for u in ordered if u.article is None and len(u.order) == 1]
    letters = [
        b
        for b in loose
        if body_bounds.x1 + 0.5 * scale <= b.x0 <= body_bounds.x1 + 8 * scale
        and body_bounds.y0 <= b.y0 < b.y1 <= body_bounds.y1 + scale
        and 0.75 * scale <= b.w <= 1.6 * scale
        and 0.75 * scale <= b.h <= 1.8 * scale
        and re.fullmatch(
            r"[\u3005\u3041-\u3096\u30a1-\u30fa\u3400-\u9fff]", regions[b.slot].text.strip()
        )
    ]
    lanes: list[list[_Box]] = []
    for letter in sorted(letters, key=lambda b: (b.cx, b.y0)):
        if not lanes or letter.cx - lanes[-1][0].cx > 0.5 * scale:
            lanes.append([])
        lanes[-1].append(letter)
    candidates: list[tuple[list[_Box], tuple[int, ...]]] = []
    for lane in lanes:
        lane.sort(key=lambda b: b.y0)
        if not 3 <= len(lane) <= 8 or lane[-1].y1 - lane[0].y0 < 6 * scale:
            continue
        gaps = [b.y0 - a.y1 for a, b in zip(lane, lane[1:], strict=False)]
        if not all(0.75 * scale <= gap <= 3 * scale for gap in gaps):
            continue
        if max(gaps) > 1.5 * min(gaps):
            continue
        name_bounds = _bounds(lane)
        titles = tuple(
            b.slot
            for b in boxes
            if b.slot not in body_slots
            and name_bounds.x1 + scale <= b.x0 <= name_bounds.x1 + 12 * scale
            and b.y0 + 3 * scale < name_bounds.y0
            and b.w >= 1.75 * scale
            and b.h >= 4 * scale
            and b.vertical
            and len(regions[b.slot].text.strip()) >= 2
        )
        if titles:
            candidates.append((lane, titles))
    if len(candidates) > 1:
        diagnostics.append("competing_front_matter_signature")
        return ordered, ()
    if not candidates:
        return ordered, ()
    lane, titles = candidates[0]
    if any(
        b.slot not in body_slots
        and b.slot not in titles
        and b.w >= 1.75 * scale
        and b.h >= 4 * scale
        and b.vertical
        and len(regions[b.slot].text.strip()) >= 2
        for b in boxes
    ):
        return ordered, ()
    if max(boxes[i].cx for i in titles) - min(boxes[i].cx for i in titles) > 2 * max(
        boxes[i].w for i in titles
    ):
        return ordered, ()
    # Existing per-passage ownership contradicts a single front-matter owner.
    if any(
        u.article is not None and (u.article.labels or u.article.signatures or u.article.ruby)
        for u in flow
    ):
        return ordered, ()
    if any(
        not 0.75 * scale <= median(boxes[i].w for i in u.article.body) <= 1.5 * scale
        for u in flow
        if u.article is not None
    ):
        return ordered, ()
    wraps = 0
    for previous, current in zip(flow, flow[1:], strict=False):
        a, b = previous.box, current.box
        overlap = min(a.x1, b.x1) - max(a.x0, b.x0)
        next_band = (
            b.y0 > a.y0 + 2 * scale
            and overlap >= 0.6 * min(a.w, b.w)
            and -0.25 * scale <= b.y0 - a.y1 <= 4 * scale
        )
        next_page = (
            scale <= a.x0 - b.x1 <= 8 * scale
            and abs(b.y0 - body_bounds.y0) <= 2 * scale
            and a.y1 >= body_bounds.y1 - 2 * scale
        )
        if not next_band and not next_page:
            return ordered, ()
        if next_band and any(
            other.slot not in body_slots
            and not other.vertical
            and len(regions[other.slot].text.strip()) >= 2
            # OCR boxes can overlap either adjacent band by a few pixels.
            # A divider centered in the inter-band zone still interrupts flow.
            and a.y1 - 0.25 * scale <= (other.y0 + other.y1) / 2 <= b.y0 + 0.25 * scale
            and min(other.x1, a.x1, b.x1) - max(other.x0, a.x0, b.x0)
            >= 0.5 * min(other.w, a.w, b.w)
            for other in boxes
        ):
            return ordered, ()
        wraps += int(next_page)
    if wraps > 1:
        return ordered, ()
    signatures = tuple(b.slot for b in lane)
    tail = flow[-1]
    assert tail.article is not None
    owned_bounds = _bounds([tail.box, *lane])
    article = replace(
        tail.article,
        signatures=(*tail.article.signatures, *signatures),
        bbox=(owned_bounds.x0, owned_bounds.y0, owned_bounds.x1, owned_bounds.y1),
    )
    replacement = replace(tail, order=(*tail.order, *signatures), article=article)
    # Keep the established body-flow order. Original source positions remain in
    # boxes and ownership lineage; moving the signature does not rerun XY-cut.
    result = [
        replacement if unit is tail else unit
        for unit in ordered
        if not (unit.article is None and unit.order[0] in signatures)
    ]
    diagnostics.append("front_matter_signature:" + ",".join(str(i) for i in signatures))
    return result, (FrontMatterSignaturePlan(signatures, body_slots, titles),)


def _horizontal_ruby(
    regions: Sequence[RegionLike], boxes: list[_Box]
) -> tuple[tuple[int, ...], dict[int, int]] | None:
    """Furigana on a horizontal page: a low kana line resting on the line it annotates.

    Detectors return each reading as its own line above its base line, so the
    page text alternates readings and text. A reading is recognized by its
    position and size against one base line that holds an ideograph, not by
    page-wide statistics. Base lines keep their input order; the readings of
    each block of consecutive base lines follow that block. Returns the order
    and each reading's owner, or None when the page has no such line.
    """
    readings = [
        b
        for b in boxes
        if b.w >= HORIZONTAL_RUBY_MIN_ASPECT * b.h
        and _FURIGANA.fullmatch("".join(regions[b.slot].text.split()))
        and _KANA.search(regions[b.slot].text)
    ]
    if not readings:
        return None
    bases = [b for b in boxes if b.w >= b.h and _IDEOGRAPH.search(regions[b.slot].text)]
    owners: dict[int, int] = {}
    for ruby in readings:
        candidates = [
            (abs(base.y0 - ruby.y1), base.slot)
            for base in bases
            if base.slot != ruby.slot
            and ruby.h <= HORIZONTAL_RUBY_MAX_HEIGHT * base.h
            and ruby.w
            <= HORIZONTAL_RUBY_MAX_GLYPH * base.h * len("".join(regions[ruby.slot].text.split()))
            and ruby.y0 < base.y0
            and -HORIZONTAL_RUBY_OVERLAP * base.h
            <= base.y0 - ruby.y1
            <= HORIZONTAL_RUBY_GAP * base.h
            and base.x0 - 0.5 * base.h <= ruby.x0
            and ruby.x1 <= base.x1 + 0.5 * base.h
        ]
        if candidates:
            owners[ruby.slot] = min(candidates)[1]
    for ruby in readings:
        if ruby.slot in owners and any(
            other.slot != ruby.slot
            and other.slot not in owners
            and abs(other.h - ruby.h) <= HORIZONTAL_RUBY_SAME_SIZE * ruby.h
            and 0 <= ruby.y0 - other.y1 <= ruby.h
            and min(other.x1, ruby.x1) > max(other.x0, ruby.x0)
            for other in boxes
            if other.w >= other.h
        ):
            del owners[ruby.slot]
    # A reading cannot own another reading.
    owners = {ruby: base for ruby, base in owners.items() if base not in owners}
    if not owners:
        return None
    order: list[int] = []
    pending: list[tuple[int, float, int]] = []
    previous: _Box | None = None

    def flush() -> None:
        # Readings follow their lines, and run left to right along one line.
        order.extend(slot for _, _, slot in sorted(pending))
        pending.clear()

    for box in boxes:
        if box.slot in owners:
            continue
        if previous is not None and not (
            -previous.h <= box.y0 - previous.y1 <= HORIZONTAL_BLOCK_GAP * max(previous.h, box.h)
        ):
            flush()
        position = len(order)
        order.append(box.slot)
        pending.extend(
            (position, boxes[ruby].x0, ruby) for ruby, base in owners.items() if base == box.slot
        )
        previous = box
    flush()
    return tuple(order), owners


def plan_reading_order(
    regions: Sequence[RegionLike], *, raw_source_slots: Sequence[tuple[int, int]] | None = None
) -> ReadingPlan:
    """Plan whole-source emission, bounded to MAX_REGIONS; never suppress errors.

    Input ordinals are the only identities consumed here. Diagnostics flag
    incomplete geometry evidence; an applied plan is not acceptance evidence.
    """
    identity = tuple(range(len(regions)))
    raw_slots: tuple[tuple[int, int], ...] = ()
    if raw_source_slots is not None:
        if not isinstance(raw_source_slots, Sequence) or len(raw_source_slots) != len(regions):
            raise ValueError("Invalid raw source cardinality")
        if any(
            not isinstance(pair, tuple | list)
            or len(pair) != 2
            or any(type(value) is not int or value < 0 for value in pair)
            for pair in raw_source_slots
        ):
            raise ValueError("Invalid raw source identity")
        raw_slots = tuple((pair[0], pair[1]) for pair in raw_source_slots)
        if len(set(raw_slots)) != len(raw_slots):
            raise ValueError("Duplicate raw source identity")

    def unchanged(reason: str, skew: float = 0) -> ReadingPlan:
        return ReadingPlan(
            identity,
            frozenset(),
            "\n".join(r.text for r in regions),
            skew,
            False,
            diagnostics=(reason,),
            source_slots=identity,
            raw_source_slots=raw_slots,
        )

    def horizontal(reason: str, skew: float, boxes: list[_Box]) -> ReadingPlan:
        found = _horizontal_ruby(regions, boxes)
        if found is None:
            return unchanged(reason, skew)
        order, owners = found
        ruby = frozenset(owners)
        pieces: list[str] = []
        for position, slot in enumerate(order):
            if position:
                changed = (slot in ruby) != (order[position - 1] in ruby)
                pieces.append("\n\n" if changed else "\n")
            pieces.append(regions[slot].text)
        return ReadingPlan(
            order,
            ruby,
            "".join(pieces),
            skew,
            True,
            diagnostics=(reason, "horizontal_ruby"),
            source_slots=order,
            raw_source_slots=tuple(raw_slots[i] for i in order) if raw_slots else (),
            horizontal_ruby_owners=tuple(sorted(owners.items())),
        )

    if len(regions) > MAX_REGIONS:
        return unchanged("region_cap")
    if not regions:
        return unchanged("empty_page")
    if any(len(r.polygon) < 3 for r in regions):
        return unchanged("missing_geometry")
    estimate = estimate_page_skew(tuple(r.polygon for r in regions))
    skew = estimate.degrees if estimate is not None else 0.0
    inconsistent = estimate is not None and estimate.consistency < SKEW_MIN_CONSISTENCY
    facing = _facing_page_frames(regions) if inconsistent else None
    boxes = _analysis_boxes(regions, skew, facing)
    long_boxes = [
        b for b in boxes if b.h >= LONG_LINE_RATIO * b.w and not _number_label(regions[b.slot].text)
    ]
    if len(long_boxes) < MIN_LONG_VERTICAL_LINES:
        return horizontal("fewer_than_two_long_vertical_lines", skew, boxes)
    # Tall boxes without kana or ideographs are rotated horizontal lines (a
    # sideways scan of digits or Latin text). A vertical page has them in the
    # minority, so most long boxes must carry kana or ideographs. Chart axes
    # and drawings read as low-score ideographs do not count as columns.
    scripted = [b for b in long_boxes if _CJK.search(regions[b.slot].text)]
    if len(scripted) < MIN_LONG_VERTICAL_LINES or 2 * len(scripted) < len(long_boxes):
        return horizontal("long_lines_without_kana_or_ideographs", skew, boxes)
    # A region without a score counts as readable; a score of zero does not.
    scores = [getattr(regions[b.slot], "confidence", None) for b in scripted]
    if (
        sum(score is None or score >= MIN_COLUMN_CONFIDENCE for score in scores)
        < MIN_LONG_VERTICAL_LINES
    ):
        return horizontal("fewer_than_two_readable_vertical_lines", skew, boxes)
    diagnostics: list[str] = []
    if inconsistent:
        if facing is None:
            return unchanged("inconsistent_page_skew", skew)
        diagnostics.append(f"facing_page_skew:{facing[1].degrees:.2f},{facing[2].degrees:.2f}")
    eligible_boxes = [b for b in boxes if not _number_label(regions[b.slot].text)]
    articles = _demote_annotation_bands(_articles(long_boxes, eligible_boxes))
    if not articles:
        return unchanged("no_supported_column_band", skew)
    used = _attach_regions(regions, boxes, articles, diagnostics)
    _attach_ruby(regions, boxes, articles, used, diagnostics)
    for article in articles:
        for body in article.anchors:
            if any(
                other is not article
                and other.bounds.y0 > body.y0 + 2 * article.scale
                and body.y1 > other.bounds.y0 + other.scale
                and other.bounds.x0 - other.scale <= body.cx <= other.bounds.x1 + other.scale
                for other in articles
            ):
                diagnostics.append(f"possible_cross_band_composite:{body.slot}")
    units: list[_Unit] = []
    for article in articles:
        body_order = _body_order(article.body, article.scale)
        positions = {slot: i for i, slot in enumerate(body_order)}
        sorted_ruby = sorted(
            article.ruby, key=lambda pair: (positions[pair[1]], pair[0].y0, pair[0].slot)
        )
        ruby = tuple(box.slot for box, _ in sorted_ruby)
        labels = tuple(b.slot for b in sorted(article.labels, key=lambda b: (b.y0, -b.cx)))
        signatures = _body_order(article.signatures, article.scale)
        bounds = _bounds(
            [*article.body, *article.labels, *article.signatures, *(box for box, _ in article.ruby)]
        )
        public_article = ArticlePlan(
            body_order,
            ruby,
            labels,
            signatures,
            (bounds.x0, bounds.y0, bounds.x1, bounds.y1),
            tuple((box.slot, owner) for box, owner in sorted_ruby),
        )
        units.append(_Unit(bounds, (*labels, *body_order, *signatures, *ruby), public_article))
    units.extend(_Unit(b, (b.slot,)) for b in boxes if b.slot not in used)
    ordered = _order_units(units, median(a.scale for a in articles))
    ordered, front_matter = _front_matter_signature(
        regions, boxes, ordered, median(a.scale for a in articles), diagnostics
    )
    order = tuple(slot for unit in ordered for slot in unit.order)
    if len(order) != len(regions) or set(order) != set(identity):
        raise ValueError("Reading-order plan is not a complete source permutation.")
    article_plans = tuple(u.article for u in ordered if u.article is not None)
    ruby_set = frozenset(slot for article in article_plans for slot in article.ruby)
    pieces: list[str] = []
    for position, slot in enumerate(order):
        if position:
            previous = order[position - 1]
            pieces.append("\n\n" if (slot in ruby_set) != (previous in ruby_set) else "\n")
        pieces.append(regions[slot].text)
    return ReadingPlan(
        order,
        ruby_set,
        "".join(pieces),
        skew,
        True,
        diagnostics=tuple(diagnostics),
        articles=article_plans,
        source_slots=order,
        raw_source_slots=tuple(raw_slots[i] for i in order) if raw_slots else (),
        front_matter_signatures=front_matter,
    )
