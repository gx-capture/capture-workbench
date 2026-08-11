"""Ollama-backed structuring provider implementation."""

from __future__ import annotations

import asyncio
import json
import re
from copy import deepcopy
from typing import cast

import httpx
from capture_structuring import (
    DEFAULT_STRUCTURING_NUM_CTX,
    DEFAULT_STRUCTURING_NUM_PREDICT,
    assemble_structuring_document,
    build_structuring_batch_prompt,
    ollama_structuring_batch_schema,
    plan_structuring_batches,
    structuring_batch_generation_options,
    validate_structuring_batch,
)

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureBlockV1,
    CaptureDocumentV1,
    CaptureEngineV1,
    RawCaptureV1,
)
from capture_runtime.model_catalog import model_option
from capture_runtime.ollama.lifecycle_impl import IsolatedOllamaLifecycle, RuntimeUnavailableError

_QWEN_0_8B_PROFILE_ID = model_option("qwen3.5-0.8b-v1").profile_id


def _single_segment_generation_schema(
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
        "CaptureIdentitySemanticBlockV1" if target_language is None else "CaptureSemanticBlockV1"
    )
    block_definition = cast(dict[str, object], definitions[definition_name])
    block_properties = cast(dict[str, object], block_definition["properties"])
    source_segment_property = cast(dict[str, object], block_properties["sourceSegmentId"])
    source_segment_property["enum"] = [source_segment_id]
    return schema


