"""Copy the layout and reading-order sources of NDLOCR-Lite into the package.

Usage: vendor_ndlocr_lite.py <checkout of ndl-lab/ndlocr-lite at UPSTREAM_COMMIT>

Every source file is checked against the digest of its upstream bytes before
the listed edits are applied, so the vendored tree is reproducible from upstream alone.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

UPSTREAM_REPOSITORY = "https://github.com/ndl-lab/ndlocr-lite"
UPSTREAM_COMMIT = "636d1cfeb1331f89f4048f416e49e23a09a714b5"
PACKAGE = "capture_runtime._vendor.ndlocr_lite"
TARGET = Path(__file__).resolve().parents[1] / "src" / "capture_runtime" / "_vendor" / "ndlocr_lite"
EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
SOURCES = {
    "LICENCE": "12538e73c4a1e05fc0c0b75d9d4de657f139d94ebc5f44b03a84cc1f793358f0",
    "src/ndl_parser.py": "abe329084b3bc11bf57f330ffe057a610f672a3dd6f691e631f3339098a10997",
    "src/reading_order/__init__.py": EMPTY,
    "src/reading_order/order/__init__.py": EMPTY,
    "src/reading_order/order/reorder.py": (
        "10f70501a54d1b84a0c87668aa80ac91eaf0b9c139393823578170617816ab5e"
    ),
    "src/reading_order/order/smooth_order.py": (
        "e65da8b03e989d850c1dfaa391c6b5bd158de5c8a3caddfa4ba59ef86b1feab3"
    ),
    "src/reading_order/order/warichu_block.py": (
        "50a31488e86c338078b366c0d506584949fbbbb7970e0cc2cb58069c883a3012"
    ),
    "src/reading_order/utils/__init__.py": EMPTY,
    "src/reading_order/utils/xml.py": (
        "4f2660326e3d3f20aa8ea94544ade6d6041ec11731fb5feca6c66e8289bb9efa"
    ),
    "src/reading_order/utils/logger.py": (
        "b4b18f9d7a3a7cc84ee34568622c30d721d418d571129430b5ecd2a7a6d9aee0"
    ),
    "src/reading_order/utils/time.py": (
        "38936d312df9298d82196eaefd54c67fd1cfa68fdb51421669bc99bd211d6eeb"
    ),
    "src/reading_order/xy_cut/__init__.py": EMPTY,
    "src/reading_order/xy_cut/block_xy_cut.py": (
        "5c5790d0a85beff5c1a1246e0369daa9a15a12f50e312f1e9b0e332d74b34f94"
    ),
    "src/reading_order/xy_cut/eval.py": (
        "c424b8954ef844b44bb0067487b15d29c841abbec8aaa14a3adf41d2dc09fa60"
    ),
}
# (file, upstream text, replacement, occurrences). Nothing else changes.
EDITS = (
    # Unused by the functions the runtime calls; neither package is a runtime dependency.
    ("src/ndl_parser.py", "from lxml import etree as ET\nfrom tqdm import tqdm\n", "", 1),
    # networkx is not a runtime dependency; _digraph.py provides the two calls used.
    (
        "src/reading_order/order/smooth_order.py",
        "import networkx as nx\n",
        f"from {PACKAGE} import _digraph as nx\n",
        1,
    ),
)
ABSOLUTE_IMPORT = ("from reading_order.", f"from {PACKAGE}.reading_order.")


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    upstream = Path(sys.argv[1])
    for relative, digest in SOURCES.items():
        # Upstream stores LF; a checkout with autocrlf must not change the identity.
        data = (upstream / relative).read_bytes().replace(b"\r\n", b"\n")
        if hashlib.sha256(data).hexdigest() != digest:
            raise SystemExit(f"{relative} differs from commit {UPSTREAM_COMMIT}")
        if relative.endswith(".py"):
            text = data.decode("utf-8")
            for name, old, new, count in EDITS:
                if name == relative:
                    if text.count(old) != count:
                        raise SystemExit(f"{relative}: expected {count} of {old!r}")
                    text = text.replace(old, new)
            text = text.replace(*ABSOLUTE_IMPORT)
            data = text.encode("utf-8")
        target = TARGET / relative.removeprefix("src/")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(target.relative_to(TARGET).as_posix())


if __name__ == "__main__":
    main()
