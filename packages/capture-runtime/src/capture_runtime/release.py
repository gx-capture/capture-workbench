"""Deterministic schema and release-manifest generation."""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any

from capture_runtime.constants import (
    API_VERSION,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    RUNTIME_VERSION,
)
from capture_runtime.contracts import CaptureDocumentV1

CAPTURE_DOCUMENT_SCHEMA_ID = (
    "https://github.com/gx-capture/capture-workbench/schema/capture-document-v1.schema.json"
)
CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256 = (
    "2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def capture_document_schema() -> dict[str, Any]:
    """Return the authoritative semantic CaptureDocumentV1 JSON Schema."""

    schema = CaptureDocumentV1.model_json_schema(by_alias=True)
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = CAPTURE_DOCUMENT_SCHEMA_ID
    return schema


def capture_document_schema_release_bytes() -> bytes:
    """Serialize the v1 release schema with deterministic Windows CRLF bytes."""

    serialized = json.dumps(capture_document_schema(), ensure_ascii=False, indent=2, sort_keys=True)
    return (serialized.replace("\n", "\r\n") + "\r\n").encode("utf-8")


def capture_document_schema_release_sha256() -> str:
    return hashlib.sha256(capture_document_schema_release_bytes()).hexdigest()


def write_capture_document_schema(output: Path) -> Path:
    schema_bytes = capture_document_schema_release_bytes()
    digest = hashlib.sha256(schema_bytes).hexdigest()
    if digest != CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256:
        raise ValueError(
            "CaptureDocumentV1 schema bytes changed without an intentional schema release"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(schema_bytes)
    return output


def build_release_artifacts(
    *,
    executable: Path,
    schema: Path,
    output_dir: Path,
) -> dict[str, Any]:
    if not executable.is_file():
        raise FileNotFoundError(executable)
    if not schema.is_file():
        raise FileNotFoundError(schema)
    json.loads(schema.read_text(encoding="utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)
    released_executable = output_dir / "capture-runtime-x86_64-pc-windows-msvc.exe"
    released_schema = output_dir / "capture-document-v1.schema.json"
    shutil.copy2(executable, released_executable)
    shutil.copy2(schema, released_schema)
    manifest: dict[str, Any] = {
        "manifestVersion": "1",
        "runtimeVersion": RUNTIME_VERSION,
        "apiVersion": API_VERSION,
        "captureDocumentSchemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
        "platform": "windows",
        "arch": "x86_64",
        "fileName": released_executable.name,
        "bytes": released_executable.stat().st_size,
        "sha256": sha256_file(released_executable),
        "schemaFileName": released_schema.name,
        "schemaSha256": sha256_file(released_schema),
    }
    (output_dir / "capture-runtime-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / f"{released_executable.name}.sha256").write_text(
        f"{manifest['sha256']}  {released_executable.name}\n",
        encoding="utf-8",
    )
    return manifest
