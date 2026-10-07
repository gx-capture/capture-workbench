"""Routing of vertical-dominant pages and the vendored layout code behind the reader."""

from __future__ import annotations

import itertools
import json
from dataclasses import dataclass
from pathlib import Path

import pytest

from capture_runtime._vendor.ndlocr_lite import _digraph
from capture_runtime.ocr_vertical_routing import (
    reader_result_reason,
    route_reason,
    vertical_reader_directory,
    vertical_share,
)

FIXTURE = Path(__file__).parents[1] / "fixtures" / "vertical-ocr" / "vertical-reader-layout.json"


@dataclass(frozen=True)
class Region:
    text: str
    polygon: tuple[tuple[float, float], ...]
    confidence: float | None = None


def box(text: str, x: float, y: float, width: float, height: float) -> Region:
    return Region(text, ((x, y), (x + width, y), (x + width, y + height), (x, y + height)))


def column(text: str, x: float) -> Region:
    return box(text, x, 0, 20, 300)


def test_share_counts_characters_in_tall_boxes() -> None:
    regions = (
        column("縦書きの本文です", 100),
        column("二行目の本文です", 60),
        box("横書きの見出し", 0, 320, 200, 24),
        box("一", 30, 0, 20, 60),  # a single character says nothing about direction
        box("  ", 0, 0, 5, 50),
    )
    measure = vertical_share(regions)
    assert (measure.tall_boxes, measure.characters) == (2, 24)
    assert measure.share == pytest.approx(16 / 24)


def test_share_of_an_empty_page_is_zero() -> None:
    assert vertical_share(()).share == 0.0


@pytest.mark.parametrize(
    ("columns", "horizontal", "treated_as_vertical", "expected"),
    [
        (5, 0, True, None),
        (8, 1, True, None),  # a heading or page number beside the columns
        (5, 4, True, "mixed_directions"),  # a boxed passage among horizontal questions
        (2, 0, True, "few_tall_boxes"),
        (5, 0, False, "not_vertical"),  # sideways scan or chart marks: the policy refused it
    ],
)
def test_only_vertical_dominant_pages_are_routed(
    columns: int, horizontal: int, treated_as_vertical: bool, expected: str | None
) -> None:
    regions = [column("縦書きの本文です", 40 * index) for index in range(columns)]
    regions += [
        box("横書きの設問文です", 0, 320 + 30 * index, 220, 24) for index in range(horizontal)
    ]
    reason = route_reason(vertical_share(regions), treated_as_vertical=treated_as_vertical)
    assert reason == expected


@pytest.mark.parametrize(
    ("text", "confidence", "expected"),
    [
        ("縦書きの本文です", 0.99, None),
        ("本件原告主張被告未依約給付", 0.99, "no_kana"),  # vertical Chinese, read with confidence
        ("本件原告主張被告未依約給付", 0.86, "no_kana"),
        ("本件原告主張被告未依約給付", 0.84, None),  # unsure: the reader's text decides
        ("本件原告主張被告未依約給付", None, None),  # no scores: the reader's text decides
        ("本件原告主張被告未依約給付ノ件", 0.99, None),  # kana among kanji
    ],
)
def test_a_confidently_read_page_without_kana_is_not_routed(
    text: str, confidence: float | None, expected: str | None
) -> None:
    regions = [
        Region(text, ((40 * i, 0), (40 * i + 20, 0), (40 * i + 20, 300), (40 * i, 300)), confidence)
        for i in range(5)
    ]
    measure = vertical_share(regions)
    assert route_reason(measure, treated_as_vertical=True) == expected
    assert measure.confidence == (None if confidence is None else pytest.approx(confidence))


def test_kana_share_ignores_whitespace_and_counts_both_syllabaries() -> None:
    from capture_runtime.ocr_vertical_routing import kana_share

    assert kana_share(["あ ア\n", "漢 字"]) == pytest.approx(0.5)
    assert kana_share(["", "  "]) == 0.0
    assert kana_share(["ー、。"]) == 0.0  # the long-vowel mark and punctuation are not kana


