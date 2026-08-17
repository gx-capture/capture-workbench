"""Private authenticated runtime discovery and contract validation."""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from ._error_mapping import decode_response
from .codec import decode_model
from .contracts import (
    CAPTURE_API_VERSION,
    CAPTURE_DOCUMENT_SCHEMA_SHA256,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CAPTURE_RUNTIME_VERSION,
    RuntimeReady,
    RuntimeStreamingCapabilities,
    StructuringMode,
)
from .errors import CaptureRuntimeCompatibilityError, CaptureRuntimeProtocolError

RequestFn = Callable[..., httpx.Response]


@dataclass(frozen=True, slots=True)
class RuntimeDiscovery:
    """Authenticated compatibility evidence cached by ``CaptureRuntimeClient``."""

    ready: RuntimeReady
    streaming: RuntimeStreamingCapabilities | None
    schema_sha256: str
    contract_index: Mapping[str, Any]
    contract_bundle: Mapping[str, Any]


def handshake(request: RequestFn) -> RuntimeReady:
    """Validate readiness using the SDK's compiled v2 compatibility identity."""
    response = request("GET", "/v2/health/ready")
    payload = decode_response(response)
    if not isinstance(payload, Mapping):
        raise CaptureRuntimeProtocolError("Capture Runtime readiness response is not an object.")
    assert_compatible_payload(payload)
    ready = decode_model(httpx.Response(200, json=payload), RuntimeReady)
    assert_compatible(ready)
    return ready


def discover(
    request: RequestFn,
    *,
    allowed_contract_set_sha256: Collection[str],
) -> RuntimeDiscovery:
    """Perform one authenticated, immutable contract discovery transaction."""
    ready = handshake(request)
    index_response = request("GET", "/meta/v2/contracts")
    index = decode_response(index_response)
    if not isinstance(index, Mapping):
        raise CaptureRuntimeProtocolError("Capture Runtime contract index is not an object.")
    validate_contract_index(index, ready)
    href = index.get("href")
    if not isinstance(href, str) or not href.startswith("/meta/v2/contracts/sha256/"):
        raise CaptureRuntimeProtocolError("Capture Runtime contract index href is invalid.")
    href_digest = href.removeprefix("/meta/v2/contracts/sha256/")
    if not re.fullmatch(r"[0-9a-f]{64}", href_digest) or href_digest != index.get("sha256"):
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract index href digest does not match its advertised bundle hash."
        )
    bundle_response = request("GET", href)
    bundle_bytes = bundle_response.content
    digest = hashlib.sha256(bundle_bytes).hexdigest()
    if digest not in allowed_contract_set_sha256:
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract bundle identity is not allowlisted."
        )
    etag = bundle_response.headers.get("etag")
    if (
        digest != index.get("sha256")
        or bundle_response.headers.get("x-contract-sha256") not in {None, digest}
        or (etag is not None and etag not in {digest, f'"{digest}"'})
    ):
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract bundle hash is incompatible."
        )
    try:
        bundle = json.loads(bundle_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CaptureRuntimeProtocolError(
            "Capture Runtime contract bundle is not valid JSON."
        ) from error
    schema_sha256 = validate_contract_bundle(bundle, digest)
    streaming = decode_model(
        request("GET", "/v2/streaming/health/ready"), RuntimeStreamingCapabilities
    )
    return RuntimeDiscovery(
        ready=ready,
        streaming=streaming,
        schema_sha256=schema_sha256,
        contract_index=index,
        contract_bundle=bundle,
    )


def assert_compatible(ready: RuntimeReady) -> None:
    failures: list[str] = []
    if ready.api_version != CAPTURE_API_VERSION:
        failures.append(f"API version {ready.api_version} is unsupported")
    if ready.capture_document_schema_version != CAPTURE_DOCUMENT_SCHEMA_VERSION:
        failures.append("CaptureDocument schema version is unsupported")
    if ready.runtime_version != CAPTURE_RUNTIME_VERSION:
        failures.append(
            f"runtime version {ready.runtime_version} is incompatible with "
            f"{CAPTURE_RUNTIME_VERSION}"
        )
    structuring_modes = ready.capabilities.get("structuringModes", [])
    if (
        StructuringMode.HOST.value not in structuring_modes
        and StructuringMode.RUNTIME.value not in structuring_modes
    ):
        failures.append("runtime exposes no structuring mode")
    if failures:
        raise CaptureRuntimeCompatibilityError("; ".join(failures))


def assert_compatible_payload(payload: Mapping[str, Any]) -> None:
    failures: list[str] = []
    if payload.get("apiVersion") != CAPTURE_API_VERSION:
        failures.append("API version is unsupported")
    if payload.get("captureDocumentSchemaVersion") != CAPTURE_DOCUMENT_SCHEMA_VERSION:
        failures.append("CaptureDocument schema version is unsupported")
    if failures:
        raise CaptureRuntimeCompatibilityError("; ".join(failures))


def validate_contract_index(index: Mapping[str, Any], ready: RuntimeReady) -> None:
    required = {
        "catalogVersion",
        "runtimeVersion",
        "contractSetVersion",
        "surfaces",
        "sha256",
        "href",
    }
    if not required.issubset(index):
        raise CaptureRuntimeProtocolError(
            "Capture Runtime contract index is missing required fields."
        )
    if index.get("catalogVersion") != "2" or index.get("contractSetVersion") != "2":
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract catalog version is unsupported."
        )
    if index.get("runtimeVersion") != ready.runtime_version:
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract catalog runtimeVersion is incompatible."
        )
    if not isinstance(index.get("sha256"), str) or not re.fullmatch(
        r"[0-9a-f]{64}", index["sha256"]
    ):
        raise CaptureRuntimeProtocolError("Capture Runtime contract index hash is invalid.")
    surfaces = index.get("surfaces")
    if not isinstance(surfaces, list) or {
        surface.get("id") for surface in surfaces if isinstance(surface, Mapping)
    } != {"v2"}:
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract catalog does not expose the v2 surface."
        )


