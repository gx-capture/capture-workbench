"""Canonical, authenticated runtime contract discovery data.

The runtime owns the wire contracts, but consumers need a small immutable
description of the current API surface before they can safely issue requests.
This module builds that description in-process from the generated contract
artifacts when they are available (and from the canonical Pydantic models when
the runtime is installed without the sibling package).  The bundle is hashed
from its exact canonical UTF-8 JSON bytes; the hash is therefore the identity
of the immutable payload served by the discovery routes.
"""

from __future__ import annotations

import inspect
import json
import re
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from pydantic import BaseModel

import capture_runtime.contracts as contracts
from capture_runtime import _contract_set_bundle as _bundle_support
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.problem_registry import (
    DEFAULT_PROBLEM_REGISTRY,
    ProblemDefinition,
    ProblemRegistry,
)
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    capture_document_schema_release_bytes,
)

CONTRACT_SET_VERSION = "2"
CATALOG_VERSION = CONTRACT_SET_VERSION
SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema"
CONTRACT_MEDIA_TYPE = "application/json"
DISCOVERY_PATH = "/meta/v2/contracts"
DISCOVERY_BUNDLE_PATH = f"{DISCOVERY_PATH}/sha256"
CONTRACT_ASSET_DIR = Path(__file__).resolve().parent / "assets"
CONTRACT_ASSET_PATH = CONTRACT_ASSET_DIR / "contract-set.json"
CONTRACT_ASSET_SHA256_PATH = CONTRACT_ASSET_DIR / "contract-set.sha256"


class ContractSetError(ValueError):
    """Raised when a contract index or bundle fails integrity validation."""


def _duplicate(values: Iterable[object]) -> list[object]:
    return _bundle_support.duplicate(values)


def _validate_bundle_entries(bundle: Mapping[str, Any]) -> None:
    """Reject duplicate catalog entries and dangling references before serving bytes."""
    _bundle_support.validate_bundle_entries(
        bundle,
        error_type=ContractSetError,
        duplicate_fn=_duplicate,
    )


def _assert_secret_free(value: object, *, _path: str = "bundle") -> None:
    """Fail closed if executable contract bytes contain credential-shaped fields.

    Authentication *policy* (for example ``authentication: bearer``) is safe
    metadata.  Actual credential fields are not; rejecting them here prevents a
    future builder from accidentally embedding runtime settings or bearer
    tokens in the immutable executable bundle.
    """

    _bundle_support.assert_secret_free(value, error_type=ContractSetError, path=_path)


def route_inventory(routes: Iterable[object]) -> tuple[tuple[str, str], ...]:
    """Return normalized public runtime HTTP route keys from FastAPI routes.

    FastAPI 0.115 keeps included routers as lazy ``_IncludedRouter`` entries
    until OpenAPI/startup; walk both concrete routes and included-router
    children so the drift check is valid before the first request.  Preserve
    legacy entries in the observed inventory so a retired route is reported
    as an explicit ``extra`` operation instead of silently disappearing.
    """

    return _bundle_support.route_inventory(routes)


def contract_operation_inventory(contract_set: ContractSet) -> tuple[tuple[str, str], ...]:
    """Return normalized v2 operation keys from a loaded contract set."""
    return _bundle_support.contract_operation_inventory(contract_set.bundle)


def validate_route_inventory(routes: Iterable[object], contract_set: ContractSet) -> None:
    """Fail closed when registered public routes drift from the immutable catalog."""

    expected = contract_operation_inventory(contract_set)
    actual = route_inventory(routes)
    if expected != actual:
        expected_set = set(expected)
        actual_set = set(actual)
        missing = sorted(expected_set - actual_set)
        extra = sorted(actual_set - expected_set)
        raise ContractSetError(
            f"runtime route inventory drift: missing={missing!r}; extra={extra!r}"
        )


def canonical_json_bytes(value: object) -> bytes:
    """Serialize JSON deterministically for hashing and transport."""
    return _bundle_support.canonical_json_bytes(value, error_type=ContractSetError)


def sha256_hex(value: bytes) -> str:
    """Return the lowercase SHA-256 digest for exact bytes."""
    return _bundle_support.sha256_hex(value)


def _deep_freeze(value: Any) -> Any:
    """Freeze nested contract data so served bytes cannot drift in-process."""
    return _bundle_support.deep_freeze(value)


def _json_source(source: object) -> dict[str, Any]:
    return _bundle_support.json_source(source, error_type=ContractSetError)


