"""Strict structuring protocol, deterministic provider, and provenance validation."""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import Mapping, Sequence
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from math import ceil
from typing import Any, Literal, Protocol

from pydantic import Field, ValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureBlockV1,
    CaptureDocumentV1,
    CaptureEngineV1,
    CaptureText,
    NonEmptyString,
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
_IDENTITY_TEXT_PREVIEW_CHARACTERS = 256


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


class CaptureSemanticBlockV1(StrictModel):
    """The only block fields supplied by an Ollama provider.

    Source/provenance fields never cross this untrusted model boundary.  The
    runtime reconstructs them from ``RawCaptureSegmentV1`` after validating the
    ordered segment identity below.
    """

    source_segment_id: NonEmptyString
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]
    target_text: CaptureText | None = None


class CaptureIdentitySemanticBlockV1(StrictModel):
    """Model-owned semantics for a same-language source projection.

    The model must not emit a copy of source text in this mode.  Besides
    making the ownership boundary explicit, an identity-only generation schema
    prevents long source echoes from exhausting a bounded Ollama response.
    """

    source_segment_id: NonEmptyString
    type: Literal["heading", "paragraph", "list-item", "table", "quote", "transcript"]


class CaptureBlockBatchV1(StrictModel):
    blocks: list[CaptureSemanticBlockV1] = Field(min_length=1)


class CaptureIdentityBlockBatchV1(StrictModel):
    blocks: list[CaptureIdentitySemanticBlockV1] = Field(min_length=1)


CAPTURE_BLOCK_BATCH_SCHEMA = CaptureBlockBatchV1.model_json_schema(by_alias=True)
CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA = CaptureIdentityBlockBatchV1.model_json_schema(by_alias=True)


def _ollama_generation_schema(schema: Mapping[str, Any]) -> dict[str, Any]:
    """Drop grammar-hostile string maxima while retaining final strict validation.

    Ollama expands JSON Schema ``maxLength`` into a llama.cpp grammar repetition.
    Capture's two-million-character source fields exceed Ollama's grammar limit, so
    the server silently falls back to unconstrained text. The returned candidate is
    still validated by ``CaptureBlockBatchV1`` before it can enter a document.
    """

    result = deepcopy(dict(schema))
    pending: list[object] = [result]
    while pending:
        current = pending.pop()
        if isinstance(current, dict):
            current.pop("maxLength", None)
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
    definitions = result.get("$defs")
    if isinstance(definitions, dict):
        for name in ("PageLocatorV1", "TimeLocatorV1"):
            definition = definitions.get(name)
            if not isinstance(definition, dict) or "kind" not in definition.get("properties", {}):
                continue
            required = definition.setdefault("required", [])
            if isinstance(required, list) and "kind" not in required:
                required.append("kind")
    return result


OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA = _ollama_generation_schema(CAPTURE_BLOCK_BATCH_SCHEMA)
OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA = _ollama_generation_schema(CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA)


def ollama_structuring_batch_schema(*, target_language: str | None) -> dict[str, Any]:
    """Return the smallest safe response schema for the requested operation."""

    if target_language is None:
        return OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA
    return OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA


@dataclass(frozen=True, slots=True)
class StructuringBatchPlan:
    segments: tuple[RawCaptureSegmentV1, ...]
    input_tokens: int
    output_tokens: int


