"""Print the module import graph of one Python package as JSON.

Helper for the `python` levels of tools/architecture-graph.ts. Run it in an
environment that has grimp (import-linter) with PYTHONPATH pointing at the
directory that holds the package, for example:

    PYTHONPATH=packages/capture-runtime/src \
      uvx --from import-linter==2.5.2 python tools/architecture_graph_python.py capture_runtime

The output is the module-level graph; the TypeScript side collapses modules to
nodes so the grouping rule stays in one tested place.
"""

import json
import sys

import grimp


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: architecture_graph_python.py <package>")
    package = sys.argv[1]
    # cache_dir=None keeps grimp from writing a .grimp_cache directory.
    graph = grimp.build_graph(package, cache_dir=None)
    modules = sorted(graph.modules)
    edges = [
        [importer, imported]
        for importer in modules
        for imported in sorted(graph.find_modules_directly_imported_by(importer))
    ]
    json.dump({"package": package, "modules": modules, "edges": edges}, sys.stdout)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
