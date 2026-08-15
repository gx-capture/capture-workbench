from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from contextlib import contextmanager
from importlib.resources import files
from pathlib import Path

import httpx
import pytest

from capture_runtime_client import (
    CAPTURE_CONTRACT_SET_SHA256,
    CAPTURE_DOCUMENT_SCHEMA_SHA256,
    CaptureAuthenticationError,
    CaptureProtocolError,
    CaptureRemoteError,
    CaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    InMemoryRuntimeTransport,
    RuntimeReady,
    validate_loopback_base_url,
)


def test_packaged_contract_set_hash_matches_runtime_asset() -> None:
    runtime_asset = (
        Path(__file__).resolve().parents[2]
        / "capture-runtime"
        / "src"
        / "capture_runtime"
        / "assets"
    )
    runtime_bundle = (runtime_asset / "contract-set.json").read_bytes()
    runtime_digest = (runtime_asset / "contract-set.sha256").read_text(encoding="ascii").strip()
    packaged = files("capture_runtime_client.private.assets")
    packaged_bundle = packaged.joinpath("contract-set.json").read_bytes()
    packaged_digest = packaged.joinpath("contract-set.sha256").read_text(encoding="ascii").strip()
    assert hashlib.sha256(runtime_bundle).hexdigest() == runtime_digest
    assert packaged_bundle == runtime_bundle
    assert packaged_digest == runtime_digest == CAPTURE_CONTRACT_SET_SHA256


def _ready(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "ready": True,
        "service": "capture-runtime",
        "apiVersion": "2.0",
        "runtimeVersion": "0.4.0",
        "captureDocumentSchemaVersion": "2",
        "capabilities": {
            "captureKinds": ["pdf"],
            "structuringModes": ["host"],
            "supportsCancellation": True,
            "supportsRawDiagnostics": True,
            "maxUploadBytes": 100,
        },
    }
    payload.update(overrides)
    return payload


def _discovery_routes() -> dict[tuple[str, str], Callable[[httpx.Request], httpx.Response]]:
    packaged = files("capture_runtime_client.private.assets")
    bundle = packaged.joinpath("contract-set.json").read_bytes()
    digest = hashlib.sha256(bundle).hexdigest()
    href = f"/meta/v2/contracts/sha256/{digest}"
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.0",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": href,
    }
    return {
        ("GET", "/v2/health/ready"): lambda request: httpx.Response(
            200, json=_ready(), request=request
        ),
        ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
            200, json=index, request=request
        ),
        ("GET", href): lambda request: httpx.Response(
            200,
            content=bundle,
            headers={"X-Contract-SHA256": digest, "ETag": f'"{digest}"'},
            request=request,
        ),
        ("GET", "/v2/streaming/health/ready"): lambda request: httpx.Response(
            200,
            json={
                "protocolVersion": "2",
                "captureKinds": ["pdf", "image", "audio"],
                "supportsProgressiveAudio": True,
                "maxChunkBytes": 1_048_576,
                "checkpointIntervalMs": 500,
                "heartbeatIntervalMs": 1_000,
                "stallTimeoutMs": 5_000,
            },
            request=request,
        ),
    }


def _transport(
    routes: dict[tuple[str, str], Callable[[httpx.Request], httpx.Response]],
) -> InMemoryRuntimeTransport:
    return InMemoryRuntimeTransport({**_discovery_routes(), **routes})


