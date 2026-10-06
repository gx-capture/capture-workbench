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
    ("first_pass", "texts", "expected"),
    [
        (100, ["あ" * 60, "い" * 60], None),
        (100, ["あ" * 50], None),
        (100, ["あ" * 49], "reader_returned_far_less_text"),
        (100, [], "reader_returned_no_text"),
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


def test_reader_refuses_an_incomplete_model_directory(tmp_path: Path) -> None:
    pytest.importorskip("numpy", reason="The vertical reader requires the WindowsML extras.")
    import hashlib

    from capture_runtime.ocr_vertical_reader import (
        VerticalPageReader,
        VerticalReaderAssetError,
        verify_vertical_reader_files,
    )

    with pytest.raises(VerticalReaderAssetError, match="missing or resized"):
        VerticalPageReader(tmp_path)
    files = {"model.onnx": (5, hashlib.sha256(b"model").hexdigest())}
    (tmp_path / "model.onnx").write_bytes(b"model")
    verify_vertical_reader_files(tmp_path, files)
    (tmp_path / "model.onnx").write_bytes(b"mode")
    with pytest.raises(VerticalReaderAssetError, match="missing or resized"):
        verify_vertical_reader_files(tmp_path, files)
    (tmp_path / "model.onnx").write_bytes(b"madel")
    with pytest.raises(VerticalReaderAssetError, match="digest differs"):
        verify_vertical_reader_files(tmp_path, files)
