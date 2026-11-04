from __future__ import annotations

from typing import Any

from capture_runtime.ocr.infrastructure.ocr_alignment import (
    UnsupportedAlignmentPipeline,
    _operations,
)


def alignment_available(pipeline: Any) -> bool:
    """Probe injected/custom pipelines; canonical attachment must still raise."""
    try:
        _operations(pipeline)
    except UnsupportedAlignmentPipeline:
        return False
    return True
