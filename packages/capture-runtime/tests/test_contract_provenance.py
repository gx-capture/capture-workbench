from __future__ import annotations

import copy
import hashlib
from datetime import UTC, datetime

import pytest
from capture_structuring import StructuringValidationError, validate_structuring_candidate
from pydantic import ValidationError

from capture_runtime.contracts import CaptureDocument, RawCapture


def _engine(name: str) -> dict[str, str]:
    digest = hashlib.sha256(name.encode()).hexdigest()
    return {"engine": name, "model": "model-v1", "digest": f"sha256:{digest}"}


def _raw_payload() -> dict[str, object]:
    created_at = datetime(2026, 7, 20, 12, 0, tzinfo=UTC).isoformat()
    segments = [
        {
            "segmentId": "segment-1",
            "order": 0,
            "locator": {"kind": "page", "page": 1},
            "text": "First",
        },
        {
            "segmentId": "segment-2",
            "order": 1,
            "locator": {"kind": "page", "page": 2},
            "text": "Second",
        },
    ]
    return {
        "schemaVersion": "2",
        "diagnosticOnly": True,
        "source": {
            "sha256": "1" * 64,
            "fileName": "source.pdf",
            "mediaType": "application/pdf",
            "bytes": 100,
        },
        "segments": segments,
        "sourceText": "First\nSecond",
        "extractionEngine": _engine("windowsml-ocr"),
        "warnings": [],
        "createdAt": created_at,
    }


def _document_payload() -> dict[str, object]:
    raw = _raw_payload()
    segments = raw["segments"]
    assert isinstance(segments, list)
    blocks = [
        {
            "blockId": f"block-{index + 1}",
            "order": index,
            "type": "paragraph",
            "sourceSegmentId": segment["segmentId"],
            "locator": segment["locator"],
            "sourceText": segment["text"],
            "targetText": segment["text"],
        }
        for index, segment in enumerate(segments)
    ]
    return {
        "schemaVersion": "2",
        "source": raw["source"],
        "rawSegments": segments,
        "blocks": blocks,
        "sourceText": raw["sourceText"],
        "targetText": "First\nSecond",
        "extractionEngine": raw["extractionEngine"],
        "structuringEngine": _engine("host-structurer"),
        "warnings": [],
        "createdAt": raw["createdAt"],
        "completedAt": datetime(2026, 7, 20, 12, 1, tzinfo=UTC).isoformat(),
    }


def test_document_requires_exact_block_coverage_order_source_text_and_locator() -> None:
    assert CaptureDocument.model_validate(_document_payload()).target_text == "First\nSecond"

    omitted = copy.deepcopy(_document_payload())
    omitted["blocks"] = omitted["blocks"][:1]

    reordered = copy.deepcopy(_document_payload())
    reordered["blocks"] = list(reversed(reordered["blocks"]))
    for index, block in enumerate(reordered["blocks"]):
        block["order"] = index
    reordered["targetText"] = "Second\nFirst"

    duplicated = copy.deepcopy(_document_payload())
    duplicated["blocks"][1] = copy.deepcopy(duplicated["blocks"][0])
    duplicated["blocks"][1]["blockId"] = "block-2"
    duplicated["blocks"][1]["order"] = 1
    duplicated["targetText"] = "First\nFirst"

    changed_text = copy.deepcopy(_document_payload())
    changed_text["blocks"][0]["sourceText"] = "Changed"

    changed_locator = copy.deepcopy(_document_payload())
    changed_locator["blocks"][0]["locator"] = {"kind": "page", "page": 99}

    for invalid in [omitted, reordered, duplicated, changed_text, changed_locator]:
        with pytest.raises(ValidationError):
            CaptureDocument.model_validate(invalid)


def test_candidate_cannot_omit_raw_provenance_even_if_internally_valid() -> None:
    raw = RawCapture.model_validate(_raw_payload())
    candidate = copy.deepcopy(_document_payload())
    candidate["rawSegments"] = candidate["rawSegments"][:1]
    candidate["blocks"] = candidate["blocks"][:1]
    candidate["sourceText"] = "First"
    candidate["targetText"] = "First"
    internally_valid = CaptureDocument.model_validate(candidate)
    with pytest.raises(StructuringValidationError):
        validate_structuring_candidate(internally_valid, raw)
