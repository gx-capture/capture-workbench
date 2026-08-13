from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from capture_runtime.contracts import RawCaptureV1
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    capture_document_schema_release_sha256,
)

ROOT = Path(__file__).resolve().parents[3]
GENERATOR = ROOT / "packages" / "capture-runtime" / "scripts" / "generate_contracts.py"


def test_shared_contract_artifacts_are_regenerated_without_drift() -> None:
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        cwd=ROOT / "packages" / "capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_shared_contract_artifacts_retain_pinned_document_schema() -> None:
    assert capture_document_schema_release_sha256() == CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256
    generated = (
        ROOT
        / "packages"
        / "capture-contracts"
        / "python"
        / "src"
        / "capture_contracts"
        / "schemas"
        / "capture-document-v1.schema.json"
    )
    assert (
        generated.read_bytes()
        == (
            ROOT
            / "packages"
            / "capture-contracts"
            / "src"
            / "generated"
            / "schemas"
            / "capture-document-v1.schema.json"
        ).read_bytes()
    )


def test_raw_capture_segment_ids_remain_unique_runtime_invariant() -> None:
    schema = RawCaptureV1.model_json_schema(by_alias=True)
    segment_schema = schema["properties"]["segments"]["items"]["$ref"]
    segment_name = segment_schema.rsplit("/", 1)[-1]
    segment_definition = schema["$defs"][segment_name]
    assert segment_definition["properties"]["segmentId"]["minLength"] == 1
    manifest = (
        ROOT
        / "packages"
        / "capture-contracts"
        / "python"
        / "src"
        / "capture_contracts"
        / "contract-manifest.json"
    )
    assert any(
        item["id"] == "raw-segment-ids-unique"
        for item in json.loads(manifest.read_text(encoding="utf-8"))["invariants"]
    )
    models = json.loads(manifest.read_text(encoding="utf-8"))["models"]
    assert all(item["extraPolicy"] == "forbid" for item in models)


def test_typescript_artifact_exports_manifest_semantics_for_hosts() -> None:
    source = (
        ROOT / "packages" / "capture-contracts" / "src" / "generated" / "contracts.ts"
    ).read_text(encoding="utf-8")
    assert "export const CAPTURE_CONTRACT_INVARIANTS" in source
    assert 'id: "raw-segment-ids-unique"' in source
    assert "export const CAPTURE_CONTRACT_EXTRA_POLICIES" in source
    assert '"CaptureDocumentV1": "forbid"' in source


def test_typescript_artifact_preserves_locator_fidelity_for_in_repo_consumers() -> None:
    root = ROOT / "packages" / "capture-contracts" / "src" / "generated"
    source = (root / "contracts.ts").read_text(encoding="utf-8")
    schema_source = (root / "capture-document-v1-schema.ts").read_text(encoding="utf-8")
    assert "export type CaptureLocatorV1 = PageLocatorV1 | TimeLocatorV1;" in source
    assert 'readonly kind: "page";' in source
    assert "readonly boundingBox?: readonly [number, number, number, number] | null;" in source
    assert "GENERATED_CAPTURE_DOCUMENT_V1_JSON_SCHEMA" in schema_source


def test_retired_capture_job_v1_contract_is_not_published() -> None:
    output = ROOT / "packages" / "capture-contracts"
    legacy_names = {"CaptureJobV1", "CaptureJobStatus", "CaptureJobStage"}

    for manifest_path in (
        output / "src" / "generated" / "contract-manifest.json",
        output / "python" / "src" / "capture_contracts" / "contract-manifest.json",
    ):
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        assert legacy_names.isdisjoint(item["name"] for item in manifest["models"])
        assert legacy_names.isdisjoint(item["name"] for item in manifest["enums"])
        assert all(
            not legacy_names.intersection(item["models"].split(", "))
            for item in manifest["invariants"]
        )

    for generated_source in (
        output / "src" / "generated" / "contracts.ts",
        output / "python" / "src" / "capture_contracts" / "generated_models.py",
        ROOT / "packages" / "capture-angular" / "src" / "lib" / "contracts" / "index.ts",
    ):
        source = generated_source.read_text(encoding="utf-8")
        assert all(name not in source for name in legacy_names)

    assert not (output / "src" / "generated" / "schemas" / "capture-job-v1.schema.json").exists()
    assert not (
        output / "python" / "src" / "capture_contracts" / "schemas" / "capture-job-v1.schema.json"
    ).exists()


def test_generator_rejects_and_removes_stale_schema_artifacts(tmp_path: Path) -> None:
    output = tmp_path / "capture-contracts"
    generated = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(output)],
        cwd=ROOT / "packages" / "capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert generated.returncode == 0, generated.stdout + generated.stderr

    stale_paths = (
        output / "src" / "generated" / "schemas" / "retired.schema.json",
        output / "python" / "src" / "capture_contracts" / "schemas" / "retired.schema.json",
    )
    for stale_path in stale_paths:
        stale_path.write_text("{}\n", encoding="utf-8")

    checked = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(output), "--check"],
        cwd=ROOT / "packages" / "capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert checked.returncode != 0
    check_output = checked.stdout + checked.stderr
    assert all(str(path) in check_output for path in stale_paths)

    regenerated = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(output)],
        cwd=ROOT / "packages" / "capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert regenerated.returncode == 0, regenerated.stdout + regenerated.stderr
    assert all(not path.exists() for path in stale_paths)
