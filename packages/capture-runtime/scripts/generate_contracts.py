"""Generate shared wire-contract schemas and TypeScript declarations.

``capture_runtime.contracts`` remains the single source of wire truth. This
script emits schema artifacts and typed SDK projections for host adapters.
Semantic invariants that JSON Schema cannot express are recorded in the
generated manifest; the Java OCR projection is rendered directly from the
canonical OCR schema embedded in the contract-set bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
import re
from enum import StrEnum
from pathlib import Path
from typing import Any

import pydantic
import pydantic_core
from pydantic import BaseModel

import capture_runtime.contracts as contracts
from capture_runtime.constants import (
    API_VERSION,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    RUNTIME_VERSION,
)
from capture_runtime.contract_set import canonical_json_bytes, default_contract_bundle
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_ID,
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    capture_document_schema_release_bytes,
)

ROOT = Path(__file__).resolve().parents[3]
RUNTIME_ASSET_DIR = ROOT / "packages" / "capture-runtime" / "src" / "capture_runtime" / "assets"
OCR_PROFILE_SOURCE = (
    ROOT / "packages" / "capture-runtime" / "model-sources" / "commit-a" / "model" / "pipeline.json"
)
OCR_PROFILE_ASSET_NAME = "ocr-profile.json"
JAVA_OCR_SCHEMA_NAME = "CaptureOcrProjectionV3"
JAVA_OCR_SCHEMA_FILE = "capture-ocr-projection-v3.schema.json"
JAVA_OUTPUT = (
    ROOT
    / "packages"
    / "capture-runtime-client-java"
    / "src"
    / "main"
    / "java"
    / "com"
    / "gx"
    / "capture"
    / "runtime"
    / "client"
    / "CaptureRuntimeTypes.java"
)
JAVA_CONTRACT_HASH_OUTPUT = (
    ROOT
    / "packages"
    / "capture-runtime-client-java"
    / "src"
    / "main"
    / "resources"
    / "capture-runtime-contract-set.sha256"
)
CONSUMER_ROOT = ROOT
DEFAULT_OUTPUT: Path | None = None
PINNED_PYDANTIC_VERSION = "2.13.4"
PINNED_PYDANTIC_CORE_VERSION = "2.46.4"
JAVA_OCR_BEGIN = b"  // BEGIN GENERATED OCR PROJECTION\n"
JAVA_OCR_END = b"  // END GENERATED OCR PROJECTION\n"
JAVA_CONTRACT_SHA_PATTERN = re.compile(
    rb"(public static final String CONTRACT_SET_SHA256\s*=\s*\")([0-9a-f]{64})(\";)"
)


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _runtime_asset_files(output: Path) -> dict[Path, bytes]:
    """Return the canonical runtime bundle and its adjacent digest file."""

    bundle = canonical_json_bytes(default_contract_bundle())
    digest = hashlib.sha256(bundle).hexdigest()
    return {
        output / "contract-set.json": bundle,
        output / "contract-set.sha256": f"{digest}\n".encode("ascii"),
    }


def _ocr_profile_asset(output: Path) -> dict[Path, bytes]:
    """Package the exact canonical OCR profile for pre-inference provenance."""

    try:
        profile = OCR_PROFILE_SOURCE.read_bytes()
        parsed = json.loads(profile)
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"Canonical OCR profile is unreadable: {OCR_PROFILE_SOURCE}") from error
    if not isinstance(parsed, dict) or not isinstance(parsed.get("algorithm"), str):
        raise RuntimeError("Canonical OCR profile must contain an algorithm identity")
    return {output / OCR_PROFILE_ASSET_NAME: profile}


def _java_quoted(value: str) -> str:
    return json.dumps(value, ensure_ascii=False)


def _java_number(value: object, path: str) -> str:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise RuntimeError(f"Canonical OCR schema value is not numeric: {path}")
    if isinstance(value, int):
        return str(value)
    return format(value, ".15g")


def _schema_number(value: object) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _java_identifier(value: str) -> str:
    identifier = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_").upper()
    if not identifier or identifier[0].isdigit():
        raise RuntimeError(f"Canonical OCR enum value cannot be rendered in Java: {value}")
    return identifier


def _schema_object(
    schema: dict[str, Any], name: str, fields: set[str], required: set[str]
) -> dict[str, Any]:
    definitions = schema.get("$defs")
    if not isinstance(definitions, dict) or name not in definitions:
        raise RuntimeError(f"Canonical OCR schema is missing definition: {name}")
    node = definitions[name]
    if not isinstance(node, dict) or node.get("type") != "object":
        raise RuntimeError(f"Canonical OCR definition is not an object: {name}")
    _schema_keys(
        node,
        {"additionalProperties", "properties", "required", "title", "type"},
        f"$defs.{name}",
    )
    if node.get("additionalProperties") is not False:
        raise RuntimeError(f"Canonical OCR definition must forbid extra fields: {name}")
    properties = node.get("properties")
    actual_fields = set(properties) if isinstance(properties, dict) else set()
    if actual_fields != fields:
        raise RuntimeError(
            f"Unsupported canonical OCR fields for {name}: "
            f"expected {sorted(fields)}, found {sorted(actual_fields)}"
        )
    actual_required = set(node.get("required", []))
    if actual_required != required:
        raise RuntimeError(
            f"Unsupported canonical OCR required fields for {name}: "
            f"expected {sorted(required)}, found {sorted(actual_required)}"
        )
    return node


def _schema_keys(node: object, allowed: set[str], path: str) -> None:
    if not isinstance(node, dict):
        raise RuntimeError(f"Canonical OCR schema node is not an object: {path}")
    extras = set(node) - allowed - {"description"}
    if extras:
        raise RuntimeError(f"Unsupported canonical OCR constraints at {path}: {sorted(extras)}")


def _schema_type(node: object, expected: str, path: str) -> dict[str, Any]:
    if not isinstance(node, dict) or node.get("type") != expected:
        raise RuntimeError(f"Canonical OCR schema type is unsupported at {path}")
    return node


def _schema_ref(node: object, expected: str, path: str) -> None:
    if not isinstance(node, dict) or node.get("$ref") != expected:
        raise RuntimeError(f"Canonical OCR schema reference drift at {path}")


def _schema_enum(schema: dict[str, Any], name: str, expected: set[str]) -> list[str]:
    definitions = schema.get("$defs")
    node = definitions.get(name) if isinstance(definitions, dict) else None
    _schema_keys(node, {"enum", "title", "type"}, f"$defs.{name}")
    values = node.get("enum") if isinstance(node, dict) else None
    if not isinstance(values, list) or set(values) != expected:
        raise RuntimeError(
            f"Unsupported canonical OCR enum {name}: expected {sorted(expected)}, found {values}"
        )
    return [str(value) for value in values]


def _schema_number_union(node: object, path: str) -> dict[str, Any]:
    if not isinstance(node, dict) or not isinstance(node.get("anyOf"), list):
        raise RuntimeError(f"Canonical OCR nullable number drift at {path}")
    _schema_keys(node, {"anyOf", "default", "title"}, path)
    options = node["anyOf"]
    numbers = [item for item in options if isinstance(item, dict) and item.get("type") == "number"]
    nulls = [item for item in options if item == {"type": "null"}]
    if len(numbers) != 1 or len(nulls) != 1 or len(options) != 2:
        raise RuntimeError(f"Canonical OCR nullable number drift at {path}")
    number = numbers[0]
    _schema_keys(number, {"maximum", "minimum", "type", "title"}, path)
    if not _schema_number(number.get("minimum")) or not _schema_number(number.get("maximum")):
        raise RuntimeError(f"Canonical OCR nullable number bounds missing at {path}")
    return number


def _schema_any_of_refs(node: object, expected_refs: set[str], path: str) -> None:
    if not isinstance(node, dict) or not isinstance(node.get("anyOf"), list):
        raise RuntimeError(f"Canonical OCR union drift at {path}")
    _schema_keys(node, {"anyOf", "default", "title"}, path)
    refs = {item.get("$ref") for item in node["anyOf"] if isinstance(item, dict) and "$ref" in item}
    null_count = sum(item == {"type": "null"} for item in node["anyOf"])
    if refs != expected_refs or null_count != 1 or len(node["anyOf"]) != len(expected_refs) + 1:
        raise RuntimeError(f"Canonical OCR union drift at {path}")


def _java_ocr_schema_spec(schema: dict[str, Any]) -> dict[str, Any]:
    """Validate and extract the only schema surface supported by the Java DTO renderer."""

    _schema_keys(
        schema,
        {"$defs", "additionalProperties", "properties", "required", "title", "type"},
        "CaptureOcrProjectionV3",
    )
    if schema.get("title") != JAVA_OCR_SCHEMA_NAME:
        raise RuntimeError("Canonical OCR schema title is unsupported")
    if schema.get("type") != "object" or schema.get("additionalProperties") is not False:
        raise RuntimeError("Canonical OCR projection must be a closed object")
    top_fields = {
        "apiVersion",
        "schemaVersion",
        "captureId",
        "status",
        "source",
        "pages",
        "pageCount",
        "runtimeVersion",
        "contractSha256",
        "provenance",
        "warnings",
        "failure",
        "createdAt",
    }
    top_required = {
        "apiVersion",
        "schemaVersion",
        "captureId",
        "status",
        "pages",
        "pageCount",
        "runtimeVersion",
        "contractSha256",
        "provenance",
        "createdAt",
    }
    top_properties = schema.get("properties")
    if not isinstance(top_properties, dict) or set(top_properties) != top_fields:
        found = sorted(top_properties) if isinstance(top_properties, dict) else top_properties
        raise RuntimeError(f"Unsupported canonical OCR top-level fields: {found}")
    if set(schema.get("required", [])) != top_required:
        raise RuntimeError("Canonical OCR top-level required fields are unsupported")

    definitions = schema.get("$defs")
    expected_definitions = {
        "CaptureFailureV2",
        "CaptureSource",
        "OcrBoxV3",
        "OcrPageProjectionV3",
        "OcrPageStatus",
        "OcrPointV3",
        "OcrProjectionStatus",
        "OcrProvenanceResolvedV3",
        "OcrProvenanceUnavailableReason",
        "OcrProvenanceUnavailableV3",
        "OcrProvenanceV3",
        "OcrRasterV3",
    }
    if not isinstance(definitions, dict) or set(definitions) != expected_definitions:
        found = sorted(definitions) if isinstance(definitions, dict) else definitions
        raise RuntimeError(f"Unsupported canonical OCR definitions: {found}")

    source = _schema_object(
        schema,
        "CaptureSource",
        {"sha256", "fileName", "mediaType", "bytes"},
        {"sha256", "fileName", "mediaType", "bytes"},
    )
    failure = _schema_object(
        schema,
        "CaptureFailureV2",
        {"code", "message", "stage", "retryable"},
        {"code", "message"},
    )
    point = _schema_object(schema, "OcrPointV3", {"x", "y"}, {"x", "y"})
    box = _schema_object(
        schema,
        "OcrBoxV3",
        {"polygon", "text", "confidence"},
        {"polygon", "text", "confidence"},
    )
    page = _schema_object(
        schema,
        "OcrPageProjectionV3",
        {"page", "status", "raster", "text", "boxes", "confidence", "provenance", "failure"},
        {"page", "status", "raster", "provenance"},
    )
    raster = _schema_object(
        schema,
        "OcrRasterV3",
        {"width", "height", "scale", "coordinateSystem"},
        {"width", "height", "scale", "coordinateSystem"},
    )
    resolved = _schema_object(
        schema,
        "OcrProvenanceResolvedV3",
        {"status", "engine", "model", "modelDigest", "device", "profileId", "profileSpecSha256"},
        {"status", "engine", "model", "modelDigest", "device", "profileId", "profileSpecSha256"},
    )
    unavailable = _schema_object(
        schema,
        "OcrProvenanceUnavailableV3",
        {"status", "profileId", "profileSpecSha256", "reason"},
        {"status", "profileId", "profileSpecSha256", "reason"},
    )
    provenance = definitions["OcrProvenanceV3"]
    if not isinstance(provenance, dict):
        raise RuntimeError("Canonical OCR provenance union is missing")
    _schema_keys(
        provenance,
        {"discriminator", "oneOf", "title"},
        "$defs.OcrProvenanceV3",
    )
    discriminator = provenance.get("discriminator")
    if discriminator != {
        "mapping": {
            "resolved": "#/$defs/OcrProvenanceResolvedV3",
            "unavailable": "#/$defs/OcrProvenanceUnavailableV3",
        },
        "propertyName": "status",
    }:
        raise RuntimeError("Canonical OCR provenance discriminator is unsupported")
    one_of = provenance.get("oneOf")
    if one_of != [
        {"$ref": "#/$defs/OcrProvenanceResolvedV3"},
        {"$ref": "#/$defs/OcrProvenanceUnavailableV3"},
    ]:
        raise RuntimeError("Canonical OCR provenance union is unsupported")

    point_props = point["properties"]
    point_minimums: list[int | float] = []
    for field in ("x", "y"):
        item = _schema_type(point_props[field], "number", f"OcrPointV3.{field}")
        _schema_keys(item, {"minimum", "title", "type"}, f"OcrPointV3.{field}")
        minimum = item.get("minimum")
        if not _schema_number(minimum):
            raise RuntimeError(f"Canonical OCR point constraint is unsupported: {field}")
        point_minimums.append(minimum)
    if point_minimums[0] != point_minimums[1]:
        raise RuntimeError("Canonical OCR point x/y constraints must match")

    box_props = box["properties"]
    polygon = _schema_type(box_props["polygon"], "array", "OcrBoxV3.polygon")
    _schema_keys(
        polygon,
        {"items", "maxItems", "minItems", "title", "type"},
        "OcrBoxV3.polygon",
    )
    if polygon.get("items") != {"$ref": "#/$defs/OcrPointV3"}:
        raise RuntimeError("Canonical OCR polygon item reference is unsupported")
    if not isinstance(polygon.get("minItems"), int) or not isinstance(polygon.get("maxItems"), int):
        raise RuntimeError("Canonical OCR polygon constraints are unsupported")
    box_text = _schema_type(box_props["text"], "string", "OcrBoxV3.text")
    _schema_keys(
        box_text,
        {"maxLength", "minLength", "title", "type"},
        "OcrBoxV3.text",
    )
    if not isinstance(box_text.get("minLength"), int) or not isinstance(
        box_text.get("maxLength"), int
    ):
        raise RuntimeError("Canonical OCR box text constraints are unsupported")
    box_confidence = _schema_number_union(box_props["confidence"], "OcrBoxV3.confidence")

    raster_props = raster["properties"]
    raster_dimensions: list[int | float] = []
    for field in ("width", "height"):
        item = _schema_type(raster_props[field], "integer", f"OcrRasterV3.{field}")
        _schema_keys(item, {"exclusiveMinimum", "title", "type"}, f"OcrRasterV3.{field}")
        minimum = item.get("exclusiveMinimum")
        if not _schema_number(minimum):
            raise RuntimeError(f"Canonical OCR raster constraint is unsupported: {field}")
        raster_dimensions.append(minimum)
    if raster_dimensions[0] != raster_dimensions[1]:
        raise RuntimeError("Canonical OCR raster width/height constraints must match")
    raster_scale = _schema_type(raster_props["scale"], "number", "OcrRasterV3.scale")
    _schema_keys(
        raster_scale,
        {"exclusiveMinimum", "maximum", "title", "type"},
        "OcrRasterV3.scale",
    )
    if not _schema_number(raster_scale.get("exclusiveMinimum")) or not _schema_number(
        raster_scale.get("maximum")
    ):
        raise RuntimeError("Canonical OCR raster scale constraints are unsupported")
    raster_coordinate = _schema_type(
        raster_props["coordinateSystem"], "string", "OcrRasterV3.coordinateSystem"
    )
    _schema_keys(
        raster_coordinate,
        {"const", "title", "type"},
        "OcrRasterV3.coordinateSystem",
    )
    coordinate_system = raster_coordinate.get("const")
    if not isinstance(coordinate_system, str):
        raise RuntimeError("Canonical OCR coordinate system is unsupported")

    page_props = page["properties"]
    page_number = _schema_type(page_props["page"], "integer", "OcrPageProjectionV3.page")
    _schema_keys(page_number, {"minimum", "title", "type"}, "OcrPageProjectionV3.page")
    if not _schema_number(page_number.get("minimum")):
        raise RuntimeError("Canonical OCR page number constraint is unsupported")
    _schema_ref(page_props["status"], "#/$defs/OcrPageStatus", "OcrPageProjectionV3.status")
    _schema_ref(page_props["raster"], "#/$defs/OcrRasterV3", "OcrPageProjectionV3.raster")
    page_text = _schema_type(page_props["text"], "string", "OcrPageProjectionV3.text")
    _schema_keys(
        page_text,
        {"default", "maxLength", "title", "type"},
        "OcrPageProjectionV3.text",
    )
    if not isinstance(page_text.get("default"), str) or not isinstance(
        page_text.get("maxLength"), int
    ):
        raise RuntimeError("Canonical OCR page text constraints are unsupported")
    boxes = _schema_type(page_props["boxes"], "array", "OcrPageProjectionV3.boxes")
    _schema_keys(
        boxes,
        {"items", "maxItems", "title", "type"},
        "OcrPageProjectionV3.boxes",
    )
    if boxes.get("items") != {"$ref": "#/$defs/OcrBoxV3"} or not isinstance(
        boxes.get("maxItems"), int
    ):
        raise RuntimeError("Canonical OCR page boxes constraints are unsupported")
    page_confidence = _schema_number_union(
        page_props["confidence"], "OcrPageProjectionV3.confidence"
    )
    if page_props["confidence"].get("default") is not None:
        raise RuntimeError("Canonical OCR page confidence default is unsupported")
    _schema_ref(
        page_props["provenance"], "#/$defs/OcrProvenanceV3", "OcrPageProjectionV3.provenance"
    )
    _schema_any_of_refs(
        page_props["failure"], {"#/$defs/CaptureFailureV2"}, "OcrPageProjectionV3.failure"
    )
    if page_props["failure"].get("default") is not None:
        raise RuntimeError("Canonical OCR page failure default is unsupported")

    api_version = _schema_type(top_properties["apiVersion"], "string", "apiVersion")
    schema_version = _schema_type(top_properties["schemaVersion"], "string", "schemaVersion")
    capture_id = _schema_type(top_properties["captureId"], "string", "captureId")
    _schema_keys(api_version, {"const", "title", "type"}, "apiVersion")
    _schema_keys(schema_version, {"const", "title", "type"}, "schemaVersion")
    _schema_keys(capture_id, {"minLength", "title", "type"}, "captureId")
    if (
        not isinstance(api_version.get("const"), str)
        or not isinstance(schema_version.get("const"), str)
        or not isinstance(capture_id.get("minLength"), int)
    ):
        raise RuntimeError("Canonical OCR top-level string constraints are unsupported")
    _schema_ref(
        top_properties["status"], "#/$defs/OcrProjectionStatus", "CaptureOcrProjectionV3.status"
    )
    _schema_any_of_refs(
        top_properties["source"], {"#/$defs/CaptureSource"}, "CaptureOcrProjectionV3.source"
    )
    if top_properties["source"].get("default") is not None:
        raise RuntimeError("Canonical OCR source default is unsupported")
    top_pages = _schema_type(top_properties["pages"], "array", "CaptureOcrProjectionV3.pages")
    _schema_keys(
        top_pages,
        {"items", "maxItems", "title", "type"},
        "CaptureOcrProjectionV3.pages",
    )
    if top_pages.get("items") != {"$ref": "#/$defs/OcrPageProjectionV3"} or not isinstance(
        top_pages.get("maxItems"), int
    ):
        raise RuntimeError("Canonical OCR projection pages constraints are unsupported")
    page_count = _schema_type(
        top_properties["pageCount"], "integer", "CaptureOcrProjectionV3.pageCount"
    )
    _schema_keys(
        page_count,
        {"maximum", "minimum", "title", "type"},
        "CaptureOcrProjectionV3.pageCount",
    )
    if not _schema_number(page_count.get("minimum")) or not _schema_number(
        page_count.get("maximum")
    ):
        raise RuntimeError("Canonical OCR page count constraints are unsupported")
    runtime_version_schema = _schema_type(
        top_properties["runtimeVersion"], "string", "runtimeVersion"
    )
    _schema_keys(runtime_version_schema, {"const", "title", "type"}, "runtimeVersion")
    runtime_version = runtime_version_schema.get("const")
    if not isinstance(runtime_version, str):
        raise RuntimeError("Canonical OCR runtime version is unsupported")
    contract_sha = _schema_type(top_properties["contractSha256"], "string", "contractSha256")
    _schema_keys(contract_sha, {"pattern", "title", "type"}, "contractSha256")
    if contract_sha.get("pattern") != "^[0-9a-f]{64}$":
        raise RuntimeError("Canonical OCR contract digest constraint is unsupported")
    _schema_ref(
        top_properties["provenance"], "#/$defs/OcrProvenanceV3", "CaptureOcrProjectionV3.provenance"
    )
    warnings = _schema_type(top_properties["warnings"], "array", "CaptureOcrProjectionV3.warnings")
    _schema_keys(
        warnings, {"items", "maxItems", "title", "type"}, "CaptureOcrProjectionV3.warnings"
    )
    warning_items = _schema_type(
        warnings.get("items"), "string", "CaptureOcrProjectionV3.warnings.items"
    )
    _schema_keys(
        warning_items,
        {"maxLength", "title", "type"},
        "CaptureOcrProjectionV3.warnings.items",
    )
    if not isinstance(warnings.get("maxItems"), int) or not isinstance(
        warning_items.get("maxLength"), int
    ):
        raise RuntimeError("Canonical OCR warnings constraints are unsupported")
    _schema_any_of_refs(
        top_properties["failure"], {"#/$defs/CaptureFailureV2"}, "CaptureOcrProjectionV3.failure"
    )
    if top_properties["failure"].get("default") is not None:
        raise RuntimeError("Canonical OCR failure default is unsupported")
    created_at = _schema_type(top_properties["createdAt"], "string", "createdAt")
    _schema_keys(created_at, {"format", "title", "type"}, "createdAt")
    if created_at.get("format") != "date-time":
        raise RuntimeError("Canonical OCR createdAt constraint is unsupported")

    source_props = source["properties"]
    _schema_keys(
        _schema_type(source_props["sha256"], "string", "CaptureSource.sha256"),
        {"pattern", "title", "type"},
        "CaptureSource.sha256",
    )
    file_name = _schema_type(source_props["fileName"], "string", "CaptureSource.fileName")
    media_type = _schema_type(source_props["mediaType"], "string", "CaptureSource.mediaType")
    bytes_schema = _schema_type(source_props["bytes"], "integer", "CaptureSource.bytes")
    _schema_keys(file_name, {"maxLength", "minLength", "title", "type"}, "CaptureSource.fileName")
    _schema_keys(media_type, {"minLength", "title", "type"}, "CaptureSource.mediaType")
    _schema_keys(bytes_schema, {"minimum", "title", "type"}, "CaptureSource.bytes")
    if (
        source_props["sha256"].get("pattern") != "^[0-9a-f]{64}$"
        or file_name.get("minLength") != 1
        or file_name.get("maxLength") != 255
        or media_type.get("minLength") != 1
        or bytes_schema.get("minimum") != 1
    ):
        raise RuntimeError("Referenced CaptureSource schema is incompatible with Java")
    failure_props = failure["properties"]
    failure_code = _schema_type(failure_props["code"], "string", "CaptureFailureV2.code")
    failure_message = _schema_type(failure_props["message"], "string", "CaptureFailureV2.message")
    failure_stage = failure_props["stage"]
    retryable = _schema_type(failure_props["retryable"], "boolean", "CaptureFailureV2.retryable")
    _schema_keys(failure_code, {"pattern", "title", "type"}, "CaptureFailureV2.code")
    _schema_keys(
        failure_message,
        {"maxLength", "minLength", "title", "type"},
        "CaptureFailureV2.message",
    )
    _schema_keys(failure_stage, {"anyOf", "default", "title"}, "CaptureFailureV2.stage")
    _schema_keys(retryable, {"default", "title", "type"}, "CaptureFailureV2.retryable")
    if failure_stage.get("anyOf") != [{"type": "string", "minLength": 1}, {"type": "null"}]:
        raise RuntimeError("Referenced CaptureFailure stage schema is incompatible with Java")
    if (
        failure_code.get("pattern") != "^[a-z][a-z0-9_]{1,63}$"
        or failure_message.get("minLength") != 1
        or failure_message.get("maxLength") != 500
        or failure_stage.get("default") is not None
        or retryable.get("default") is not False
    ):
        raise RuntimeError("Referenced CaptureFailure schema is incompatible with Java")

    resolved_props = resolved["properties"]
    unavailable_props = unavailable["properties"]
    resolved_status = _schema_type(
        resolved_props["status"], "string", "OcrProvenanceResolvedV3.status"
    )
    resolved_engine = _schema_type(
        resolved_props["engine"], "string", "OcrProvenanceResolvedV3.engine"
    )
    _schema_keys(resolved_status, {"const", "title", "type"}, "OcrProvenanceResolvedV3.status")
    _schema_keys(resolved_engine, {"const", "title", "type"}, "OcrProvenanceResolvedV3.engine")
    resolved_status_const = resolved_status.get("const")
    resolved_engine_const = resolved_engine.get("const")
    if not isinstance(resolved_status_const, str) or not isinstance(resolved_engine_const, str):
        raise RuntimeError("Canonical OCR resolved provenance constants are unsupported")
    for field in ("model", "device", "profileId"):
        item = _schema_type(resolved_props[field], "string", f"OcrProvenanceResolvedV3.{field}")
        _schema_keys(
            item,
            {"minLength", "title", "type"},
            f"OcrProvenanceResolvedV3.{field}",
        )
        if item.get("minLength") != 1:
            raise RuntimeError(f"Canonical OCR resolved provenance field is unsupported: {field}")
    model_digest = _schema_type(
        resolved_props["modelDigest"], "string", "OcrProvenanceResolvedV3.modelDigest"
    )
    _schema_keys(
        model_digest,
        {"not", "pattern", "title", "type"},
        "OcrProvenanceResolvedV3.modelDigest",
    )
    if (
        not isinstance(model_digest.get("pattern"), str)
        or not isinstance(model_digest.get("not"), dict)
        or not isinstance(model_digest["not"].get("const"), str)
    ):
        raise RuntimeError("Canonical OCR model digest constraints are unsupported")
    profile_sha = _schema_type(
        resolved_props["profileSpecSha256"],
        "string",
        "OcrProvenanceResolvedV3.profileSpecSha256",
    )
    _schema_keys(
        profile_sha,
        {"pattern", "title", "type"},
        "OcrProvenanceResolvedV3.profileSpecSha256",
    )
    if profile_sha.get("pattern") != "^[0-9a-f]{64}$":
        raise RuntimeError("Canonical OCR profile digest constraint is unsupported")
    unavailable_status = _schema_type(
        unavailable_props["status"], "string", "OcrProvenanceUnavailableV3.status"
    )
    unavailable_profile = _schema_type(
        unavailable_props["profileId"], "string", "OcrProvenanceUnavailableV3.profileId"
    )
    unavailable_sha = _schema_type(
        unavailable_props["profileSpecSha256"],
        "string",
        "OcrProvenanceUnavailableV3.profileSpecSha256",
    )
    _schema_keys(
        unavailable_status,
        {"const", "title", "type"},
        "OcrProvenanceUnavailableV3.status",
    )
    _schema_keys(
        unavailable_profile,
        {"minLength", "title", "type"},
        "OcrProvenanceUnavailableV3.profileId",
    )
    _schema_keys(
        unavailable_sha,
        {"pattern", "title", "type"},
        "OcrProvenanceUnavailableV3.profileSpecSha256",
    )
    unavailable_status_const = unavailable_status.get("const")
    if (
        not isinstance(unavailable_status_const, str)
        or unavailable_profile.get("minLength") != 1
        or unavailable_sha.get("pattern") != "^[0-9a-f]{64}$"
    ):
        raise RuntimeError("Canonical OCR unavailable provenance constraints are unsupported")
    _schema_ref(
        unavailable_props["reason"],
        "#/$defs/OcrProvenanceUnavailableReason",
        "OcrProvenanceUnavailableV3.reason",
    )

    return {
        "api_version": top_properties["apiVersion"].get("const"),
        "schema_version": top_properties["schemaVersion"].get("const"),
        "capture_id_min": capture_id["minLength"],
        "runtime_version": runtime_version,
        "contract_sha_pattern": contract_sha["pattern"],
        "point_min": point_props["x"]["minimum"],
        "polygon_min": polygon["minItems"],
        "polygon_max": polygon["maxItems"],
        "box_text_min": box_text["minLength"],
        "box_text_max": box_text["maxLength"],
        "box_conf_min": box_confidence["minimum"],
        "box_conf_max": box_confidence["maximum"],
        "raster_dimension_exclusive_min": raster_props["width"]["exclusiveMinimum"],
        "raster_scale_exclusive_min": raster_scale["exclusiveMinimum"],
        "raster_scale_max": raster_scale["maximum"],
        "coordinate_system": raster_coordinate["const"],
        "page_min": page_number["minimum"],
        "page_text_max": page_text["maxLength"],
        "page_boxes_max": boxes["maxItems"],
        "page_conf_min": page_confidence["minimum"],
        "page_conf_max": page_confidence["maximum"],
        "page_count_min": page_count["minimum"],
        "page_count_max": page_count["maximum"],
        "projection_pages_max": top_pages["maxItems"],
        "warning_max": warnings["maxItems"],
        "warning_text_max": warning_items["maxLength"],
        "source_sha_pattern": source_props["sha256"]["pattern"],
        "failure_code_pattern": failure_code["pattern"],
        "model_digest_pattern": model_digest["pattern"],
        "model_digest_forbidden": model_digest["not"]["const"],
        "resolved_status": resolved_status_const,
        "resolved_engine": resolved_engine_const,
        "unavailable_status": unavailable_status_const,
        "page_text_default": page_text["default"],
        "projection_status": _schema_enum(schema, "OcrProjectionStatus", {"completed", "failed"}),
        "page_status": _schema_enum(schema, "OcrPageStatus", {"recognized", "empty", "failed"}),
        "unavailable_reason": _schema_enum(
            schema,
            "OcrProvenanceUnavailableReason",
            {"model_unavailable", "worker_crashed", "worker_timeout", "protocol_failure"},
        ),
    }


def _java_components(fields: list[tuple[str, str, bool]]) -> str:
    lines = []
    for index, (java_type, name, required) in enumerate(fields):
        annotation = "@JsonProperty(required = true) " if required else ""
        suffix = "," if index < len(fields) - 1 else ""
        lines.append(f"      {annotation}{java_type} {name}{suffix}")
    return "\n".join(lines)


def _java_enum(name: str, values: list[str]) -> str:
    lines = [f"  public enum {name} {{"]
    for index, value in enumerate(values):
        suffix = "," if index < len(values) - 1 else ";"
        lines.append(f"    {_java_identifier(value)}({_java_quoted(value)}){suffix}")
    lines.extend(
        [
            "",
            "    private final String wireValue;",
            "",
            f"    {name}(String wireValue) {{",
            "      this.wireValue = wireValue;",
            "    }",
            "",
            "    @JsonValue",
            "    public String wireValue() {",
            "      return wireValue;",
            "    }",
            "",
            "    @JsonCreator(mode = JsonCreator.Mode.DELEGATING)",
            f"    public static {name} fromWireValue(String value) {{",
            "      for (var item : values()) {",
            "        if (item.wireValue.equals(value)) return item;",
            "      }",
            f'      throw new IllegalArgumentException("unknown OCR {name}: " + value);',
            "    }",
            "  }",
        ]
    )
    return "\n".join(lines)


def _java_ocr_block(schema: dict[str, Any]) -> str:
    spec = _java_ocr_schema_spec(schema)
    projection_status = _java_enum("OcrProjectionStatus", spec["projection_status"])
    page_status = _java_enum("OcrPageStatus", spec["page_status"])
    reason = _java_enum("OcrProvenanceUnavailableReason", spec["unavailable_reason"])
    raster_record = _java_components(
        [
            ("long", "width", True),
            ("long", "height", True),
            ("double", "scale", True),
            ("String", "coordinateSystem", True),
        ]
    )
    point_record = _java_components([("double", "x", True), ("double", "y", True)])
    box_record = _java_components(
        [
            ("List<OcrPoint>", "polygon", True),
            ("String", "text", True),
            ("Double", "confidence", True),
        ]
    )
    resolved_record = _java_components(
        [
            ("String", "status", True),
            ("String", "engine", True),
            ("String", "model", True),
            ("String", "modelDigest", True),
            ("String", "device", True),
            ("String", "profileId", True),
            ("String", "profileSpecSha256", True),
        ]
    )
    unavailable_record = _java_components(
        [
            ("String", "status", True),
            ("String", "profileId", True),
            ("String", "profileSpecSha256", True),
            ("OcrProvenanceUnavailableReason", "reason", True),
        ]
    )
    page_record = _java_components(
        [
            ("long", "page", True),
            ("OcrPageStatus", "status", True),
            ("OcrRaster", "raster", True),
            ("String", "text", False),
            ("List<OcrBox>", "boxes", False),
            ("Double", "confidence", False),
            ("OcrProvenance", "provenance", True),
            ("Failure", "failure", False),
        ]
    )
    raster_min = _java_number(spec["raster_dimension_exclusive_min"], "raster.width")
    raster_scale_min = _java_number(spec["raster_scale_exclusive_min"], "raster.scale")
    raster_scale_max = _java_number(spec["raster_scale_max"], "raster.scale")
    raster_validation = (
        f"      if (width <= {raster_min} || height <= {raster_min} "
        f"|| !Double.isFinite(scale) || scale <= {raster_scale_min} "
        f"|| scale > {raster_scale_max}) {{"
    )
    coordinate_length = _java_number(
        len(spec["coordinate_system"]), "raster.coordinateSystem.const"
    )
    coordinate_validation = (
        f"      coordinateSystem = ocrText(coordinateSystem, 1, {coordinate_length}, "
        '"coordinateSystem");'
    )
    coordinate_error = (
        f'        throw new IllegalArgumentException("coordinateSystem must equal '
        f'{_java_quoted(spec["coordinate_system"])[1:-1]}");'
    )
    point_min = _java_number(spec["point_min"], "point.x")
    point_validation = (
        f"      if (!Double.isFinite(x) || x < {point_min} "
        f"|| !Double.isFinite(y) || y < {point_min}) {{"
    )
    polygon_min = _java_number(spec["polygon_min"], "box.polygon.minItems")
    polygon_max = _java_number(spec["polygon_max"], "box.polygon.maxItems")
    polygon_validation = (
        f"      if (polygon.size() < {polygon_min} || polygon.size() > {polygon_max}) {{"
    )
    polygon_error = (
        f'        throw new IllegalArgumentException("OCR polygon point count must be '
        f'between {polygon_min} and {polygon_max}");'
    )
    box_text_min = _java_number(spec["box_text_min"], "box.text.minLength")
    box_text_max = _java_number(spec["box_text_max"], "box.text.maxLength")
    box_text_validation = f'      text = ocrText(text, {box_text_min}, {box_text_max}, "text");'
    box_conf_min = _java_number(spec["box_conf_min"], "box.confidence.minimum")
    box_conf_max = _java_number(spec["box_conf_max"], "box.confidence.maximum")
    box_conf_validation = (
        "      if (confidence != null && (!Double.isFinite(confidence) "
        f"|| confidence < {box_conf_min} || confidence > {box_conf_max})) {{"
    )
    resolved_status = _java_quoted(spec["resolved_status"])
    resolved_status_error = (
        f"      if (!{resolved_status}.equals(status)) throw new IllegalArgumentException("
        f'"OCR resolved provenance status must equal {resolved_status[1:-1]}");'
    )
    resolved_engine = _java_quoted(spec["resolved_engine"])
    resolved_engine_error = (
        f"      if (!{resolved_engine}.equals(engine)) throw new IllegalArgumentException("
        f'"OCR engine must equal {resolved_engine[1:-1]}");'
    )
    unavailable_status = _java_quoted(spec["unavailable_status"])
    unavailable_status_error = (
        f"      if (!{unavailable_status}.equals(status)) throw new IllegalArgumentException("
        f'"OCR unavailable provenance status must equal {unavailable_status[1:-1]}");'
    )
    model_digest_validation = (
        f"      if (!modelDigest.matches({_java_quoted(spec['model_digest_pattern'])}) "
        f"|| {_java_quoted(spec['model_digest_forbidden'])}.equals(modelDigest)) {{"
    )
    page_min = _java_number(spec["page_min"], "page.minimum")
    page_text_max = _java_number(spec["page_text_max"], "page.text.maxLength")
    page_text_validation = (
        f"      text = text == null ? {_java_quoted(spec['page_text_default'])} "
        f': ocrText(text, 0, {page_text_max}, "text");'
    )
    page_boxes_max = _java_number(spec["page_boxes_max"], "page.boxes.maxItems")
    page_boxes_validation = (
        f"      if (boxes.size() > {page_boxes_max}) throw new IllegalArgumentException("
        '"OCR boxes exceed the canonical limit");'
    )
    page_conf_min = _java_number(spec["page_conf_min"], "page.confidence.minimum")
    page_conf_max = _java_number(spec["page_conf_max"], "page.confidence.maximum")
    page_conf_validation = (
        "      if (confidence != null && (!Double.isFinite(confidence) "
        f"|| confidence < {page_conf_min} || confidence > {page_conf_max})) "
        'throw new IllegalArgumentException("OCR confidence is outside the canonical range");'
    )
    projection_api_max = _java_number(len(spec["api_version"]), "apiVersion.const")
    projection_schema_max = _java_number(len(spec["schema_version"]), "schemaVersion.const")
    projection_capture_min = _java_number(spec["capture_id_min"], "captureId.minLength")
    projection_page_count_min = _java_number(spec["page_count_min"], "pageCount.minimum")
    projection_page_count_max = _java_number(spec["page_count_max"], "pageCount.maximum")
    projection_pages_max = _java_number(spec["projection_pages_max"], "pages.maxItems")
    projection_runtime_max = _java_number(len(spec["runtime_version"]), "runtimeVersion.const")
    projection_api_validation = (
        f'      apiVersion = ocrText(apiVersion, 1, {projection_api_max}, "apiVersion"); '
        f"if (!{_java_quoted(spec['api_version'])}.equals(apiVersion)) "
        'throw new IllegalArgumentException("apiVersion is incompatible");'
    )
    projection_schema_validation = (
        f"      schemaVersion = ocrText(schemaVersion, 1, {projection_schema_max}, "
        '"schemaVersion"); '
        f"if (!{_java_quoted(spec['schema_version'])}.equals(schemaVersion)) "
        'throw new IllegalArgumentException("schemaVersion is incompatible");'
    )
    projection_capture_validation = (
        f"      captureId = ocrText(captureId, {projection_capture_min}, Long.MAX_VALUE, "
        '"captureId");'
    )
    projection_page_count_validation = (
        f"      if (pageCount < {projection_page_count_min} || "
        f"pageCount > {projection_page_count_max} || pageCount != pages.size()) "
        'throw new IllegalArgumentException("pageCount must equal pages.size() and '
        'stay in the canonical range");'
    )
    projection_pages_validation = (
        f"      if (pages.size() > {projection_pages_max}) throw new IllegalArgumentException("
        '"OCR pages exceed the canonical limit");'
    )
    projection_runtime_validation = (
        f"      runtimeVersion = ocrText(runtimeVersion, 1, {projection_runtime_max}, "
        '"runtimeVersion"); '
        "if (!OCR_RUNTIME_VERSION.equals(runtimeVersion)) "
        'throw new IllegalArgumentException("runtimeVersion is incompatible");'
    )
    projection_components = _java_components(
        [
            ("String", "apiVersion", True),
            ("String", "schemaVersion", True),
            ("String", "captureId", True),
            ("OcrProjectionStatus", "status", True),
            ("Source", "source", False),
            ("List<OcrPageProjection>", "pages", True),
            ("long", "pageCount", True),
            ("String", "runtimeVersion", True),
            ("String", "contractSha256", True),
            ("OcrProvenance", "provenance", True),
            ("List<String>", "warnings", False),
            ("Failure", "failure", False),
            ("String", "createdAt", True),
        ]
    )
    lines = [
        "  // BEGIN GENERATED OCR PROJECTION",
        "  // Generated from capture-ocr-projection-v3.schema.json in contract-set.json. Do not edit.",  # noqa: E501
        f"  private static final String OCR_RUNTIME_VERSION = {_java_quoted(spec['runtime_version'])};",  # noqa: E501
        f"  private static final Pattern OCR_SOURCE_SHA256_PATTERN = Pattern.compile({_java_quoted(spec['source_sha_pattern'])});",  # noqa: E501
        f"  private static final Pattern OCR_FAILURE_CODE_PATTERN = Pattern.compile({_java_quoted(spec['failure_code_pattern'])});",  # noqa: E501
        "",
        projection_status,
        "",
        page_status,
        "",
        f"  public record OcrRaster(\n{raster_record}) {{",
        "    public OcrRaster {",
        raster_validation,
        '        throw new IllegalArgumentException("OCR raster metadata is invalid");',
        "      }",
        coordinate_validation,
        f"      if (!{_java_quoted(spec['coordinate_system'])}.equals(coordinateSystem)) {{",
        coordinate_error,
        "      }",
        "    }",
        "  }",
        "",
        f"  public record OcrPoint(\n{point_record}) {{",
        "    public OcrPoint {",
        point_validation,
        '        throw new IllegalArgumentException("OCR polygon coordinates must be finite and non-negative");',  # noqa: E501
        "      }",
        "    }",
        "  }",
        "",
        f"  public record OcrBox(\n{box_record}) {{",
        "    public OcrBox {",
        '      polygon = List.copyOf(Objects.requireNonNull(polygon, "polygon"));',
        polygon_validation,
        polygon_error,
        "      }",
        box_text_validation,
        box_conf_validation,
        '        throw new IllegalArgumentException("OCR box confidence is outside the canonical range");',  # noqa: E501
        "      }",
        "    }",
        "  }",
        "",
        "  private static String ocrText(String value, long minimum, long maximum, String field) {",
        '    if (value == null) throw new IllegalArgumentException(field + " must not be null");',
        "    value = value.strip();",
        "    var length = value.codePointCount(0, value.length());",
        "    if (length < minimum || length > maximum) {",
        '      throw new IllegalArgumentException(field + " length is outside the canonical range");',  # noqa: E501
        "    }",
        "    return value;",
        "  }",
        "",
        "  private static String ocrSha256(String value, String field) {",
        "    value = ocrText(value, 64, 64, field);",
        f"    if (!value.matches({_java_quoted(spec['contract_sha_pattern'])})) {{",
        '      throw new IllegalArgumentException(field + " must be a lowercase SHA-256 digest");',
        "    }",
        "    return value;",
        "  }",
        "",
        reason,
        "",
        "  @JsonTypeInfo(",
        "      use = JsonTypeInfo.Id.NAME,",
        "      include = JsonTypeInfo.As.EXISTING_PROPERTY,",
        '      property = "status",',
        "      visible = true)",
        "  @JsonSubTypes({",
        '    @JsonSubTypes.Type(value = OcrProvenanceResolved.class, name = "resolved"),',
        '    @JsonSubTypes.Type(value = OcrProvenanceUnavailable.class, name = "unavailable")',
        "  })",
        "  public sealed interface OcrProvenance",
        "      permits OcrProvenanceResolved, OcrProvenanceUnavailable {",
        "    String status();",
        "",
        "    String profileId();",
        "",
        "    String profileSpecSha256();",
        "  }",
        "",
        '  @JsonTypeName("resolved")',
        f"  public record OcrProvenanceResolved(\n{resolved_record}) implements OcrProvenance {{",
        "    public OcrProvenanceResolved {",
        resolved_status_error,
        '      engine = ocrText(engine, 1, Long.MAX_VALUE, "engine");',
        resolved_engine_error,
        '      model = ocrText(model, 1, Long.MAX_VALUE, "model");',
        '      modelDigest = ocrText(modelDigest, 1, Long.MAX_VALUE, "modelDigest");',
        model_digest_validation,
        '        throw new IllegalArgumentException("modelDigest is not a resolved model digest");',
        "      }",
        '      device = ocrText(device, 1, Long.MAX_VALUE, "device");',
        '      profileId = ocrText(profileId, 1, Long.MAX_VALUE, "profileId");',
        '      profileSpecSha256 = ocrSha256(profileSpecSha256, "profileSpecSha256");',
        "    }",
        "  }",
        "",
        '  @JsonTypeName("unavailable")',
        f"  public record OcrProvenanceUnavailable(\n{unavailable_record}) implements OcrProvenance {{",  # noqa: E501
        "    public OcrProvenanceUnavailable {",
        unavailable_status_error,
        '      profileId = ocrText(profileId, 1, Long.MAX_VALUE, "profileId");',
        '      profileSpecSha256 = ocrSha256(profileSpecSha256, "profileSpecSha256");',
        '      reason = Objects.requireNonNull(reason, "reason");',
        "    }",
        "  }",
        "",
        "  private static List<String> ocrWarnings(List<String> values) {",
        "    if (values == null) return List.of();",
        f'    if (values.size() > {_java_number(spec["warning_max"], "warnings.maxItems")}) throw new IllegalArgumentException("OCR warnings exceed the canonical limit");',  # noqa: E501
        "    return List.copyOf(values.stream().map(value -> ocrText(value, 0, "
        f'{_java_number(spec["warning_text_max"], "warnings.items.maxLength")}, "warning")).toList());',  # noqa: E501
        "  }",
        "",
        f"  public record OcrPageProjection(\n{page_record}) {{",  # noqa: E501
        "    public OcrPageProjection {",
        f'      if (page < {page_min}) throw new IllegalArgumentException("OCR page must be positive");',  # noqa: E501
        '      status = Objects.requireNonNull(status, "status");',
        '      raster = Objects.requireNonNull(raster, "raster");',
        page_text_validation,
        "      boxes = boxes == null ? List.of() : List.copyOf(boxes);",
        page_boxes_validation,
        page_conf_validation,
        '      provenance = Objects.requireNonNull(provenance, "provenance");',
        '      if ((status == OcrPageStatus.RECOGNIZED || status == OcrPageStatus.EMPTY) && !(provenance instanceof OcrProvenanceResolved)) throw new IllegalArgumentException("recognized and empty OCR pages require resolved provenance");',  # noqa: E501
        '      if (status == OcrPageStatus.RECOGNIZED && (text.isBlank() || confidence == null || failure != null)) throw new IllegalArgumentException("recognized OCR page is invalid");',  # noqa: E501
        '      if (status == OcrPageStatus.EMPTY && (!text.isBlank() || !boxes.isEmpty() || confidence != null || failure != null)) throw new IllegalArgumentException("empty OCR page is invalid");',  # noqa: E501
        '      if (status == OcrPageStatus.FAILED && (!text.isBlank() || !boxes.isEmpty() || confidence != null || failure == null)) throw new IllegalArgumentException("failed OCR page is invalid");',  # noqa: E501
        '      for (var box : boxes) for (var point : box.polygon()) if (point.x() > raster.width() || point.y() > raster.height()) throw new IllegalArgumentException("OCR polygon must stay inside the raw raster bounds");',  # noqa: E501
        "    }",
        "  }",
        "",
        f"  public record CaptureOcrProjection(\n{projection_components}) {{",  # noqa: E501
        "    public CaptureOcrProjection {",
        projection_api_validation,
        projection_schema_validation,
        projection_capture_validation,
        '      status = Objects.requireNonNull(status, "status");',
        '      pages = List.copyOf(Objects.requireNonNull(pages, "pages"));',
        projection_page_count_validation,
        projection_pages_validation,
        projection_runtime_validation,
        '      contractSha256 = ocrSha256(contractSha256, "contractSha256");',
        '      provenance = Objects.requireNonNull(provenance, "provenance");',
        "      for (var index = 0; index < pages.size(); index++) {",
        "        var page = pages.get(index);",
        '        if (page.page() != index + 1) throw new IllegalArgumentException("OCR pages must be complete and ordered from page one");',  # noqa: E501
        '        if (!provenance.equals(page.provenance())) throw new IllegalArgumentException("page OCR provenance must match document provenance");',  # noqa: E501
        "      }",
        "      warnings = ocrWarnings(warnings);",
        '      createdAt = timestamp(createdAt, "createdAt");',
        '      if (status == OcrProjectionStatus.COMPLETED && (pages.isEmpty() || source == null || failure != null)) throw new IllegalArgumentException("completed OCR projections require pages, source, provenance, and no failure");',  # noqa: E501
        '      if (status == OcrProjectionStatus.COMPLETED && !(provenance instanceof OcrProvenanceResolved)) throw new IllegalArgumentException("completed OCR projections require resolved provenance");',  # noqa: E501
        '      if (status == OcrProjectionStatus.COMPLETED && pages.stream().anyMatch(page -> page.status() == OcrPageStatus.FAILED)) throw new IllegalArgumentException("completed OCR projections must not contain failed pages");',  # noqa: E501
        '      if (status == OcrProjectionStatus.COMPLETED && pages.stream().noneMatch(page -> page.status() == OcrPageStatus.RECOGNIZED)) throw new IllegalArgumentException("completed OCR projections require recognized text");',  # noqa: E501
        '      if (status == OcrProjectionStatus.FAILED && failure == null) throw new IllegalArgumentException("failed OCR projection requires failure");',  # noqa: E501
        "    }",
        "  }",
        "  // END GENERATED OCR PROJECTION",
    ]
    return "\n".join(lines) + "\n"


def _java_ocr_files(
    java_output: Path, schema: dict[str, Any], contract_set_sha256: str
) -> dict[Path, bytes]:
    """Render Java OCR DTOs and pin their compiled contract identity."""

    block = _java_ocr_block(schema).encode("utf-8")
    if not re.fullmatch(r"[0-9a-f]{64}", contract_set_sha256):
        raise RuntimeError("Canonical Java contract-set hash is malformed")
    if not java_output.is_file():
        raise RuntimeError(f"Java OCR output source is missing: {java_output}")
    source = java_output.read_bytes()
    matches = list(JAVA_CONTRACT_SHA_PATTERN.finditer(source))
    if len(matches) != 1:
        raise RuntimeError("Java output must contain exactly one contract-set hash constant")
    contract_match = matches[0]
    source = (
        source[: contract_match.start(2)]
        + contract_set_sha256.encode("ascii")
        + source[contract_match.end(2) :]
    )
    start = source.find(JAVA_OCR_BEGIN)
    end = source.find(JAVA_OCR_END, start + len(JAVA_OCR_BEGIN)) if start >= 0 else -1
    if start < 0 or end < 0:
        raise RuntimeError("Java OCR output must contain the generated region markers")
    end += len(JAVA_OCR_END)
    return {java_output: source[:start] + block + source[end:]}


def _model_types() -> dict[str, type[BaseModel]]:
    return {
        name: value
        for name, value in vars(contracts).items()
        if inspect.isclass(value)
        and issubclass(value, BaseModel)
        and value is not BaseModel
        and name not in {"StrictModel", "RootModel"}
    }


def _enum_values() -> dict[str, list[str]]:
    return {
        name: [str(item.value) for item in value]
        for name, value in vars(contracts).items()
        if (inspect.isclass(value) and issubclass(value, StrEnum) and value is not StrEnum)
    }


def _model_schema(name: str, model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema(by_alias=True, ref_template="#/$defs/{model}")
    if name == "CaptureDocument":
        # The release schema is a pinned public artifact. Keep it byte-identical
        # while the other generated model schemas remain inspectable snapshots.
        return json.loads(capture_document_schema_release_bytes())
    return schema


def _filename(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "-", name).lower() + ".schema.json"


def _ts_literal(value: object) -> str:
    return json.dumps(value, ensure_ascii=False)


def _ts_identifier(value: str) -> str:
    result = re.sub(r"[^A-Za-z0-9_$]", "_", value)
    return result if result and not result[0].isdigit() else f"_{result}"


def _ts_type(schema: Any) -> str:
    if isinstance(schema, bool):
        return "unknown" if schema else "never"
    if not isinstance(schema, dict):
        return "unknown"
    if "$ref" in schema:
        return str(schema["$ref"]).rsplit("/", 1)[-1]
    if "const" in schema:
        return _ts_literal(schema["const"])
    if "enum" in schema:
        return " | ".join(_ts_literal(item) for item in schema["enum"])
    for key in ("anyOf", "oneOf"):
        if key in schema:
            return " | ".join(dict.fromkeys(_ts_type(item) for item in schema[key]))
    if "allOf" in schema:
        return " & ".join(_ts_type(item) for item in schema["allOf"])
    if "prefixItems" in schema:
        prefix_items = schema["prefixItems"]
        if isinstance(prefix_items, list):
            return "readonly [" + ", ".join(_ts_type(item) for item in prefix_items) + "]"
    if schema.get("type") == "array":
        return f"readonly ({_ts_type(schema.get('items', {}))})[]"
    if schema.get("type") == "object":
        properties = schema.get("properties")
        if isinstance(properties, dict):
            fields = "; ".join(
                f"{_ts_identifier(key)}: {_ts_type(value)}" for key, value in properties.items()
            )
            return f"{{ {fields} }}"
        additional = schema.get("additionalProperties")
        if isinstance(additional, dict):
            return f"Record<string, {_ts_type(additional)}>"
        return "Record<string, unknown>"
    return {
        "string": "string",
        "integer": "number",
        "number": "number",
        "boolean": "boolean",
        "null": "null",
    }.get(str(schema.get("type")), "unknown")


def _ts_decl(name: str, schema: dict[str, Any]) -> str:
    properties = schema.get("properties")
    if schema.get("type") != "object" or not isinstance(properties, dict):
        return f"export type {_ts_identifier(name)} = {_ts_type(schema)};"
    required = set(schema.get("required", []))
    lines = [f"export interface {_ts_identifier(name)} {{"]
    for field, field_schema in properties.items():
        # Pydantic omits fields with defaults from JSON Schema's required list,
        # but a const/default field is still present on every wire instance.
        required_by_default = field_schema.get("const") is not None or (
            field_schema.get("type") == "array" and "default" in field_schema
        )
        optional = "" if field in required or required_by_default else "?"
        description = field_schema.get("description") if isinstance(field_schema, dict) else None
        if isinstance(description, str):
            lines.append(f"  /** {description.replace('*/', '* /')} */")
        lines.append(f"  readonly {_ts_identifier(field)}{optional}: {_ts_type(field_schema)};")
    lines.append("}")
    return "\n".join(lines)


def _typescript_source(
    models: dict[str, dict[str, Any]],
    enums: dict[str, list[str]],
    aliases: list[dict[str, str]],
    invariants: list[dict[str, str]],
) -> bytes:
    lines = [
        "// Generated by packages/capture-runtime/scripts/generate_contracts.py. Do not edit.",
        "",
        "export const CONTRACT_MANIFEST_VERSION = '1' as const;",
        f"export const RUNTIME_VERSION = {_ts_literal(RUNTIME_VERSION)} as const;",
        "export const CAPTURE_RUNTIME_VERSION = RUNTIME_VERSION;",
        f"export const API_VERSION = {_ts_literal(API_VERSION)} as const;",
        "export const CAPTURE_API_VERSION = API_VERSION;",
        "export const CAPTURE_DOCUMENT_SCHEMA_VERSION = "
        f"{_ts_literal(CAPTURE_DOCUMENT_SCHEMA_VERSION)} as const;",
        "export const CAPTURE_DOCUMENT_SCHEMA_ID = "
        f"{_ts_literal(CAPTURE_DOCUMENT_SCHEMA_ID)} as const;",
        "export const CAPTURE_DOCUMENT_SCHEMA_SHA256 = "
        f"{_ts_literal(CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256)} as const;",
        "",
    ]
    for name, values in sorted(enums.items()):
        lines.extend(
            [
                "/** Wire enum. */",
                f"export type {_ts_identifier(name)} = "
                + " | ".join(_ts_literal(value) for value in values)
                + ";",
                "",
            ]
        )
    for alias in aliases:
        lines.extend(
            [
                f"export type {_ts_identifier(alias['name'])} = {alias['type']};",
                "",
            ]
        )
    for name, schema in sorted(models.items()):
        lines.extend([_ts_decl(name, schema), ""])
    lines.append(
        "export type CaptureContractName = "
        + " | ".join(_ts_literal(name) for name in sorted(models))
        + ";"
    )
    lines.extend(
        [
            "",
            "export type CaptureContractInvariant = {",
            "  readonly id: string;",
            "  readonly models: string;",
            "  readonly description: string;",
            "};",
            "",
            "export const CAPTURE_CONTRACT_INVARIANTS = [",
        ]
    )
    for invariant in invariants:
        lines.extend(
            [
                "  {",
                f"    id: {_ts_literal(invariant['id'])},",
                f"    models: {_ts_literal(invariant['models'])},",
                f"    description: {_ts_literal(invariant['description'])},",
                "  },",
            ]
        )
    lines.extend(
        [
            "] as const satisfies readonly CaptureContractInvariant[];",
            "",
            "export type CaptureContractExtraPolicy = 'allow' | 'forbid';",
            "",
            "export const CAPTURE_CONTRACT_EXTRA_POLICIES = {",
        ]
    )
    for name, schema in sorted(models.items()):
        extra_policy = "forbid" if schema.get("additionalProperties") is False else "allow"
        lines.append(f"  {_ts_literal(name)}: {_ts_literal(extra_policy)},")
    lines.extend(
        [
            "} as const satisfies Readonly<Record<"
            "CaptureContractName, CaptureContractExtraPolicy>>;",
        ]
    )
    return "\n".join(lines).encode("utf-8") + b"\n"


def _typescript_document_schema_source() -> bytes:
    schema = json.loads(capture_document_schema_release_bytes())
    return (
        "// Generated by packages/capture-runtime/scripts/generate_contracts.py. Do not edit.\n"
        "\n"
        "export const GENERATED_CAPTURE_DOCUMENT_JSON_SCHEMA = "
        + json.dumps(schema, ensure_ascii=False, indent=2)
        + " as const;\n"
    ).encode("utf-8")


def _python_models_source() -> bytes:
    """Emit host-side Pydantic models from the canonical runtime module."""

    source = inspect.getsource(contracts)
    source = source.replace(
        "from typing import Annotated, Any, Literal, Self",
        "from typing import Annotated, Any, Final, Literal, Self",
        1,
    )
    source = re.sub(
        (
            r"from capture_runtime\.constants import \(.*?\)\n"
            r"|from capture_runtime\.constants import [^\n]+\n"
        ),
        "\n".join(
            [
                f"API_VERSION: Final = {API_VERSION!r}",
                (f"CAPTURE_DOCUMENT_SCHEMA_VERSION: Final = {CAPTURE_DOCUMENT_SCHEMA_VERSION!r}"),
                f"RUNTIME_VERSION: Final = {RUNTIME_VERSION!r}",
                "",
            ]
        )
        + "\n",
        source,
        count=1,
        flags=re.DOTALL,
    )
    # Mypy accepts literal values in a ``Literal[...]`` parameter, but not a
    # Final variable reference.  Keep the canonical runtime model dynamic
    # while rendering the generated SDK field as the release's literal.
    source = source.replace(
        "runtime_version: Literal[RUNTIME_VERSION]  # type: ignore[valid-type]",
        f"runtime_version: Literal[{RUNTIME_VERSION!r}]",
        1,
    )
    source = source.replace(
        '"""Pydantic wire contracts for the Capture Runtime v2 API."""',
        '"""Generated host-side Pydantic models for the Capture Runtime v2 API."""',
        1,
    )
    public_names = [
        "StrictModel",
        "NonEmptyString",
        "CaptureText",
        "ProjectedText",
        "WarningText",
        "Sha256Hex",
        "EngineDigest",
        "CaptureLocator",
        "CaptureRequirementId",
        "project_source_text",
        *_model_types().keys(),
        *_enum_values().keys(),
    ]
    source += "\n\n# Generated public names. Do not edit.\n__all__ = [\n"
    for name in dict.fromkeys(public_names):
        source += f"    {name!r},\n"
    source += "]\n"
    return (
        "# Generated by packages/capture-runtime/scripts/generate_contracts.py. Do not edit.\n\n"
        + source
    ).encode("utf-8")


def _consumer_files(
    consumer_root: Path,
    models: dict[str, dict[str, Any]],
    manifest: dict[str, Any],
    asset_files: dict[Path, bytes],
) -> dict[Path, bytes]:
    """Render the checked-in TypeScript/Python SDK contract inputs.

    The SDKs deliberately keep generated code private, but those files are
    still release artifacts. Including them in the same generator/check pass
    prevents a client from silently consuming a stale OCR schema or asset.
    """

    ts_root = consumer_root / "packages" / "capture-runtime-client"
    python_root = (
        consumer_root
        / "packages"
        / "capture-runtime-client-python"
        / "src"
        / "capture_runtime_client"
        / "private"
    )
    files: dict[Path, bytes] = {
        ts_root / "src" / "private" / "generated-contracts.ts": _typescript_source(
            models, _enum_values(), manifest["aliases"], manifest["invariants"]
        ),
        ts_root
        / "src"
        / "private"
        / "capture-document-schema.ts": _typescript_document_schema_source(),
        python_root / "generated_models.py": _python_models_source(),
    }
    for path, content in asset_files.items():
        if path.name not in {"contract-set.json", "contract-set.sha256"}:
            continue
        files[ts_root / "src" / "private" / "assets" / path.name] = content
        files[python_root / "assets" / path.name] = content
    for name, schema in models.items():
        content = (
            capture_document_schema_release_bytes()
            if name == "CaptureDocument"
            else _json_bytes(schema)
        )
        files[python_root / "schemas" / _filename(name)] = content
    return files


def _invariants() -> list[dict[str, str]]:
    return [
        {
            "id": "raw-segment-ids-unique",
            "models": "RawCapture, CaptureDocument",
            "description": "segmentId values are unique within the raw segment list.",
        },
        {
            "id": "raw-segment-order-contiguous",
            "models": "RawCapture, CaptureDocument",
            "description": ("segment order values are contiguous and match list order."),
        },
        {
            "id": "block-source-segment-unique-coverage",
            "models": "CaptureDocument",
            "description": (
                "blocks[].sourceSegmentId values are unique and reference every "
                "rawSegments[].segmentId exactly once, in raw order."
            ),
        },
        {
            "id": "block-order-contiguous",
            "models": "CaptureDocument",
            "description": "block order values are contiguous and match list order.",
        },
        {
            "id": "block-provenance-locator-and-source-text",
            "models": "CaptureDocument",
            "description": (
                "each block locator equals its raw segment locator and each block "
                "sourceText equals its raw segment text."
            ),
        },
        {
            "id": "source-text-exact-projection",
            "models": "RawCapture, CaptureDocument",
            "description": ("sourceText is the exact newline projection of segment texts."),
        },
        {
            "id": "target-text-exact-projection",
            "models": "CaptureDocument",
            "description": (
                "targetText is the exact newline projection of block targetText values."
            ),
        },
        {
            "id": "completion-after-creation",
            "models": "CaptureDocument",
            "description": "completedAt must not precede createdAt.",
        },
        {
            "id": "terminal-jobs-have-completion-time",
            "models": "CaptureOperationV2",
            "description": "terminal capture operations must carry completedAt.",
        },
        {
            "id": "time-locator-interval-valid",
            "models": "TimeLocator",
            "description": "endMs must be greater than startMs.",
        },
        {
            "id": "ocr-compute-preflight-mode",
            "models": "OcrComputePreflightV2",
            "description": (
                "gpu-dml carries no fallback reason or notice; cpu-fallback carries "
                "a stable reason and user notice."
            ),
        },
        {
            "id": "ocr-compute-preflight-identity",
            "models": "OcrComputePreflightV2",
            "description": (
                "pre-OCR compute decisions carry API, schema, runtime, contract-set, "
                "and exact contract digest identity."
            ),
        },
        {
            "id": "timestamps-timezone-aware",
            "models": "RawCapture, CaptureDocument, CaptureOperationV2, RuntimeInstallationV2",
            "description": "timestamp fields must include a timezone.",
        },
    ]


def _manifest(models: dict[str, dict[str, Any]]) -> dict[str, Any]:
    model_entries = []
    for name, schema in sorted(models.items()):
        model_entries.append(
            {
                "name": name,
                "schemaFile": _filename(name),
                "schemaSha256": hashlib.sha256(
                    _json_bytes(schema)
                    if name != "CaptureDocument"
                    else capture_document_schema_release_bytes()
                ).hexdigest(),
                "extraPolicy": (
                    "forbid" if schema.get("additionalProperties") is False else "allow"
                ),
                "strStripWhitespace": bool(
                    contracts.StrictModel.model_config.get("str_strip_whitespace", False)
                ),
            }
        )
    return {
        "manifestVersion": "1",
        "packageVersion": RUNTIME_VERSION,
        "runtimeVersion": RUNTIME_VERSION,
        "apiVersion": API_VERSION,
        "captureDocumentSchemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
        "captureDocumentSchemaId": CAPTURE_DOCUMENT_SCHEMA_ID,
        "captureDocumentSchemaSha256": CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
        "models": model_entries,
        "enums": [
            {"name": name, "values": values} for name, values in sorted(_enum_values().items())
        ],
        "aliases": [
            {"name": "CaptureLocator", "type": "PageLocator | TimeLocator"},
            {
                "name": "CaptureRequirementId",
                "type": (
                    "'windowsml-ocr' | 'whisper-primary' | 'ollama-runtime' "
                    "| 'capture-ollama-model'"
                ),
            },
        ],
        "invariants": _invariants(),
    }


def _canonical_ocr_schema_from_contract_bytes(bundle: bytes) -> dict[str, Any]:
    try:
        parsed = json.loads(bundle)
    except json.JSONDecodeError as error:
        raise RuntimeError("Canonical contract-set bytes are not valid JSON") from error
    schemas = parsed.get("schemas") if isinstance(parsed, dict) else None
    if not isinstance(schemas, list):
        raise RuntimeError("Canonical contract-set bytes do not contain schemas")
    matches = [
        item
        for item in schemas
        if isinstance(item, dict)
        and item.get("name") == JAVA_OCR_SCHEMA_NAME
        and item.get("schemaFile") == JAVA_OCR_SCHEMA_FILE
    ]
    if len(matches) != 1 or not isinstance(matches[0].get("schema"), dict):
        raise RuntimeError("Canonical OCR schema is missing or duplicated in contract-set bytes")
    return matches[0]["schema"]


def _expected_files(
    output: Path | None,
    asset_output: Path,
    java_output: Path,
    java_contract_hash_output: Path,
    consumer_root: Path | None,
    *,
    include_runtime_files: bool = True,
    include_java_files: bool = True,
) -> dict[Path, bytes]:
    models = {name: _model_schema(name, model) for name, model in sorted(_model_types().items())}
    manifest = _manifest(models)
    generator_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    manifest["generator"] = {
        "script": "packages/capture-runtime/scripts/generate_contracts.py",
        "generatorSha256": generator_hash,
        "schemaGenerator": "pydantic.model_json_schema",
        "pydanticVersion": pydantic.__version__,
        "pydanticCoreVersion": pydantic_core.__version__,
    }
    if pydantic.__version__ != PINNED_PYDANTIC_VERSION:
        raise RuntimeError(
            "Pydantic version drifted: "
            f"expected {PINNED_PYDANTIC_VERSION}, found {pydantic.__version__}"
        )
    if pydantic_core.__version__ != PINNED_PYDANTIC_CORE_VERSION:
        raise RuntimeError(
            "pydantic-core version drifted: "
            f"expected {PINNED_PYDANTIC_CORE_VERSION}, found {pydantic_core.__version__}"
        )
    runtime_files = _runtime_asset_files(asset_output)
    files: dict[Path, bytes] = dict(runtime_files) if include_runtime_files else {}
    if include_java_files:
        ocr_schema = _canonical_ocr_schema_from_contract_bytes(
            runtime_files[asset_output / "contract-set.json"]
        )
        files.update(_ocr_profile_asset(asset_output))
        files[java_contract_hash_output] = runtime_files[asset_output / "contract-set.sha256"]
        contract_set_sha256 = hashlib.sha256(
            runtime_files[asset_output / "contract-set.json"]
        ).hexdigest()
        files.update(_java_ocr_files(java_output, ocr_schema, contract_set_sha256))
    if consumer_root is not None:
        files.update(_consumer_files(consumer_root, models, manifest, runtime_files))
    if output is None:
        return files
    files.update(
        {
            output / "src" / "generated" / "contracts.ts": _typescript_source(
                models, _enum_values(), manifest["aliases"], manifest["invariants"]
            ),
            output
            / "src"
            / "generated"
            / "capture-document-schema.ts": _typescript_document_schema_source(),
            output / "src" / "generated" / "contract-manifest.json": _json_bytes(manifest),
            output
            / "python"
            / "src"
            / "capture_runtime_private"
            / "generated_models.py": _python_models_source(),
            output
            / "python"
            / "src"
            / "capture_runtime_private"
            / "contract-manifest.json": _json_bytes(manifest),
        }
    )
    for name, schema in models.items():
        content = (
            capture_document_schema_release_bytes()
            if name == "CaptureDocument"
            else _json_bytes(schema)
        )
        files[output / "src" / "generated" / "schemas" / _filename(name)] = content
        files[
            output / "python" / "src" / "capture_runtime_private" / "schemas" / _filename(name)
        ] = content
    return files


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Optional consumer SDK output directory; runtime assets are always emitted.",
    )
    parser.add_argument(
        "--asset-output",
        type=Path,
        default=RUNTIME_ASSET_DIR,
        help="Runtime-owned contract asset directory.",
    )
    parser.add_argument(
        "--java-output",
        type=Path,
        default=JAVA_OUTPUT,
        help="Generated Java OCR projection source file.",
    )
    parser.add_argument(
        "--java-contract-hash-output",
        type=Path,
        default=JAVA_CONTRACT_HASH_OUTPUT,
        help="Digest file for the canonical contract-set bundle consumed by Java.",
    )
    parser.add_argument(
        "--consumer-output",
        type=Path,
        default=CONSUMER_ROOT,
        help="Workspace root containing the checked-in TypeScript/Python SDK outputs.",
    )
    parser.add_argument(
        "--no-consumer-output",
        action="store_true",
        help="Skip checked-in SDK outputs when rendering an isolated generated-artifact directory.",
    )
    parser.add_argument(
        "--consumer-only",
        action="store_true",
        help=(
            "Render only the checked-in TypeScript/Python SDK outputs; preserve runtime and "
            "Java files."
        ),
    )
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    if arguments.consumer_only and arguments.no_consumer_output:
        parser.error(
            "--consumer-only requires --consumer-output and cannot use --no-consumer-output"
        )
    output = arguments.output.resolve() if arguments.output is not None else None
    asset_output = arguments.asset_output.resolve()
    java_output = arguments.java_output.resolve()
    java_contract_hash_output = arguments.java_contract_hash_output.resolve()
    consumer_root = None if arguments.no_consumer_output else arguments.consumer_output.resolve()
    expected = _expected_files(
        output,
        asset_output,
        java_output,
        java_contract_hash_output,
        consumer_root,
        include_runtime_files=not arguments.consumer_only,
        include_java_files=not arguments.consumer_only,
    )
    mismatches = []
    for path, content in expected.items():
        if arguments.check:
            if not path.is_file() or path.read_bytes() != content:
                mismatches.append(str(path.relative_to(ROOT)))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    if mismatches:
        raise SystemExit("Generated contract artifacts are stale:\n- " + "\n- ".join(mismatches))
    print(
        "Generated contract artifacts are synchronized."
        if arguments.check
        else f"Generated {len(expected)} shared contract artifacts."
    )


if __name__ == "__main__":
    main()
