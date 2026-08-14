"""Synchronous Capture Runtime v2 client."""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Callable, Collection, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError

from .codec import decode_json, decode_model, iter_sse
from .contracts import (
    CAPTURE_API_VERSION,
    CAPTURE_CONTRACT_SET_SHA256,
    CAPTURE_DOCUMENT_SCHEMA_SHA256,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CAPTURE_RUNTIME_VERSION,
    CaptureDocument,
    CaptureEvent,
    CaptureOperation,
    CaptureSourceKind,
    Ingestion,
    PartialCapture,
    RawCapture,
    RuntimeInstallation,
    RuntimeModelInstallation,
    RuntimeModelOptions,
    RuntimeReady,
    RuntimeRequirements,
    RuntimeStreamingCapabilities,
    StructuringMode,
)
from .errors import (
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeProtocolError,
    CaptureTransportError,
)
from .transport import HttpRuntimeTransport, RuntimeTransport


@dataclass(frozen=True, slots=True)
class RuntimeDiscovery:
    ready: RuntimeReady
    streaming: RuntimeStreamingCapabilities | None
    schema_sha256: str
    contract_index: Mapping[str, Any]
    contract_bundle: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class CaptureUpload:
    file_name: str
    content: bytes
    source_kind: CaptureSourceKind | str
    media_type: str = "application/octet-stream"
    structuring_mode: StructuringMode | str = StructuringMode.RUNTIME
    target_language: str | None = None


@dataclass(frozen=True, slots=True)
class CaptureStreamingResult:
    operation: CaptureOperation
    raw: RawCapture
    result: CaptureDocument


