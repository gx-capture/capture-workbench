from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from capture_runtime.clock import Clock
from capture_runtime.config import OllamaRuntimeConfig
from capture_runtime.contracts import CaptureDocument, RawCapture
from capture_runtime.structuring.infrastructure.constants import (
    CAPTURE_BLOCK_BATCH_SCHEMA,
    CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA,
    OLLAMA_CAPTURE_BLOCK_BATCH_SCHEMA,
    OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA,
    ollama_structuring_batch_schema,
)
from capture_runtime.structuring.infrastructure.contracts import StructuringValidationError
from capture_runtime.structuring.infrastructure.model_catalog import legacy_profile_id, model_option
from capture_runtime.structuring.infrastructure.ollama import (
    IsolatedOllamaLifecycle,
    OllamaCaptureStructuringProvider,
    RuntimeUnavailableError,
    device_policy,
)
from capture_runtime.structuring.infrastructure.structuring import validate_structuring_candidate
from tests.integration.test_ollama_restart_readiness import (
    FakeProcessController,
    _record_installed_profile,
)
from tests.support.ollama_legacy import legacy_readiness_marker

NOW = datetime(2026, 7, 20, 8, 0, tzinfo=UTC)
COMPLETED_AT = datetime(2026, 7, 20, 8, 5, tzinfo=UTC)


class FixedClock(Clock):
    def now(self) -> datetime:
        return COMPLETED_AT


class FakeLifecycle:
    def __init__(self, config: OllamaRuntimeConfig) -> None:
        self.host_url = "http://127.0.0.1:11555"
        self.config = config
        self.starts = 0
        self.stops = 0
        self.running = False
        self.log_parser = None
        self.device_policy = None
        self._lease_lock = asyncio.Lock()

    @asynccontextmanager
    async def lease(self, cancel_event: asyncio.Event) -> AsyncIterator[None]:
        async with self._lease_lock:
            if cancel_event.is_set():
                raise asyncio.CancelledError
            yield

    def start(self) -> int:
        self.starts += 1
        self.running = True
        return 4242

    def owns_running_process(self) -> bool:
        return self.running

    def stop(self) -> None:
        self.stops += 1
        self.running = False
        self.log_parser = None
        self.device_policy = None


def _config(tmp_path: Path) -> OllamaRuntimeConfig:
    return OllamaRuntimeConfig(
        app_data_dir=tmp_path / "ollama",
        pid_file=tmp_path / "ollama" / "pid.json",
        models_dir=tmp_path / "ollama" / "models",
    )


