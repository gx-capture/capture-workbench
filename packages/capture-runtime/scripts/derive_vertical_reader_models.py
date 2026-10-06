"""Derive the vertical reader's recognizers as the runtime does, and check the pinned digests.

Usage: derive_vertical_reader_models.py <upstream src/model directory> <output directory>

The runtime derives these files itself on each machine and accepts a derived
file only with the digests pinned in ``ocr_vertical_reader.py``. This script
reproduces them from upstream's files, to re-pin the digests when upstream's
models or the ONNX Runtime release change.
"""

from __future__ import annotations

import sys
from pathlib import Path

import onnxruntime

from capture_runtime.ocr_vertical_reader import (
    DERIVATION_ONNXRUNTIME,
    DERIVED_RECOGNIZER_FILES,
    VERTICAL_READER_FILES,
    derive_recognizer,
    verify_vertical_reader_files,
)


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    if onnxruntime.__version__ != DERIVATION_ONNXRUNTIME:
        raise SystemExit(
            f"ONNX Runtime {DERIVATION_ONNXRUNTIME} is required, found {onnxruntime.__version__}"
        )
    upstream, output = Path(sys.argv[1]), Path(sys.argv[2])
    verify_vertical_reader_files(
        upstream, {name: VERTICAL_READER_FILES[name] for name in DERIVED_RECOGNIZER_FILES}
    )
    output.mkdir(parents=True, exist_ok=True)
    for name in DERIVED_RECOGNIZER_FILES:
        derive_recognizer(upstream / name, output / name)
        print(name)
    verify_vertical_reader_files(output, DERIVED_RECOGNIZER_FILES)


if __name__ == "__main__":
    main()
