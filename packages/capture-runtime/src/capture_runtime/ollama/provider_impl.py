"""Ollama-backed structuring provider implementation."""

from __future__ import annotations

import asyncio
import json
import re

import httpx

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureBlockV1,
    CaptureEngineV1,
    RawCaptureSegmentV1,
    RawCaptureV1,
)
from capture_runtime.ollama.lifecycle_impl import IsolatedOllamaLifecycle, RuntimeUnavailableError
from capture_runtime.structuring import (
    DEFAULT_STRUCTURING_NUM_CTX,
    DEFAULT_STRUCTURING_NUM_PREDICT,
    assemble_structuring_document,
    build_structuring_batch_prompt,
    ollama_structuring_batch_schema,
    plan_structuring_batches,
    structuring_batch_generation_options,
    validate_structuring_batch,
)


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
        self._lifecycle.start()
        engine_identity = await self._wait_until_ready(cancel_event)
        self._engine_identity = engine_identity
        plans = plan_structuring_batches(
            raw.segments,
            target_language=target_language,
            num_ctx=self._num_ctx,
            num_predict=self._num_predict,
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
            engine_identity=engine_identity,
            completed_at=self._clock.now(),
        )

    async def _generate_batch(
        self,
        client: httpx.AsyncClient,
        segments: tuple[RawCaptureSegmentV1, ...],
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
        num_ctx: int,
        num_predict: int,
    ) -> str:
        self._require_owned_process()
        prompt = build_structuring_batch_prompt(segments, target_language=target_language)
        request = asyncio.create_task(
            client.post(
                "/api/generate",
                json={
                    "model": self._lifecycle.config.profile_id,
                    "stream": False,
                    "think": False,
                    "format": ollama_structuring_batch_schema(target_language=target_language),
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

    async def _wait_until_ready(self, cancel_event: asyncio.Event) -> CaptureEngineV1:
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
                                self._lifecycle.config.profile_id,
                                f"{self._lifecycle.config.profile_id}:latest",
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
                                model=self._lifecycle.config.profile_id,
                                digest=digest,
                                device="local",
                            )
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)
        raise RuntimeUnavailableError("isolated Ollama profile did not become ready")

    def _require_owned_process(self) -> None:
        if not self._lifecycle.owns_running_process():
            raise RuntimeUnavailableError(
                "isolated Ollama process stopped before provider response validation"
            )
