"""Decide whether a page goes to the whole-page vertical reader.

Standard library only. The decision uses the first pass of the regular
pipeline: the reading-order policy has to treat the page as vertical, and
nearly all recognized characters have to sit in tall boxes. Pages that mix
horizontal questions with a boxed vertical passage stay with the regular
pipeline, which reads their horizontal part better.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

# Share of recognized characters in tall boxes at or above which a page is routed.
VERTICAL_SHARE_THRESHOLD = 0.8
# A box is tall when its height is at least this many times its width.
TALL_BOX_ASPECT = 2.0
MIN_TALL_BOXES = 3
# The second reader's result is kept only if it has at least this share of the
# first pass's characters; a far shorter result means it missed the page.
MIN_READER_CHARACTER_SHARE = 0.5
# The reader's files sit beside the regular OCR models when the engine ships them.
MODEL_SUBDIRECTORY = "vertical"


class VerticalLayoutError(RuntimeError):
    """The reader could not lay out or order the lines it detected on a page."""


class _Region(Protocol):
    @property
    def text(self) -> str: ...

    @property
    def polygon(self) -> tuple[tuple[float, float], ...]: ...


@dataclass(frozen=True, slots=True)
class VerticalShare:
    share: float
    tall_boxes: int
    characters: int


@dataclass(frozen=True, slots=True)
class PageRoute:
    """Private record of the routing decision for one page."""

    reader: str  # "regular" or "vertical"
    reason: str
    vertical_share: float
    tall_boxes: int
    first_pass_characters: int
    reader_characters: int | None = None
    reader_lines: int | None = None
    # Where the reader's recognizers ran; its line detector always runs on the CPU.
    recognizer_device: str | None = None


def vertical_reader_directory(model_dir: Path) -> Path | None:
    """Return the reader's model directory, or None when the engine ships without it."""

    directory = model_dir / MODEL_SUBDIRECTORY
    return directory if directory.is_dir() else None


def _characters(text: str) -> int:
    return len("".join(text.split()))


def vertical_share(regions: Sequence[_Region]) -> VerticalShare:
    total = tall = boxes = 0
    for region in regions:
        count = _characters(region.text)
        total += count
        if len(region.polygon) < 3 or count < 2:
            continue
        xs = [point[0] for point in region.polygon]
        ys = [point[1] for point in region.polygon]
        if max(ys) - min(ys) >= TALL_BOX_ASPECT * (max(xs) - min(xs)):
            tall += count
            boxes += 1
    return VerticalShare(tall / total if total else 0.0, boxes, total)


def route_reason(measure: VerticalShare, *, treated_as_vertical: bool) -> str | None:
    """Return None when the page is routed, else why it stays with the regular pipeline."""

    if not treated_as_vertical:
        return "not_vertical"
    if measure.tall_boxes < MIN_TALL_BOXES:
        return "few_tall_boxes"
    if measure.share < VERTICAL_SHARE_THRESHOLD:
        return "mixed_directions"
    return None


def reader_result_reason(first_pass_characters: int, reader_texts: Sequence[str]) -> str | None:
    """Return None when the second reader's result is kept, else why it is dropped."""

    characters = sum(_characters(text) for text in reader_texts)
    if characters == 0:
        return "reader_returned_no_text"
    if characters < MIN_READER_CHARACTER_SHARE * first_pass_characters:
        return "reader_returned_far_less_text"
    return None
