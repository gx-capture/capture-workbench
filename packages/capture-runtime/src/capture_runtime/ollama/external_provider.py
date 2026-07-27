"""Ollama provider for an endpoint owned by the host environment."""

from __future__ import annotations

import asyncio
import json
import re

import httpx

from capture_runtime.clock import Clock
from capture_runtime.config import ExternalOllamaConfig
from capture_runtime.contracts import (
    CaptureBlockV1,
    CaptureEngineV1,
    RawCaptureSegmentV1,
    RawCaptureV1,
)
from capture_runtime.ollama.lifecycle_impl import RuntimeUnavailableError
from capture_runtime.structuring import (
    CAPTURE_BLOCK_BATCH_SCHEMA,
    DEFAULT_STRUCTURING_NUM_CTX,
    DEFAULT_STRUCTURING_NUM_PREDICT,
    assemble_structuring_document,
    build_structuring_batch_prompt,
    plan_structuring_batches,
    structuring_batch_generation_options,
    validate_structuring_batch,
)


class ExternalOllamaCaptureStructuringProvider:
    """Structure bounded batches through a caller-owned Ollama endpoint."""

    def __init__(
        self,
        config: ExternalOllamaConfig,
        *,
        clock: Clock,
        request_timeout_seconds: float = 180,
        num_ctx: int = DEFAULT_STRUCTURING_NUM_CTX,
        num_predict: int = DEFAULT_STRUCTURING_NUM_PREDICT,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._config = config
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
        engine_identity = await self._wait_until_ready(cancel_event)
        self._engine_identity = engine_identity
        plans = plan_structuring_batches(
            raw.segments,
            target_language=target_language,
            num_ctx=self._num_ctx,
            num_predict=self._num_predict,
        )
        async with httpx.AsyncClient(
            base_url=self._config.endpoint_url,
            headers=self._headers(),
            timeout=self._timeout,
            follow_redirects=False,
            transport=self._transport,
        ) as client:
            blocks: list[CaptureBlockV1] = []
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
                blocks.extend(validate_structuring_batch(candidate, plan.segments))
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
        prompt = build_structuring_batch_prompt(segments, target_language=target_language)
        request = asyncio.create_task(
            client.post(
                "/api/generate",
                json={
                    "model": self._config.model,
                    "stream": False,
                    "format": CAPTURE_BLOCK_BATCH_SCHEMA,
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
            try:
                response = await request
                response.raise_for_status()
                payload = response.json()
            except (httpx.HTTPError, ValueError) as error:
                raise RuntimeUnavailableError("external Ollama generation failed") from error
            candidate = payload.get("response") if isinstance(payload, dict) else None
            if not isinstance(candidate, str):
                raise RuntimeUnavailableError(
                    "external Ollama response did not contain a JSON candidate string"
                )
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
            base_url=self._config.endpoint_url,
            headers=self._headers(),
            timeout=2,
            follow_redirects=False,
            transport=self._transport,
        ) as client:
            while asyncio.get_running_loop().time() < deadline:
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                try:
                    response = await client.get("/api/tags")
                    response.raise_for_status()
                    payload = response.json()
                except (httpx.HTTPError, ValueError) as error:
                    raise RuntimeUnavailableError(
                        "external Ollama readiness check failed"
                    ) from error
                models = payload.get("models", []) if isinstance(payload, dict) else []
                for model in models if isinstance(models, list) else []:
                    if not isinstance(model, dict):
                        continue
                    name = str(model.get("name") or model.get("model") or "")
                    if name not in {self._config.model, f"{self._config.model}:latest"}:
                        continue
                    digest = str(model.get("digest") or "")
                    if re.fullmatch(r"[0-9a-f]{64}", digest):
                        digest = f"sha256:{digest}"
                    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
                        raise RuntimeUnavailableError(
                            "external Ollama returned an invalid model digest"
                        )
                    return CaptureEngineV1(
                        engine="ollama",
                        model=self._config.model,
                        digest=digest,
                        device="remote",
                    )
                await asyncio.sleep(0.2)
        raise RuntimeUnavailableError("configured external Ollama model did not become ready")

    def _headers(self) -> dict[str, str]:
        if self._config.api_key is None:
            return {}
        return {"Authorization": f"Bearer {self._config.api_key}"}


__all__ = ["ExternalOllamaCaptureStructuringProvider"]
