"""Ollama-backed structuring provider implementation."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import httpx

from capture_runtime.clock import Clock
from capture_runtime.contracts import CaptureEngine, RawCapture
from capture_runtime.structuring.infrastructure.constants import (
    DEFAULT_STRUCTURING_NUM_CTX,
    DEFAULT_STRUCTURING_NUM_PREDICT,
)
from capture_runtime.structuring.infrastructure.coordinator import (
    StructuringCoordinator,
    StructuringGenerationRequest,
)
from capture_runtime.structuring.infrastructure.model_catalog import (
    MODEL_OPTIONS,
    legacy_profile_id,
    model_option,
)
from capture_runtime.structuring.infrastructure.ollama.lifecycle_impl import (
    IsolatedOllamaLifecycle,
    RuntimeUnavailableError,
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
        async with self._lifecycle.lease(cancel_event):
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
        model_name = self._selected_model_name()
        profile_id = _planning_profile_id(model_name)
        self._lifecycle.start()
        try:
            engine_identity = await self._wait_until_ready(cancel_event, model_name)
            self._engine_identity = engine_identity
            async with httpx.AsyncClient(
                base_url=self._lifecycle.host_url,
                timeout=self._timeout,
                follow_redirects=False,
                trust_env=False,
                transport=self._transport,
            ) as client:

                async def generate(request: StructuringGenerationRequest) -> str:
                    return await self._generate_batch(
                        client,
                        request,
                        cancel_event=cancel_event,
                        model_name=model_name,
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
            # especially speech recognition CPU fallback, needs those resources.
            self._lifecycle.stop()

    async def _generate_batch(
        self,
        client: httpx.AsyncClient,
        generation_request: StructuringGenerationRequest,
        *,
        cancel_event: asyncio.Event,
        model_name: str,
    ) -> str:
        self._require_owned_process(str(client.base_url).rstrip("/"))
        request = asyncio.create_task(
            client.post(
                "/api/generate",
                json={
                    "model": model_name,
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
            self._require_owned_process(str(client.base_url).rstrip("/"))
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
        self, cancel_event: asyncio.Event, model_name: str
    ) -> CaptureEngine:
        deadline = asyncio.get_running_loop().time() + 30
        async with httpx.AsyncClient(
            base_url=self._lifecycle.host_url,
            timeout=2,
            follow_redirects=False,
            trust_env=False,
            transport=self._transport,
        ) as client:
            while asyncio.get_running_loop().time() < deadline:
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                self._require_owned_process(str(client.base_url).rstrip("/"))
                try:
                    response = await client.get("/api/tags")
                    self._require_owned_process(str(client.base_url).rstrip("/"))
                    if response.status_code == 200:
                        models = response.json().get("models", [])
                        for model in models:
                            name = str(model.get("name") or model.get("model") or "")
                            if name not in {
                                model_name,
                                f"{model_name}:latest",
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
                                model=model_name,
                                digest=digest,
                                device="local",
                            )
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.2)
        raise RuntimeUnavailableError("isolated Ollama profile did not become ready")

    def _selected_model_name(self) -> str:
        """Return the Ollama model the verified selection or install marker names.

        A selection or marker written before profile ids lost their consumer
        prefix names the model under its old name; it is used only when it
        matches the expected option and its digests.
        """

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
            marker_profile = _verified_marker_profile_id(
                legacy_marker, self._lifecycle.config.profile_id
            )
            if marker_profile is not None:
                return marker_profile
        raise RuntimeUnavailableError("model_selection_required")

    def _require_owned_process(self, expected_url: str) -> None:
        # The lease must still be the one this client was created for: an
        # installation can restart Ollama on another port while a capture waits.
        if not self._lifecycle.owns_running_process() or self._lifecycle.host_url != expected_url:
            raise RuntimeUnavailableError(
                "isolated Ollama process stopped before provider response validation"
            )


def _planning_profile_id(model_name: str) -> str:
    """Plan batches for the option's current profile, also under its old model name."""

    for option in MODEL_OPTIONS:
        if model_name in {option.profile_id, legacy_profile_id(option)}:
            return option.profile_id
    return model_name


def _verified_marker_profile_id(marker: Path, expected_profile_id: str) -> str | None:
    """Return the marker's profile only when it records the expected option's digests."""

    option = next(
        (option for option in MODEL_OPTIONS if option.profile_id == expected_profile_id),
        None,
    )
    if option is None:
        return None
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    profile_id = payload.get("profileId")
    if (
        profile_id in {option.profile_id, legacy_profile_id(option)}
        and payload.get("baseModel") == option.model_reference
        and payload.get("modelfileSha256") == option.profile_spec_sha256
    ):
        return str(profile_id)
    return None