def _raw(*, count: int = 1, text_chars: int = 40) -> RawCapture:
    segments = [
        {
            "segmentId": f"page-{index + 1}",
            "order": index,
            "locator": {"kind": "page", "page": index + 1},
            "text": f"segment-{index}-" + ("x" * text_chars),
        }
        for index in range(count)
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
            "sourceText": "\n".join(str(segment["text"]) for segment in segments),
            "extractionEngine": {
                "engine": "text-recognition",
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
    assert "CaptureSemanticBlock" in definitions
    assert "PageLocator" not in definitions
    assert "TimeLocator" not in definitions


def test_identity_generation_schema_excludes_source_text_projection() -> None:
    assert CAPTURE_IDENTITY_BLOCK_BATCH_SCHEMA["title"] == "CaptureIdentityBlockBatch"
    assert not _contains_max_length(OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA)
    identity_definition = OLLAMA_IDENTITY_BLOCK_BATCH_SCHEMA["$defs"][
        "CaptureIdentitySemanticBlock"
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

    assert isinstance(document, CaptureDocument)
    assert CaptureDocument.model_validate(validate_structuring_candidate(document, raw)) == document
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
        assert call["format"]["title"] == "CaptureBlockBatch"
        assert call["think"] is False
        assert call["keep_alive"] == -1
        assert call["options"]["num_ctx"] == 8_192
        assert 0 < call["options"]["num_predict"] <= 4_096
    assert supplied_ids == [segment.segment_id for segment in raw.segments]
    assert [block.order for block in document.blocks] == list(range(5))
    assert [block.block_id for block in document.blocks] == [
        f"block-{segment.segment_id}" for segment in raw.segments
    ]


def test_isolated_ollama_preserves_order_across_multiple_batches(tmp_path: Path) -> None:
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
        num_ctx=4_096,
        num_predict=1_536,
        transport=httpx.MockTransport(handler),
    )

    document = asyncio.run(
        provider.structure(
            _raw(count=5, text_chars=1_200),
            target_language="zh-TW",
            cancel_event=asyncio.Event(),
        )
    )

    assert [block.order for block in document.blocks] == list(range(5))
    assert [block.source_segment_id for block in document.blocks] == [
        segment.segment_id for segment in _raw(count=5, text_chars=1_200).segments
    ]
    assert len(generate_calls) == 3
    assert {call["options"]["num_ctx"] for call in generate_calls} == {4_096}
    assert len({call["options"]["num_predict"] for call in generate_calls}) > 1


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

        assert isinstance(first, CaptureDocument)
        assert isinstance(second, CaptureDocument)
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

    assert isinstance(document, CaptureDocument)
    assert (
        CaptureDocument.model_validate(validate_structuring_candidate(document, _raw())) == document
    )
    assert document.blocks[0].block_id == "block-page-1"
    assert document.blocks[0].source_segment_id == "page-1"
    assert document.blocks[0].source_text == _raw().segments[0].text
    assert document.blocks[0].target_text == _raw().segments[0].text
    identity_definition = generate_calls[0]["format"]["$defs"]["CaptureIdentitySemanticBlock"]
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
    lifecycle.active_model_selection = lambda: {"profileId": "qwen3.5-0.8b-structure-v1"}
    generate_calls: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(
                200,
                json={
                    "models": [
                        {
                            "name": "qwen3.5-0.8b-structure-v1",
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
        identity_schema = call["format"]["$defs"]["CaptureIdentitySemanticBlock"]
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


def _model_named_provider(
    tmp_path: Path, model_name: str
) -> tuple[OllamaCaptureStructuringProvider, FakeLifecycle, list[dict[str, object]]]:
    """A provider without a current selection, serving one model under `model_name`."""
    config = _config(tmp_path)
    lifecycle = FakeLifecycle(config)
    lifecycle.active_model_selection = lambda: None  # type: ignore[attr-defined]
    generate_calls: list[dict[str, object]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            return httpx.Response(200, json={"models": [{"name": model_name, "digest": "c" * 64}]})
        payload = json.loads(request.content)
        generate_calls.append(payload)
        return httpx.Response(200, json={"response": _valid_candidate(payload)})

    provider = OllamaCaptureStructuringProvider(
        lifecycle,  # type: ignore[arg-type]
        clock=FixedClock(),
        transport=httpx.MockTransport(handler),
    )
    return provider, lifecycle, generate_calls


def _write_install_marker(config: OllamaRuntimeConfig, **overrides: object) -> None:
    option = model_option("qwen3.5-4b-v1")
    marker = {
        "profileId": legacy_profile_id(option),
        "baseModel": option.model_reference,
        "modelfileSha256": option.profile_spec_sha256,
        "installedAt": NOW.isoformat(),
        **overrides,
    }
    path = legacy_readiness_marker(config.app_data_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(marker), encoding="utf-8")


def test_install_marker_from_before_the_selection_names_the_model_it_verified(
    tmp_path: Path,
) -> None:
    option = model_option("qwen3.5-4b-v1")
    provider, lifecycle, generate_calls = _model_named_provider(tmp_path, legacy_profile_id(option))
    _write_install_marker(lifecycle.config)

    document = asyncio.run(
        provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event())
    )

    assert isinstance(document, CaptureDocument)
    assert [call["model"] for call in generate_calls] == [legacy_profile_id(option)]


@pytest.mark.parametrize(
    "overrides",
    [
        {"profileId": "attacker-chosen-model"},
        {"profileId": legacy_profile_id(model_option("qwen3.5-0.8b-v1"))},
        {"baseModel": "qwen3.5:0.8b"},
        {"modelfileSha256": "0" * 64},
    ],
)
def test_install_marker_that_does_not_match_the_expected_option_is_rejected(
    tmp_path: Path,
    overrides: dict[str, object],
) -> None:
    provider, lifecycle, generate_calls = _model_named_provider(
        tmp_path, str(overrides.get("profileId", "unused"))
    )
    _write_install_marker(lifecycle.config, **overrides)

    with pytest.raises(RuntimeUnavailableError, match="model_selection_required"):
        asyncio.run(provider.structure(_raw(), target_language=None, cancel_event=asyncio.Event()))
    assert generate_calls == []
    assert lifecycle.starts == 0


def test_verified_selection_under_the_old_model_name_plans_for_the_current_profile(
    tmp_path: Path,
) -> None:
    option = model_option("qwen3.5-0.8b-v1")
    provider, lifecycle, generate_calls = _model_named_provider(tmp_path, legacy_profile_id(option))
    lifecycle.active_model_selection = lambda: {  # type: ignore[attr-defined]
        "profileId": legacy_profile_id(option)
    }

    asyncio.run(
        provider.structure(_raw(count=3), target_language=None, cancel_event=asyncio.Event())
    )

    # The 0.8B profile structures one segment per request under either name.
    assert [call["model"] for call in generate_calls] == [legacy_profile_id(option)] * 3


@pytest.mark.parametrize(
    ("mode", "expected_calls", "expected_backend", "expected_state"),
    [
        ("verified", 1, "cuda", "verified"),
        ("cpu", 1, "cpu", "verified"),
        ("corrected", 2, "cuda", "verified"),
        ("repeated_mismatch", 2, "rocm", "mismatch"),
        ("no_target", 1, "rocm", "mismatch"),
        ("zero_offload", 1, None, "selected_unverified"),
        ("stale", 1, None, "unknown"),
        ("unmanaged", 1, "rocm", "unknown"),
        ("reload", 2, "cuda", "verified"),
        ("resident", 2, "cuda", "verified"),
        ("changed_digest", 1, None, None),
    ],
)
def test_owned_document_verifies_and_replays_only_once(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    mode: str,
    expected_calls: int,
    expected_backend: str | None,
    expected_state: str | None,
) -> None:
    config = _config(tmp_path)
    config.app_data_dir.mkdir()
    multi_batch = mode in ("reload", "resident")
    _record_installed_profile(config, "qwen3.5-0.8b-v1" if multi_batch else "qwen3.5-4b-v1")
    log_path = config.app_data_dir / "ollama.log"
    fixtures = Path(__file__).parents[1] / "fixtures/ollama_0_40_13"
    cuda = (fixtures / "cuda-dgpu-hip-hidden.log").read_text(encoding="utf-8")
    rocm = (fixtures / "rocm-igpu-selected-with-cuda-present.log").read_text(encoding="utf-8")
    cpu = (fixtures / "cpu-all-gpus-hidden.log").read_text(encoding="utf-8")
    log_path.write_text(rocm, encoding="utf-8")
    adapter = "Unavailable adapter" if mode == "no_target" else "NVIDIA GeForce RTX 4060 Laptop GPU"
    target = "unmanaged" if mode == "unmanaged" else "cpu" if mode == "cpu" else "cuda"
    policy = device_policy.OllamaDevicePolicy(target, adapter_name=adapter)
    monkeypatch.setattr(
        "capture_runtime.structuring.infrastructure.ollama.lifecycle_impl.resolve_device_policy",
        lambda: policy,
    )
    controller = FakeProcessController()
    ports = iter((12001, 12002))
    lifecycle = IsolatedOllamaLifecycle(
        config,
        process_controller=controller,
        executable_resolver=lambda: "ollama",
        clock=FixedClock(),
        listener_owner=SimpleNamespace(listener_pid=lambda port: 4242),
        port_selector=lambda: next(ports),
    )
    calls: list[httpx.Request] = []
    tags: list[int | None] = []
    original_sleep = asyncio.sleep

    async def observe_sleep(delay: float, result: object = None) -> object:
        assert len(calls) < 2, "the resident batch must skip the runner evidence wait"
        return await original_sleep(delay, result)

    if mode == "resident":
        monkeypatch.setattr(asyncio, "sleep", observe_sleep)

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/tags":
            tags.append(request.url.port)
            if mode == "changed_digest" and len(tags) == 2:
                payload = _tags(config).json()
                payload["models"][0]["digest"] = "e" * 64
                return httpx.Response(200, json=payload)
            if multi_batch:
                payload = _tags(config).json()
                payload["models"][0]["name"] = model_option("qwen3.5-0.8b-v1").profile_id
                return httpx.Response(200, json=payload)
            return _tags(config)
        calls.append(request)
        if mode != "stale" and not (mode == "resident" and len(calls) == 2):
            log = (
                cuda
                if mode in ("verified", "zero_offload")
                or ((mode == "corrected" and len(calls) == 2) or (multi_batch and len(calls) == 1))
                else rocm
            )
            if mode == "cpu":
                log = cpu
            if mode == "zero_offload":
                log = log.replace("offloaded 34/34", "offloaded 0/34")
            with log_path.open("a", encoding="utf-8") as stream:
                marker = "model buffer" if mode == "cpu" else "using device"
                split = log.index(marker) + 7
                stream.write(log[:split])
                stream.flush()
                await asyncio.sleep(0.04)
                stream.write(log[split:])
            if mode == "reload":
                parser = lifecycle.log_parser
                assert parser is not None
                async with asyncio.timeout(2):
                    while parser.load_revision() < 2 * len(calls):
                        await asyncio.sleep(0.01)
        payload = json.loads(request.content)
        candidate = (
            "discard this candidate"
            if mode in ("corrected", "repeated_mismatch") and len(calls) == 1
            else (_valid_candidate(payload))
        )
        return httpx.Response(200, json={"response": candidate})

    provider = OllamaCaptureStructuringProvider(
        lifecycle, clock=FixedClock(), transport=httpx.MockTransport(handler)
    )
    raw = _raw(count=2, text_chars=40) if multi_batch else _raw()
    if mode == "changed_digest":
        with pytest.raises(RuntimeUnavailableError, match="model identity changed"):
            asyncio.run(provider.structure(raw, target_language=None, cancel_event=asyncio.Event()))
        assert tags == [12001, 12002]
        assert len(calls) == expected_calls
        assert len(controller.spawned) == len(controller.stopped) == 2
        return
    result = asyncio.run(
        provider.structure(raw, target_language=None, cancel_event=asyncio.Event())
    )
    assert isinstance(result, CaptureDocument)
    assert len(calls) == expected_calls
    expected_processes = 1 if multi_batch else expected_calls
    assert len(controller.spawned) == len(controller.stopped) == expected_processes
    if mode == "reload":
        assert "model reload disagreed with the document device" in caplog.text
    assert provider.device_execution is not None
    assert provider.device_execution.observed_backend == expected_backend
    assert provider.device_execution.state == expected_state
    assert result.structuring_engine == provider.engine_identity
    assert result.structuring_engine.device == expected_backend
    expected_name = {
        "cuda": "NVIDIA GeForce RTX 4060 Laptop GPU",
        "rocm": "AMD Radeon(TM) 880M Graphics",
    }.get(expected_backend or "")
    assert result.structuring_engine.device_name == expected_name
    wire_engine = result.model_dump(mode="json", by_alias=True)["structuringEngine"]
    assert wire_engine["device"] == expected_backend
    assert wire_engine["deviceName"] == expected_name
    if expected_processes == 2:
        assert tags == [12001, 12002]
        assert [call.url.port for call in calls] == tags
        assert calls[0].content == calls[1].content
        assert controller.environments[1]["OLLAMA_LLM_LIBRARY"] == "cuda_v13"
