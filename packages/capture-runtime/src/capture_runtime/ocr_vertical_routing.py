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


DETECTOR = "deim-s-1024x1024.onnx"
RECOGNIZER_30 = "parseq-ndl-24x256-30-tiny-189epoch-tegaki3-r8data-202604.onnx"
RECOGNIZER_50 = "parseq-ndl-24x384-50-tiny-300epoch-tegaki3-r8data-202604.onnx"
RECOGNIZER_100 = "parseq-ndl-24x768-100-tiny-153epoch-tegaki3-r8data-202604.onnx"
CLASSES = "ndl.yaml"
CHARSET = "NDLmoji.yaml"
UPSTREAM_COMMIT = "636d1cfeb1331f89f4048f416e49e23a09a714b5"
# The ONNX Runtime release whose extended optimization gives the pinned derived files.
DERIVATION_ONNXRUNTIME = "1.24.4"
# name -> (bytes, sha256) of upstream's files at UPSTREAM_COMMIT, as the engine delivers them.
VERTICAL_READER_FILES: dict[str, tuple[int, str]] = {
    DETECTOR: (40256763, "c156ce0c4e704bc3bf7e4016d0a87b949cffa8b3724f4b4cc696b8284c3c7373"),
    RECOGNIZER_30: (
        36457393,
        "9e651bae4c1a4d5254da1127e86e82e21ef62d5339b37e62d4a3d3d30831772d",
    ),
    RECOGNIZER_50: (
        37808553,
        "49cea9db4552f19eb05c8ee202fcf74714977749b2f4c9376b127fde41b07a99",
    ),
    RECOGNIZER_100: (
        42588187,
        "06462b0dbd5b0b8508545c8c3d485cf20dbf4ffa652fe145e69c9e7457080602",
    ),
    CLASSES: (299, "0c2a6a184dd322375b76f2ce3842f8ac555d53edad0ab63655c013f4c471c5a0"),
    CHARSET: (42434, "f6ad5a2de444b495155866af811cf1a98309dcae3225db802767ea531a2dc529"),
}
# name -> (bytes, sha256) of each recognizer after derivation. Only these bytes are
# accepted from the cache.
DERIVED_RECOGNIZER_FILES: dict[str, tuple[int, str]] = {
    RECOGNIZER_30: (
        35793563,
        "5730246a2b34af0f468a3ff425ac9ce379a4b3d7971574be0c4c7705f0e2da83",
    ),
    RECOGNIZER_50: (
        36841180,
        "1fb8f416d3055fc25cd21623343b3d1dbcf92e57e64feafe1fac53aef81661fc",
    ),
    RECOGNIZER_100: (
        40857625,
        "8ee4578450853d5ea02e55b8aa20f052bca528b59ca7727e61d5f027a4cf7104",
    ),
}


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
    # How many of the three recognizers were loaded in derived form from the cache.
    derived_recognizers: int | None = None


def vertical_reader_directory(model_dir: Path) -> Path | None:
    """Return the reader's model directory, or None when the engine ships without it."""

    directory = model_dir / MODEL_SUBDIRECTORY
    return directory if directory.is_dir() else None


def vertical_reader_declaration() -> dict[str, object]:
    """The reader as the OCR profile declares it; the profile must equal this."""

    return {
        "artifacts": [
            {"bytes": size, "path": f"{MODEL_SUBDIRECTORY}/{name}", "sha256": digest}
            for name, (size, digest) in sorted(VERTICAL_READER_FILES.items())
        ],
        "derivedRecognizers": {
            "artifacts": [
                {"bytes": size, "sha256": digest, "source": f"{MODEL_SUBDIRECTORY}/{name}"}
                for name, (size, digest) in sorted(DERIVED_RECOGNIZER_FILES.items())
            ],
            "level": "extended",
            "onnxruntime": DERIVATION_ONNXRUNTIME,
            "provider": "CPUExecutionProvider",
            "storage": "engine-cache",
        },
        "detectorDevice": "cpu",
        "license": "CC-BY-4.0",
        "modelDir": MODEL_SUBDIRECTORY,
        "recognizerDevice": "regular-pipeline-device",
        "revision": UPSTREAM_COMMIT,
        "routing": {
            "minimumReaderCharacterShare": MIN_READER_CHARACTER_SHARE,
            "minimumTallBoxes": MIN_TALL_BOXES,
            "minimumVerticalCharacterShare": VERTICAL_SHARE_THRESHOLD,
            "tallBoxAspect": TALL_BOX_ASPECT,
        },
        "source": "ndl-lab/ndlocr-lite",
    }


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
