"""Decide whether a page goes to the whole-page vertical reader.

Standard library only. The decision uses the first pass of the regular
pipeline: the reading-order policy has to treat the page as vertical, and
nearly all recognized characters have to sit in tall boxes. Pages that mix
horizontal questions with a boxed vertical passage stay with the regular
pipeline, which reads their horizontal part better.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol
from uuid import uuid4

# Share of recognized characters in tall boxes at or above which a page is routed.
VERTICAL_SHARE_THRESHOLD = 0.8
# A box is tall when its height is at least this many times its width.
TALL_BOX_ASPECT = 2.0
MIN_TALL_BOXES = 3
# The reader is a Japanese model. A page counts as Japanese when at least this share
# of its characters is kana; vertical Chinese has none and is read better by the
# regular pipeline.
MIN_KANA_SHARE = 0.05
# A first pass this sure of its text (character-weighted mean score) that found no
# kana settles that the page is not Japanese. A less sure one, such as handwriting
# it could not read, leaves the question to the reader's own text.
CONFIDENT_FIRST_PASS = 0.85
_KANA = re.compile(r"[\u3041-\u3096\u30a1-\u30fa]")
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


# A temporary file older than this was left by a worker that died while deriving.
STALE_TEMPORARY_SECONDS = 3600


class VerticalReaderAssetError(RuntimeError):
    """The model directory holds a vertical reader that is incomplete or altered."""


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
    kana_share: float = 0.0
    # Character-weighted mean score of the first pass; None when it reports no scores.
    confidence: float | None = None


@dataclass(frozen=True, slots=True)
class PageRoute:
    """Private record of the routing decision for one page."""

    reader: str  # "regular" or "vertical"
    reason: str
    vertical_share: float
    tall_boxes: int
    first_pass_characters: int
    kana_share: float = 0.0
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
            "confidentFirstPass": CONFIDENT_FIRST_PASS,
            "minimumKanaCharacterShare": MIN_KANA_SHARE,
            "minimumReaderCharacterShare": MIN_READER_CHARACTER_SHARE,
            "minimumTallBoxes": MIN_TALL_BOXES,
            "minimumVerticalCharacterShare": VERTICAL_SHARE_THRESHOLD,
            "tallBoxAspect": TALL_BOX_ASPECT,
        },
        "source": "ndl-lab/ndlocr-lite",
    }


def read_with_identity(path: Path, size: int, digest: str) -> bytes | None:
    """Return a file's bytes when they have the given size and SHA-256, else None.

    The bytes returned are the bytes that were hashed, so a caller that loads a
    model from them cannot be handed a file swapped after the check.
    """

    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size != size:
            return None
        data = path.read_bytes()
    except OSError:
        return None
    if len(data) != size or hashlib.sha256(data).hexdigest() != digest:
        return None
    return data


def read_reader_file(
    directory: Path, name: str, files: Mapping[str, tuple[int, str]] | None = None
) -> bytes:
    size, digest = (VERTICAL_READER_FILES if files is None else files)[name]
    data = read_with_identity(directory / name, size, digest)
    if data is None:
        raise VerticalReaderAssetError(f"Vertical reader file is missing or altered: {name}")
    return data


def verify_vertical_reader_files(
    directory: Path, files: Mapping[str, tuple[int, str]] | None = None
) -> None:
    for name in VERTICAL_READER_FILES if files is None else files:
        read_reader_file(directory, name, files)


def cached_recognizer(
    source: bytes,
    identity: tuple[int, str],
    cache_root: Path | None,
    derive: Callable[[bytes, Path], None],
    *,
    derivable: bool = True,
) -> bytes | None:
    """Return the derived form of a recognizer from the shared cache, deriving it once.

    The cache names entries by SHA-256, as the engine download cache does, and
    only bytes with the pinned size and digest are returned. None means there
    is no usable derived form and the caller loads the upstream bytes. Nothing
    here fails a page: derivation is only a faster start.

    ``derivable`` is false when this ONNX Runtime is not the release the pinned
    digests were made with; then nothing is derived. A machine that derives
    other bytes leaves a marker so that it does not derive on every start.
    """

    if cache_root is None:
        return None
    size, digest = identity
    shard = cache_root / digest[:2]
    entry = shard / digest
    marker = shard / f"{digest}.underivable"
    temporary = shard / f".{digest}.{uuid4().hex}.tmp"
    try:
        # A link in place of the shard directory would take reads and writes elsewhere.
        if shard.exists() and shard.resolve() != cache_root.resolve() / digest[:2]:
            return None
        data = read_with_identity(entry, size, digest)
        if data is not None:
            os.utime(entry)  # keeps the entry from idle eviction
            return data
        if not derivable or marker.is_file():
            return None
        shard.mkdir(parents=True, exist_ok=True)
        cutoff = time.time() - STALE_TEMPORARY_SECONDS
        for stale in shard.glob(f".{digest}.*.tmp"):
            if stale.stat().st_mtime < cutoff:
                stale.unlink(missing_ok=True)
        derive(source, temporary)
        data = read_with_identity(temporary, size, digest)
        if data is None:
            marker.write_bytes(b"")
            return None
        try:
            os.replace(temporary, entry)
        except OSError:
            pass  # another worker holds or has just written the entry; the bytes are good
        return data
    except Exception:  # noqa: BLE001 - any failure to derive means the upstream bytes are used
        return None
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def characters(text: str) -> int:
    """Characters of a text without whitespace, the unit of every count here."""

    return len("".join(text.split()))


def kana_share(texts: Sequence[str]) -> float:
    """Share of kana among the characters of the given texts, whitespace aside."""

    joined = "".join("".join(text.split()) for text in texts)
    return len(_KANA.findall(joined)) / len(joined) if joined else 0.0


def vertical_share(regions: Sequence[_Region]) -> VerticalShare:
    total = tall = boxes = scored = 0
    weighted = 0.0
    for region in regions:
        count = characters(region.text)
        total += count
        score = getattr(region, "confidence", None)
        if score is not None:
            weighted += score * count
            scored += count
        if len(region.polygon) < 3 or count < 2:
            continue
        xs = [point[0] for point in region.polygon]
        ys = [point[1] for point in region.polygon]
        if max(ys) - min(ys) >= TALL_BOX_ASPECT * (max(xs) - min(xs)):
            tall += count
            boxes += 1
    return VerticalShare(
        tall / total if total else 0.0,
        boxes,
        total,
        kana_share([region.text for region in regions]),
        weighted / scored if scored else None,
    )


def route_reason(measure: VerticalShare, *, treated_as_vertical: bool) -> str | None:
    """Return None when the page is routed, else why it stays with the regular pipeline."""

    if not treated_as_vertical:
        return "not_vertical"
    if measure.tall_boxes < MIN_TALL_BOXES:
        return "few_tall_boxes"
    if measure.share < VERTICAL_SHARE_THRESHOLD:
        return "mixed_directions"
    if (
        measure.kana_share < MIN_KANA_SHARE
        and measure.confidence is not None
        and measure.confidence >= CONFIDENT_FIRST_PASS
    ):
        return "no_kana"
    return None


def reader_result_reason(first_pass_characters: int, reader_texts: Sequence[str]) -> str | None:
    """Return None when the second reader's result is kept, else why it is dropped."""

    count = sum(characters(text) for text in reader_texts)
    if count == 0:
        return "reader_returned_no_text"
    if count < MIN_READER_CHARACTER_SHARE * first_pass_characters:
        return "reader_returned_far_less_text"
    if kana_share(reader_texts) < MIN_KANA_SHARE:
        return "reader_text_without_kana"
    return None
