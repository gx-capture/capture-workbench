from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from capture_structuring import (
    CAPTURE_BLOCK_BATCH_SCHEMA,
    CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA,
    OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA,
    OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA,
    StructuringValidationError,
    ollama_structuring_batch_schema,
    validate_structuring_candidate,
)

from capture_runtime.clock import Clock
from capture_runtime.config import OllamaRuntimeConfig
from capture_runtime.contracts import CaptureDocumentV1, RawCaptureV1
from capture_runtime.ollama import (
    OllamaCaptureStructuringProvider,
    RuntimeUnavailableError,
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
        self.stops = 0
        self.running = False

    def start(self) -> int:
        self.starts += 1
        self.running = True
        return 4242

    def owns_running_process(self) -> bool:
        return self.running

    def stop(self) -> None:
        self.stops += 1
        self.running = False


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
    blocks = []
    for segment in prompt["rawSegments"]:
        segment_id = segment.get("segmentId") or segment["sourceSegmentId"]
        block = {
            "type": "paragraph",
            "sourceSegmentId": segment_id,
        }
        if prompt["targetLanguage"] is not None:
            block["targetText"] = f"Target: {segment['text']}"
        blocks.append(block)
    return json.dumps({"blocks": blocks}, ensure_ascii=False)


def _contains_max_length(value: object) -> bool:
    if isinstance(value, dict):
        return "maxLength" in value or any(_contains_max_length(item) for item in value.values())
    if isinstance(value, list):
        return any(_contains_max_length(item) for item in value)
    return False


def test_ollama_generation_schema_keeps_shape_but_omits_grammar_hostile_maxima() -> None:
    assert CAPTURE_BLOCK_BATCH_SCHEMA["title"] == OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA["title"]
    assert _contains_max_length(CAPTURE_BLOCK_BATCH_SCHEMA)
    assert not _contains_max_length(OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA)
    definitions = OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA["$defs"]
    assert "CaptureSemanticBlockV1" in definitions
    assert "PageLocatorV1" not in definitions
    assert "TimeLocatorV1" not in definitions


def test_identity_generation_schema_excludes_source_text_projection() -> None:
    assert CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA["title"] == "CaptureIdentityBlockBatchV1"
    assert not _contains_max_length(OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA)
    identity_definition = OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA["$defs"][
        "CaptureIdentitySemanticBlockV1"
    ]
    assert "targetText" not in identity_definition["properties"]
    assert (
        ollama_structuring_batch_schema(target_language=None) == OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA
    )
    assert (
        ollama_structuring_batch_schema(target_language="zh-TW")
        == OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA
    )


def test_isolated_ollama_structures_token_bounded_batches_and_releases_process(
    tmp_path: Path,
) -> None:
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
    assert (
        CaptureDocumentV1.model_validate(validate_structuring_candidate(document, raw)) == document
    )
    assert lifecycle.starts == 1
    assert lifecycle.stops == 1
    assert lifecycle.running is False
    assert document.created_at == NOW
    assert document.completed_at == COMPLETED_AT
    assert len(generate_calls) == 1
    supplied_ids: list[str] = []
    for call in generate_calls:
        prompt = json.loads(str(call["prompt"]))
        supplied_ids.extend(segment["segmentId"] for segment in prompt["rawSegments"])
        assert call["format"]["title"] == "CaptureBlockBatchV1"
        assert call["think"] is False
        assert call["keep_alive"] == 0
        assert 0 < call["options"]["num_ctx"] <= 8_192
        assert 0 < call["options"]["num_predict"] <= 4_096
    assert supplied_ids == [segment.segment_id for segment in raw.segments]
    assert [block.order for block in document.blocks] == list(range(5))
    assert [block.block_id for block in document.blocks] == [
        f"block-{segment.segment_id}" for segment in raw.segments
    ]


def test_isolated_ollama_serializes_owned_process_leases(tmp_path: Path) -> None:
    async def scenario() -> None:
        config = _config(tmp_path)
        lifecycle = FakeLifecycle(config)
        active_generations = 0
        maximum_active_generations = 0

        async def handler(request: httpx.Request) -> httpx.Response:
            nonlocal active_generations, maximum_active_generations
            if request.url.path == "/api/tags":
                return _tags(config)
            payload = json.loads(request.content)
            active_generations += 1
            maximum_active_generations = max(maximum_active_generations, active_generations)
            await asyncio.sleep(0.01)
            active_generations -= 1
            return httpx.Response(200, json={"response": _valid_candidate(payload)})

        provider = OllamaCaptureStructuringProvider(
            lifecycle,  # type: ignore[arg-type]
            clock=FixedClock(),
            transport=httpx.MockTransport(handler),
        )
        first, second = await asyncio.gather(
            provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event()),
            provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event()),
        )

        assert isinstance(first, CaptureDocumentV1)
        assert isinstance(second, CaptureDocumentV1)
        assert maximum_active_generations == 1
        assert lifecycle.starts == 2
        assert lifecycle.stops == 2
        assert lifecycle.running is False

    asyncio.run(scenario())


