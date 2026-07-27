from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime

import httpx
import pytest

from capture_runtime.clock import Clock
from capture_runtime.config import ExternalOllamaConfig
from capture_runtime.contracts import CaptureDocumentV1, RawCaptureV1
from capture_runtime.ollama import (
    ExternalOllamaCaptureStructuringProvider,
    RuntimeUnavailableError,
)

NOW = datetime(2026, 7, 20, 8, 0, tzinfo=UTC)
COMPLETED_AT = datetime(2026, 7, 20, 8, 5, tzinfo=UTC)


class FixedClock(Clock):
    def now(self) -> datetime:
        return COMPLETED_AT


def _raw() -> RawCaptureV1:
    return RawCaptureV1.model_validate(
        {
            "schemaVersion": "1",
            "diagnosticOnly": True,
            "source": {
                "sha256": "a" * 64,
                "fileName": "sample.pdf",
                "mediaType": "application/pdf",
                "bytes": 42,
            },
            "segments": [
                {
                    "segmentId": "page-1",
                    "order": 0,
                    "locator": {"kind": "page", "page": 1},
                    "text": "source text",
                }
            ],
            "sourceText": "source text",
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
        segment = prompt["rawSegments"][0]
        candidate = {
            "blocks": [
                {
                    "blockId": f"block-{segment['segmentId']}",
                    "order": segment["order"],
                    "type": "paragraph",
                    "sourceSegmentId": segment["segmentId"],
                    "locator": segment["locator"],
                    "sourceText": segment["text"],
                    "targetText": "translated text",
                }
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

    assert isinstance(document, CaptureDocumentV1)
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