@pytest.mark.parametrize(
    ("first_pass", "texts", "expected"),
    [
        (100, ["あ" * 60, "い" * 60], None),
        (100, ["あ" * 50], None),
        (100, ["あ" * 49], "reader_returned_far_less_text"),
        (100, [], "reader_returned_no_text"),
        (100, ["漢" * 80], "reader_text_without_kana"),
        (100, ["漢" * 95 + "あ" * 5], None),
        (100, ["漢" * 96 + "あ" * 4], "reader_text_without_kana"),
        (100, [" ", "\n"], "reader_returned_no_text"),
    ],
)
def test_a_reader_result_far_shorter_than_the_first_pass_is_dropped(
    first_pass: int, texts: list[str], expected: str | None
) -> None:
    assert reader_result_reason(first_pass, texts) == expected


def test_reader_directory_is_optional(tmp_path: Path) -> None:
    assert vertical_reader_directory(tmp_path) is None
    (tmp_path / "vertical").mkdir()
    assert vertical_reader_directory(tmp_path) == tmp_path / "vertical"


def _graph(nodes: int, edges: list[tuple[int, int]]) -> _digraph.DiGraph:
    graph = _digraph.DiGraph()
    for node in range(nodes):
        graph.add_node(node)
    for source, target in edges:
        graph.add_edge(source, target, weight=1.0)
    return graph


@pytest.mark.parametrize("nodes", [2, 3, 5, 7])
@pytest.mark.parametrize("reach", [1, 2, 3])
def test_simple_paths_are_complete_and_depth_first(nodes: int, reach: int) -> None:
    # The graph smooth_order builds: each node linked both ways to its next neighbours.
    edges = [
        pair
        for step in range(1, reach + 1)
        for index in range(nodes - step)
        for pair in ((index, index + step), (index + step, index))
    ]
    graph = _graph(nodes, edges)
    allowed = set(edges)
    inner = range(1, nodes - 1)
    expected = {
        (0, *middle, nodes - 1)
        for size in range(nodes - 1)
        for middle in itertools.permutations(inner, size)
        if all(pair in allowed for pair in itertools.pairwise((0, *middle, nodes - 1)))
    }
    paths = [tuple(path) for path in _digraph.all_simple_paths(graph, 0, nodes - 1)]
    assert len(paths) == len(set(paths))
    assert set(paths) == expected
    # Depth first with neighbours in insertion order is lexicographic in neighbour rank.
    rank = {
        node: {target: position for position, target in enumerate(graph[node])}
        for node in graph.nodes()
    }
    keys = [[rank[a][b] for a, b in itertools.pairwise(path)] for path in paths]
    assert keys == sorted(keys)


def test_path_from_a_node_to_itself_is_the_node_alone() -> None:
    # As in networkx: smooth_order relies on it to rewrite a block that has one element.
    graph = _graph(2, [(0, 1), (1, 0)])
    assert list(_digraph.all_simple_paths(graph, 1, 1)) == [[1]]
    with pytest.raises(ValueError, match="nodes of the graph"):
        list(_digraph.all_simple_paths(graph, 0, 4))


LAYOUT = json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", LAYOUT["cases"], ids=[case["id"] for case in LAYOUT["cases"]])
def test_line_order_equals_upstream_for_recorded_detections(case: dict) -> None:
    np = pytest.importorskip("numpy", reason="The vertical reader requires the WindowsML extras.")
    from capture_runtime.ocr_vertical_reader import _ordered_layout

    detections = [
        {
            "class_index": item["classIndex"],
            "confidence": np.float32(item["confidence"]),
            "box": np.array(item["box"], dtype=np.int32),
            "pred_char_count": np.float32(item["predictedCount"]),
        }
        for item in case["detections"]
    ]
    root = _ordered_layout(case["width"], case["height"], LAYOUT["classes"], detections)
    lines = [
        [int(element.get(name, "")) for name in ("X", "Y", "WIDTH", "HEIGHT")]
        for element in root.findall(".//LINE")
    ]
    assert lines == case["lines"]


