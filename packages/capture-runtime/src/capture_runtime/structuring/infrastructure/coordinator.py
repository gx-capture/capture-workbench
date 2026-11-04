"""Runtime-owned coordinator for provider-backed capture structuring.

Provider adapters own lifecycle and HTTP transport.  This coordinator owns the
provider-neutral request loop: conservative batching, prompt/schema selection,
minimal semantic validation, trusted provenance reconstruction, and canonical
v2 document assembly.
"""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Awaitable, Callable
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime
from typing import cast

from capture_runtime.contracts import CaptureBlock, CaptureDocument, CaptureEngine, RawCapture

from .constants import (
    DEFAULT_STRUCTURING_NUM_CTX,
    DEFAULT_STRUCTURING_NUM_PREDICT,
    ollama_structuring_batch_schema,
)
from .structuring import (
    StructuringBatchPlan,
    StructuringCandidate,
    StructuringValidationError,
    assemble_structuring_document,
    build_structuring_batch_prompt,
    plan_structuring_batches,
    structuring_batch_generation_options,
    validate_structuring_batch,
)

_QWEN_SINGLE_SEGMENT_PROFILE_ID = "capture-workbench-qwen3.5-0.8b-structure-v1"


@dataclass(frozen=True, slots=True)
class StructuringGenerationRequest:
    """One provider request planned by the runtime coordinator."""

    plan: StructuringBatchPlan
    prompt: dict[str, object]
    schema: dict[str, object]
    num_ctx: int
    num_predict: int


StructuringGenerate = Callable[
    [StructuringGenerationRequest], StructuringCandidate | Awaitable[StructuringCandidate]
]
"""Provider callback that performs one already-planned generation request."""


def single_segment_generation_schema(
    segments: tuple[object, ...], *, target_language: str | None
) -> dict[str, object]:
    """Bind tiny-model generation to one exact source segment."""

    prompt = build_structuring_batch_prompt(segments, target_language=target_language)
    prompt_segments = prompt.get("rawSegments")
    if not isinstance(prompt_segments, list) or len(prompt_segments) != 1:
        raise ValueError("single-segment generation requires exactly one raw segment")
    prompt_segment = prompt_segments[0]
    if not isinstance(prompt_segment, dict):
        raise ValueError("single-segment prompt projection must be an object")
    source_segment_id = prompt_segment.get("sourceSegmentId") or prompt_segment.get("segmentId")
    if not isinstance(source_segment_id, str) or not source_segment_id:
        raise ValueError("single-segment prompt projection requires a source segment ID")

    schema = deepcopy(ollama_structuring_batch_schema(target_language=target_language))
    properties = cast(dict[str, object], schema["properties"])
    blocks = cast(dict[str, object], properties["blocks"])
    blocks["minItems"] = 1
    blocks["maxItems"] = 1
    definitions = cast(dict[str, object], schema["$defs"])
    definition_name = (
        "CaptureIdentitySemanticBlock" if target_language is None else "CaptureSemanticBlock"
    )
    block_definition = cast(dict[str, object], definitions[definition_name])
    block_properties = cast(dict[str, object], block_definition["properties"])
    source_segment_property = cast(dict[str, object], block_properties["sourceSegmentId"])
    source_segment_property["enum"] = [source_segment_id]
    return schema


class StructuringCoordinator:
    """Coordinate bounded provider requests into one canonical v2 document."""

    def __init__(
        self,
        *,
        num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
        num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
        single_segment_profile_id: str | None = _QWEN_SINGLE_SEGMENT_PROFILE_ID,
    ) -> None:
        self._num_ctx = num_ctx
        self._num_predict = num_predict
        self._single_segment_profile_id = single_segment_profile_id

    async def structure(
        self,
        raw: RawCapture,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
        engine_identity: CaptureEngine,
        completed_at: datetime | Callable[[], datetime],
        profile_id: str,
        generate: StructuringGenerate,
    ) -> CaptureDocument:
        """Generate and validate all batches for one runtime capture."""

        requests = self.plan_requests(
            raw,
            target_language=target_language,
            profile_id=profile_id,
        )
        blocks: list[CaptureBlock] = []
        for request in requests:
            if cancel_event.is_set():
                raise asyncio.CancelledError
            response = generate(request)
            candidate = await response if inspect.isawaitable(response) else response
            if not isinstance(candidate, (bytes, bytearray, str)):
                raise StructuringValidationError(
                    "provider generation must return UTF-8 JSON bytes or JSON text"
                )
            blocks.extend(
                CaptureBlock.model_validate(block)
                for block in validate_structuring_batch(
                    candidate,
                    request.plan.segments,
                    target_language=target_language,
                    order_offset=len(blocks),
                )
            )

        completion_time = completed_at() if callable(completed_at) else completed_at
        document = assemble_structuring_document(
            raw,
            blocks,
            engine_identity=engine_identity,
            completed_at=completion_time,
        )
        return CaptureDocument.model_validate(document)

    def plan_requests(
        self,
        raw: RawCapture,
        *,
        target_language: str | None,
        profile_id: str,
    ) -> tuple[StructuringGenerationRequest, ...]:
        """Prepare deterministic provider-ready requests without generating output.

        Pull-session routes use this read-only projection so provider prompts,
        schemas, and adaptive budgets are produced by the same coordinator as
        the direct provider adapters.
        """

        requests: list[StructuringGenerationRequest] = []
        for plan in self._plans(raw, target_language=target_language, profile_id=profile_id):
            num_ctx, num_predict = structuring_batch_generation_options(
                plan,
                max_num_ctx=self._num_ctx,
                max_num_predict=self._num_predict,
            )
            requests.append(
                StructuringGenerationRequest(
                    plan=plan,
                    prompt=build_structuring_batch_prompt(
                        plan.segments,
                        target_language=target_language,
                    ),
                    schema=self._generation_schema(
                        plan.segments,
                        target_language=target_language,
                        profile_id=profile_id,
                    ),
                    num_ctx=num_ctx,
                    num_predict=num_predict,
                )
            )
        return tuple(requests)

    def _plans(
        self,
        raw: RawCapture,
        *,
        target_language: str | None,
        profile_id: str,
    ) -> list[StructuringBatchPlan]:
        if profile_id == self._single_segment_profile_id:
            return [
                plan
                for segment in raw.segments
                for plan in plan_structuring_batches(
                    (segment,),
                    target_language=target_language,
                    num_ctx=self._num_ctx,
                    num_predict=self._num_predict,
                    schema=single_segment_generation_schema(
                        (segment,),
                        target_language=target_language,
                    ),
                )
            ]
        return plan_structuring_batches(
            raw.segments,
            target_language=target_language,
            num_ctx=self._num_ctx,
            num_predict=self._num_predict,
            schema=ollama_structuring_batch_schema(target_language=target_language),
        )

    def _generation_schema(
        self,
        segments: tuple[object, ...],
        *,
        target_language: str | None,
        profile_id: str,
    ) -> dict[str, object]:
        if profile_id == self._single_segment_profile_id:
            return single_segment_generation_schema(
                segments,
                target_language=target_language,
            )
        return ollama_structuring_batch_schema(target_language=target_language)


__all__ = [
    "StructuringCoordinator",
    "StructuringGenerate",
    "StructuringGenerationRequest",
    "single_segment_generation_schema",
]
