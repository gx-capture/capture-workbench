from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import pytest

from capture_structuring import (
    CAPTURE_BLOCK_BATCH_SCHEMA,
    StructuringValidationError,
    plan_structuring_batches,
    structure_capture,
    validate_structuring_batch,
    validate_structuring_candidate,
)

NOW = datetime(2026, 8, 4, 12, 0, tzinfo=UTC)
COMPLETED_AT = datetime(2026, 8, 4, 12, 1, tzinfo=UTC)


def raw_capture() -> dict[str, object]:
    segments = [
        {
            "segmentId": "page-1",
            "order": 0,
            "locator": {"kind": "page", "page": 1},
            "text": "A trusted source sentence.",
        },
        {
            "segmentId": "page-2",
            "order": 1,
            "locator": {"kind": "page", "page": 2},
            "text": "A second source sentence.",
        },
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


def test_sdk_rebuilds_provenance_from_minimal_llm_bytes() -> None:
    prompts: list[dict[str, object]] = []

    async def generate(prompt: dict[str, object], schema: dict[str, object]) -> bytes:
        prompts.append({"prompt": prompt, "schema": schema})
        blocks = [
            {
                "sourceSegmentId": (
                    segment["sourceSegmentId"]
                    if "sourceSegmentId" in segment
                    else segment["segmentId"]
                ),
                "type": "paragraph",
            }
            for segment in prompt["rawSegments"]  # type: ignore[index]
        ]
        return json.dumps({"blocks": blocks}).encode()

    document = asyncio.run(
        structure_capture(
            raw_capture(),
            llm_generate=generate,
            structuring_engine={
                "engine": "host-test",
                "model": "test-model",
                "digest": f"sha256:{'c' * 64}",
                "device": "host",
            },
            completed_at=COMPLETED_AT,
        )
    )

    assert document["source"] == raw_capture()["source"]
    assert document["rawSegments"] == raw_capture()["segments"]
    assert document["blocks"][0] == {
        "blockId": "block-page-1",
        "order": 0,
        "type": "paragraph",
        "sourceSegmentId": "page-1",
        "locator": {"kind": "page", "page": 1},
        "sourceText": "A trusted source sentence.",
        "targetText": "A trusted source sentence.",
    }
    assert document["completedAt"] == COMPLETED_AT.isoformat()
    assert prompts[0]["schema"]["title"] == "CaptureIdentityBlockBatch"


def test_sdk_preserves_global_block_order_across_batches() -> None:
    raw = raw_capture()
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
    calls = 0

    def generate(prompt: dict[str, object], schema: dict[str, object]) -> str:
        nonlocal calls
        calls += 1
        return json.dumps(
            {
                "blocks": [
                    {
                        "sourceSegmentId": (
                            segment["sourceSegmentId"]
                            if "sourceSegmentId" in segment
                            else segment["segmentId"]
                        ),
                        "type": "paragraph",
                        "targetText": "translated",
                    }
                    for segment in prompt["rawSegments"]  # type: ignore[index]
                ]
            }
        )

    document = asyncio.run(
        structure_capture(
            raw,
            llm_generate=generate,
            structuring_engine={
                "engine": "host-test",
                "model": "test-model",
                "digest": f"sha256:{'c' * 64}",
                "device": "host",
            },
            completed_at=COMPLETED_AT,
            target_language="zh-TW",
            num_ctx=4_096,
            num_predict=1_536,
        )
    )

    assert calls == 3
    assert [block["order"] for block in document["blocks"]] == list(range(5))


def test_sdk_rejects_full_block_echo_at_the_llm_seam() -> None:
    candidate = json.dumps(
        {
            "blocks": [
                {
                    "sourceSegmentId": "page-1",
                    "type": "paragraph",
                    "blockId": "forged",
                }
            ]
        }
    )

    with pytest.raises(StructuringValidationError, match="semantic fields"):
        validate_structuring_batch(
            candidate.encode(),
            raw_capture()["segments"],  # type: ignore[arg-type]
            target_language="zh-TW",
        )


def test_sdk_accepts_text_candidates_and_allows_an_explicit_host_schema() -> None:
    schemas: list[dict[str, object]] = []

    def generate(prompt: dict[str, object], schema: dict[str, object]) -> str:
        schemas.append(schema)
        return json.dumps(
            {
                "blocks": [
                    {
                        "sourceSegmentId": (
                            segment["sourceSegmentId"]
                            if "sourceSegmentId" in segment
                            else segment["segmentId"]
                        ),
                        "type": "paragraph",
                        "targetText": "translated",
                    }
                    for segment in prompt["rawSegments"]  # type: ignore[index]
                ]
            }
        )

    asyncio.run(
        structure_capture(
            raw_capture(),
            llm_generate=generate,
            structuring_engine={
                "engine": "host-test",
                "model": "test-model",
                "digest": f"sha256:{'c' * 64}",
                "device": "host",
            },
            target_language="zh-TW",
            completed_at=COMPLETED_AT,
        )
    )
    assert schemas[0] is CAPTURE_BLOCK_BATCH_SCHEMA

    host_schema = {"title": "host-schema", "type": "object"}
    schemas.clear()
    asyncio.run(
        structure_capture(
            raw_capture(),
            llm_generate=generate,
            structuring_engine={
                "engine": "host-test",
                "model": "test-model",
                "digest": f"sha256:{'c' * 64}",
                "device": "host",
            },
            target_language="zh-TW",
            completed_at=COMPLETED_AT,
            schema=host_schema,
        )
    )
    assert schemas[0] is host_schema


def test_candidate_validation_is_schema_strict_and_order_independent() -> None:
    raw = raw_capture()
    document = asyncio.run(
        structure_capture(
            raw,
            llm_generate=lambda prompt, schema: json.dumps(
                {
                    "blocks": [
                        {
                            "sourceSegmentId": segment["sourceSegmentId"],
                            "type": "paragraph",
                        }
                        for segment in prompt["rawSegments"]  # type: ignore[index]
                    ]
                }
            ).encode(),
            structuring_engine={
                "engine": "host-test",
                "model": "test-model",
                "digest": f"sha256:{'c' * 64}",
                "device": "host",
            },
            completed_at=COMPLETED_AT,
        )
    )
    reordered = dict(document)
    reordered["source"] = dict(reversed(list(document["source"].items())))  # type: ignore[union-attr]
    reordered["extractionEngine"] = dict(
        reversed(list(document["extractionEngine"].items()))  # type: ignore[union-attr]
    )
    assert validate_structuring_candidate(reordered, raw) == reordered

    invalid = dict(document)
    invalid["source"] = {
        **document["source"],  # type: ignore[dict-item]
        "sha256": "not-a-sha256",
    }
    with pytest.raises(StructuringValidationError):
        validate_structuring_candidate(invalid, raw)


def test_batch_validation_covers_count_order_modes_and_budget() -> None:
    segments = raw_capture()["segments"]
    with pytest.raises(StructuringValidationError):
        validate_structuring_batch(
            json.dumps({"blocks": []}).encode(),
            segments,  # type: ignore[arg-type]
            target_language="zh-TW",
        )
    with pytest.raises(StructuringValidationError):
        validate_structuring_batch(
            json.dumps(
                {
                    "blocks": [
                        {"sourceSegmentId": "page-2", "type": "paragraph"},
                        {"sourceSegmentId": "page-1", "type": "paragraph"},
                    ]
                }
            ).encode(),
            segments,  # type: ignore[arg-type]
            target_language="zh-TW",
        )
    with pytest.raises(StructuringValidationError):
        validate_structuring_batch(
            json.dumps(
                {
                    "blocks": [
                        {
                            "sourceSegmentId": "page-1",
                            "type": "paragraph",
                            "targetText": "echo",
                        },
                        {
                            "sourceSegmentId": "page-2",
                            "type": "paragraph",
                            "targetText": "echo",
                        },
                    ]
                }
            ).encode(),
            segments,  # type: ignore[arg-type]
            target_language=None,
        )
    with pytest.raises(StructuringValidationError):
        validate_structuring_batch(
            json.dumps(
                {
                    "blocks": [
                        {"sourceSegmentId": "page-1", "type": "paragraph"},
                        {"sourceSegmentId": "page-2", "type": "paragraph"},
                    ]
                }
            ).encode(),
            segments,  # type: ignore[arg-type]
            target_language="zh-TW",
        )
    with pytest.raises(StructuringValidationError):
        plan_structuring_batches(
            [{**segments[0], "text": "x" * 2_000_000}],  # type: ignore[index]
            target_language="zh-TW",
        )


def test_invalid_wire_input_uses_structuring_validation_error() -> None:
    with pytest.raises(StructuringValidationError):
        validate_structuring_candidate({}, object())
