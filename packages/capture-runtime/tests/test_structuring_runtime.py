from __future__ import annotations

import asyncio
import copy
import json
from datetime import UTC, datetime

import pytest

from capture_runtime.structuring import (
    CAPTURE_BLOCK_BATCH_SCHEMA,
    StructuringValidationError,
    plan_structuring_batches,
    structure_capture,
    validate_structuring_batch,
    validate_structuring_candidate,
)

NOW = datetime(2026, 8, 4, 12, 0, tzinfo=UTC)
COMPLETED_AT = datetime(2026, 8, 4, 12, 1, tzinfo=UTC)


def _raw_capture(*, text_chars: int = 24) -> dict[str, object]:
    segments = [
        {
            "segmentId": f"page-{index + 1}",
            "order": index,
            "locator": {"kind": "page", "page": index + 1},
            "text": f"segment-{index}-" + ("x" * text_chars),
        }
        for index in range(2)
    ]
    return {
        "schemaVersion": "2",
        "diagnosticOnly": True,
        "source": {
            "sha256": "a" * 64,
            "fileName": "sample.pdf",
            "mediaType": "application/pdf",
            "bytes": 42,
        },
        "segments": segments,
        "sourceText": "\n".join(str(segment["text"]) for segment in segments),
        "extractionEngine": {
            "engine": "windowsml-ocr",
            "model": "capture-ocr-v1",
            "digest": f"sha256:{'b' * 64}",
            "device": "igpu",
        },
        "warnings": ["source warning"],
        "createdAt": NOW.isoformat(),
    }


def _engine() -> dict[str, str]:
    return {
        "engine": "host-test",
        "model": "test-model",
        "digest": f"sha256:{'c' * 64}",
        "device": "host",
    }


def _semantic_response(prompt: dict[str, object], *, translated: bool) -> bytes:
    blocks = []
    for segment in prompt["rawSegments"]:  # type: ignore[index]
        segment_id = segment.get("sourceSegmentId") or segment["segmentId"]  # type: ignore[union-attr]
        block: dict[str, object] = {"sourceSegmentId": segment_id, "type": "paragraph"}
        if translated:
            block["targetText"] = "translated"
        blocks.append(block)
    return json.dumps({"blocks": blocks}).encode()


def test_runtime_identity_coordinator_reconstructs_trusted_provenance() -> None:
    prompts: list[dict[str, object]] = []

    async def generate(prompt: dict[str, object], schema: dict[str, object]) -> bytes:
        prompts.append({"prompt": prompt, "schema": schema})
        return _semantic_response(prompt, translated=False)

    raw = _raw_capture()
    document = asyncio.run(
        structure_capture(
            raw,
            llm_generate=generate,
            structuring_engine=_engine(),
            completed_at=COMPLETED_AT,
        )
    )

    assert document["source"] == raw["source"]
    assert document["rawSegments"] == raw["segments"]
    assert document["blocks"][0]["blockId"] == "block-page-1"  # type: ignore[index]
    assert document["blocks"][0]["sourceText"] == raw["segments"][0]["text"]  # type: ignore[index]
    assert document["completedAt"] == COMPLETED_AT.isoformat()
    assert prompts[0]["schema"]["title"] == "CaptureIdentityBlockBatch"  # type: ignore[index]
    assert prompts[0]["prompt"]["rawSegments"] == [  # type: ignore[index]
        {"sourceSegmentId": "page-1", "textPreview": raw["segments"][0]["text"]},
        {"sourceSegmentId": "page-2", "textPreview": raw["segments"][1]["text"]},
    ]


def test_runtime_translation_batches_preserve_global_order_and_schema() -> None:
    raw = _raw_capture(text_chars=1_200)
    segments = [
        {
            "segmentId": f"page-{index + 1}",
            "order": index,
            "locator": {"kind": "page", "page": index + 1},
            "text": f"segment-{index}-" + ("x" * 1_200),
        }
        for index in range(5)
    ]
    raw["segments"] = segments
    raw["sourceText"] = "\n".join(str(segment["text"]) for segment in segments)
    calls: list[dict[str, object]] = []

    def generate(prompt: dict[str, object], schema: dict[str, object]) -> str:
        calls.append({"prompt": prompt, "schema": schema})
        return _semantic_response(prompt, translated=True).decode()

    document = asyncio.run(
        structure_capture(
            raw,
            llm_generate=generate,
            structuring_engine=_engine(),
            target_language="zh-TW",
            completed_at=COMPLETED_AT,
            num_ctx=4_096,
            num_predict=1_536,
        )
    )

    assert len(calls) == 3
    assert calls[0]["schema"] is CAPTURE_BLOCK_BATCH_SCHEMA
    assert [block["order"] for block in document["blocks"]] == list(range(5))  # type: ignore[index]
    assert [block["sourceSegmentId"] for block in document["blocks"]] == [  # type: ignore[index]
        segment["segmentId"] for segment in segments
    ]


def test_runtime_semantic_and_provenance_mismatches_fail_closed() -> None:
    raw = _raw_capture()
    full_echo = json.dumps(
        {
            "blocks": [
                {"sourceSegmentId": "page-1", "type": "paragraph", "blockId": "forged"},
                {"sourceSegmentId": "page-2", "type": "paragraph"},
            ]
        }
    )
    with pytest.raises(StructuringValidationError, match="semantic fields"):
        validate_structuring_batch(full_echo, raw["segments"], target_language="zh-TW")  # type: ignore[arg-type]

    document = asyncio.run(
        structure_capture(
            raw,
            llm_generate=lambda prompt, schema: _semantic_response(prompt, translated=False),
            structuring_engine=_engine(),
            completed_at=COMPLETED_AT,
        )
    )
    changed = copy.deepcopy(document)
    changed["source"]["sha256"] = "d" * 64  # type: ignore[index]
    with pytest.raises(StructuringValidationError, match="provenance"):
        validate_structuring_candidate(changed, raw)


def test_runtime_batch_planner_rejects_segment_that_cannot_fit() -> None:
    with pytest.raises(StructuringValidationError, match="exceeds the provider token budget"):
        plan_structuring_batches(
            [{**_raw_capture()["segments"][0], "text": "x" * 2_000_000}],  # type: ignore[index]
            target_language="zh-TW",
        )