def load_contract_index(source: object) -> dict[str, Any]:
    """Load and validate the shape of a discovery index."""
    index = _json_source(source)
    required = {"catalogVersion", "runtimeVersion", "contractSetVersion", "surfaces", "sha256"}
    missing = required.difference(index)
    if missing:
        raise ContractSetError(f"contract index is missing fields: {', '.join(sorted(missing))}")
    if index.get("catalogVersion") != CATALOG_VERSION:
        raise ContractSetError("unsupported catalogVersion")
    if index.get("contractSetVersion") != CONTRACT_SET_VERSION:
        raise ContractSetError("unsupported contractSetVersion")
    digest = index.get("sha256")
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ContractSetError("contract index sha256 must be lowercase hexadecimal")
    return index


def load_contract_bundle(source: object) -> dict[str, Any]:
    """Load and validate the shape of an immutable contract bundle."""
    bundle = _json_source(source)
    required = {
        "contractSetVersion",
        "schemaDialect",
        "surfaces",
        "schemas",
        "operations",
        "problems",
        "invariants",
    }
    missing = required.difference(bundle)
    if missing:
        raise ContractSetError(f"contract bundle is missing fields: {', '.join(sorted(missing))}")
    if bundle.get("contractSetVersion") != CONTRACT_SET_VERSION:
        raise ContractSetError("unsupported contractSetVersion")
    if bundle.get("schemaDialect") != SCHEMA_DIALECT:
        raise ContractSetError("unsupported JSON Schema dialect")
    for field in ("surfaces", "schemas", "operations", "problems", "invariants"):
        if not isinstance(bundle[field], list):
            raise ContractSetError(f"contract bundle {field} must be an array")
    _validate_bundle_entries(bundle)
    _assert_secret_free(bundle)
    return bundle


@dataclass(frozen=True, slots=True)
class ContractSet:
    """An immutable contract bundle and its discovery index."""

    _bundle: Mapping[str, Any]
    _index: Mapping[str, Any]
    _bundle_bytes: bytes
    _index_bytes: bytes
    sha256: str

    @property
    def bundle(self) -> Mapping[str, Any]:
        return self._bundle

    @property
    def index(self) -> Mapping[str, Any]:
        return self._index

    @property
    def bundle_bytes(self) -> bytes:
        return self._bundle_bytes

    @property
    def index_bytes(self) -> bytes:
        return self._index_bytes

    @property
    def etag(self) -> str:
        """The strong HTTP ETag for both index and bundle representations."""

        return f'"{self.sha256}"'

    @classmethod
    def from_parts(cls, index: object, bundle: object) -> ContractSet:
        """Load an index/bundle pair and verify the index digest."""

        loaded_index = load_contract_index(index)
        loaded_bundle = load_contract_bundle(bundle)
        bundle_bytes = canonical_json_bytes(loaded_bundle)
        digest = sha256_hex(bundle_bytes)
        if loaded_index["sha256"] != digest:
            raise ContractSetError("contract index sha256 does not match bundle bytes")
        index_bytes = canonical_json_bytes(loaded_index)
        return cls(
            _bundle=_deep_freeze(loaded_bundle),
            _index=_deep_freeze(loaded_index),
            _bundle_bytes=bundle_bytes,
            _index_bytes=index_bytes,
            sha256=digest,
        )

    @classmethod
    def from_bundle(
        cls,
        bundle: object,
        *,
        runtime_version: str = RUNTIME_VERSION,
        href_prefix: str = DISCOVERY_BUNDLE_PATH,
    ) -> ContractSet:
        """Build an index from an immutable bundle mapping or JSON source."""

        loaded_bundle = load_contract_bundle(bundle)
        bundle_bytes = canonical_json_bytes(loaded_bundle)
        digest = sha256_hex(bundle_bytes)
        surfaces = loaded_bundle["surfaces"]
        index = {
            "catalogVersion": CATALOG_VERSION,
            "runtimeVersion": runtime_version,
            "contractSetVersion": loaded_bundle["contractSetVersion"],
            "surfaces": surfaces,
            "sha256": digest,
            "href": f"{href_prefix}/{digest}",
            "mediaType": CONTRACT_MEDIA_TYPE,
        }
        return cls.from_parts(index, loaded_bundle)