def test_loopback_transport_and_handshake() -> None:
    def operation(path: str, **overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
            "path": path,
            "method": "GET",
            "surface": "v2",
            "body": {"kind": "none"},
            "requiredHeaders": [],
            "idempotency": {"mode": "none", "header": None},
            "responseStatusCodes": [200],
        }
        value.update(overrides)
        return value

    bundle = {
        "contractSetVersion": "2",
        "schemaDialect": "https://json-schema.org/draft/2020-12/schema",
        "surfaces": [{"id": "v2"}],
        "schemas": [{"name": "CaptureDocument", "schemaSha256": CAPTURE_DOCUMENT_SCHEMA_SHA256}],
        "operations": [
            operation("/v2/health/ready"),
            operation(
                "/v2/captures",
                method="POST",
                body={"kind": "json"},
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation("/v2/streaming/health/ready"),
            operation("/v2/runtime/requirements"),
            operation(
                "/v2/runtime/installations",
                method="POST",
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation("/v2/runtime/model-options"),
            operation(
                "/v2/runtime/model-installations",
                method="POST",
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation(
                "/v2/ingestions/{ingestion_id}/chunks/{chunk_index}",
                method="PUT",
                body={"kind": "binary"},
                requiredHeaders=["Content-Range", "Digest", "X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation(
                "/v2/captures/{capture_id}/events",
                mediaType="text/event-stream",
                optionalHeaders=["Last-Event-ID"],
                streaming={"kind": "sse", "lastEventIdHeader": "Last-Event-ID"},
            ),
            operation("/v2/captures/{capture_id}/raw"),
            operation("/v2/captures/{capture_id}/result"),
        ],
        "problems": [],
        "invariants": [],
    }
    bundle_bytes = json.dumps(bundle, separators=(",", ":"), sort_keys=True).encode()
    digest = hashlib.sha256(bundle_bytes).hexdigest()
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.0",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": f"/meta/v2/contracts/sha256/{digest}",
    }
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(), request=request
            ),
            ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
                200, json=index, request=request
            ),
            ("GET", "/v2/streaming/health/ready"): lambda request: httpx.Response(
                200,
                json={
                    "protocolVersion": "2",
                    "maxChunkBytes": 10,
                    "checkpointIntervalMs": 500,
                    "heartbeatIntervalMs": 1000,
                    "stallTimeoutMs": 5000,
                },
                request=request,
            ),
            ("GET", index["href"]): lambda request: httpx.Response(
                200,
                content=bundle_bytes,
                headers={"X-Contract-SHA256": digest, "ETag": f'"{digest}"'},
                request=request,
            ),
        }
    )
    client = CaptureRuntimeClient(transport=transport, allowed_contract_set_sha256=[digest])
    ready = client.handshake()
    assert isinstance(ready, RuntimeReady)
    assert client.discover().schema_sha256 == CAPTURE_DOCUMENT_SCHEMA_SHA256


def test_compatibility_failure_is_machine_readable() -> None:
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(apiVersion="1.0"), request=request
            )
        }
    )
    with pytest.raises(CaptureRuntimeCompatibilityError):
        CaptureRuntimeClient(transport=transport).handshake()


def test_loopback_validation_rejects_remote_or_credentials() -> None:
    assert validate_loopback_base_url(43123) == "http://127.0.0.1:43123"
    with pytest.raises(CaptureRuntimeError):
        validate_loopback_base_url("https://example.test:43123")
    with pytest.raises(CaptureRuntimeError):
        validate_loopback_base_url("http://localhost:43123")


def test_discovery_rejects_unknown_contract_set_hash() -> None:
    bundle = b'{"contractSetVersion":"2","schemas":[],"operations":[]}'
    digest = hashlib.sha256(bundle).hexdigest()
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.0",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": f"/meta/v2/contracts/sha256/{digest}",
    }
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(), request=request
            ),
            ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
                200, json=index, request=request
            ),
            ("GET", index["href"]): lambda request: httpx.Response(
                200, content=bundle, request=request
            ),
        }
    )
    with pytest.raises(CaptureRuntimeCompatibilityError, match="allowlisted"):
        CaptureRuntimeClient(transport=transport).discover()


def test_discovery_rejects_wrong_content_addressed_href() -> None:
    digest = "a" * 64
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.0",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": f"/meta/v2/contracts/sha256/{'b' * 64}",
    }
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(), request=request
            ),
            ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
                200, json=index, request=request
            ),
        }
    )
    with pytest.raises(CaptureRuntimeCompatibilityError, match="href digest"):
        CaptureRuntimeClient(transport=transport, allowed_contract_set_sha256=[digest]).discover()