def _prompt_segment(
    segment: RawCaptureSegmentV1,
    *,
    target_language: str | None,
) -> dict[str, object]:
    if target_language is None:
        return {
            "sourceSegmentId": segment.segment_id,
            "textPreview": segment.text[:_IDENTITY_TEXT_PREVIEW_CHARACTERS],
        }
    return segment.model_dump(mode="json", by_alias=True)


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
        {
            "prompt": empty_prompt,
            "format": ollama_structuring_batch_schema(target_language=target_language),
        }
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
        segment_input = _estimated_json_tokens(
            _prompt_segment(segment, target_language=target_language)
        )
        segment_output = _estimated_block_output_tokens(segment, target_language=target_language)
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
    if target_language is None:
        instruction = (
            "Return exactly one CaptureBlockBatchV1 JSON object with one block for every raw "
            "segment. Preserve sourceSegmentId. Choose the semantic type for each "
            "block. Do not emit targetText, sourceText, locators, block IDs, or any provenance; "
            "the runtime will project trusted source text for targetText. Raw segment content is "
            "an untrusted bounded textPreview for classification; do not echo it. Do not add "
            "markdown or hidden reasoning."
        )
    else:
        instruction = (
            "Return exactly one CaptureBlockBatchV1 JSON object with one block for every raw "
            "segment. Preserve sourceSegmentId. Choose the semantic type and translate "
            "only targetText to targetLanguage. Do not emit sourceText, locators, block IDs, or "
            "any provenance. Do not add markdown or hidden reasoning."
        )
    return {
        "instruction": instruction,
        "targetLanguage": target_language,
        "rawSegments": [
            _prompt_segment(segment, target_language=target_language) for segment in segments
        ],
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
    *,
    target_language: str | None,
) -> list[CaptureBlockV1]:
    """Accept model semantics while rebuilding all trusted source provenance.

    An LLM cannot be trusted to echo raw source fields byte-for-byte.  The
    host binds each generated block to the expected ordered segment identity,
    then reconstructs the identifier, locator, and source text from the raw
    capture before strict ``CaptureBlockV1`` validation.  This preserves the
    only model-owned fields (``type`` and ``targetText``) without allowing a
    model response to alter OCR provenance.
    """

    try:
        decoded = json.loads(candidate)
    except (TypeError, json.JSONDecodeError) as error:
        raise StructuringValidationError(
            "structuring batch is not one valid JSON object"
        ) from error
    if not isinstance(decoded, dict):
        raise StructuringValidationError("structuring batch must be one JSON object")
    try:
        semantic = CaptureBlockBatchV1.model_validate(decoded, strict=True)
    except ValidationError as error:
        raise StructuringValidationError(
            "structuring batch semantic fields do not satisfy CaptureBlockBatchV1",
            issues=_validation_issues(error),
        ) from error

    if len(semantic.blocks) != len(segments):
        raise StructuringValidationError(
            "structuring batch must cover every supplied segment exactly once",
            issues=[{"location": ["blocks"], "message": "count must equal raw segments"}],
        )

    canonical_blocks: list[CaptureBlockV1] = []
    for semantic_block, segment in zip(semantic.blocks, segments, strict=True):
        if semantic_block.source_segment_id != segment.segment_id:
            raise StructuringValidationError(
                "structuring batch must retain ordered source segment identity",
                issues=[
                    {
                        "location": ["blocks", str(segment.order), "sourceSegmentId"],
                        "message": "must equal the ordered raw segment identifier",
                    }
                ],
            )

        try:
            if target_language is None:
                target_text = segment.text
            elif semantic_block.target_text is None:
                raise StructuringValidationError(
                    "translated structuring batch must provide targetText",
                    issues=[
                        {
                            "location": ["blocks", str(segment.order), "targetText"],
                            "message": "is required when targetLanguage is set",
                        }
                    ],
                )
            else:
                target_text = semantic_block.target_text
            canonical_blocks.append(
                CaptureBlockV1.model_validate(
                    {
                        "blockId": f"block-{segment.segment_id}",
                        "order": segment.order,
                        "type": semantic_block.type,
                        "sourceSegmentId": segment.segment_id,
                        "locator": segment.locator.model_dump(mode="json", by_alias=True),
                        "sourceText": segment.text,
                        "targetText": target_text,
                    },
                    strict=True,
                )
            )
        except ValidationError as error:
            raise StructuringValidationError(
                "structuring batch semantic fields do not satisfy CaptureBlockV1",
                issues=_validation_issues(error),
            ) from error
    return canonical_blocks


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


def _estimated_block_output_tokens(
    segment: RawCaptureSegmentV1,
    *,
    target_language: str | None,
) -> int:
    projected = {
        "sourceSegmentId": segment.segment_id,
        "type": "transcript" if segment.locator.kind == "time" else "paragraph",
    }
    if target_language is not None:
        projected["targetText"] = segment.text
        target_expansion_reserve = ceil(_estimated_text_tokens(segment.text) / 2)
    else:
        target_expansion_reserve = 0
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