def test_isolated_ollama_rebuilds_trusted_identity_target_from_raw_segments(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    generate_calls: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return _tags(config)
        payload = json.loads(request.content)
        generate_calls.append(payload)
        return httpx.Response(200, json={"response": _valid_candidate(payload)})

    provider = OllamaCaptureStructuringProvider(
        FakeLifecycle(config),  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )

    document = asyncio.run(
        provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event())
    )

    assert isinstance(document, CaptureDocumentV1)
    assert (
        CaptureDocumentV1.model_validate(validate_structuring_candidate(document, _raw()))
        == document
    )
    assert document.blocks[0].block_id == "block-page-1"
    assert document.blocks[0].source_segment_id == "page-1"
    assert document.blocks[0].source_text == _raw().segments[0].text
    assert document.blocks[0].target_text == _raw().segments[0].text
    identity_definition = generate_calls[0]["format"]["$defs"]["CaptureIdentitySemanticBlockV1"]
    assert "targetText" not in identity_definition["properties"]
    identity_prompt = json.loads(str(generate_calls[0]["prompt"]))
    assert identity_prompt["rawSegments"] == [
        {"sourceSegmentId": "page-1", "textPreview": _raw().segments[0].text}
    ]


def test_qwen_0_8b_structures_large_identity_capture_as_exact_single_segment_batches(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    lifecycle = FakeLifecycle(config)
    lifecycle.active_model_selection = lambda: {
        "profileId": "capture-workbench-qwen3.5-0.8b-structure-v1"
    }
    generate_calls: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "capture-workbench-qwen3.5-0.8b-structure-v1",
                            "digest": "c" * 64,
                        }
                    ]
                },
            )
        payload = json.loads(request.content)
        generate_calls.append(payload)
        prompt = json.loads(payload["prompt"])
        segment = prompt["rawSegments"][0]
        return httpx.Response(
            200,
            json={
                "response": json.dumps(
                    {
                        "blocks": [
                            {
                                "sourceSegmentId": segment["sourceSegmentId"],
                                "type": "paragraph",
                            }
                        ]
                    }
                )
            },
        )

    provider = OllamaCaptureStructuringProvider(
        lifecycle,  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )
    document = asyncio.run(
        provider.structure(_raw(count=44), target_language=None, cancel_event=asyncio.Event())
    )

    assert len(generate_calls) == 44
    assert [block.order for block in document.blocks] == list(range(44))
    for call, segment in zip(generate_calls, _raw(count=44).segments, strict=True):
        prompt = json.loads(call["prompt"])
        assert len(prompt["rawSegments"]) == 1
        blocks_schema = call["format"]["properties"]["blocks"]
        assert blocks_schema["minItems"] == 1
        assert blocks_schema["maxItems"] == 1
        identity_schema = call["format"]["$defs"]["CaptureIdentitySemanticBlockV1"]
        assert identity_schema["properties"]["sourceSegmentId"]["enum"] == [segment.segment_id]


@pytest.mark.parametrize("mutation", ["count", "sourceSegmentId", "type", "targetText"])
def test_isolated_ollama_rejects_unbound_or_invalid_batch_semantics(
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
        elif mutation == "sourceSegmentId":
            blocks[0]["sourceSegmentId"] = "page-999"
        elif mutation == "type":
            blocks[0]["type"] = "invented"
        else:
            blocks[0]["targetText"] = 42
        return httpx.Response(200, json={"response": json.dumps(candidate)})

    provider = OllamaCaptureStructuringProvider(
        FakeLifecycle(config),  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(StructuringValidationError, match="batch|identity|semantic"):
        asyncio.run(
            provider.structure(_raw(), target_language="zh-TW", cancel_event=asyncio.Event())
        )


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
                target_language="zh-TW",
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