def _schema_filename(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower() + ".schema.json"


def _model_types() -> dict[str, type[BaseModel]]:
    return {
        name: value
        for name, value in vars(contracts).items()
        if inspect.isclass(value)
        and issubclass(value, BaseModel)
        and value is not BaseModel
        and name != "StrictModel"
    }


def _load_schemas() -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build schemas from runtime-owned Pydantic models deterministically.

    The runtime executable derives every schema from the models shipped in this
    package so source and frozen executables share one contract-set identity.
    CaptureDocument is the one release-pinned schema whose hash is
    defined over its exact release bytes rather than canonicalized JSON.
    """

    records: list[dict[str, Any]] = []
    for name, model in sorted(_model_types().items()):
        schema = (
            json.loads(capture_document_schema_release_bytes())
            if name == "CaptureDocument"
            else model.model_json_schema(by_alias=True, ref_template="#/$defs/{model}")
        )
        records.append(
            {
                "name": name,
                "schemaFile": _schema_filename(name),
                "schemaSha256": (
                    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256
                    if name == "CaptureDocument"
                    else sha256_hex(canonical_json_bytes(schema))
                ),
                "extraPolicy": "forbid",
                "strStripWhitespace": True,
                "schema": schema,
            }
        )
    return records, []


def _surface_definitions() -> list[dict[str, Any]]:
    return [
        {
            "id": "v2",
            "version": "2",
            "basePath": "/v2",
            "mediaType": CONTRACT_MEDIA_TYPE,
            "authentication": "bearer",
        },
    ]


def _operation(
    operation_id: str,
    surface: str,
    method: str,
    path: str,
    *,
    request_schema: str | None = None,
    response_schema: str | None = None,
    media_type: str = CONTRACT_MEDIA_TYPE,
    problems: tuple[str, ...] = (),
    body_kind: str = "none",
    required_headers: tuple[str, ...] = (),
    optional_headers: tuple[str, ...] = (),
    idempotency: str = "none",
    response_statuses: tuple[int, ...] = (200,),
) -> dict[str, Any]:
    operation = {
        "id": operation_id,
        "surface": surface,
        "method": method,
        "path": path,
        "requestSchema": request_schema,
        "responseSchema": response_schema,
        "mediaType": media_type,
        "problems": list(problems),
        "body": {"kind": body_kind},
        "requiredHeaders": list(required_headers),
        "optionalHeaders": list(optional_headers),
        "idempotency": {
            "mode": idempotency,
            "header": "X-Idempotency-Key" if idempotency != "none" else None,
        },
        "responseStatusCodes": list(response_statuses),
    }
    if media_type == "text/event-stream":
        operation["streaming"] = {
            "kind": "sse",
            "lastEventIdHeader": "Last-Event-ID",
        }
    return operation


_COMMON_PROBLEMS = (
    "unauthorized",
    "invalid_host",
    "origin_not_allowed",
    "validation_error",
)


def _operation_definitions() -> list[dict[str, Any]]:
    """Describe every currently registered authenticated v2 operation."""

    v2 = "/v2"
    operations = [
        _operation(
            "v2.health.ready",
            "v2",
            "GET",
            f"{v2}/health/ready",
            response_schema="RuntimeReady",
            problems=_COMMON_PROBLEMS,
        ),
        _operation(
            "v2.streaming.health.ready",
            "v2",
            "GET",
            f"{v2}/streaming/health/ready",
            response_schema="RuntimeStreamingCapabilitiesV2",
            problems=_COMMON_PROBLEMS,
        ),
        _operation(
            "v2.ingestions.open",
            "v2",
            "POST",
            f"{v2}/ingestions",
            request_schema="OpenIngestionV2",
            response_schema="IngestionV2",
            problems=_COMMON_PROBLEMS + ("idempotency_conflict",),
            body_kind="json",
            required_headers=("X-Idempotency-Key",),
            idempotency="required",
            response_statuses=(201,),
        ),
        _operation(
            "v2.ingestions.get",
            "v2",
            "GET",
            f"{v2}/ingestions/{{ingestion_id}}",
            response_schema="IngestionV2",
            problems=_COMMON_PROBLEMS + ("ingestion_not_found",),
        ),
        _operation(
            "v2.ingestions.chunks.append",
            "v2",
            "PUT",
            f"{v2}/ingestions/{{ingestion_id}}/chunks/{{chunk_index}}",
            response_schema="IngestionV2",
            problems=_COMMON_PROBLEMS
            + (
                "ingestion_not_found",
                "invalid_chunk_headers",
                "chunk_too_large",
                "chunk_total_conflict",
                "chunk_length_mismatch",
                "chunk_checksum_mismatch",
                "chunk_conflict",
                "chunk_out_of_order",
                "chunk_rejected",
            ),
            body_kind="binary",
            required_headers=("Content-Range", "Digest", "X-Idempotency-Key"),
            idempotency="required",
        ),
        _operation(
            "v2.ingestions.finalize",
            "v2",
            "POST",
            f"{v2}/ingestions/{{ingestion_id}}/finalize",
            request_schema="FinalizeIngestionV2",
            response_schema="IngestionV2",
            problems=_COMMON_PROBLEMS + ("ingestion_not_found", "ingestion_finalize_rejected"),
            body_kind="json",
        ),
        _operation(
            "v2.ingestions.delete",
            "v2",
            "DELETE",
            f"{v2}/ingestions/{{ingestion_id}}",
            problems=_COMMON_PROBLEMS + ("ingestion_not_found", "ingestion_delete_rejected"),
            response_statuses=(204,),
        ),
        _operation(
            "v2.captures.start",
            "v2",
            "POST",
            f"{v2}/captures",
            request_schema="StartCaptureV2",
            response_schema="CaptureOperationV2",
            problems=_COMMON_PROBLEMS + ("ingestion_not_found", "idempotency_conflict"),
            body_kind="json",
            required_headers=("X-Idempotency-Key",),
            idempotency="required",
            response_statuses=(202,),
        ),
        _operation(
            "v2.captures.get",
            "v2",
            "GET",
            f"{v2}/captures/{{capture_id}}",
            response_schema="CaptureOperationV2",
            problems=_COMMON_PROBLEMS + ("capture_not_found",),
        ),
        _operation(
            "v2.captures.events",
            "v2",
            "GET",
            f"{v2}/captures/{{capture_id}}/events",
            media_type="text/event-stream",
            problems=_COMMON_PROBLEMS + ("capture_not_found", "invalid_event_cursor"),
            optional_headers=("Last-Event-ID",),
        ),
        _operation(
            "v2.captures.partial",
            "v2",
            "GET",
            f"{v2}/captures/{{capture_id}}/partial",
            response_schema="PartialCaptureV2",
            problems=_COMMON_PROBLEMS + ("capture_not_found", "partial_unavailable"),
        ),
        _operation(
            "v2.captures.raw",
            "v2",
            "GET",
            f"{v2}/captures/{{capture_id}}/raw",
            response_schema="RawCapture",
            problems=_COMMON_PROBLEMS + ("capture_not_found", "raw_unavailable"),
        ),
        _operation(
            "v2.captures.cancel",
            "v2",
            "POST",
            f"{v2}/captures/{{capture_id}}/cancel",
            response_schema="CaptureOperationV2",
            problems=_COMMON_PROBLEMS + ("capture_not_found",),
        ),
        _operation(
            "v2.captures.structure",
            "v2",
            "POST",
            f"{v2}/captures/{{capture_id}}/structure",
            response_schema="CaptureStreamingResult",
            problems=_COMMON_PROBLEMS
            + ("capture_not_found", "raw_unavailable", "invalid_capture_state"),
        ),
        _operation(
            "v2.captures.structure.session.open",
            "v2",
            "POST",
            f"{v2}/captures/{{capture_id}}/structure/session",
            request_schema="OpenStructuringSessionV2",
            response_schema="StructuringSessionV2",
            problems=_COMMON_PROBLEMS
            + (
                "capture_not_found",
                "raw_unavailable",
                "invalid_capture_state",
                "idempotency_conflict",
                "structuring_session_corrupt",
            ),
            body_kind="json",
            required_headers=("X-Idempotency-Key",),
            idempotency="required",
            response_statuses=(201,),
        ),
        _operation(
            "v2.captures.structure.session.get",
            "v2",
            "GET",
            f"{v2}/captures/{{capture_id}}/structure/session",
            response_schema="StructuringSessionV2",
            problems=_COMMON_PROBLEMS + ("structuring_session_not_found",),
        ),
        _operation(
            "v2.captures.structure.session.batch.get",
            "v2",
            "GET",
            f"{v2}/captures/{{capture_id}}/structure/session/batches/{{batch_index}}",
            response_schema="StructuringBatchV2",
            problems=_COMMON_PROBLEMS
            + ("structuring_session_not_found", "structuring_batch_not_found"),
        ),
        _operation(
            "v2.captures.structure.session.batch.submit",
            "v2",
            "PUT",
            f"{v2}/captures/{{capture_id}}/structure/session/batches/{{batch_index}}",
            request_schema="SubmitStructuringBatchV2",
            response_schema="StructuringSessionV2",
            problems=_COMMON_PROBLEMS
            + (
                "structuring_session_not_found",
                "structuring_batch_not_found",
                "structuring_batch_digest_conflict",
                "structuring_session_corrupt",
                "structuring_invalid_output",
                "raw_unavailable",
                "invalid_capture_state",
                "idempotency_conflict",
            ),
            body_kind="json",
            required_headers=("X-Idempotency-Key",),
            idempotency="required",
        ),
        _operation(
            "v2.captures.structure.commit",
            "v2",
            "POST",
            f"{v2}/captures/{{capture_id}}/structure/commit",
            request_schema="CaptureDocument",
            response_schema="CaptureOperationV2",
            problems=_COMMON_PROBLEMS
            + (
                "capture_not_found",
                "raw_unavailable",
                "invalid_structure",
                "idempotency_conflict",
                "invalid_capture_state",
            ),
            body_kind="json",
            required_headers=("X-Idempotency-Key",),
            idempotency="required",
        ),
        _operation(
            "v2.captures.structure.failure",
            "v2",
            "POST",
            f"{v2}/captures/{{capture_id}}/structure/failure",
            request_schema="ReportStructuringFailureV2",
            response_schema="CaptureOperationV2",
            problems=_COMMON_PROBLEMS
            + ("capture_not_found", "idempotency_conflict", "invalid_capture_state"),
            body_kind="json",
            required_headers=("X-Idempotency-Key",),
            idempotency="required",
        ),
        _operation(
            "v2.captures.result",
            "v2",
            "GET",
            f"{v2}/captures/{{capture_id}}/result",
            response_schema="CaptureDocument",
            problems=_COMMON_PROBLEMS + ("capture_not_found", "result_unavailable"),
        ),
        _operation(
            "v2.captures.delete",
            "v2",
            "DELETE",
            f"{v2}/captures/{{capture_id}}",
            problems=_COMMON_PROBLEMS + ("capture_not_found",),
            response_statuses=(204,),
        ),
    ]
    # Runtime requirements/installations are part of the v2 contract train;
    # readiness is provided by the streaming v2 health route above.
    operations.extend(
        [
            _operation(
                "v2.runtime.requirements",
                "v2",
                "GET",
                f"{v2}/runtime/requirements",
                response_schema="RuntimeRequirementsV2",
                problems=_COMMON_PROBLEMS,
            ),
            _operation(
                "v2.runtime.model-options",
                "v2",
                "GET",
                f"{v2}/runtime/model-options",
                response_schema="RuntimeModelOptionsV2",
                problems=_COMMON_PROBLEMS + ("requirement_disabled",),
            ),
            _operation(
                "v2.runtime.installations.create",
                "v2",
                "POST",
                f"{v2}/runtime/installations",
                request_schema="StartRuntimeInstallationV2",
                response_schema="RuntimeInstallationV2",
                problems=_COMMON_PROBLEMS + ("requirement_disabled", "idempotency_conflict"),
                body_kind="json",
                required_headers=("X-Idempotency-Key",),
                idempotency="required",
                response_statuses=(202,),
            ),
            _operation(
                "v2.runtime.installations.list",
                "v2",
                "GET",
                f"{v2}/runtime/installations",
                response_schema="RuntimeInstallationsV2",
                problems=_COMMON_PROBLEMS,
            ),
            _operation(
                "v2.runtime.installations.get",
                "v2",
                "GET",
                f"{v2}/runtime/installations/{{installation_id}}",
                response_schema="RuntimeInstallationV2",
                problems=_COMMON_PROBLEMS + ("installation_not_found",),
            ),
            _operation(
                "v2.runtime.installations.cancel",
                "v2",
                "POST",
                f"{v2}/runtime/installations/{{installation_id}}/cancel",
                response_schema="RuntimeInstallationV2",
                problems=_COMMON_PROBLEMS + ("installation_not_found",),
            ),
            _operation(
                "v2.runtime.model-installations.create",
                "v2",
                "POST",
                f"{v2}/runtime/model-installations",
                request_schema="StartRuntimeModelInstallationV2",
                response_schema="RuntimeModelInstallationV2",
                problems=_COMMON_PROBLEMS
                + ("requirement_disabled", "model_option_unknown", "idempotency_conflict"),
                body_kind="json",
                required_headers=("X-Idempotency-Key",),
                idempotency="required",
                response_statuses=(202,),
            ),
            _operation(
                "v2.runtime.model-installations.get",
                "v2",
                "GET",
                f"{v2}/runtime/model-installations/{{installation_id}}",
                response_schema="RuntimeModelInstallationV2",
                problems=_COMMON_PROBLEMS + ("installation_not_found",),
            ),
            _operation(
                "v2.runtime.model-installations.cancel",
                "v2",
                "POST",
                f"{v2}/runtime/model-installations/{{installation_id}}/cancel",
                response_schema="RuntimeModelInstallationV2",
                problems=_COMMON_PROBLEMS + ("installation_not_found",),
            ),
        ]
    )
    return [operation for operation in operations if operation["surface"] == "v2"]


def _problem_definitions() -> list[dict[str, Any]]:
    """Serialize the single centralized v2 problem catalog."""

    return DEFAULT_PROBLEM_REGISTRY.as_dicts()


def default_contract_bundle() -> dict[str, Any]:
    """Build the deterministic bundle for the current v2 runtime."""

    schemas, generated_invariants = _load_schemas()
    invariants = list(generated_invariants)
    invariants.append(
        {
            "id": "authenticated-v2",
            "models": "all /v2 operations",
            "description": "Every runtime API operation is protected by Bearer authentication.",
        }
    )
    return {
        "contractSetVersion": CONTRACT_SET_VERSION,
        "schemaDialect": SCHEMA_DIALECT,
        "surfaces": _surface_definitions(),
        "schemas": schemas,
        "operations": _operation_definitions(),
        "problems": _problem_definitions(),
        "invariants": invariants,
    }


def _load_packaged_contract_bundle() -> Mapping[str, Any]:
    """Load and verify the byte-stable contract asset shipped with runtime."""

    try:
        bundle_bytes = CONTRACT_ASSET_PATH.read_bytes()
        expected_digest = CONTRACT_ASSET_SHA256_PATH.read_text(encoding="ascii")
    except OSError as error:
        raise ContractSetError("packaged contract asset is missing") from error
    if expected_digest.endswith("\n"):
        expected_digest = expected_digest[:-1]
    if expected_digest.endswith("\r"):
        expected_digest = expected_digest[:-1]
    if not re.fullmatch(r"[0-9a-f]{64}", expected_digest):
        raise ContractSetError("packaged contract asset digest is malformed")
    actual_digest = sha256_hex(bundle_bytes)
    if actual_digest != expected_digest:
        raise ContractSetError("packaged contract asset digest does not match bytes")
    loaded = load_contract_bundle(bundle_bytes)
    current = default_contract_bundle()
    if canonical_json_bytes(loaded) != canonical_json_bytes(current):
        raise ContractSetError("packaged contract asset drifted from runtime sources")
    return loaded


def load_contract_set(
    *,
    index: object | None = None,
    bundle: object | None = None,
) -> ContractSet:
    """Load a contract set from an index/bundle pair or build the default one."""

    if index is None and bundle is None:
        return ContractSet.from_bundle(_load_packaged_contract_bundle())
    if index is None or bundle is None:
        raise ContractSetError("contract index and bundle must be provided together")
    return ContractSet.from_parts(index, bundle)


# Explicit aliases make the file-oriented seam discoverable to host tests and
# tooling without coupling the runtime to a generated package import path.
load_index = load_contract_index
load_bundle = load_contract_bundle


__all__ = [
    "CATALOG_VERSION",
    "CONTRACT_MEDIA_TYPE",
    "CONTRACT_SET_VERSION",
    "CONTRACT_ASSET_DIR",
    "CONTRACT_ASSET_PATH",
    "CONTRACT_ASSET_SHA256_PATH",
    "DISCOVERY_BUNDLE_PATH",
    "DISCOVERY_PATH",
    "SCHEMA_DIALECT",
    "ContractSet",
    "ContractSetError",
    "ProblemDefinition",
    "ProblemRegistry",
    "canonical_json_bytes",
    "default_contract_bundle",
    "load_bundle",
    "load_contract_bundle",
    "load_contract_index",
    "load_contract_set",
    "load_index",
    "route_inventory",
    "contract_operation_inventory",
    "validate_route_inventory",
    "sha256_hex",
]
