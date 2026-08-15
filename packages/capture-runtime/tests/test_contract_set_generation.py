from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

from capture_runtime.contract_set import CONTRACT_ASSET_PATH, load_contract_set
from capture_runtime.contracts import RawCapture
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    capture_document_schema_release_sha256,
)

ROOT = Path(__file__).resolve().parents[3]
GENERATOR = ROOT / "packages" / "capture-runtime" / "scripts" / "generate_contracts.py"


def test_runtime_contract_asset_is_regenerated_without_drift() -> None:
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        cwd=ROOT / "packages" / "capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_runtime_asset_matches_contract_set_and_exact_digest() -> None:
    asset = CONTRACT_ASSET_PATH.read_bytes()
    contract_set = load_contract_set()
    legacy_schema_suffix = "V" + "1"
    assert contract_set.bundle_bytes == asset
    assert hashlib.sha256(asset).hexdigest() == contract_set.sha256
    assert all(
        not schema["name"].endswith(legacy_schema_suffix)
        for schema in contract_set.bundle["schemas"]
    )


def test_document_schema_release_is_pinned_and_v2() -> None:
    assert capture_document_schema_release_sha256() == CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256
    schema = json.loads(
        (
            ROOT / "packages/capture-runtime/src/capture_runtime/assets/contract-set.json"
        ).read_bytes()
    )
    document = next(item for item in schema["schemas"] if item["name"] == "CaptureDocument")
    assert document["schemaSha256"] == CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256


def test_raw_capture_segment_ids_remain_unique_runtime_invariant() -> None:
    schema = RawCapture.model_json_schema(by_alias=True)
    segment_schema = schema["properties"]["segments"]["items"]["$ref"]
    segment_name = segment_schema.rsplit("/", 1)[-1]
    segment_definition = schema["$defs"][segment_name]
    assert segment_definition["properties"]["segmentId"]["minLength"] == 1