def validate_contract_bundle(bundle: Any, digest: str) -> str:
    if (
        not isinstance(bundle, Mapping)
        or bundle.get("contractSetVersion") != "2"
        or bundle.get("schemaDialect") != "https://json-schema.org/draft/2020-12/schema"
    ):
        raise CaptureRuntimeProtocolError("Capture Runtime contract bundle is invalid.")
    for field in ("surfaces", "schemas", "operations", "problems", "invariants"):
        if not isinstance(bundle.get(field), list):
            raise CaptureRuntimeProtocolError(
                f"Capture Runtime contract bundle {field} is invalid."
            )
    surfaces = bundle["surfaces"]
    surface_ids = {surface.get("id") for surface in surfaces if isinstance(surface, Mapping)}
    if surface_ids != {"v2"}:
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract bundle does not expose the v2 surface."
        )
    operations_value = bundle["operations"]
    if not isinstance(operations_value, list):
        raise CaptureRuntimeProtocolError("Capture Runtime contract bundle operations are invalid.")
    operations: list[Any] = operations_value
    for operation in operations:
        if not isinstance(operation, Mapping) or not all(
            isinstance(operation.get(field), expected)
            for field, expected in (
                ("path", str),
                ("method", str),
                ("surface", str),
                ("body", Mapping),
                ("requiredHeaders", list),
                ("idempotency", Mapping),
                ("responseStatusCodes", list),
            )
        ):
            raise CaptureRuntimeProtocolError(
                "Capture Runtime contract operation metadata is invalid."
            )
    operation_paths = {
        operation.get("path") for operation in operations if isinstance(operation, Mapping)
    }
    required_paths = {
        "/v2/health/ready",
        "/v2/streaming/health/ready",
        "/v2/runtime/requirements",
        "/v2/runtime/installations",
        "/v2/runtime/model-options",
        "/v2/runtime/model-installations",
        "/v2/captures",
        "/v2/captures/{capture_id}/events",
        "/v2/captures/{capture_id}/raw",
        "/v2/captures/{capture_id}/result",
        "/v2/captures/{capture_id}/structure/session",
        "/v2/captures/{capture_id}/structure/session/batches/{batch_index}",
    }
    if not required_paths.issubset(operation_paths):
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract bundle does not advertise the required client surface."
        )

    def find_operation(path: str, method: str | None = None) -> Mapping[str, Any] | None:
        return next(
            (
                item
                for item in operations
                if isinstance(item, Mapping)
                and item.get("path") == path
                and (method is None or item.get("method") == method)
            ),
            None,
        )

    upload = find_operation("/v2/captures")
    chunk = find_operation("/v2/ingestions/{ingestion_id}/chunks/{chunk_index}")
    events = find_operation("/v2/captures/{capture_id}/events")
    session_open = find_operation("/v2/captures/{capture_id}/structure/session", "POST")
    batch_get = find_operation(
        "/v2/captures/{capture_id}/structure/session/batches/{batch_index}", "GET"
    )
    batch_submit = find_operation(
        "/v2/captures/{capture_id}/structure/session/batches/{batch_index}", "PUT"
    )
    if (
        upload is None
        or not isinstance(upload.get("body"), Mapping)
        or upload["body"].get("kind") not in {"json", "none"}
        or "X-Idempotency-Key" not in upload.get("requiredHeaders", [])
    ):
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime v2 capture metadata is incompatible."
        )
    if (
        chunk is None
        or not isinstance(chunk.get("body"), Mapping)
        or chunk["body"].get("kind") != "binary"
        or not all(
            header in chunk.get("requiredHeaders", [])
            for header in ("Content-Range", "Digest", "X-Idempotency-Key")
        )
    ):
        raise CaptureRuntimeCompatibilityError("Capture Runtime v2 chunk metadata is incompatible.")
    streaming = events.get("streaming") if events is not None else None
    if (
        events is None
        or events.get("mediaType") != "text/event-stream"
        or not isinstance(streaming, Mapping)
        or streaming.get("kind") != "sse"
        or streaming.get("lastEventIdHeader") != "Last-Event-ID"
    ):
        raise CaptureRuntimeCompatibilityError("Capture Runtime SSE metadata is incompatible.")
    if (
        session_open is None
        or not isinstance(session_open.get("body"), Mapping)
        or session_open["body"].get("kind") != "json"
        or "X-Idempotency-Key" not in session_open.get("requiredHeaders", [])
        or session_open.get("idempotency", {}).get("mode") != "required"
        or batch_get is None
        or not isinstance(batch_get.get("body"), Mapping)
        or batch_get["body"].get("kind") != "none"
        or batch_submit is None
        or not isinstance(batch_submit.get("body"), Mapping)
        or batch_submit["body"].get("kind") != "json"
        or "X-Idempotency-Key" not in batch_submit.get("requiredHeaders", [])
        or batch_submit.get("idempotency", {}).get("mode") != "required"
    ):
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime pull-session metadata is incompatible."
        )
    canonical_bundle = json.dumps(
        bundle,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    if hashlib.sha256(canonical_bundle).hexdigest() != digest:
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime contract bundle bytes are not canonical."
        )
    schemas = bundle.get("schemas")
    document = (
        next(
            (
                item
                for item in schemas
                if isinstance(item, Mapping) and item.get("name") == "CaptureDocument"
            ),
            None,
        )
        if isinstance(schemas, list)
        else None
    )
    if (
        not isinstance(document, Mapping)
        or document.get("schemaSha256") != CAPTURE_DOCUMENT_SCHEMA_SHA256
    ):
        raise CaptureRuntimeCompatibilityError(
            "Capture Runtime document schema hash is incompatible."
        )
    return str(document["schemaSha256"])


__all__ = [
    "RuntimeDiscovery",
    "assert_compatible",
    "assert_compatible_payload",
    "discover",
    "handshake",
    "validate_contract_bundle",
    "validate_contract_index",
]