class CaptureRuntimeClient:
    def __init__(
        self,
        *,
        transport: RuntimeTransport | None = None,
        base_url: str | int | None = None,
        bearer_token: str | None = None,
        timeout_seconds: float = 30,
        expected_contract_set_sha256: str | None = None,
        allowed_contract_set_sha256: Collection[str] | None = None,
        max_retries: int = 2,
        retry_backoff_seconds: float = 0.0,
    ) -> None:
        if max_retries < 0:
            raise ValueError("max_retries must be non-negative")
        if retry_backoff_seconds < 0:
            raise ValueError("retry_backoff_seconds must be non-negative")
        if transport is None:
            if base_url is None or bearer_token is None:
                raise ValueError("base_url and bearer_token are required without a transport")
            transport = HttpRuntimeTransport(
                base_url=base_url, bearer_token=bearer_token, timeout_seconds=timeout_seconds
            )
        self._transport = transport
        self._allowed_contract_set_sha256 = frozenset(
            allowed_contract_set_sha256
            or (expected_contract_set_sha256 or CAPTURE_CONTRACT_SET_SHA256,)
        )
        self._max_retries = max_retries
        self._retry_backoff_seconds = retry_backoff_seconds
        self._discovery: RuntimeDiscovery | None = None
        self._discovering = False

    def handshake(self) -> RuntimeReady:
        response = self._request("GET", "/v2/health/ready")
        payload = decode_json(response)
        if not isinstance(payload, Mapping):
            raise CaptureRuntimeProtocolError(
                "Capture Runtime readiness response is not an object."
            )
        self._assert_compatible_payload(payload)
        ready = decode_model(httpx.Response(200, json=payload), RuntimeReady)
        self._assert_compatible(ready)
        return ready

    def discover(self) -> RuntimeDiscovery:
        if self._discovery is not None:
            return self._discovery
        if self._discovering:
            raise CaptureRuntimeProtocolError("Capture Runtime contract discovery re-entered.")
        self._discovering = True
        try:
            ready = self.handshake()
            index_response = self._request("GET", "/meta/v2/contracts")
            index = decode_json(index_response)
            if not isinstance(index, Mapping):
                raise CaptureRuntimeProtocolError(
                    "Capture Runtime contract index is not an object."
                )
            self._validate_contract_index(index, ready)
            href = index.get("href")
            if not isinstance(href, str) or not href.startswith(
                "/meta/v2/contracts/sha256/"
            ):
                raise CaptureRuntimeProtocolError("Capture Runtime contract index href is invalid.")
            href_digest = href.removeprefix("/meta/v2/contracts/sha256/")
            if not re.fullmatch(r"[0-9a-f]{64}", href_digest) or href_digest != index.get(
                "sha256"
            ):
                raise CaptureRuntimeCompatibilityError(
                    "Capture Runtime contract index href digest does not match "
                    "its advertised bundle hash."
                )
            bundle_response = self._request("GET", href)
            bundle_bytes = bundle_response.content
            digest = hashlib.sha256(bundle_bytes).hexdigest()
            if digest not in self._allowed_contract_set_sha256:
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
            schema_sha256 = self._validate_contract_bundle(bundle, digest)
            streaming = decode_model(
                self._request("GET", "/v2/streaming/health/ready"),
                RuntimeStreamingCapabilities,
            )
            self._discovery = RuntimeDiscovery(
                ready=ready,
                streaming=streaming,
                schema_sha256=schema_sha256,
                contract_index=index,
                contract_bundle=bundle,
            )
            return self._discovery
        finally:
            self._discovering = False

    def get_requirements(self) -> RuntimeRequirements:
        return decode_model(self._request("GET", "/v2/runtime/requirements"), RuntimeRequirements)

    def start_installation(
        self, requirement_id: str, *, idempotency_key: UUID | str
    ) -> RuntimeInstallation:
        return decode_model(
            self._request(
                "POST",
                "/v2/runtime/installations",
                headers={"X-Idempotency-Key": str(idempotency_key)},
                json={"requirementId": requirement_id, "consent": True},
            ),
            RuntimeInstallation,
        )

    def list_installations(self) -> list[RuntimeInstallation]:
        payload = decode_json(self._request("GET", "/v2/runtime/installations"))
        if not isinstance(payload, Mapping) or not isinstance(payload.get("items"), list):
            raise CaptureRuntimeProtocolError("Capture Runtime installations response is invalid.")
        try:
            return [RuntimeInstallation.model_validate(item) for item in payload["items"]]
        except ValidationError as error:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime installations response is invalid."
            ) from error

    def get_installation(self, installation_id: str) -> RuntimeInstallation:
        return decode_model(
            self._request("GET", f"/v2/runtime/installations/{_safe_id(installation_id)}"),
            RuntimeInstallation,
        )

    def cancel_installation(self, installation_id: str) -> RuntimeInstallation:
        return decode_model(
            self._request("POST", f"/v2/runtime/installations/{_safe_id(installation_id)}/cancel"),
            RuntimeInstallation,
        )

    def get_model_options(self) -> RuntimeModelOptions:
        return decode_model(
            self._request("GET", "/v2/runtime/model-options"), RuntimeModelOptions
        )

    def get_model_installation(self, installation_id: str) -> RuntimeModelInstallation:
        return decode_model(
            self._request("GET", f"/v2/runtime/model-installations/{_safe_id(installation_id)}"),
            RuntimeModelInstallation,
        )

    def get_model_installation_status(self, installation_id: str) -> RuntimeModelInstallation:
        """Status-oriented alias for :meth:`get_model_installation`."""
        return self.get_model_installation(installation_id)

    def cancel_model_installation(self, installation_id: str) -> RuntimeModelInstallation:
        return decode_model(
            self._request(
                "POST", f"/v2/runtime/model-installations/{_safe_id(installation_id)}/cancel"
            ),
            RuntimeModelInstallation,
        )

    def start_capture(self, upload: CaptureUpload, *, client_request_id: str) -> CaptureOperation:
        """Open, upload, finalize, and start one v2 capture operation."""
        return self.start_streaming_capture(upload, client_request_id=client_request_id)

    def upload_path(
        self,
        path: Path,
        *,
        source_kind: CaptureSourceKind | str,
        client_request_id: str,
        media_type: str = "application/octet-stream",
        target_language: str | None = None,
    ) -> CaptureOperation:
        return self.start_capture(
            CaptureUpload(
                path.name,
                path.read_bytes(),
                source_kind,
                media_type,
                target_language=target_language,
            ),
            client_request_id=client_request_id,
        )

    def get_capture(self, capture_id: str) -> CaptureOperation:
        return self.get_streaming_capture(capture_id)

    def cancel_capture(self, capture_id: str) -> CaptureOperation:
        return self.cancel_streaming_capture(capture_id)

    def get_raw(self, capture_id: str) -> RawCapture:
        return decode_model(
            self._request("GET", f"/v2/captures/{_safe_id(capture_id)}/raw"), RawCapture
        )

    def get_result(self, capture_id: str) -> CaptureStreamingResult:
        return self.get_streaming_result(capture_id)

    def commit_structure(
        self,
        capture_id: str,
        candidate: str | bytes | Mapping[str, object] | CaptureDocument,
        *,
        idempotency_key: UUID | str,
    ) -> CaptureOperation:
        return self.commit_streaming_structure(
            capture_id,
            candidate,
            idempotency_key=idempotency_key,
        )

    def report_structuring_failure(
        self,
        capture_id: str,
        *,
        code: str,
        message: str,
        idempotency_key: UUID | str,
    ) -> CaptureOperation:
        return self.report_streaming_failure(
            capture_id,
            code=code,
            message=message,
            idempotency_key=idempotency_key,
        )

    def delete_capture(self, capture_id: str) -> None:
        self.delete_streaming_capture(capture_id)

    def get_streaming_capabilities(self) -> RuntimeStreamingCapabilities:
        return decode_model(
            self._request("GET", "/v2/streaming/health/ready"), RuntimeStreamingCapabilities
        )

    def start_streaming_capture(
        self, upload: CaptureUpload, *, client_request_id: str
    ) -> CaptureOperation:
        content = upload.content
        digest = hashlib.sha256(content).hexdigest()
        kind = CaptureSourceKind(upload.source_kind)
        ingestion = decode_model(
            self._request(
                "POST",
                "/v2/ingestions",
                headers={"X-Idempotency-Key": f"{client_request_id}-ingestion"},
                json={
                    "protocolVersion": "2",
                    "kind": kind.value,
                    "mode": "file",
                    "clientRequestId": f"{client_request_id}-ingestion",
                    "fileName": upload.file_name,
                    "mediaType": upload.media_type,
                    "totalBytes": len(content),
                    "sourceSha256": digest,
                },
            ),
            Ingestion,
        )
        try:
            chunk_size = min(1024 * 1024, self.get_streaming_capabilities().max_chunk_bytes)
            for offset in range(ingestion.next_offset, len(content), chunk_size):
                chunk = content[offset : offset + chunk_size]
                ingestion = decode_model(
                    self._request(
                        "PUT",
                        f"/v2/ingestions/{ingestion.ingestion_id}/chunks/{ingestion.next_chunk_index}",
                        headers={
                            "Content-Range": (
                                f"bytes {offset}-{offset + len(chunk) - 1}/{len(content)}"
                            ),
                            "Digest": f"sha-256={hashlib.sha256(chunk).hexdigest()}",
                            "X-Idempotency-Key": (
                                f"{ingestion.ingestion_id}-{ingestion.next_chunk_index}"
                            ),
                        },
                        content=chunk,
                    ),
                    Ingestion,
                )
            decode_model(
                self._request(
                    "POST",
                    f"/v2/ingestions/{ingestion.ingestion_id}/finalize",
                    json={"protocolVersion": "2", "totalBytes": len(content), "sha256": digest},
                ),
                Ingestion,
            )
            return decode_model(
                self._request(
                    "POST",
                    "/v2/captures",
                    headers={"X-Idempotency-Key": client_request_id},
                    json={
                        "protocolVersion": "2",
                        "clientRequestId": client_request_id,
                        "ingestionId": ingestion.ingestion_id,
                        "structuringMode": StructuringMode(upload.structuring_mode).value,
                        "targetLanguage": upload.target_language,
                        "startPolicy": "eager",
                    },
                ),
                CaptureOperation,
            )
        except Exception:
            self._transport.request("DELETE", f"/v2/ingestions/{ingestion.ingestion_id}")
            raise

    def get_streaming_capture(self, capture_id: str) -> CaptureOperation:
        return self._decode_capture_operation(
            self._request("GET", f"/v2/captures/{_safe_id(capture_id)}"), capture_id
        )

    def get_partial(self, capture_id: str) -> PartialCapture:
        partial = decode_model(
            self._request("GET", f"/v2/captures/{_safe_id(capture_id)}/partial"), PartialCapture
        )
        if partial.capture_id != capture_id:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned an invalid capture identity."
            )
        return partial

    def get_streaming_result(self, capture_id: str) -> CaptureStreamingResult:
        payload = decode_json(self._request("GET", f"/v2/captures/{_safe_id(capture_id)}/result"))
        try:
            operation = CaptureOperation.model_validate(payload["operation"])
            raw = RawCapture.model_validate(payload["raw"])
            result = CaptureDocument.model_validate(payload["result"])
            if operation.capture_id != capture_id:
                raise ValueError("capture identity mismatch")
            if raw.source != result.source or (
                operation.source is not None and operation.source != raw.source
            ):
                raise ValueError("source identity mismatch")
            return CaptureStreamingResult(
                operation=operation,
                raw=raw,
                result=result,
            )
        except (KeyError, TypeError, ValueError, ValidationError) as error:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned an invalid streaming result."
            ) from error

    def capture_events(
        self,
        capture_id: str,
        *,
        last_event_id: int | str | None = None,
        max_reconnects: int = 2,
        on_activity: Callable[[], None] | None = None,
    ) -> Iterator[CaptureEvent]:
        if max_reconnects < 0:
            raise ValueError("max_reconnects must be non-negative")
        self._ensure_discovered()
        previous = int(last_event_id) if last_event_id is not None else -1
        reconnects = 0
        while True:
            headers = {"Accept": "text/event-stream"}
            if previous >= 0:
                headers["Last-Event-ID"] = str(previous)
            try:
                with self._transport.stream(
                    "GET", f"/v2/captures/{_safe_id(capture_id)}/events", headers=headers
                ) as response:
                    if response.status_code >= 400:
                        decode_json(response)
                    content_type = response.headers.get("content-type", "")
                    if not content_type.lower().startswith("text/event-stream"):
                        raise CaptureRuntimeProtocolError(
                            "Capture Runtime event stream has an invalid content type."
                        )

                    def chunks() -> Iterator[bytes]:
                        for chunk in response.iter_bytes():
                            if on_activity is not None:
                                on_activity()
                            yield chunk

                    for frame in iter_sse(chunks()):
                        try:
                            event = CaptureEvent.model_validate(json.loads(frame["data"]))
                        except (KeyError, json.JSONDecodeError, ValidationError) as error:
                            raise CaptureRuntimeProtocolError(
                                "Capture Runtime returned an invalid event frame."
                            ) from error
                        if event.capture_id != capture_id or event.sequence <= previous:
                            raise CaptureRuntimeProtocolError(
                                "Capture Runtime returned an invalid event identity or sequence."
                            )
                        previous = event.sequence
                        yield event
                        if event.event_type.value in {"completed", "failed", "cancelled"}:
                            return
            except CaptureRuntimeProtocolError:
                raise
            except (UnicodeDecodeError, ValueError) as error:
                raise CaptureRuntimeProtocolError(
                    "Capture Runtime returned an invalid event stream."
                ) from error
            except (CaptureTransportError, httpx.HTTPError):
                if reconnects >= max_reconnects:
                    raise
                reconnects += 1
                continue
            if reconnects >= max_reconnects:
                return
            reconnects += 1

    def cancel_streaming_capture(self, capture_id: str) -> CaptureOperation:
        return self._decode_capture_operation(
            self._request("POST", f"/v2/captures/{_safe_id(capture_id)}/cancel"), capture_id
        )

    def commit_streaming_structure(
        self,
        capture_id: str,
        candidate: str | bytes | Mapping[str, object] | CaptureDocument,
        *,
        idempotency_key: UUID | str,
    ) -> CaptureOperation:
        headers = {
            "Content-Type": "application/json",
            "X-Idempotency-Key": str(idempotency_key),
        }
        if isinstance(candidate, CaptureDocument):
            kwargs: dict[str, Any] = {
                "json": candidate.model_dump(mode="json", by_alias=True)
            }
        elif isinstance(candidate, Mapping):
            kwargs = {"json": dict(candidate)}
        else:
            kwargs = {
                "content": candidate.encode("utf-8")
                if isinstance(candidate, str)
                else candidate
            }
        return self._decode_capture_operation(
            self._request(
                "POST",
                f"/v2/captures/{_safe_id(capture_id)}/structure/commit",
                headers=headers,
                **kwargs,
            ),
            capture_id,
        )

    def report_streaming_failure(
        self, capture_id: str, *, code: str, message: str, idempotency_key: UUID | str
    ) -> CaptureOperation:
        return self._decode_capture_operation(
            self._request(
                "POST",
                f"/v2/captures/{_safe_id(capture_id)}/structure/failure",
                headers={"X-Idempotency-Key": str(idempotency_key)},
                json={"protocolVersion": "2", "code": code, "message": message},
            ),
            capture_id,
        )

    def delete_streaming_capture(self, capture_id: str) -> None:
        decode_json(self._request("DELETE", f"/v2/captures/{_safe_id(capture_id)}"))

    def close(self) -> None:
        close = getattr(self._transport, "close", None)
        if callable(close):
            close()

    def __enter__(self) -> CaptureRuntimeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if (
            path.startswith("/v2/")
            and path != "/v2/health/ready"
            and not self._discovering
        ):
            self._ensure_discovered()
        normalized_method = method.upper()
        headers = kwargs.get("headers") or {}
        has_idempotency_key = any(
            str(key).lower() == "x-idempotency-key" and bool(value)
            for key, value in dict(headers).items()
        )
        retryable_request = normalized_method in {"GET", "HEAD", "DELETE"} or has_idempotency_key
        retries = self._max_retries if retryable_request else 0
        for attempt in range(retries + 1):
            try:
                response = self._transport.request(method, path, **kwargs)
            except CaptureTransportError:
                if attempt >= retries:
                    raise
                self._sleep_before_retry(attempt)
                continue
            except httpx.HTTPError as error:
                if attempt >= retries:
                    raise CaptureTransportError(
                        "Capture Runtime transport request failed.", str(error)
                    ) from error
                self._sleep_before_retry(attempt)
                continue
            if response.status_code in {408, 425, 429, 500, 502, 503, 504} and attempt < retries:
                retry_after = _retry_after_seconds(response)
                response.close()
                self._sleep_before_retry(attempt, retry_after)
                continue
            return response
        raise AssertionError("retry loop must return or raise")

    def _ensure_discovered(self) -> RuntimeDiscovery:
        if self._discovery is not None:
            return self._discovery
        if self._discovering:
            raise CaptureRuntimeProtocolError("Capture Runtime contract discovery re-entered.")
        return self.discover()

    @staticmethod
    def _decode_capture_operation(
        response: httpx.Response, requested_capture_id: str
    ) -> CaptureOperation:
        operation = decode_model(response, CaptureOperation)
        if operation.capture_id != requested_capture_id:
            raise CaptureRuntimeProtocolError(
                "Capture Runtime returned an invalid capture identity."
            )
        return operation

    def _sleep_before_retry(self, attempt: int, retry_after: float | None = None) -> None:
        delay = (
            retry_after
            if retry_after is not None
            else self._retry_backoff_seconds * (2**attempt)
        )
        if delay > 0:
            time.sleep(delay)

    @staticmethod
    def _assert_compatible(ready: RuntimeReady) -> None:
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

    @staticmethod
    def _assert_compatible_payload(payload: Mapping[str, Any]) -> None:
        failures: list[str] = []
        if payload.get("apiVersion") != CAPTURE_API_VERSION:
            failures.append("API version is unsupported")
        if payload.get("captureDocumentSchemaVersion") != CAPTURE_DOCUMENT_SCHEMA_VERSION:
            failures.append("CaptureDocument schema version is unsupported")
        if failures:
            raise CaptureRuntimeCompatibilityError("; ".join(failures))

    @staticmethod
    def _validate_contract_index(index: Mapping[str, Any], ready: RuntimeReady) -> None:
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

    @staticmethod
    def _validate_contract_bundle(bundle: Any, digest: str) -> str:
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
            raise CaptureRuntimeProtocolError(
                "Capture Runtime contract bundle operations are invalid."
            )
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
        }
        if not required_paths.issubset(operation_paths):
            raise CaptureRuntimeCompatibilityError(
                "Capture Runtime contract bundle does not advertise the required client surface."
            )

        def find_operation(path: str) -> Mapping[str, Any] | None:
            return next(
                (
                    item
                    for item in operations
                    if isinstance(item, Mapping) and item.get("path") == path
                ),
                None,
            )

        upload = find_operation("/v2/captures")
        chunk = find_operation("/v2/ingestions/{ingestion_id}/chunks/{chunk_index}")
        events = find_operation("/v2/captures/{capture_id}/events")
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
            raise CaptureRuntimeCompatibilityError(
                "Capture Runtime v2 chunk metadata is incompatible."
            )
        streaming = events.get("streaming") if events is not None else None
        if (
            events is None
            or events.get("mediaType") != "text/event-stream"
            or not isinstance(streaming, Mapping)
            or streaming.get("kind") != "sse"
            or streaming.get("lastEventIdHeader") != "Last-Event-ID"
        ):
            raise CaptureRuntimeCompatibilityError("Capture Runtime SSE metadata is incompatible.")
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


def _safe_id(value: str) -> str:
    if (
        not value
        or len(value) > 128
        or any(
            char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
            for char in value
        )
    ):
        raise ValueError("Capture Runtime identifier is invalid")
    return value


def _retry_after_seconds(response: httpx.Response) -> float | None:
    value = response.headers.get("retry-after")
    if value is None:
        return None
    try:
        return max(0.0, float(value))
    except ValueError:
        return None


__all__ = ["CaptureRuntimeClient", "CaptureUpload", "CaptureStreamingResult", "RuntimeDiscovery"]
