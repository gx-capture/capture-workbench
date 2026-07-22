"""Strict structuring protocol, deterministic provider, and provenance validation."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from math import ceil
from typing import Any, Protocol

from pydantic import Field, ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureBlockV1,
    CaptureDocumentV1,
    CaptureEngineV1,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StrictModel,
)

DEFAULT_STRUCTURING_NUM_CTX = 8_192
DEFAULT_STRUCTURING_NUM_PREDICT = 4_096
_CONTEXT_RESERVE_TOKENS = 512
_OUTPUT_RESERVE_TOKENS = 256
_ESTIMATED_BYTES_PER_TOKEN = 3
_MIN_REQUEST_TOKENS = 256


class CaptureStructuringProvider(Protocol):
    @property
    def engine_identity(self) -> CaptureEngineV1 | None: ...

    async def structure(
        self,
        raw: RawCaptureV1,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object: ...


class StructuringValidationError(ValueError):
    def __init__(self, message: str, *, issues: list[dict[str, Any]] | None = None) -> None:
        super().__init__(message)
        self.issues = issues or []


class CaptureBlockBatchV1(StrictModel):
    blocks: list[CaptureBlockV1] = Field(min_length=1)


CAPTURE_BLOCK_BATCH_SCHEMA = CaptureBlockBatchV1.model_json_schema(by_alias=True)


@dataclass(frozen=True, slots=True)
class StructuringBatchPlan:
    segments: tuple[RawCaptureSegmentV1, ...]
    input_tokens: int
    output_tokens: int


def plan_structuring_batches(
    segments: Sequence[RawCaptureSegmentV1],
    *,
    target_language: str | None,
    num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
    num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
) -> list[StructuringBatchPlan]:
    """Plan bounded batches using a conservative UTF-8 token estimate."""

    if num_predict <= _OUTPUT_RESERVE_TOKENS:
        raise ValueError("Capture structuring output budget is too small")
    if num_ctx <= num_predict + _CONTEXT_RESERVE_TOKENS:
        raise ValueError("Capture structuring context budget is too small")
    input_limit = num_ctx - num_predict - _CONTEXT_RESERVE_TOKENS
    output_limit = num_predict - _OUTPUT_RESERVE_TOKENS
    empty_prompt = build_structuring_batch_prompt((), target_language=target_language)
    fixed_input = _estimated_json_tokens(
        {"prompt": empty_prompt, "format": CAPTURE_BLOCK_BATCH_SCHEMA}
    )
    fixed_output = _estimated_json_tokens({"blocks": []})
    if fixed_input >= input_limit or fixed_output >= output_limit:
        raise StructuringValidationError(
            "Capture structuring schema does not fit the configured provider budget."
        )

    plans: list[StructuringBatchPlan] = []
    current: list[RawCaptureSegmentV1] = []
    current_input = fixed_input
    current_output = fixed_output
    for segment in segments:
        segment_input = _estimated_json_tokens(segment.model_dump(mode="json", by_alias=True))
        segment_output = _estimated_block_output_tokens(segment)
        next_input = current_input + segment_input
        next_output = current_output + segment_output
        if current and (next_input > input_limit or next_output > output_limit):
            plans.append(StructuringBatchPlan(tuple(current), current_input, current_output))
            current = []
            current_input = fixed_input
            current_output = fixed_output
            next_input = current_input + segment_input
            next_output = current_output + segment_output
        if next_input > input_limit or next_output > output_limit:
            raise StructuringValidationError(
                f"Raw segment {segment.segment_id!r} exceeds the provider token budget.",
                issues=[
                    {
                        "location": ["rawSegments", str(segment.order)],
                        "message": "must fit one structuring batch",
                    }
                ],
            )
        current.append(segment)
        current_input = next_input
        current_output = next_output

    if current:
        plans.append(StructuringBatchPlan(tuple(current), current_input, current_output))
    return plans


def build_structuring_batch_prompt(
    segments: Sequence[RawCaptureSegmentV1],
    *,
    target_language: str | None,
) -> dict[str, object]:
    return {
        "instruction": (
            "Return exactly one CaptureBlockBatchV1 JSON object with one block for every raw "
            "segment. Preserve sourceSegmentId, global order, locator, and sourceText exactly. "
            "Set blockId to 'block-' plus sourceSegmentId so it remains globally unique. When "
            "targetLanguage is null, copy sourceText to targetText; otherwise translate only "
            "targetText. Do not add, omit, merge, reorder, or split segments. Do not add markdown "
            "or hidden reasoning."
        ),
        "targetLanguage": target_language,
        "rawSegments": [segment.model_dump(mode="json", by_alias=True) for segment in segments],
    }


def structuring_batch_generation_options(
    plan: StructuringBatchPlan,
    *,
    max_num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
    max_num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
) -> tuple[int, int]:
    num_predict = min(
        max_num_predict,
        max(_MIN_REQUEST_TOKENS, plan.output_tokens + _OUTPUT_RESERVE_TOKENS),
    )
    num_ctx = min(
        max_num_ctx,
        max(
            _MIN_REQUEST_TOKENS,
            plan.input_tokens + num_predict + _CONTEXT_RESERVE_TOKENS,
        ),
    )
    return num_ctx, num_predict


class HostOnlyCaptureStructuringProvider:
    """Fail closed if an internal caller bypasses host-mode capability checks."""

    @property
    def engine_identity(self) -> CaptureEngineV1 | None:
        return None

    async def structure(
        self,
        raw: RawCaptureV1,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object:
        del raw, target_language, cancel_event
        raise StructuringValidationError(
            "runtime structuring is disabled; submit a host candidate instead"
        )


def _validation_issues(error: ValidationError) -> list[dict[str, Any]]:
    return [
        {
            "location": [str(part) for part in issue["loc"]],
            "message": issue["msg"],
            "type": issue["type"],
        }
        for issue in error.errors()
    ]


def validate_structuring_candidate(candidate: object, raw: RawCaptureV1) -> CaptureDocumentV1:
    """Validate schema and exact extraction provenance without repairing output."""

    try:
        if isinstance(candidate, CaptureDocumentV1):
            document = CaptureDocumentV1.model_validate(
                candidate.model_dump(mode="json", by_alias=True)
            )
        elif isinstance(candidate, str):
            document = CaptureDocumentV1.model_validate_json(candidate)
        elif isinstance(candidate, Mapping):
            document = CaptureDocumentV1.model_validate(candidate)
        else:
            raise StructuringValidationError("structuring output must be a JSON object")
    except ValidationError as error:
        raise StructuringValidationError(
            "structuring output does not satisfy CaptureDocumentV1",
            issues=_validation_issues(error),
        ) from error
    except json.JSONDecodeError as error:
        raise StructuringValidationError("structuring output is not valid JSON") from error

    mismatches: list[str] = []
    if document.source != raw.source:
        mismatches.append("source")
    if document.raw_segments != raw.segments:
        mismatches.append("rawSegments")
    if document.source_text != raw.source_text:
        mismatches.append("sourceText")
    if document.extraction_engine != raw.extraction_engine:
        mismatches.append("extractionEngine")
    if document.created_at != raw.created_at:
        mismatches.append("createdAt")
    if not set(raw.warnings).issubset(document.warnings):
        mismatches.append("warnings")
    if mismatches:
        raise StructuringValidationError(
            "structured output changed extraction provenance",
            issues=[
                {"location": [field], "message": "must equal raw capture"} for field in mismatches
            ],
        )
    return document


def validate_structuring_batch(
    candidate: str,
    segments: Sequence[RawCaptureSegmentV1],
) -> list[CaptureBlockV1]:
    """Reject any non-canonical batch or changed extraction provenance."""

    try:
        decoded = json.loads(candidate)
    except (TypeError, json.JSONDecodeError) as error:
        raise StructuringValidationError(
            "structuring batch is not one valid JSON object"
        ) from error
    if not isinstance(decoded, dict):
        raise StructuringValidationError("structuring batch must be one JSON object")
    raw_blocks = decoded.get("blocks")
    if not isinstance(raw_blocks, list) or len(raw_blocks) != len(segments):
        raise StructuringValidationError(
            "structuring batch must cover every supplied segment exactly once",
            issues=[{"location": ["blocks"], "message": "count must equal raw segments"}],
        )

    for raw_block, segment in zip(raw_blocks, segments, strict=True):
        if not isinstance(raw_block, dict):
            raise StructuringValidationError("structuring batch blocks must be JSON objects")
        expected = {
            "blockId": f"block-{segment.segment_id}",
            "order": segment.order,
            "sourceSegmentId": segment.segment_id,
            "locator": segment.locator.model_dump(mode="json", by_alias=True),
            "sourceText": segment.text,
        }
        for field, value in expected.items():
            if raw_block.get(field) != value:
                raise StructuringValidationError(
                    "structuring batch changed required provenance",
                    issues=[
                        {
                            "location": ["blocks", str(segment.order), field],
                            "message": "must equal raw segment",
                        }
                    ],
                )

    try:
        validated = CaptureBlockBatchV1.model_validate_json(candidate, strict=True)
    except ValidationError as error:
        raise StructuringValidationError(
            "structuring batch does not satisfy CaptureBlockBatchV1",
            issues=_validation_issues(error),
        ) from error
    canonical = validated.model_dump(mode="json", by_alias=True)
    if canonical != decoded:
        raise StructuringValidationError("structuring batch values must already be canonical")
    return validated.blocks


def assemble_structuring_document(
    raw: RawCaptureV1,
    blocks: Sequence[CaptureBlockV1],
    *,
    engine_identity: CaptureEngineV1,
    completed_at: datetime,
) -> CaptureDocumentV1:
    """Build deterministic envelope fields, then apply canonical full validation."""

    document = CaptureDocumentV1(
        source=raw.source,
        raw_segments=raw.segments,
        blocks=list(blocks),
        source_text=raw.source_text,
        target_text="\n".join(block.target_text for block in blocks),
        extraction_engine=raw.extraction_engine,
        structuring_engine=engine_identity,
        warnings=raw.warnings,
        created_at=raw.created_at,
        completed_at=completed_at,
    )
    return validate_structuring_candidate(document, raw)


def _estimated_block_output_tokens(segment: RawCaptureSegmentV1) -> int:
    projected = {
        "blockId": f"block-{segment.segment_id}",
        "order": segment.order,
        "type": "transcript" if segment.locator.kind == "time" else "paragraph",
        "sourceSegmentId": segment.segment_id,
        "locator": segment.locator.model_dump(mode="json", by_alias=True),
        "sourceText": segment.text,
        "targetText": segment.text,
    }
    target_expansion_reserve = ceil(_estimated_text_tokens(segment.text) / 2)
    return _estimated_json_tokens(projected) + target_expansion_reserve


def _estimated_json_tokens(value: object) -> int:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return max(1, ceil(len(encoded) / _ESTIMATED_BYTES_PER_TOKEN))


def _estimated_text_tokens(value: str) -> int:
    return max(1, ceil(len(value.encode("utf-8")) / _ESTIMATED_BYTES_PER_TOKEN))


class FakeCaptureStructuringProvider:
    """Deterministic strict-provider fake used by CI and verification harnesses."""

    def __init__(
        self,
        clock: Clock,
        *,
        delay_seconds: float = 0,
        mode: str = "valid",
    ) -> None:
        self._clock = clock
        self._delay_seconds = delay_seconds
        self._mode = mode
        digest_source = "fake-structurer:deterministic-structure-v1"
        self._engine_identity = CaptureEngineV1(
            engine="fake-structurer",
            model="deterministic-structure-v1",
            digest=f"sha256:{hashlib.sha256(digest_source.encode()).hexdigest()}",
            device="fake",
        )

    @property
    def engine_identity(self) -> CaptureEngineV1:
        return self._engine_identity

    async def structure(
        self,
        raw: RawCaptureV1,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object:
        if self._delay_seconds:
            try:
                await asyncio.wait_for(cancel_event.wait(), timeout=self._delay_seconds)
            except TimeoutError:
                pass
        if cancel_event.is_set():
            raise asyncio.CancelledError
        if self._mode == "invalid_json":
            return "{not-json"

        target_prefix = f"[{target_language}] " if target_language else ""
        blocks = [
            CaptureBlockV1(
                block_id=f"block-{index + 1}",
                order=index,
                type="transcript" if segment.locator.kind == "time" else "paragraph",
                source_segment_id=segment.segment_id,
                locator=segment.locator,
                source_text=segment.text,
                target_text=f"{target_prefix}{segment.text}",
            )
            for index, segment in enumerate(raw.segments)
        ]
        document = CaptureDocumentV1(
            source=raw.source,
            raw_segments=raw.segments,
            blocks=blocks,
            source_text=raw.source_text,
            target_text="\n".join(block.target_text for block in blocks),
            extraction_engine=raw.extraction_engine,
            structuring_engine=self._engine_identity,
            warnings=raw.warnings,
            created_at=raw.created_at,
            completed_at=self._clock.now(),
        )
        payload = document.model_dump(mode="json", by_alias=True)
        if self._mode == "invalid_order":
            payload["blocks"][0]["order"] = 4
        elif self._mode == "invalid_locator":
            payload["blocks"][0]["locator"] = {"kind": "page", "page": 999}
        elif self._mode == "invalid_provenance":
            payload["source"]["sha256"] = "0" * 64
        elif self._mode == "invalid_structuring_digest":
            payload["structuringEngine"]["digest"] = f"sha256:{'0' * 64}"
        return payload
