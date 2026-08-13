"""Generate shared wire-contract schemas and TypeScript declarations.

``capture_runtime.contracts`` remains the single source of wire truth. This
script emits schema artifacts and types for host adapters; it does not create a
second runtime validator. Semantic invariants that JSON Schema cannot express
are recorded in the generated manifest and remain enforced by the runtime.
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
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_ID,
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    capture_document_schema_release_bytes,
)

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = ROOT / "packages" / "capture-contracts"
PINNED_PYDANTIC_VERSION = "2.13.4"
PINNED_PYDANTIC_CORE_VERSION = "2.46.4"


def _json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _model_types() -> dict[str, type[BaseModel]]:
    return {
        name: value
        for name, value in vars(contracts).items()
        if inspect.isclass(value)
        and issubclass(value, BaseModel)
        and value is not BaseModel
        and name != "StrictModel"
    }


def _enum_values() -> dict[str, list[str]]:
    return {
        name: [str(item.value) for item in value]
        for name, value in vars(contracts).items()
        if (inspect.isclass(value) and issubclass(value, StrEnum) and value is not StrEnum)
    }


def _model_schema(name: str, model: type[BaseModel]) -> dict[str, Any]:
    schema = model.model_json_schema(by_alias=True, ref_template="#/$defs/{model}")
    if name == "CaptureDocumentV1":
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
    lines: list[str] = []
    description = schema.get("description")
    if isinstance(description, str):
        safe_description = description.replace("*/", "* /")
        lines.extend(
            [
                "/**",
                (
                    f" * @deprecated {safe_description}"
                    if description.lstrip().lower().startswith("deprecated")
                    else f" * {safe_description}"
                ),
                " */",
            ]
        )
    lines.append(f"export interface {_ts_identifier(name)} {{")
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
        "export const GENERATED_CAPTURE_DOCUMENT_V1_JSON_SCHEMA = "
        + json.dumps(schema, ensure_ascii=False, indent=2)
        + " as const;\n"
    ).encode("utf-8")


def _python_models_source() -> bytes:
    """Emit host-side Pydantic models from the canonical runtime module."""

    source = inspect.getsource(contracts)
    source = re.sub(
        r"from capture_runtime\.constants import \(.*?\)\n",
        "\n".join(
            [
                f"API_VERSION = {API_VERSION!r}",
                f"CAPTURE_DOCUMENT_SCHEMA_VERSION = {CAPTURE_DOCUMENT_SCHEMA_VERSION!r}",
                f"RUNTIME_VERSION = {RUNTIME_VERSION!r}",
                "",
            ]
        )
        + "\n",
        source,
        count=1,
        flags=re.DOTALL,
    )
    source = source.replace(
        '"""Pydantic wire contracts for Capture Runtime API v1."""',
        '"""Generated host-side Pydantic models for Capture Runtime API v1."""',
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
        "CaptureLocatorV1",
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


def _invariants() -> list[dict[str, str]]:
    return [
        {
            "id": "raw-segment-ids-unique",
            "models": "RawCaptureV1, CaptureDocumentV1",
            "description": "segmentId values are unique within the raw segment list.",
        },
        {
            "id": "raw-segment-order-contiguous",
            "models": "RawCaptureV1, CaptureDocumentV1",
            "description": ("segment order values are contiguous and match list order."),
        },
        {
            "id": "block-source-segment-unique-coverage",
            "models": "CaptureDocumentV1",
            "description": (
                "blocks[].sourceSegmentId values are unique and reference every "
                "rawSegments[].segmentId exactly once, in raw order."
            ),
        },
        {
            "id": "block-order-contiguous",
            "models": "CaptureDocumentV1",
            "description": "block order values are contiguous and match list order.",
        },
        {
            "id": "block-provenance-locator-and-source-text",
            "models": "CaptureDocumentV1",
            "description": (
                "each block locator equals its raw segment locator and each block "
                "sourceText equals its raw segment text."
            ),
        },
        {
            "id": "source-text-exact-projection",
            "models": "RawCaptureV1, CaptureDocumentV1",
            "description": ("sourceText is the exact newline projection of segment texts."),
        },
        {
            "id": "target-text-exact-projection",
            "models": "CaptureDocumentV1",
            "description": (
                "targetText is the exact newline projection of block targetText values."
            ),
        },
        {
            "id": "completion-after-creation",
            "models": "CaptureDocumentV1",
            "description": "completedAt must not precede createdAt.",
        },
        {
            "id": "time-locator-interval-valid",
            "models": "TimeLocatorV1",
            "description": "endMs must be greater than startMs.",
        },
        {
            "id": "timestamps-timezone-aware",
            "models": "RawCaptureV1, CaptureDocumentV1, RuntimeInstallationV1",
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
                    if name != "CaptureDocumentV1"
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
            {"name": "CaptureLocatorV1", "type": "PageLocatorV1 | TimeLocatorV1"},
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


def _expected_files(output: Path) -> dict[Path, bytes]:
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
    files: dict[Path, bytes] = {
        output / "src" / "generated" / "contracts.ts": _typescript_source(
            models, _enum_values(), manifest["aliases"], manifest["invariants"]
        ),
        output
        / "src"
        / "generated"
        / "capture-document-v1-schema.ts": _typescript_document_schema_source(),
        output / "src" / "generated" / "contract-manifest.json": _json_bytes(manifest),
        output
        / "python"
        / "src"
        / "capture_contracts"
        / "generated_models.py": _python_models_source(),
        output / "python" / "src" / "capture_contracts" / "contract-manifest.json": _json_bytes(
            manifest
        ),
    }
    for name, schema in models.items():
        content = (
            capture_document_schema_release_bytes()
            if name == "CaptureDocumentV1"
            else _json_bytes(schema)
        )
        files[output / "src" / "generated" / "schemas" / _filename(name)] = content
        files[output / "python" / "src" / "capture_contracts" / "schemas" / _filename(name)] = (
            content
        )
    return files


def _managed_schema_paths(output: Path) -> set[Path]:
    schema_directories = (
        output / "src" / "generated" / "schemas",
        output / "python" / "src" / "capture_contracts" / "schemas",
    )
    return {
        path
        for directory in schema_directories
        if directory.is_dir()
        for path in directory.glob("*.schema.json")
    }


def _display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    output = arguments.output.resolve()
    expected = _expected_files(output)
    expected_paths = set(expected)
    stale_schema_paths = _managed_schema_paths(output) - expected_paths
    mismatches = (
        [_display_path(path) for path in sorted(stale_schema_paths)] if arguments.check else []
    )
    for path, content in expected.items():
        if arguments.check:
            if not path.is_file() or path.read_bytes() != content:
                mismatches.append(_display_path(path))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    if not arguments.check:
        for path in stale_schema_paths:
            path.unlink()
    if mismatches:
        raise SystemExit("Generated contract artifacts are stale:\n- " + "\n- ".join(mismatches))
    print(
        "Generated contract artifacts are synchronized."
        if arguments.check
        else f"Generated {len(expected)} shared contract artifacts."
    )


if __name__ == "__main__":
    main()
