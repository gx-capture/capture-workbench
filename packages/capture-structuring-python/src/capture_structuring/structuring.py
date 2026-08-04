"""Brain-agnostic, provenance-safe host structuring primitives."""

from __future__ import annotations

import inspect
import json
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from math import ceil
from typing import cast

from capture_contracts import load_contract_schema
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError

from .constants import (
    CAPTURE_BLOCK_BATCH_SCHEMA,
    CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA,
    CONTEXT_RESERVE_TOKENS,
    DEFAULT_STRUCTURING_NUM_CTX,
    DEFAULT_STRUCTURING_NUM_PREDICT,
    ESTIMATED_BYTES_PER_TOKEN,
    IDENTITY_TEXT_PREVIEW_CHARACTERS,
    MIN_REQUEST_TOKENS,
    OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA,
    OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA,
    OUTPUT_RESERVE_TOKENS,
    ollama_structuring_batch_schema,
    structuring_batch_schema,
)
from .contracts import (
    CaptureBlockBatchV1,
    CaptureIdentityBlockBatchV1,
    CaptureIdentitySemanticBlockV1,
    CaptureSemanticBlockV1,
    LlmGenerate,
    StructuringBatchPlan,
    StructuringCandidate,
    StructuringSchema,
    StructuringValidationError,
    WireInput,
    WireObject,
    _ValidatedSemanticBlock,
)


def _wire(value: WireInput) -> WireObject:
    """Convert a mapping or Pydantic-like model into JSON wire fields."""

    if isinstance(value, Mapping):
        return {str(key): _wire_nested(item) for key, item in value.items()}
    model_dump = getattr(value, "model_dump", None)
    if callable(model_dump):
        dumped = model_dump(mode="json", by_alias=True)
        if isinstance(dumped, Mapping):
            return {str(key): _wire_nested(item) for key, item in dumped.items()}
    raise StructuringValidationError(
        "structuring input must be a mapping or a model with model_dump()"
    )