class OllamaCaptureStructuringProvider:
    """Structure bounded batches through the isolated Ollama profile."""

    def __init__(
        self,
        lifecycle: IsolatedOllamaLifecycle,
        *,
        clock: Clock,
        request_timeout_seconds: float = 180,
        num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
        num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._lifecycle = lifecycle
        self._clock = clock
        self._timeout = request_timeout_seconds
        self._num_ctx = num_ctx
        self._num_predict = num_predict
        self._transport = transport
        self._engine_identity: CaptureEngineV1 | None = None
        self._structure_lock = asyncio.Lock()

    @property
    def engine_identity(self) -> CaptureEngineV1 | None:
        return self._engine_identity

    async def structure(
        self,
        raw: RawCaptureV1,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object:
        async with self._structure_lock:
            return await self._structure_exclusive(
                raw,
                target_language=target_language,
                cancel_event=cancel_event,
            )

    async def _structure_exclusive(
        self,
        raw: RawCaptureV1,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object:
        profile_id = self._selected_profile_id()
        self._lifecycle.start()
        try:
            engine_identity = await self._wait_until_ready(cancel_event, profile_id)
            self._engine_identity = engine_identity
            if profile_id == _QWEN_0_8B_PROFILE_ID:
                plans = [
                    plan
                    for segment in raw.segments
                    for plan in plan_structuring_batches(
                        (segment,),
                        target_language=target_language,
                        num_ctx=self._num_ctx,
                        num_predict=self._num_predict,
                        schema=_single_segment_generation_schema(
                            (segment,), target_language=target_language
                        ),
                    )
                ]
            else:
                plans = plan_structuring_batches(
                    raw.segments,
                    target_language=target_language,
                    num_ctx=self._num_ctx,
                    num_predict=self._num_predict,
                    schema=ollama_structuring_batch_schema(target_language=target_language),
                )
            blocks: list[CaptureBlockV1] = []
            async with httpx.AsyncClient(
                base_url=self._lifecycle.config.host_url,
                timeout=self._timeout,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                for plan in plans:
                    if cancel_event.is_set():
                        raise asyncio.CancelledError
                    num_ctx, num_predict = structuring_batch_generation_options(
                        plan,
                        max_num_ctx=self._num_ctx,
                        max_num_predict=self._num_predict,
                    )
                    candidate = await self._generate_batch(
                        client,
                        plan.segments,
                        target_language=target_language,
                        cancel_event=cancel_event,
                        num_ctx=num_ctx,
                        num_predict=num_predict,
                        profile_id=profile_id,
                    )
                    blocks.extend(
                        CaptureBlockV1.model_validate(block)
                        for block in validate_structuring_batch(
                            candidate,
                            plan.segments,
                            target_language=target_language,
                            order_offset=len(blocks),
                        )
                    )
            return CaptureDocumentV1.model_validate(
                assemble_structuring_document(
                    raw,
                    blocks,
                    engine_identity=engine_identity,
                    completed_at=self._clock.now(),
                )
            )
        finally:
            # The process owns native model allocations beyond one request.
            # End the bounded per-document lease before another extractor,
            # especially Whisper CPU fallback, needs those resources.
            self._lifecycle.stop()

    async def _generate_batch(
        self,
        client: httpx.AsyncClient,
        segments: tuple[object, ...],
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
        num_ctx: int,
        num_predict: int,
        profile_id: str,
    ) -> str:
        self._require_owned_process()
        prompt = build_structuring_batch_prompt(segments, target_language=target_language)
        generation_schema = (
            _single_segment_generation_schema(segments, target_language=target_language)
            if profile_id == _QWEN_0_8B_PROFILE_ID
            else ollama_structuring_batch_schema(target_language=target_language)
        )
        request = asyncio.create_task(
            client.post(
                "/api/generate",
                json={
                    "model": profile_id,
                    "stream": False,
                    "think": False,
                    # Keep the selected model resident for the bounded
                    # document lease. Qwen 0.8B uses one request per raw
                    # segment; unloading between requests turns a normal
                    # progressive capture into an unusably slow sequence of
                    # cold starts. The lifecycle stop in the outer finally
                    # still releases the owned process after the document.
                    "keep_alive": -1,
                    "format": generation_schema,
                    "prompt": json.dumps(prompt, ensure_ascii=False, separators=(",", ":")),
                    "options": {"num_ctx": num_ctx, "num_predict": num_predict},
                },
            )
        )
        cancellation = asyncio.create_task(cancel_event.wait())
        try:
            done, _ = await asyncio.wait(
                {request, cancellation}, return_when=asyncio.FIRST_COMPLETED
            )
            if cancellation in done and cancel_event.is_set():
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)
                raise asyncio.CancelledError
            response = await request
            self._require_owned_process()
            response.raise_for_status()
            payload = response.json()
            candidate = payload.get("response")
            if not isinstance(candidate, str):
                raise RuntimeError("Ollama response did not contain a JSON candidate string")
            return candidate
        finally:
            cancellation.cancel()
            await asyncio.gather(cancellation, return_exceptions=True)
            if not request.done():
                request.cancel()
                await asyncio.gather(request, return_exceptions=True)

    async def _wait_until_ready(
        self, cancel_event: asyncio.Event, profile_id: str
    ) -> CaptureEngineV1:
        deadline = asyncio.get_running_loop().time() + 30
        async with httpx.AsyncClient(
            base_url=self._lifecycle.config.host_url,
            timeout=2,
            follow_redirects=False,
            transport=self._transport,
        ) as client:
            while asyncio.get_running_loop().time() < deadline:
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                self._require_owned_process()
                try:
                    response = await client.get("/api/tags")
                    self._require_owned_process()
                    if response.status_code == 200:
                        models = response.json().get("models", [])
                        for model in models:
                            name = str(model.get("name") or model.get("model") or "")
                            if name not in {
                                profile_id,
                                f"{profile_id}:latest",
                            }:
                                continue
                            digest = str(model.get("digest") or "")
                            if re.fullmatch(r"[0-9a-f]{64}", digest):
                                digest = f"sha256:{digest}"
                            if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                                raise RuntimeUnavailableError(
                                    "isolated Ollama returned an invalid model digest"
                                )
                            return CaptureEngineV1(
                                engine="ollama",
                                model=profile_id,
                                digest=digest,
                                device="local",
                            )
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)
        raise RuntimeUnavailableError("isolated Ollama profile did not become ready")

    def _selected_profile_id(self) -> str:
        selection_reader = getattr(self._lifecycle, "active_model_selection", None)
        if not callable(selection_reader):
            return self._lifecycle.config.profile_id
        selection = selection_reader()
        if selection is not None:
            profile_id = selection.get("profileId")
            if isinstance(profile_id, str) and profile_id:
                return profile_id
        legacy_marker = (
            self._lifecycle.config.app_data_dir / "requirements" / "capture-ollama-model.ready.json"
        )
        if legacy_marker.is_file():
            return self._lifecycle.config.profile_id
        raise RuntimeUnavailableError("model_selection_required")

    def _require_owned_process(self) -> None:
        if not self._lifecycle.owns_running_process():
            raise RuntimeUnavailableError(
                "isolated Ollama process stopped before provider response validation"
            )