def test_reader_files_are_accepted_only_with_their_pinned_bytes(tmp_path: Path) -> None:
    import hashlib

    from capture_runtime.ocr_vertical_routing import (
        VerticalReaderAssetError,
        read_reader_file,
        verify_vertical_reader_files,
    )

    files = {"model.onnx": (5, hashlib.sha256(b"model").hexdigest())}
    with pytest.raises(VerticalReaderAssetError, match="missing or altered: model.onnx"):
        verify_vertical_reader_files(tmp_path, files)
    with pytest.raises(VerticalReaderAssetError, match="deim-s-1024x1024.onnx"):
        verify_vertical_reader_files(tmp_path)
    (tmp_path / "model.onnx").write_bytes(b"model")
    assert read_reader_file(tmp_path, "model.onnx", files) == b"model"
    for altered in (b"mode", b"madel"):
        (tmp_path / "model.onnx").write_bytes(altered)
        with pytest.raises(VerticalReaderAssetError):
            read_reader_file(tmp_path, "model.onnx", files)


def _identity(data: bytes) -> tuple[int, str]:
    import hashlib

    return len(data), hashlib.sha256(data).hexdigest()


def test_recognizer_is_derived_once_and_then_served_from_the_cache(tmp_path: Path) -> None:
    from capture_runtime.ocr_vertical_routing import cached_recognizer

    identity = _identity(b"derived")
    calls: list[bytes] = []

    def derive(source: bytes, target: Path) -> None:
        calls.append(source)
        target.write_bytes(b"derived")

    cache = tmp_path / "cache"
    first = cached_recognizer(b"upstream", identity, cache, derive)
    second = cached_recognizer(b"upstream", identity, cache, derive)

    assert first == second == b"derived"
    assert calls == [b"upstream"]
    shard = cache / identity[1][:2]
    assert [path.name for path in shard.iterdir()] == [identity[1]]


@pytest.mark.parametrize("written", [b"other bytes", b"derive!"])
def test_machine_that_derives_other_bytes_does_not_derive_again(
    tmp_path: Path, written: bytes
) -> None:
    from capture_runtime.ocr_vertical_routing import cached_recognizer

    identity = _identity(b"derived")
    calls: list[int] = []

    def derive(_source: bytes, target: Path) -> None:
        calls.append(1)
        target.write_bytes(written)

    cache = tmp_path / "cache"
    assert cached_recognizer(b"upstream", identity, cache, derive) is None
    assert cached_recognizer(b"upstream", identity, cache, derive) is None
    assert calls == [1]
    left = [path.name for path in cache.rglob("*") if path.is_file()]
    assert left == [f"{identity[1]}.underivable"]


def test_failed_derivation_is_tried_again_and_leaves_nothing(tmp_path: Path) -> None:
    from capture_runtime.ocr_vertical_routing import cached_recognizer

    identity = _identity(b"derived")
    calls: list[int] = []

    def derive(_source: bytes, target: Path) -> None:
        calls.append(1)
        if len(calls) == 1:
            target.write_bytes(b"partial")
            raise RuntimeError("optimization failed")
        target.write_bytes(b"derived")

    cache = tmp_path / "cache"
    assert cached_recognizer(b"upstream", identity, cache, derive) is None
    assert [path for path in cache.rglob("*") if path.is_file()] == []
    assert cached_recognizer(b"upstream", identity, cache, derive) == b"derived"


