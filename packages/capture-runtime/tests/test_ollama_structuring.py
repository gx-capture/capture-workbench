from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest

from capture_runtime.clock import Clock
from capture_runtime.config import OllamaRuntimeConfig
from capture_runtime.contracts import CaptureDocumentV1, RawCaptureV1
from capture_runtime.ollama import (
    OllamaCaptureStructuringProvider,
    RuntimeUnavailableError,
)
from capture_runtime.structuring import (
    StructuringValidationError,
    validate_structuring_candidate,
)

NOW = datetime(2026, 7, 20, 8, 0, tzinfo=UTC)
COMPLETED_AT = datetime(2026, 7, 20, 8, 5, tzinfo=UTC)


class FixedClock(Clock):
    def now(self) -> datetime:
        return COMPLETED_AT


class FakeLifecycle:
    def __init__(self, config: OllamaRuntimeConfig) -> None:
        self.config = config
        self.starts = 0
        self.running = False

    def start(self) -> int:
        self.starts += 1
        self.running = True
        return 4242

    def owns_running_process(self) -> bool:
        return self.running


def _config(tmp_path: Path) -> OllamaRuntimeConfig:
    return OllamaRuntimeConfig(
        host_url="http://127.0.0.1:11555",
        app_data_dir=tmp_path / "ollama",
        pid_file=tmp_path / "ollama" / "pid.json",
        models_dir=tmp_path / "ollama" / "models",
    )


def _raw(*, count: int = 1, text_chars: int = 40) -> RawCaptureV1:
    segments = [
        {
            "segmentId": f"page-{index + 1}",
            "order": index,
            "locator": {"kind": "page", "page": index + 1},
            "text": f"segment-{index}-" + ("x" * text_chars),
        }
        for index in range(count)
    ]
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
            "segments": segments,
            "sourceText": "\n".join(str(segment["text"]) for segment in segments),
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


def _tags(config: OllamaRuntimeConfig) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "models": [
                {
                    "name": config.profile_id,
                    "digest": "c" * 64,
                }
            ]
        },
    )


def _valid_candidate(request_payload: dict[str, object]) -> str:
    prompt = json.loads(str(request_payload["prompt"]))
    blocks = [
        {
            "blockId": f"block-{segment['segmentId']}",
            "order": segment["order"],
            "type": "paragraph",
            "sourceSegmentId": segment["segmentId"],
            "locator": segment["locator"],
            "sourceText": segment["text"],
            "targetText": f"Target: {segment['text']}",
        }
        for segment in prompt["rawSegments"]
    ]
    return json.dumps({"blocks": blocks}, ensure_ascii=False)


def test_isolated_ollama_structures_token_bounded_batches(tmp_path: Path) -> None:
    config = _config(tmp_path)
    lifecycle = FakeLifecycle(config)
    generate_calls: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return _tags(config)
        assert request.url.path == "/api/generate"
        payload = json.loads(request.content)
        generate_calls.append(payload)
        return httpx.Response(200, json={"response": _valid_candidate(payload)})

    provider = OllamaCaptureStructuringProvider(
        lifecycle,  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )
    raw = _raw(count=5, text_chars=1_200)

    document = asyncio.run(
        provider.structure(raw, target_language="zh-TW", cancel_event=asyncio.Event())
    )

    assert isinstance(document, CaptureDocumentV1)
    assert validate_structuring_candidate(document, raw) == document
    assert lifecycle.starts == 1
    assert document.created_at == NOW
    assert document.completed_at == COMPLETED_AT
    assert len(generate_calls) >= 2
    supplied_ids: list[str] = []
    for call in generate_calls:
        prompt = json.loads(str(call["prompt"]))
        supplied_ids.extend(segment["segmentId"] for segment in prompt["rawSegments"])
        assert call["format"]["title"] == "CaptureBlockBatchV1"
        assert 0 < call["options"]["num_ctx"] <= 8_192
        assert 0 < call["options"]["num_predict"] <= 4_096
    assert supplied_ids == [segment.segment_id for segment in raw.segments]
    assert [block.order for block in document.blocks] == list(range(5))
    assert [block.block_id for block in document.blocks] == [
        f"block-{segment.segment_id}" for segment in raw.segments
    ]


@pytest.mark.parametrize("mutation", ["count", "order", "locator", "sourceText", "blockId"])
def test_isolated_ollama_rejects_mutated_batch_provenance(
    tmp_path: Path,
    mutation: str,
) -> None:
    config = _config(tmp_path)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return _tags(config)
        payload = json.loads(request.content)
        candidate = json.loads(_valid_candidate(payload))
        blocks = candidate["blocks"]
        if mutation == "count":
            blocks.pop()
        elif mutation == "order":
            blocks[0]["order"] += 1
        elif mutation == "locator":
            blocks[0]["locator"]["page"] += 1
        elif mutation == "sourceText":
            blocks[0]["sourceText"] += " changed"
        else:
            blocks[0]["blockId"] = "model-invented-id"
        return httpx.Response(200, json={"response": json.dumps(candidate)})

    provider = OllamaCaptureStructuringProvider(
        FakeLifecycle(config),  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(StructuringValidationError, match="batch|provenance"):
        asyncio.run(provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event()))


def test_isolated_ollama_fails_before_generation_for_oversized_segment(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    generate_calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal generate_calls
        if request.url.path == "/api/tags":
            return _tags(config)
        generate_calls += 1
        raise AssertionError("oversized segment must not reach Ollama generation")

    provider = OllamaCaptureStructuringProvider(
        FakeLifecycle(config),  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(StructuringValidationError, match="exceeds the provider token budget"):
        asyncio.run(
            provider.structure(
                _raw(text_chars=20_000),
                target_language=None,
                cancel_event=asyncio.Event(),
            )
        )

    assert generate_calls == 0


def test_isolated_ollama_rejects_a_foreign_ready_response_after_owned_exit(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    lifecycle = FakeLifecycle(config)

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/tags"
        lifecycle.running = False
        return _tags(config)

    provider = OllamaCaptureStructuringProvider(
        lifecycle,  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(RuntimeUnavailableError, match="process stopped"):
        asyncio.run(provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event()))


def test_isolated_ollama_rejects_a_foreign_generation_after_owned_exit(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    lifecycle = FakeLifecycle(config)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return _tags(config)
        payload = json.loads(request.content)
        lifecycle.running = False
        return httpx.Response(200, json={"response": _valid_candidate(payload)})

    provider = OllamaCaptureStructuringProvider(
        lifecycle,  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(RuntimeUnavailableError, match="process stopped"):
        asyncio.run(provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event()))


def test_isolated_ollama_cancels_in_flight_batch_request(tmp_path: Path) -> None:
    async def scenario() -> None:
        config = _config(tmp_path)
        request_started = asyncio.Event()
        request_cancelled = asyncio.Event()

        async def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/api/tags":
                return _tags(config)
            request_started.set()
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                request_cancelled.set()
                raise
            raise AssertionError("unreachable")

        provider = OllamaCaptureStructuringProvider(
            FakeLifecycle(config),  # type: ignore[arg-type]
            clock=FixedClock(),
            transport=httpx.MockTransport(handler),
        )
        cancellation = asyncio.Event()
        task = asyncio.create_task(
            provider.structure(_raw(), target_language=None, cancel_event=cancellation)
        )
        await request_started.wait()
        cancellation.set()

        with pytest.raises(asyncio.CancelledError):
            await task
        assert request_cancelled.is_set()

    asyncio.run(scenario())
