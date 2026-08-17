"""Synchronous Capture Runtime v2 client."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable, Collection, Iterator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from uuid import UUID

import httpx
from pydantic import ValidationError

from ._discovery import (
    RuntimeDiscovery,
    assert_compatible,
    assert_compatible_payload,
    validate_contract_bundle,
    validate_contract_index,
)
from ._discovery import (
    discover as discover_runtime,
)
from ._discovery import (
    handshake as handshake_runtime,
)
from ._error_mapping import (
    decode_capture_operation,
    decode_response,
    decode_streaming_result,
)
from ._retry import RetryPolicy
from ._transport import create_http_runtime_transport
from .codec import decode_model, iter_sse
from .contracts import (
    CAPTURE_CONTRACT_SET_SHA256,
    CaptureDocument,
    CaptureEvent,
    CaptureOperation,
    CaptureSourceKind,
    Ingestion,
    OpenStructuringSession,
    PartialCapture,
    RawCapture,
    RuntimeInstallation,
    RuntimeModelInstallation,
    RuntimeModelOptions,
    RuntimeReady,
    RuntimeRequirements,
    RuntimeStreamingCapabilities,
    StructuringBatch,
    StructuringMode,
    StructuringSession,
    SubmitStructuringBatch,
)
from .errors import CaptureRuntimeProtocolError, CaptureTransportError
from .transport import RuntimeTransport


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
    """Public synchronous facade for authenticated Capture Runtime v2 calls.

    Discovery, retry, transport, and response mapping remain private so
    consumers keep the established import path and method contracts.
    """

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
        retry_policy = RetryPolicy(max_retries, retry_backoff_seconds)
        if transport is None:
            if base_url is None or bearer_token is None:
                raise ValueError("base_url and bearer_token are required without a transport")
            transport = create_http_runtime_transport(
                base_url=base_url,
                bearer_token=bearer_token,
                timeout_seconds=timeout_seconds,
            )
        self._transport = transport
        self._retry_policy = retry_policy
        self._allowed_contract_set_sha256 = frozenset(
            allowed_contract_set_sha256
            or (expected_contract_set_sha256 or CAPTURE_CONTRACT_SET_SHA256,)
        )
        self._max_retries = max_retries
        self._retry_backoff_seconds = retry_backoff_seconds
        self._discovery: RuntimeDiscovery | None = None
        self._discovering = False

    def handshake(self) -> RuntimeReady:
        return handshake_runtime(self._request)

    def discover(self) -> RuntimeDiscovery:
        if self._discovery is not None:
            return self._discovery
        if self._discovering:
            raise CaptureRuntimeProtocolError("Capture Runtime contract discovery re-entered.")
        self._discovering = True
        try:
            self._discovery = discover_runtime(
                self._request,
                allowed_contract_set_sha256=self._allowed_contract_set_sha256,
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
        payload = decode_response(self._request("GET", "/v2/runtime/installations"))
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
        return decode_model(self._request("GET", "/v2/runtime/model-options"), RuntimeModelOptions)

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

    def open_structuring_session(
        self,
        capture_id: str,
        request: OpenStructuringSession | Mapping[str, Any],
        *,
        idempotency_key: UUID | str | None = None,
    ) -> StructuringSession:
        """Open a pull-based structuring session with a matching idempotency key."""
        try:
            payload = (
                request
                if isinstance(request, OpenStructuringSession)
                else OpenStructuringSession.model_validate(request)
            )
        except ValidationError as error:
            raise CaptureRuntimeProtocolError(
                "Structuring session request is invalid.", error.errors(include_url=False)
            ) from error
        if payload.capture_id != capture_id:
            raise CaptureRuntimeProtocolError(
                "Structuring session captureId must match the route capture."
            )
        key = payload.client_request_id if idempotency_key is None else str(idempotency_key)
        if not key or key != payload.client_request_id:
            raise CaptureRuntimeProtocolError(
                "X-Idempotency-Key must match structuring session clientRequestId."
            )
        return decode_model(
            self._request(
                "POST",
                f"/v2/captures/{_safe_id(capture_id)}/structure/session",
                headers={
                    "Content-Type": "application/json",
                    "X-Idempotency-Key": key,
                },
                json=payload.model_dump(mode="json", by_alias=True),
            ),
            StructuringSession,
        )

    def get_structuring_session(self, capture_id: str) -> StructuringSession:
        return decode_model(
            self._request("GET", f"/v2/captures/{_safe_id(capture_id)}/structure/session"),
            StructuringSession,
        )

    def get_structuring_batch(self, capture_id: str, batch_index: int) -> StructuringBatch:
        return decode_model(
            self._request(
                "GET",
                f"/v2/captures/{_safe_id(capture_id)}/structure/session/batches/{_safe_batch_index(batch_index)}",
            ),
            StructuringBatch,
        )

    def pull_structuring_batch(self, capture_id: str, batch_index: int) -> StructuringBatch:
        """Alias that makes the pull nature explicit for host coordinators."""
        return self.get_structuring_batch(capture_id, batch_index)

    def submit_structuring_batch(
        self,
        capture_id: str,
        batch_index: int,
        submission: SubmitStructuringBatch | Mapping[str, Any],
        *,
        idempotency_key: UUID | str,
    ) -> StructuringSession:
        try:
            payload = (
                submission
                if isinstance(submission, SubmitStructuringBatch)
                else SubmitStructuringBatch.model_validate(submission)
            )
        except ValidationError as error:
            raise CaptureRuntimeProtocolError(
                "Structuring batch submission is invalid.", error.errors(include_url=False)
            ) from error
        key = str(idempotency_key)
        if not key:
            raise CaptureRuntimeProtocolError(
                "Structuring batch submissions require X-Idempotency-Key."
            )
        return decode_model(
            self._request(
                "PUT",
                f"/v2/captures/{_safe_id(capture_id)}/structure/session/batches/{_safe_batch_index(batch_index)}",
                headers={
                    "Content-Type": "application/json",
                    "X-Idempotency-Key": key,
                },
                json=payload.model_dump(mode="json", by_alias=True),
            ),
            StructuringSession,
        )

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
        operation, raw, result = decode_streaming_result(
            self._request("GET", f"/v2/captures/{_safe_id(capture_id)}/result"),
            capture_id,
        )
        return CaptureStreamingResult(operation=operation, raw=raw, result=result)

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
                        decode_response(response)
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
            kwargs: dict[str, Any] = {"json": candidate.model_dump(mode="json", by_alias=True)}
        elif isinstance(candidate, Mapping):
            kwargs = {"json": dict(candidate)}
        else:
            kwargs = {
                "content": candidate.encode("utf-8") if isinstance(candidate, str) else candidate
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
        decode_response(self._request("DELETE", f"/v2/captures/{_safe_id(capture_id)}"))

    def close(self) -> None:
        close = getattr(self._transport, "close", None)
        if callable(close):
            close()

    def __enter__(self) -> CaptureRuntimeClient:
        return self

    def __exit__(self, *_args: object) -> None:
        self.close()

    def _request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if path.startswith("/v2/") and path != "/v2/health/ready" and not self._discovering:
            self._ensure_discovered()
        return self._retry_policy.request(self._transport, method, path, **kwargs)

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
        return decode_capture_operation(response, requested_capture_id)

    @staticmethod
    def _assert_compatible(ready: RuntimeReady) -> None:
        assert_compatible(ready)

    @staticmethod
    def _assert_compatible_payload(payload: Mapping[str, Any]) -> None:
        assert_compatible_payload(payload)

    @staticmethod
    def _validate_contract_index(index: Mapping[str, Any], ready: RuntimeReady) -> None:
        validate_contract_index(index, ready)

    @staticmethod
    def _validate_contract_bundle(bundle: Any, digest: str) -> str:
        return validate_contract_bundle(bundle, digest)


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


def _safe_batch_index(value: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError("Capture Runtime batch index is invalid")
    return value


__all__ = ["CaptureRuntimeClient", "CaptureUpload", "CaptureStreamingResult", "RuntimeDiscovery"]