def test_nothing_is_derived_with_another_onnxruntime_release_or_without_a_cache(
    tmp_path: Path,
) -> None:
    from capture_runtime.ocr_vertical_routing import cached_recognizer

    def derive(_source: bytes, _target: Path) -> None:
        raise AssertionError("must not derive")

    identity = _identity(b"derived")
    assert cached_recognizer(b"upstream", identity, None, derive) is None
    assert cached_recognizer(b"upstream", identity, tmp_path, derive, derivable=False) is None
    # An entry already in the cache is still served: its bytes are the pinned ones.
    entry = tmp_path / identity[1][:2] / identity[1]
    entry.parent.mkdir()
    entry.write_bytes(b"derived")
    assert cached_recognizer(b"upstream", identity, tmp_path, derive, derivable=False) == b"derived"


def test_altered_cache_entry_is_replaced_and_its_bytes_are_never_returned(tmp_path: Path) -> None:
    from capture_runtime.ocr_vertical_routing import cached_recognizer

    identity = _identity(b"derived")
    entry = tmp_path / "cache" / identity[1][:2] / identity[1]
    entry.parent.mkdir(parents=True)
    entry.write_bytes(b"altered")

    def derive(_source: bytes, target: Path) -> None:
        target.write_bytes(b"derived")

    assert cached_recognizer(b"upstream", identity, tmp_path / "cache", derive) == b"derived"
    assert entry.read_bytes() == b"derived"


def test_stale_temporary_files_of_a_killed_worker_are_removed(tmp_path: Path) -> None:
    import os
    import time

    from capture_runtime.ocr_vertical_routing import STALE_TEMPORARY_SECONDS, cached_recognizer

    identity = _identity(b"derived")
    shard = tmp_path / identity[1][:2]
    shard.mkdir()
    stale = shard / f".{identity[1]}.dead.tmp"
    fresh = shard / f".{identity[1]}.live.tmp"
    stale.write_bytes(b"x")
    fresh.write_bytes(b"x")
    old = time.time() - STALE_TEMPORARY_SECONDS - 60
    os.utime(stale, (old, old))

    def derive(_source: bytes, target: Path) -> None:
        target.write_bytes(b"derived")

    assert cached_recognizer(b"upstream", identity, tmp_path, derive) == b"derived"
    assert not stale.exists()
    assert fresh.exists()  # another worker may still be writing it


