"""Print the capture_runtime module import graph as JSON.

Helper for tools/architecture-graph.ts. Run it in an environment that has
grimp (import-linter) with PYTHONPATH pointing at packages/capture-runtime/src:

    PYTHONPATH=packages/capture-runtime/src \
      uvx --from import-linter==2.5.2 python tools/architecture_graph_runtime.py

The output is the module-level graph; the TypeScript side collapses modules to
their top-level groups so the grouping rule stays in one tested place.
"""

import json
import sys

import grimp

PACKAGE = "capture_runtime"


def main() -> None:
    # cache_dir=None keeps grimp from writing a .grimp_cache directory.
    graph = grimp.build_graph(PACKAGE, cache_dir=None)
    modules = sorted(graph.modules)
    edges = [
        [importer, imported]
        for importer in modules
        for imported in sorted(graph.find_modules_directly_imported_by(importer))
    ]
    json.dump({"package": PACKAGE, "modules": modules, "edges": edges}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
