"""The two networkx calls used by reading_order/order/smooth_order.py.

Not part of NDLOCR-Lite. Paths are produced in the order of
networkx.all_simple_paths (depth first, neighbours in insertion order), because
smooth_order keeps the first path of minimum weight.
"""

from __future__ import annotations

from collections.abc import Iterator


class DiGraph:
    def __init__(self) -> None:
        self._successors: dict[int, dict[int, dict[str, float]]] = {}

    def add_node(self, node: int) -> None:
        self._successors.setdefault(node, {})

    def add_edge(self, source: int, target: int, *, weight: float) -> None:
        self.add_node(source)
        self.add_node(target)
        self._successors[source][target] = {"weight": weight}

    def nodes(self) -> list[int]:
        return list(self._successors)

    def number_of_nodes(self) -> int:
        return len(self._successors)

    def __getitem__(self, node: int) -> dict[int, dict[str, float]]:
        return self._successors[node]


def all_simple_paths(graph: DiGraph, source: int, target: int) -> Iterator[list[int]]:
    if source not in graph.nodes() or target not in graph.nodes():
        raise ValueError("source and target must be nodes of the graph")
    if source == target:
        # networkx yields the trivial path, so a block with one element is still rewritten.
        yield [source]
        return
    path = [source]
    on_path = {source}
    stack = [iter(graph[source])]
    while stack:
        child = next(stack[-1], None)
        if child is None:
            stack.pop()
            on_path.discard(path.pop())
        elif child in on_path:
            continue
        elif child == target:
            yield [*path, child]
        else:
            path.append(child)
            on_path.add(child)
            stack.append(iter(graph[child]))
