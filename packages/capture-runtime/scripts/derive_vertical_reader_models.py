"""Derive the vertical reader's delivered recognizers from upstream NDLOCR-Lite models.

Usage: derive_vertical_reader_models.py <upstream src/model directory> <output directory>

Each upstream recognizer is checked against its pinned digest, optimized by ONNX
Runtime at the extended level on the CPU provider and saved under the same name.
The result is checked against the digests the runtime accepts, so a delivered
set can be reproduced from upstream alone. The runtime loads these files without
further optimization. The detector and the two configuration files are delivered
as upstream publishes them.
"""

from __future__ import annotations

import sys
from pathlib import Path

import onnxruntime

from capture_runtime.ocr_vertical_reader import (
    DERIVATION_ONNXRUNTIME,
    UPSTREAM_RECOGNIZER_FILES,
    VERTICAL_READER_FILES,
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
    verify_vertical_reader_files(upstream, UPSTREAM_RECOGNIZER_FILES)
    output.mkdir(parents=True, exist_ok=True)
    for name in UPSTREAM_RECOGNIZER_FILES:
        options = onnxruntime.SessionOptions()
        options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
        options.optimized_model_filepath = str(output / name)
        onnxruntime.InferenceSession(
            str(upstream / name), options, providers=["CPUExecutionProvider"]
        )
        print(name)
    verify_vertical_reader_files(
        output, {name: VERTICAL_READER_FILES[name] for name in UPSTREAM_RECOGNIZER_FILES}
    )


if __name__ == "__main__":
    main()