def test_error_taxonomy_preserves_remote_diagnostics() -> None:
    response = httpx.Response(
        409,
        json={
            "error": {
                "code": "new_problem",
                "message": "conflict",
                "details": {
                    "category": "conflict",
                    "retryable": True,
                    "issues": [{"location": ["id"], "message": "duplicate"}],
                    "requestId": "body-request",
                },
            }
        },
        headers={"X-Request-ID": "header-request"},
    )
    with pytest.raises(CaptureRemoteError) as caught:
        CaptureRuntimeClient(transport=_transport({})).get_capture("x")
    assert caught.value.status_code == 404

    with pytest.raises(CaptureRemoteError) as mapped:
        from capture_runtime_client.codec import decode_json

        decode_json(response)
    assert mapped.value.code == "new_problem"
    assert mapped.value.category == "conflict"
    assert mapped.value.retryable is True
    assert mapped.value.request_id == "header-request"
    assert mapped.value.issues[0]["message"] == "duplicate"

    unauthorized = httpx.Response(
        401,
        json={"error": {"code": "unauthorized", "message": "Bearer secret"}},
    )
    with pytest.raises(CaptureAuthenticationError):
        decode_json(unauthorized)


def test_malformed_json_and_sse_resume_are_protocol_safe() -> None:
    from capture_runtime_client.codec import decode_json

    with pytest.raises(CaptureProtocolError):
        decode_json(httpx.Response(200, content=b"not-json"))
    event = {
        "protocolVersion": "2",
        "eventId": "e1",
        "sequence": 2,
        "captureId": "cap",
        "kind": "audio",
        "eventType": "completed",
        "stage": "completed",
        "createdAt": "2026-01-01T00:00:00+00:00",
    }
    stream = f"id: 2\ndata: {json.dumps(event)}\n\n".encode()
    transport = _transport(
        {
            ("GET", "/v2/captures/cap/events"): lambda request: httpx.Response(
                200,
                content=stream,
                headers={"Content-Type": "text/event-stream"},
                request=request,
            )
        }
    )
    result = list(CaptureRuntimeClient(transport=transport).capture_events("cap", last_event_id=1))
    assert result[0].sequence == 2


