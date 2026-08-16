"""Ollama-backed structuring provider implementation."""

from __future__ import annotations

import asyncio
import json
import re

import httpx

from capture_runtime.clock import Clock
from capture_runtime.contracts import CaptureEngine, RawCapture
from capture_runtime.model_catalog import model_option
from capture_runtime.ollama.lifecycle_impl import IsolatedOllamaLifecycle, RuntimeUnavailableError
from capture_runtime.structuring import (
    DEFAULT_STRUCTURING_NUM_CTX,
    DEFAULT_STRUCTURING_NUM_PREDICT,
    StructuringCoordinator,
    StructuringGenerationRequest,
)

_QWEN_0_8B_PROFILE_ID = model_option("qwen3.5-0.8b-v1").profile_id


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
        self._coordinator = StructuringCoordinator(
            num_ctx=num_ctx,
            num_predict=num_predict,
            single_segment_profile_id=_QWEN_0_8B_PROFILE_ID,
        )
        self._engine_identity: CaptureEngine | None = None
        self._structure_lock = asyncio.Lock()

    @property
    def engine_identity(self) -> CaptureEngine | None:
        return self._engine_identity

    async def structure(
        self,
        raw: RawCapture,
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
        raw: RawCapture,
        *,
        target_language: str | None,
        cancel_event: asyncio.Event,
    ) -> object:
        profile_id = self._selected_profile_id()
        self._lifecycle.start()
        try:
            engine_identity = await self._wait_until_ready(cancel_event, profile_id)
            self._engine_identity = engine_identity
            async with httpx.AsyncClient(
                base_url=self._lifecycle.config.host_url,
                timeout=self._timeout,
                follow_redirects=False,
                transport=self._transport,
            ) as client:

                async def generate(request: StructuringGenerationRequest) -> str:
                    return await self._generate_batch(
                        client,
                        request,
                        cancel_event=cancel_event,
                        profile_id=profile_id,
                    )

                return await self._coordinator.structure(
                    raw,
                    target_language=target_language,
                    cancel_event=cancel_event,
                    engine_identity=engine_identity,
                    completed_at=self._clock.now,
                    profile_id=profile_id,
                    generate=generate,
                )
        finally:
            # The process owns native model allocations beyond one request.
            # End the bounded per-document lease before another extractor,
            # especially Whisper CPU fallback, needs those resources.
            self._lifecycle.stop()

    async def _generate_batch(
        self,
        client: httpx.AsyncClient,
        generation_request: StructuringGenerationRequest,
        *,
        cancel_event: asyncio.Event,
        profile_id: str,
    ) -> str:
        self._require_owned_process()
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
                    "format": generation_request.schema,
                    "prompt": json.dumps(
                        generation_request.prompt,
                        ensure_ascii=False,
                        separators=(",", ":"),
                    ),
                    "options": {
                        "num_ctx": generation_request.num_ctx,
                        "num_predict": generation_request.num_predict,
                    },
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
    ) -> CaptureEngine:
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
                            return CaptureEngine(
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