class _Image:
    """Stands in for a crop array: only its shape and column slicing are used."""

    def __init__(self, height: int, width: int, label: str) -> None:
        self.shape = (height, width, 3)
        self.label = label

    def __getitem__(self, key: object) -> _Image:
        columns = key[1]  # type: ignore[index]
        half = "L" if columns.start is None else "R"
        return _Image(self.shape[0], self.shape[1] // 2, self.label + half)


class _Recognizer:
    def __init__(self, name: str, answers: dict[str, tuple[str, float]]) -> None:
        self.name = name
        self.answers = answers
        self.seen: list[str] = []

    def read(self, image: _Image) -> tuple[str, float]:
        self.seen.append(image.label)
        return self.answers.get(image.label, (f"{self.name}:{image.label}", 0.5))


def test_cascade_sends_overflowing_lines_to_the_next_longer_recognizer() -> None:
    pytest.importorskip("capture_runtime.ocr_vertical_reader")
    from capture_runtime.ocr_vertical_reader import _Crop, _read_cascade

    short = _Recognizer("short", {"a": ("あ" * 24, 0.9), "b": ("い" * 25, 0.9)})
    middle = _Recognizer("middle", {"b": ("い" * 44, 0.8), "c": ("う" * 45, 0.8)})
    long = _Recognizer("long", {"c": ("う" * 60, 0.7), "d": ("え" * 97, 0.6)})
    crops = [
        _Crop(_Image(200, 20, "c"), 0, 2.0),
        _Crop(_Image(200, 20, "a"), 1, 3.0),
        _Crop(_Image(200, 20, "d"), 2, 100.0),
        _Crop(_Image(200, 20, "b"), 3, 3.0),
    ]

    read = _read_cascade(crops, short, middle, long, workers=1)  # type: ignore[arg-type]

    assert [crop.index for crop in read] == [0, 1, 2, 3]
    assert [(crop.text, crop.score) for crop in read] == [
        ("う" * 60, 0.7),  # 45 characters from the middle recognizer overflow to the long one
        ("あ" * 24, 0.9),  # 24 characters stay with the short recognizer
        ("え" * 97, 0.6),
        ("い" * 44, 0.8),  # 25 characters overflow to the middle recognizer
    ]
    assert (short.seen, middle.seen, sorted(long.seen)) == (["a", "b"], ["c", "b"], ["c", "d"])


def test_cascade_reads_a_very_long_horizontal_line_in_two_halves() -> None:
    pytest.importorskip("capture_runtime.ocr_vertical_reader")
    from capture_runtime.ocr_vertical_reader import _Crop, _read_cascade

    long = _Recognizer(
        "long",
        {
            "wide": ("あ" * 98, 0.5),
            "wideL": ("左" * 30, 0.9),
            "wideR": ("右" * 10, 0.5),
            "tall": ("縦" * 98, 0.4),
        },
    )
    unused = _Recognizer("unused", {})
    crops = [_Crop(_Image(20, 400, "wide"), 0, 100.0), _Crop(_Image(400, 20, "tall"), 1, 100.0)]

    read = _read_cascade(crops, unused, unused, long, workers=1)  # type: ignore[arg-type]

    assert read[0].text == "左" * 30 + "右" * 10
    assert read[0].score == pytest.approx((0.9 * 30 + 0.5 * 10) / 40)
    assert (read[1].text, read[1].score) == ("縦" * 98, 0.4)  # a tall line is not halved
    assert unused.seen == []


class _StubDetector:
    classes = ["text_block", "line_main"]

    def __init__(self, detections: list[dict[str, object]]) -> None:
        self._detections = detections

    def detect(self, _image: object) -> list[dict[str, object]]:
        return self._detections


def _reader_with(detections: list[dict[str, object]], recognizer: object) -> object:
    from capture_runtime.ocr_vertical_reader import VerticalPageReader

    reader = object.__new__(VerticalPageReader)
    reader._detector = _StubDetector(detections)
    reader._short = reader._middle = reader._long = recognizer
    reader._workers = 1
    return reader


def test_reader_returns_ordered_lines_clipped_to_the_raster(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    np = pytest.importorskip("numpy", reason="The vertical reader requires the WindowsML extras.")
    import xml.etree.ElementTree as ET

    import capture_runtime.ocr_vertical_reader as module

    def layout(width: int, height: int, _classes: object, detections: object) -> ET.Element:
        assert (width, height, len(detections)) == (100, 200, 1)  # type: ignore[arg-type]
        root = ET.Element("OCRDATASET")
        page = ET.SubElement(root, "PAGE")
        for x, y, w, h, count in ((70, 10, 40, 150, "100.000"), (-5, 190, 30, 30, "3.000")):
            ET.SubElement(
                page,
                "LINE",
                {
                    "TYPE": "本文",
                    "X": str(x),
                    "Y": str(y),
                    "WIDTH": str(w),
                    "HEIGHT": str(h),
                    "PRED_CHAR_CNT": count,
                },
            )
        return root

    class Echo:
        def read(self, image: object) -> tuple[str, float]:
            return f"{image.shape[1]}x{image.shape[0]}", 0.75  # type: ignore[attr-defined]

    monkeypatch.setattr(module, "_ordered_layout", layout)
    reader = _reader_with([{"box": (0, 0, 1, 1)}], Echo())

    lines = reader.read_array(np.zeros((200, 100, 3), dtype=np.uint8))  # type: ignore[attr-defined]

    assert [line.polygon for line in lines] == [
        ((70.0, 10.0), (100.0, 10.0), (100.0, 160.0), (70.0, 160.0)),
        ((0.0, 190.0), (25.0, 190.0), (25.0, 200.0), (0.0, 200.0)),
    ]
    assert [(line.text, line.confidence, line.kind) for line in lines] == [
        ("30x150", 0.75, "本文"),
        ("25x10", 0.75, "本文"),
    ]


def test_reader_reports_a_layout_failure_as_such(monkeypatch: pytest.MonkeyPatch) -> None:
    np = pytest.importorskip("numpy", reason="The vertical reader requires the WindowsML extras.")
    import capture_runtime.ocr_vertical_reader as module
    from capture_runtime.ocr_vertical_routing import VerticalLayoutError

    def broken(*_arguments: object) -> object:
        raise ZeroDivisionError("float division by zero")

    monkeypatch.setattr(module, "_ordered_layout", broken)
    reader = _reader_with([], object())

    with pytest.raises(VerticalLayoutError, match="ZeroDivisionError"):
        reader.read_array(np.zeros((10, 10, 3), dtype=np.uint8))  # type: ignore[attr-defined]


def test_lines_are_built_from_detections_when_the_layout_groups_none() -> None:
    np = pytest.importorskip("numpy", reason="The vertical reader requires the WindowsML extras.")
    from capture_runtime.ocr_vertical_reader import _ordered_layout

    # One box of a class the layout does not turn into a line, and one empty box.
    detections = [
        {
            "class_index": 6,
            "confidence": np.float32(0.9),
            "box": np.array([10, 20, 40, 220]),
            "pred_char_count": np.float32(100.0),
        },
        {
            "class_index": 6,
            "confidence": np.float32(0.9),
            "box": np.array([50, 20, 50, 220]),
            "pred_char_count": np.float32(100.0),
        },
    ]
    classes = [
        "text_block",
        "line_main",
        "line_caption",
        "line_ad",
        "line_note",
        "line_note_tochu",
        "block_fig",
        "block_ad",
        "block_pillar",
        "block_folio",
        "block_rubi",
        "block_chart",
        "block_eqn",
        "block_cfm",
        "block_eng",
        "block_table",
        "line_title",
    ]
    root = _ordered_layout(400, 400, classes, detections)
    lines = [
        tuple(int(element.get(name, "")) for name in ("X", "Y", "WIDTH", "HEIGHT"))
        for element in root.findall(".//LINE")
    ]
    assert lines == [(10, 20, 30, 200)]


def test_engine_cache_location_reaches_child_processes() -> None:
    from capture_runtime.config import sanitized_child_environment

    environment = {"CAPTURE_ENGINE_CACHE_DIR": "off", "CAPTURE_WINDOWSML_MODEL_DIR": "elsewhere"}
    assert sanitized_child_environment(environment) == {"CAPTURE_ENGINE_CACHE_DIR": "off"}


@pytest.mark.parametrize("change", ["threshold", "digest", "missing"])
def test_profile_whose_vertical_reader_differs_from_the_runtime_is_refused(
    tmp_path: Path, change: str
) -> None:
    from capture_runtime.ocr_profile import (
        CANONICAL_PROFILE_PATH,
        EngineRuntimeUnavailableError,
        canonical_json_bytes,
        load_profile_spec,
    )

    document = json.loads(CANONICAL_PROFILE_PATH.read_text(encoding="utf-8"))
    if change == "threshold":
        document["verticalReader"]["routing"]["minimumVerticalCharacterShare"] = 0.5
    elif change == "digest":
        document["verticalReader"]["artifacts"][0]["sha256"] = "0" * 64
    else:
        del document["verticalReader"]
    path = tmp_path / "ocr-profile.json"
    path.write_bytes(canonical_json_bytes(document))

    with pytest.raises(EngineRuntimeUnavailableError, match="vertical reader|fields drifted"):
        load_profile_spec(path)
    assert load_profile_spec().document["verticalReader"]["routing"] == {
        "confidentFirstPass": 0.85,
        "minimumKanaCharacterShare": 0.05,
        "minimumReaderCharacterShare": 0.5,
        "minimumTallBoxes": 3,
        "minimumVerticalCharacterShare": 0.8,
        "tallBoxAspect": 2.0,
    }
