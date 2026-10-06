"""Copy the layout and reading-order sources of NDLOCR-Lite into the package.

Usage: vendor_ndlocr_lite.py <checkout of ndl-lab/ndlocr-lite at UPSTREAM_COMMIT>

Every source file is checked against its pinned digest before the listed
edits are applied, so the vendored tree is reproducible from upstream alone.
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
    "LICENCE": "cacf92caf395179042f1080ea0c9be9769f4234a498ce71f931e0f395d90db5b",
    "src/ndl_parser.py": "f9659b141b80a7786fe78e2127903e55de0227f0e43f0e05b6dd1d49e64e63d5",
    "src/reading_order/__init__.py": EMPTY,
    "src/reading_order/order/__init__.py": EMPTY,
    "src/reading_order/order/reorder.py": (
        "f71bf4d2731e00abfc4333c0ae8667c203692aa36977ff3bfd3e8d6d737db279"
    ),
    "src/reading_order/order/smooth_order.py": (
        "ccea13c73d2e951bdadc24da75a9d4d22becb2deed0b2db424dea9d25c638543"
    ),
    "src/reading_order/order/warichu_block.py": (
        "07025fd86f981dc7fb644a8193063e89ecce4ae91e7e78b0f4e9f94507955183"
    ),
    "src/reading_order/utils/__init__.py": EMPTY,
    "src/reading_order/utils/xml.py": (
        "67bdc0c829f54c33b8f6f889c5c3bcea1796ce65859ee202d86bda76d9ddb9ad"
    ),
    "src/reading_order/utils/logger.py": (
        "fe24fa6eb7057cff196d75d3a8f8ef698f69a4f4aa3754831d9d4c5090452e7a"
    ),
    "src/reading_order/utils/time.py": (
        "67f8a2df675f6f5c66d22f78c17be8d0303556918e46d5f4a3b146877f275d34"
    ),
    "src/reading_order/xy_cut/__init__.py": EMPTY,
    "src/reading_order/xy_cut/block_xy_cut.py": (
        "69c8bfc47e6869b0487b5e9fb07529c30e80a041533765b95bdeebcf62b0b03a"
    ),
    "src/reading_order/xy_cut/eval.py": (
        "af5b0074990ae0ea863dd56dec95e55f04bef64224528649777a3fe7a593d151"
    ),
}
# (file, upstream text, replacement, occurrences). Line endings become LF; nothing else changes.
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
        data = (upstream / relative).read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise SystemExit(f"{relative} differs from commit {UPSTREAM_COMMIT}")
        if relative.endswith(".py"):
            text = data.decode("utf-8").replace("\r\n", "\n")
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
