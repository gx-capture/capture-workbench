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
            / "capture-angular"
            / "src"
            / "lib"
            / "generated"
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
