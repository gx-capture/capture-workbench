from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import pytest

from capture_runtime.contracts import RuntimeArtifactDescriptorV1
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_ID,
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    build_release_artifacts,
    capture_document_schema,
    capture_document_schema_release_bytes,
    capture_document_schema_release_sha256,
    write_capture_document_schema,
)

ANGULAR_GENERATED_ROOT = (
    Path(__file__).resolve().parents[2] / "capture-angular" / "src" / "lib" / "generated"
)


def test_angular_package_schema_is_the_runtime_generated_contract(tmp_path: Path) -> None:
    angular_schema = ANGULAR_GENERATED_ROOT / "capture-document-v1.schema.json"
    angular_metadata = ANGULAR_GENERATED_ROOT / "capture-document-v1-schema.generated.ts"
    schema_bytes = angular_schema.read_bytes()

    assert json.loads(schema_bytes) == capture_document_schema()
    assert schema_bytes == capture_document_schema_release_bytes()
    assert schema_bytes.endswith(b"\r\n")
    assert b"\n" not in schema_bytes.replace(b"\r\n", b"")
    assert b"\r" not in schema_bytes.replace(b"\r\n", b"")
    assert json.loads(schema_bytes)["$id"] == CAPTURE_DOCUMENT_SCHEMA_ID

    digest = hashlib.sha256(schema_bytes).hexdigest()
    assert digest == capture_document_schema_release_sha256()
    assert digest == CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256

    metadata_match = re.search(r"'([0-9a-f]{64})' as const", angular_metadata.read_text())
    assert metadata_match is not None
    assert metadata_match.group(1) == digest

    generated = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    assert generated.read_bytes() == schema_bytes


def test_public_runtime_artifact_descriptor_v1_remains_exactly_compatible() -> None:
    schema = RuntimeArtifactDescriptorV1.model_json_schema(by_alias=True)
    assert set(schema["properties"]) == {
        "artifactUrl",
        "artifactFileName",
        "bytes",
        "sha256",
    }
    assert set(schema["required"]) == {
        "artifactUrl",
        "artifactFileName",
        "bytes",
        "sha256",
    }
    angular_contracts = (ANGULAR_GENERATED_ROOT.parent / "contracts" / "index.ts").read_text(
        encoding="utf-8"
    )
    interface = angular_contracts.split("export interface RuntimeArtifactDescriptorV1 {", 1)[
        1
    ].split("}", 1)[0]
    for field in ("artifactUrl", "artifactFileName", "bytes", "sha256"):
        assert field in interface
    for internal_field in (
        "artifactVersion",
        "workerProtocolVersion",
        "extractedBytes",
        "entryPoint",
        "filesManifestSha256",
    ):
        assert internal_field not in interface


def test_release_artifacts_fail_closed_on_incomplete_engine_catalog(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    (engine_dir / "capture-engine-ocr.zip").write_bytes(b"worker")
    catalog = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "capture_runtime"
        / "assets"
        / "engine-catalog.json"
    )
    with pytest.raises(ValueError, match="catalog is incomplete"):
        build_release_artifacts(
            executable=executable,
            schema=schema,
            output_dir=tmp_path / "release",
            engine_dir=engine_dir,
            engine_catalog=catalog,
        )