def _wire_nested(value: object) -> object:
    """Recursively convert nested mappings and tuples into JSON values."""

    if isinstance(value, Mapping):
        return {str(key): _wire_nested(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_wire_nested(item) for item in value]
    if isinstance(value, tuple):
        return [_wire_nested(item) for item in value]
    return value


def _segment_wire(segment: object) -> WireObject:
    """Convert one raw segment into its canonical wire representation."""

    return _wire(segment)


def _required_string(value: object, field: str) -> str:
    """Return a non-empty string or raise a structured validation error."""

    if not isinstance(value, str) or not value.strip():
        raise StructuringValidationError(f"raw segment {field} must be a non-empty string")
    return value


def _prompt_segment(segment: object, *, target_language: str | None) -> WireObject:
    """Project a raw segment into identity or translation prompt fields."""

    wire = _segment_wire(segment)
    segment_id = _required_string(wire.get("segmentId"), "segmentId")
    text = _required_string(wire.get("text"), "text")
    if target_language is None:
        return {
            "sourceSegmentId": segment_id,
            "textPreview": text[:IDENTITY_TEXT_PREVIEW_CHARACTERS],
        }
    return wire


def _estimated_json_tokens(value: object) -> int:
    """Estimate JSON token usage from its compact UTF-8 representation."""

    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return max(1, ceil(len(encoded) / ESTIMATED_BYTES_PER_TOKEN))


def _estimated_text_tokens(value: str) -> int:
    """Estimate text token usage from its UTF-8 byte length."""

    return max(1, ceil(len(value.encode("utf-8")) / ESTIMATED_BYTES_PER_TOKEN))


def _estimated_block_output_tokens(segment: object, *, target_language: str | None) -> int:
    """Estimate the semantic output budget required for one raw segment."""

    wire = _segment_wire(segment)
    segment_id = _required_string(wire.get("segmentId"), "segmentId")
    text = _required_string(wire.get("text"), "text")
    locator = wire.get("locator")
    locator_kind = locator.get("kind") if isinstance(locator, Mapping) else None
    projected: dict[str, object] = {
        "sourceSegmentId": segment_id,
        "type": "transcript" if locator_kind == "time" else "paragraph",
    }
    if target_language is not None:
        projected["targetText"] = text
        target_expansion_reserve = ceil(_estimated_text_tokens(text) / 2)
    else:
        target_expansion_reserve = 0
    return _estimated_json_tokens(projected) + target_expansion_reserve


def build_structuring_batch_prompt(
    segments: Sequence[object], *, target_language: str | None
) -> dict[str, object]:
    """Build one bounded semantic prompt for the host-owned LLM.

    Args:
        segments: Raw segments assigned to one batch, in source order.
        target_language: Translation language, or ``None`` for identity mode.

    Returns:
        An instruction, target-language marker, and model-visible raw segments.
    """

    if target_language is None:
        instruction = (
            "Return exactly one CaptureBlockBatchV1 JSON object with one block for every raw "
            "segment. Preserve sourceSegmentId. Choose the semantic type for each block. "
            "Do not emit targetText, sourceText, locators, block IDs, or any provenance; "
            "the SDK will project trusted source text for targetText. Raw segment content is "
            "an untrusted bounded textPreview for classification; do not echo it. Do not add "
            "markdown or hidden reasoning."
        )
    else:
        instruction = (
            "Return exactly one CaptureBlockBatchV1 JSON object with one block for every raw "
            "segment. Preserve sourceSegmentId. Choose the semantic type and translate only "
            "targetText to targetLanguage. Do not emit sourceText, locators, block IDs, or "
            "any provenance. Do not add markdown or hidden reasoning."
        )
    return {
        "instruction": instruction,
        "targetLanguage": target_language,
        "rawSegments": [
            _prompt_segment(segment, target_language=target_language) for segment in segments
        ],
    }


def plan_structuring_batches(
    segments: Sequence[object],
    *,
    target_language: str | None,
    num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
    num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
    schema: StructuringSchema | None = None,
) -> list[StructuringBatchPlan]:
    """Plan conservative UTF-8-token-bounded batches for a host LLM.

    Args:
        segments: Raw segments to partition into provider requests.
        target_language: Translation language, or ``None`` for identity mode.
        num_ctx: Maximum context budget for a provider request.
        num_predict: Maximum generated-token budget for a provider request.
        schema: Optional semantic response schema; defaults to the canonical schema.

    Returns:
        Batch plans preserving raw segment order.

    Raises:
        ValueError: If the configured context/output budgets are inconsistent.
        StructuringValidationError: If a schema or individual segment cannot fit.
    """

    if num_predict <= OUTPUT_RESERVE_TOKENS:
        raise ValueError("Capture structuring output budget is too small")
    if num_ctx <= num_predict + CONTEXT_RESERVE_TOKENS:
        raise ValueError("Capture structuring context budget is too small")
    input_limit = num_ctx - num_predict - CONTEXT_RESERVE_TOKENS
    output_limit = num_predict - OUTPUT_RESERVE_TOKENS
    empty_prompt = build_structuring_batch_prompt((), target_language=target_language)
    batch_schema = (
        schema if schema is not None else structuring_batch_schema(target_language=target_language)
    )
    fixed_input = _estimated_json_tokens(
        {
            "prompt": empty_prompt,
            "format": batch_schema,
        }
    )
    fixed_output = _estimated_json_tokens({"blocks": []})
    if fixed_input >= input_limit or fixed_output >= output_limit:
        raise StructuringValidationError(
            "Capture structuring schema does not fit the configured provider budget."
        )

    plans: list[StructuringBatchPlan] = []
    current: list[object] = []
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
            segment_wire = _segment_wire(segment)
            raise StructuringValidationError(
                f"Raw segment {segment_wire.get('segmentId')!r} exceeds the provider token budget.",
                issues=[{"location": ["rawSegments"], "message": "must fit one structuring batch"}],
            )
        current.append(segment)
        current_input = next_input
        current_output = next_output

    if current:
        plans.append(StructuringBatchPlan(tuple(current), current_input, current_output))
    return plans


def structuring_batch_generation_options(
    plan: StructuringBatchPlan,
    *,
    max_num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
    max_num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
) -> tuple[int, int]:
    """Calculate adaptive provider budgets for one planned batch.

    Args:
        plan: Batch whose estimated usage drives the request budgets.
        max_num_ctx: Upper bound for the provider context budget.
        max_num_predict: Upper bound for generated tokens.

    Returns:
        A ``(num_ctx, num_predict)`` tuple for the provider request.
    """

    num_predict = min(
        max_num_predict,
        max(MIN_REQUEST_TOKENS, plan.output_tokens + OUTPUT_RESERVE_TOKENS),
    )
    num_ctx = min(
        max_num_ctx,
        max(MIN_REQUEST_TOKENS, plan.input_tokens + num_predict + CONTEXT_RESERVE_TOKENS),
    )
    return num_ctx, num_predict


def _validation_issues(error: ValidationError) -> list[dict[str, object]]:
    """Translate Pydantic errors into the SDK's stable issue shape."""

    return [
        {
            "location": [str(part) for part in issue["loc"]],
            "message": issue["msg"],
            "type": issue["type"],
        }
        for issue in error.errors()
    ]


def _decode_candidate(
    candidate: bytes | bytearray | str | Mapping[str, object] | object,
) -> WireObject:
    """Decode bytes/text/model candidates into one JSON object."""

    if isinstance(candidate, (bytes, bytearray)):
        try:
            decoded = json.loads(bytes(candidate).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise StructuringValidationError(
                "structuring output is not valid UTF-8 JSON"
            ) from error
    elif isinstance(candidate, str):
        try:
            decoded = json.loads(candidate)
        except json.JSONDecodeError as error:
            raise StructuringValidationError("structuring output is not valid JSON") from error
    elif isinstance(candidate, Mapping):
        decoded = dict(candidate)
    else:
        model_dump = getattr(candidate, "model_dump", None)
        if not callable(model_dump):
            raise StructuringValidationError("structuring output must be a JSON object")
        decoded = model_dump(mode="json", by_alias=True)
    if not isinstance(decoded, Mapping):
        raise StructuringValidationError("structuring output must be a JSON object")
    return {str(key): _wire_nested(value) for key, value in decoded.items()}


def _schema_error_issues(errors: Sequence[object]) -> list[dict[str, object]]:
    """Translate jsonschema errors into location/message issue dictionaries."""

    issues: list[dict[str, object]] = []
    for error in errors:
        path = getattr(error, "absolute_path", ())
        message = getattr(error, "message", "schema validation failed")
        issues.append({"location": [str(part) for part in path], "message": message})
    return issues


def _validate_schema(value: Mapping[str, object], name: str) -> None:
    """Validate one wire object against a pinned Capture Contracts schema."""

    validator = Draft202012Validator(load_contract_schema(name), format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(value), key=lambda error: list(error.absolute_path))
    if errors:
        raise StructuringValidationError(
            f"structuring output does not satisfy {name}",
            issues=_schema_error_issues(errors),
        )


def validate_structuring_candidate(
    candidate: bytes | bytearray | str | Mapping[str, object] | object,
    raw: WireInput,
) -> WireObject:
    """Validate the pinned document schema and preserve extraction provenance.

    Args:
        candidate: JSON bytes, JSON text, mapping, or Pydantic-like candidate.
        raw: Canonical raw capture whose extraction fields must be unchanged.

    Returns:
        The schema- and provenance-validated document wire object.

    Raises:
        StructuringValidationError: If schema or provenance validation fails.
    """

    document = _decode_candidate(candidate)
    raw_wire = _wire(raw)
    _validate_schema(raw_wire, "RawCaptureV1")
    _validate_schema(document, "CaptureDocumentV1")

    mismatches: list[str] = []
    provenance = {
        "source": (document.get("source"), raw_wire.get("source")),
        "rawSegments": (document.get("rawSegments"), raw_wire.get("segments")),
        "sourceText": (document.get("sourceText"), raw_wire.get("sourceText")),
        "extractionEngine": (
            document.get("extractionEngine"),
            raw_wire.get("extractionEngine"),
        ),
        "createdAt": (document.get("createdAt"), raw_wire.get("createdAt")),
    }
    for field, (actual, expected) in provenance.items():
        if actual != expected:
            mismatches.append(field)
    raw_warnings = raw_wire.get("warnings", [])
    document_warnings = document.get("warnings", [])
    if isinstance(raw_warnings, list) and isinstance(document_warnings, list):
        if not set(raw_warnings).issubset(document_warnings):
            mismatches.append("warnings")
    elif raw_warnings != document_warnings:
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
    candidate: StructuringCandidate,
    segments: Sequence[object],
    *,
    target_language: str | None,
) -> list[WireObject]:
    """Rebuild canonical blocks from only model-owned semantic fields.

    Args:
        candidate: JSON bytes, JSON text, or decoded semantic batch candidate.
        segments: Raw segments covered by this batch, in source order.
        target_language: Translation language, or ``None`` for identity mode.

    Returns:
        Blocks with trusted IDs, order, locators, and source text.

    Raises:
        StructuringValidationError: If semantic fields or ordered coverage fail.
    """

    decoded = _decode_candidate(candidate)
    semantic_blocks: Sequence[CaptureIdentitySemanticBlockV1 | CaptureSemanticBlockV1]
    try:
        if target_language is None:
            semantic_blocks = CaptureIdentityBlockBatchV1.model_validate(
                decoded, strict=True
            ).blocks
        else:
            semantic_blocks = CaptureBlockBatchV1.model_validate(decoded, strict=True).blocks
    except ValidationError as error:
        raise StructuringValidationError(
            "structuring batch semantic fields do not satisfy CaptureBlockBatchV1",
            issues=_validation_issues(error),
        ) from error
    if len(semantic_blocks) != len(segments):
        raise StructuringValidationError(
            "structuring batch must cover every supplied segment exactly once",
            issues=[{"location": ["blocks"], "message": "count must equal raw segments"}],
        )

    canonical_blocks: list[WireObject] = []
    for index, (semantic_block, segment) in enumerate(zip(semantic_blocks, segments, strict=True)):
        common_semantics = cast(_ValidatedSemanticBlock, semantic_block)
        segment_wire = _segment_wire(segment)
        segment_id = _required_string(segment_wire.get("segmentId"), "segmentId")
        if common_semantics.source_segment_id != segment_id:
            raise StructuringValidationError(
                "structuring batch must retain ordered source segment identity",
                issues=[
                    {
                        "location": ["blocks", str(index), "sourceSegmentId"],
                        "message": "must equal the ordered raw segment identifier",
                    }
                ],
            )
        target_text = segment_wire.get("text")
        if not isinstance(target_text, str):
            raise StructuringValidationError("raw segment text must be a string")
        if target_language is not None:
            translated_semantics = cast(CaptureSemanticBlockV1, semantic_block)
            if translated_semantics.target_text is None:
                raise StructuringValidationError(
                    "translated structuring batch must provide targetText",
                    issues=[
                        {
                            "location": ["blocks", str(index), "targetText"],
                            "message": "is required when targetLanguage is set",
                        }
                    ],
                )
            target_text = translated_semantics.target_text
        locator = segment_wire.get("locator")
        if not isinstance(locator, Mapping):
            raise StructuringValidationError("raw segment locator must be an object")
        canonical_blocks.append(
            {
                "blockId": f"block-{segment_id}",
                "order": index,
                "type": common_semantics.type,
                "sourceSegmentId": segment_id,
                "locator": dict(locator),
                "sourceText": segment_wire.get("text"),
                "targetText": target_text,
            }
        )
    return canonical_blocks


def assemble_structuring_document(
    raw: WireInput,
    blocks: Sequence[object],
    *,
    engine_identity: WireInput,
    completed_at: datetime | str,
) -> WireObject:
    """Build deterministic envelope fields and validate the document schema.

    Args:
        raw: Canonical raw capture supplying source and extraction provenance.
        blocks: Canonical blocks reconstructed from semantic model output.
        engine_identity: Trusted identity of the structuring engine.
        completed_at: Trusted completion timestamp as a datetime or ISO string.

    Returns:
        A schema- and provenance-validated document wire object.
    """

    raw_wire = _wire(raw)
    block_wires = [_wire(block) for block in blocks]
    document: WireObject = {
        "schemaVersion": raw_wire.get("schemaVersion", "1"),
        "source": raw_wire.get("source"),
        "rawSegments": raw_wire.get("segments"),
        "blocks": block_wires,
        "sourceText": raw_wire.get("sourceText"),
        "targetText": "\n".join(str(block["targetText"]) for block in block_wires),
        "extractionEngine": raw_wire.get("extractionEngine"),
        "structuringEngine": _wire(engine_identity),
        "warnings": raw_wire.get("warnings", []),
        "createdAt": raw_wire.get("createdAt"),
        "completedAt": completed_at.isoformat()
        if isinstance(completed_at, datetime)
        else completed_at,
    }
    return validate_structuring_candidate(document, raw)


async def structure_capture(
    raw: WireInput,
    *,
    llm_generate: LlmGenerate,
    structuring_engine: WireInput,
    target_language: str | None = None,
    completed_at: datetime | str | None = None,
    num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
    num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
    schema: StructuringSchema | None = None,
) -> WireObject:
    """Structure a raw capture through a host-owned ``llm_generate`` callable.

    Args:
        raw: Canonical raw capture to structure.
        llm_generate: Host callback receiving one prompt/schema pair at a time.
        structuring_engine: Trusted engine identity for the assembled document.
        target_language: Translation language, or ``None`` for identity mode.
        completed_at: Trusted completion timestamp; defaults to the current UTC time.
        num_ctx: Maximum context budget for each request.
        num_predict: Maximum generated-token budget for each request.
        schema: Optional semantic response schema; defaults to the canonical schema.

    Returns:
        The assembled schema- and provenance-validated document wire object.

    Raises:
        StructuringValidationError: If a host response is invalid or unsafe.
    """

    raw_wire = _wire(raw)
    _validate_schema(raw_wire, "RawCaptureV1")
    raw_segments = raw_wire.get("segments")
    if not isinstance(raw_segments, list):
        raise StructuringValidationError("raw capture segments must be an array")
    batch_schema = (
        schema if schema is not None else structuring_batch_schema(target_language=target_language)
    )
    plans = plan_structuring_batches(
        raw_segments,
        target_language=target_language,
        num_ctx=num_ctx,
        num_predict=num_predict,
        schema=batch_schema,
    )
    blocks: list[WireObject] = []
    for plan in plans:
        prompt = build_structuring_batch_prompt(plan.segments, target_language=target_language)
        response = llm_generate(prompt, batch_schema)
        candidate = await response if inspect.isawaitable(response) else response
        if not isinstance(candidate, (bytes, bytearray, str)):
            raise StructuringValidationError(
                "llm_generate must return UTF-8 JSON bytes or JSON text"
            )
        blocks.extend(
            validate_structuring_batch(
                candidate,
                plan.segments,
                target_language=target_language,
            )
        )
    return assemble_structuring_document(
        raw,
        blocks,
        engine_identity=structuring_engine,
        completed_at=completed_at or datetime.now(UTC),
    )


__all__ = [
    "CAPTURE_BLOCK_BATCH_SCHEMA",
    "CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA",
    "DEFAULT_STRUCTURING_NUM_CTX",
    "DEFAULT_STRUCTURING_NUM_PREDICT",
    "LlmGenerate",
    "OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA",
    "OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA",
    "CaptureBlockBatchV1",
    "CaptureIdentityBlockBatchV1",
    "CaptureIdentitySemanticBlockV1",
    "CaptureSemanticBlockV1",
    "StructuringBatchPlan",
    "StructuringCandidate",
    "StructuringSchema",
    "StructuringValidationError",
    "assemble_structuring_document",
    "build_structuring_batch_prompt",
    "ollama_structuring_batch_schema",
    "plan_structuring_batches",
    "structure_capture",
    "structuring_batch_schema",
    "structuring_batch_generation_options",
    "validate_structuring_batch",
    "validate_structuring_candidate",
]
