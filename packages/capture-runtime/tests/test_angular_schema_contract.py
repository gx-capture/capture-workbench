from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from capture_runtime.contracts import RuntimeArtifactDescriptorV1
from capture_runtime.engine_catalog import EngineCatalog, canonical_json_bytes
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_ID,
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    build_release_artifacts,
    capture_document_schema,
    capture_document_schema_release_bytes,
    capture_document_schema_release_sha256,
    write_capture_document_schema,
)

ROOT = Path(__file__).resolve().parents[3]
CONTRACTS_GENERATED_ROOT = ROOT / "packages" / "capture-contracts" / "src" / "generated"


def test_angular_package_schema_is_the_runtime_generated_contract(tmp_path: Path) -> None:
    contracts_schema = CONTRACTS_GENERATED_ROOT / "schemas" / "capture-document-v1.schema.json"
    browser_schema = CONTRACTS_GENERATED_ROOT / "capture-document-v1-schema.ts"
    schema_bytes = contracts_schema.read_bytes()

    assert json.loads(schema_bytes) == capture_document_schema()
    assert schema_bytes == capture_document_schema_release_bytes()
    assert json.loads(schema_bytes)["$id"] == CAPTURE_DOCUMENT_SCHEMA_ID

    digest = hashlib.sha256(schema_bytes).hexdigest()
    assert digest == capture_document_schema_release_sha256()
    assert digest == CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256

    browser_schema_source = browser_schema.read_text(encoding="utf-8")
    assert "GENERATED_CAPTURE_DOCUMENT_V1_JSON_SCHEMA" in browser_schema_source
    assert json.loads(schema_bytes)["$id"] in browser_schema_source

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
    generated_contracts = (CONTRACTS_GENERATED_ROOT / "contracts.ts").read_text(encoding="utf-8")
    interface = generated_contracts.split("export interface RuntimeArtifactDescriptorV1 {", 1)[
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
    source_catalog = (
        Path(__file__).resolve().parents[1]
        / "src"
        / "capture_runtime"
        / "assets"
        / "engine-catalog.json"
    )
    catalog = tmp_path / "engine-catalog.json"
    catalog.write_bytes(
        canonical_json_bytes(
            EngineCatalog.from_dict(
                json.loads(source_catalog.read_text(encoding="utf-8"))
            ).to_dict()
        )
    )
    with pytest.raises(ValueError, match="catalog is incomplete"):
        build_release_artifacts(
            executable=executable,
            schema=schema,
            output_dir=tmp_path / "release",
            engine_dir=engine_dir,
            engine_catalog=catalog,
        )
