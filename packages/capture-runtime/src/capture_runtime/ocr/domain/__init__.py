"""Document OCR domain layer."""

from __future__ import annotations

from capture_runtime.ocr.domain.compute_plan import (
    ComputePlanPolicy,
    ComputePlanSelection,
)
from capture_runtime.ocr.domain.evidence import (
    DirectMlExecutionEvidence,
    SessionDeviceProof,
)
from capture_runtime.ocr.domain.page import (
    BoundingBox,
    OcrPage,
    PageReadingOrder,
    PageRegion,
)

__all__ = [
    "BoundingBox",
    "ComputePlanPolicy",
    "ComputePlanSelection",
    "DirectMlExecutionEvidence",
    "OcrPage",
    "PageReadingOrder",
    "PageRegion",
    "SessionDeviceProof",
]
