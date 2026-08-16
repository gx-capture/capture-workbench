from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest

from capture_runtime.clock import Clock
from capture_runtime.config import ExternalOllamaConfig
from capture_runtime.contracts import CaptureDocument, RawCapture
from capture_runtime.ollama import (
    ExternalOllamaCaptureStructuringProvider,
    RuntimeUnavailableError,
)

NOW = datetime(2026, 7, 20, 8, 0, tzinfo=UTC)
COMPLETED_AT = datetime(2026, 7, 20, 8, 5, tzinfo=UTC)


class FixedClock(Clock):
    def now(self) -> datetime:
        return COMPLETED_AT


def _raw(*, segment_count: int = 1, text_chars: int = 12) -> RawCapture:
    segments = [
        {
            "segmentId": f"page-{index + 1}",
            "order": index,
            "locator": {"kind": "page", "page": index + 1},
            "text": f"source text {index}-" + ("x" * text_chars),
        }
        for index in range(segment_count)
    ]
    return RawCapture.model_validate(
        {
            "schemaVersion": "2",
            "diagnosticOnly": True,
            "source": {
                "sha256": "a" * 64,
                "fileName": "sample.pdf",
                "mediaType": "application/pdf",
                "bytes": 42,
            },
            "segments": segments,
            "sourceText": "\n".join(segment["text"] for segment in segments),
            "extractionEngine": {
                "engine": "windowsml-ocr",
                "model": "capture-ocr-v1",
                "digest": f"sha256:{'b' * 64}",
                "device": "igpu",
            },
            "warnings": [],
            "createdAt": NOW.isoformat(),
        }
    )


def _handler(requests: list[httpx.Request], *, digest: str) -> httpx.MockTransport:
    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/api/tags":
            return httpx.Response(
                200,
                json={"models": [{"name": "qwen3.5:4b", "digest": digest}]},
                request=request,
            )
        payload = json.loads(request.content)
        prompt = json.loads(payload["prompt"])
        candidate = {
            "blocks": [
                {
                    "type": "paragraph",
                    "sourceSegmentId": segment.get("segmentId") or segment["sourceSegmentId"],
                    **({"targetText": "translated text"} if "segmentId" in segment else {}),
                }
                for segment in prompt["rawSegments"]
            ]
        }
        return httpx.Response(
            200,
            json={"response": json.dumps(candidate)},
            request=request,
        )

    return httpx.MockTransport(handle)


def test_external_ollama_structures_with_bearer_auth() -> None:
    requests: list[httpx.Request] = []
    provider = ExternalOllamaCaptureStructuringProvider(
        ExternalOllamaConfig(
            endpoint_url="https://ollama.internal",
            model="qwen3.5:4b",
            api_key="secret-key",
        ),
        clock=FixedClock(),
        transport=_handler(requests, digest="c" * 64),
    )

    document = asyncio.run(
        provider.structure(_raw(), target_language="zh-TW", cancel_event=asyncio.Event())
    )

    assert isinstance(document, CaptureDocument)
    assert document.target_text == "translated text"
    assert document.structuring_engine.model == "qwen3.5:4b"
    assert document.structuring_engine.device == "remote"
    assert all(request.headers["authorization"] == "Bearer secret-key" for request in requests)
    generate = next(request for request in requests if request.url.path == "/api/generate")
    assert json.loads(generate.content)["model"] == "qwen3.5:4b"


def test_external_ollama_rejects_invalid_model_digest() -> None:
    provider = ExternalOllamaCaptureStructuringProvider(
        ExternalOllamaConfig(
            endpoint_url="https://ollama.internal",
            model="qwen3.5:4b",
        ),
        clock=FixedClock(),
        transport=_handler([], digest="not-a-digest"),
    )

    with pytest.raises(RuntimeUnavailableError, match="invalid model digest"):
        asyncio.run(provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event()))


def test_external_ollama_preserves_order_across_multiple_batches() -> None:
    requests: list[httpx.Request] = []
    provider = ExternalOllamaCaptureStructuringProvider(
        ExternalOllamaConfig(
            endpoint_url="https://ollama.internal",
            model="qwen3.5:4b",
        ),
        clock=FixedClock(),
        num_ctx=4_096,
        num_predict=1_536,
        transport=_handler(requests, digest="c" * 64),
    )

    document = asyncio.run(
        provider.structure(
            _raw(segment_count=5, text_chars=1_200),
            target_language="zh-TW",
            cancel_event=asyncio.Event(),
        )
    )

    assert [block.order for block in document.blocks] == list(range(5))
    assert len([request for request in requests if request.url.path == "/api/generate"]) == 3


def test_external_ollama_cancels_in_flight_generation() -> None:
    async def scenario() -> None:
        request_started = asyncio.Event()
        request_cancelled = asyncio.Event()

        async def handle(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return httpx.Response(
                    200,
                    json={"models": [{"name": "qwen3.5:4b", "digest": "c" * 64}]},
                    request=request,
                )
            request_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                request_cancelled.set()
                raise
            raise AssertionError("unreachable")

        provider = ExternalOllamaCaptureStructuringProvider(
            ExternalOllamaConfig(
                endpoint_url="https://ollama.internal",
                model="qwen3.5:4b",
            ),
            clock=FixedClock(),
            transport=httpx.MockTransport(handle),
        )
        cancellation = asyncio.Event()
        task = asyncio.create_task(
            provider.structure(_raw(), target_language="zh-TW", cancel_event=cancellation)
        )
        await request_started.wait()
        cancellation.set()

        with pytest.raises(asyncio.CancelledError):
            await task
        assert request_cancelled.is_set()

    asyncio.run(scenario())


def test_external_ollama_propagates_generation_http_failure() -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(
                200,
                json={"models": [{"name": "qwen3.5:4b", "digest": "c" * 64}]},
                request=request,
            )
        return httpx.Response(503, request=request)

    provider = ExternalOllamaCaptureStructuringProvider(
        ExternalOllamaConfig(
            endpoint_url="https://ollama.internal",
            model="qwen3.5:4b",
        ),
        clock=FixedClock(),
        transport=httpx.MockTransport(handle),
    )

    with pytest.raises(RuntimeUnavailableError, match="generation failed"):
        asyncio.run(
            provider.structure(_raw(), target_language="zh-TW", cancel_event=asyncio.Event())
        )