def test_model_installation_operations_and_failure_idempotency_header() -> None:
    captured_headers: dict[str, str] = {}
    model_installation = {
        "installationId": "model-1",
        "optionId": "option-1",
        "status": "running",
        "progress": 0.5,
        "createdAt": "2026-01-01T00:00:00+00:00",
        "updatedAt": "2026-01-01T00:00:00+00:00",
    }
    job = {
        "protocolVersion": "2",
        "captureId": "cap",
        "ingestionId": "ingestion-1",
        "status": "failed",
        "progress": 1,
        "partialRevision": 0,
        "lastEventSequence": 1,
        "createdAt": "2026-01-01T00:00:00+00:00",
        "updatedAt": "2026-01-01T00:00:00+00:00",
        "completedAt": "2026-01-01T00:00:00+00:00",
    }

    def report(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        return httpx.Response(200, json=job, request=request)

    transport = _transport(
        {
            ("GET", "/v2/runtime/model-installations/model-1"): lambda request: httpx.Response(
                200, json=model_installation, request=request
            ),
            ("POST", "/v2/runtime/model-installations/model-1/cancel"): lambda request: (
                httpx.Response(
                    200,
                    json={**model_installation, "status": "cancelled"},
                    request=request,
                )
            ),
            ("POST", "/v2/captures/cap/structure/failure"): report,
        }
    )
    client = CaptureRuntimeClient(transport=transport)
    assert client.get_model_installation("model-1").status.value == "running"
    assert client.get_model_installation_status("model-1").status.value == "running"
    assert client.cancel_model_installation("model-1").status.value == "cancelled"
    client.report_structuring_failure(
        "cap", code="invalid", message="unable to structure", idempotency_key="failure-1"
    )
    assert captured_headers["x-idempotency-key"] == "failure-1"


def test_public_python_sdk_is_v2_only_and_hides_generated_wire_module() -> None:
    import capture_runtime_client as sdk
    import capture_runtime_client.contracts as contracts

    generated_suffixes = ("V" + "1", "V" + "2")
    assert not any(name.endswith(generated_suffixes) for name in sdk.__all__)
    assert "generated_models" not in sdk.__dict__
    source_root = Path(__file__).parents[1] / "src" / "capture_runtime_client"
    for path in source_root.glob("*.py"):
        if path.name in {"contracts.py", "__init__.py"}:
            continue
        assert "/v" + "1/" not in path.read_text(encoding="utf-8")
    assert all(not name.endswith(generated_suffixes) for name in contracts.__all__)


def test_retry_policy_retries_idempotent_requests_only() -> None:
    attempts = 0

    def ready(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                503,
                json={"error": {"code": "busy", "message": "retry"}},
                request=request,
            )
        return httpx.Response(200, json=_ready(), request=request)

    transport = InMemoryRuntimeTransport({("GET", "/v2/health/ready"): ready})
    result = CaptureRuntimeClient(transport=transport, max_retries=1).handshake()
    assert result.ready is True
    assert attempts == 2

    post_attempts = 0

    def non_idempotent(request: httpx.Request) -> httpx.Response:
        nonlocal post_attempts
        post_attempts += 1
        return httpx.Response(
            503,
            json={"error": {"code": "busy", "message": "retry"}},
            request=request,
        )

    transport = _transport({("POST", "/v2/captures/cap/cancel"): non_idempotent})
    with pytest.raises(CaptureRemoteError):
        CaptureRuntimeClient(transport=transport, max_retries=2).cancel_capture("cap")
    assert post_attempts == 1

    keyed_attempts = 0

    def keyed(request: httpx.Request) -> httpx.Response:
        nonlocal keyed_attempts
        keyed_attempts += 1
        if keyed_attempts == 1:
            return httpx.Response(
                503,
                json={"error": {"code": "busy", "message": "retry"}},
                request=request,
            )
        return httpx.Response(200, json={
            "protocolVersion": "2",
            "captureId": "cap",
            "ingestionId": "ingestion",
            "status": "failed",
            "partialRevision": 0,
            "lastEventSequence": 0,
            "createdAt": "2026-01-01T00:00:00+00:00",
            "updatedAt": "2026-01-01T00:00:00+00:00",
            "completedAt": "2026-01-01T00:00:00+00:00",
        }, request=request)

    transport = _transport({("POST", "/v2/captures/cap/structure/failure"): keyed})
    CaptureRuntimeClient(transport=transport, max_retries=1).report_structuring_failure(
        "cap", code="failed", message="failed", idempotency_key="request-1"
    )
    assert keyed_attempts == 2


def test_sse_reconnects_with_last_event_id_cursor() -> None:
    calls: list[dict[str, str]] = []
    events = [
        {
            "protocolVersion": "2",
            "eventId": "e1",
            "sequence": 1,
            "captureId": "cap",
            "kind": "audio",
            "eventType": "checkpoint",
            "stage": "extracting",
            "partialRevision": 1,
            "createdAt": "2026-01-01T00:00:00+00:00",
        },
        {
            "protocolVersion": "2",
            "eventId": "e2",
            "sequence": 2,
            "captureId": "cap",
            "kind": "audio",
            "eventType": "completed",
            "stage": "completed",
            "partialRevision": 1,
            "createdAt": "2026-01-01T00:00:01+00:00",
        },
    ]

    class ResumeTransport(InMemoryRuntimeTransport):
        def __init__(self) -> None:
            super().__init__(_discovery_routes())

        def stream(self, method: str, path: str, **kwargs: object) -> object:
            headers = {
                str(key): str(value)
                for key, value in dict(kwargs.get("headers", {})).items()
            }
            calls.append(headers)
            index = len(calls) - 1

            @contextmanager
            def response() -> object:
                payload = events[index]
                stream = f"id: {payload['sequence']}\ndata: {json.dumps(payload)}\n\n".encode()
                yield httpx.Response(
                    200,
                    content=stream,
                    headers={"Content-Type": "text/event-stream"},
                )

            return response()

    transport = ResumeTransport()
    result = list(CaptureRuntimeClient(transport=transport).capture_events("cap"))
    assert [event.sequence for event in result] == [1, 2]
    assert calls[0].get("Last-Event-ID") is None
    assert calls[1].get("Last-Event-ID") == "1"
