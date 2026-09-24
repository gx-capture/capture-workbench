from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

from capture_runtime.contract_set import (
    CONTRACT_ASSET_PATH,
    default_contract_bundle,
    load_contract_set,
)
from capture_runtime.contracts import RawCapture
from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    capture_document_schema_release_sha256,
)

ROOT = Path(__file__).resolve().parents[4]
GENERATOR = ROOT / "packages" / "capture-runtime" / "scripts" / "generate_contracts.py"


def _generator_module():
    spec = importlib.util.spec_from_file_location("capture_runtime_contract_generator", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _canonical_ocr_schema() -> dict[str, object]:
    bundle = default_contract_bundle()
    entry = next(item for item in bundle["schemas"] if item["name"] == "CaptureOcrProjectionV3")
    return copy.deepcopy(entry["schema"])


def test_runtime_contract_asset_is_regenerated_without_drift() -> None:
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--check"],
        cwd=ROOT / "packages" / "capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_all_checked_in_generated_contract_outputs_require_lf_eol() -> None:
    """The generator's canonical output set must remain LF-normalized in Git."""

    generator = _generator_module()
    expected = generator._expected_files(
        None,
        generator.RUNTIME_ASSET_DIR,
        generator.JAVA_OUTPUT,
        generator.JAVA_CONTRACT_HASH_OUTPUT,
        generator.CONSUMER_ROOT,
    )
    paths = sorted(path.relative_to(ROOT).as_posix() for path in expected)

    result = subprocess.run(
        ["git", "check-attr", "text", "eol", "--stdin"],
        cwd=ROOT,
        check=False,
        capture_output=True,
        input=("\n".join(paths) + "\n").encode("utf-8"),
    )

    stdout = result.stdout.decode("utf-8")
    stderr = result.stderr.decode("utf-8")
    assert result.returncode == 0, stdout + stderr
    attributes: dict[str, dict[str, str]] = {}
    for line in stdout.splitlines():
        path, attribute, value = line.rsplit(": ", 2)
        attributes.setdefault(path, {})[attribute] = value

    assert set(attributes) == set(paths)
    for path in paths:
        values = attributes[path]
        if values["text"] == "unset":
            continue
        assert values == {"text": "set", "eol": "lf"}, f"{path}: {values}"


def test_packaged_ocr_profile_is_the_canonical_model_lock_bytes() -> None:
    source = (
        ROOT
        / "packages"
        / "capture-runtime"
        / "model-sources"
        / "commit-a"
        / "model"
        / "pipeline.json"
    )
    asset = (
        ROOT
        / "packages"
        / "capture-runtime"
        / "src"
        / "capture_runtime"
        / "assets"
        / "ocr-profile.json"
    )
    assert asset.read_bytes() == source.read_bytes()


def test_consumer_sdk_outputs_are_reproducible_and_pages_are_required(tmp_path: Path) -> None:
    output = tmp_path / "consumer-output"
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--output", str(output), "--no-consumer-output"],
        cwd=ROOT / "packages" / "capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert (output / "src/generated/contracts.ts").read_bytes() == (
        ROOT / "packages/capture-runtime-client/src/private/generated-contracts.ts"
    ).read_bytes()
    assert (output / "python/src/capture_runtime_private/generated_models.py").read_bytes() == (
        ROOT
        / (
            "packages/capture-runtime-client-python/src/capture_runtime_client/private/"
            "generated_models.py"
        )
    ).read_bytes()
    ts_source = (
        ROOT / "packages/capture-runtime-client/src/private/generated-contracts.ts"
    ).read_text(encoding="utf-8")
    assert "readonly pages: readonly (OcrPageProjectionV3)[];" in ts_source
    assert "readonly pages?:" not in ts_source
    python_source = (
        ROOT / "packages/capture-runtime-client-python/src/capture_runtime_client/private/"
        "generated_models.py"
    ).read_text(encoding="utf-8")
    assert "pages: list[OcrPageProjectionV3] = Field(..., max_length=500)" in python_source


def test_default_and_consumer_only_generation_share_one_canonical_contract_bundle(
    tmp_path: Path,
) -> None:
    default_output = tmp_path / "default-output"
    runtime_assets = tmp_path / "runtime-assets"
    java_contract_hash = tmp_path / "java-contract.sha256"
    java_source = (
        ROOT
        / "packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client"
        / "CaptureRuntimeTypes.java"
    )
    subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--output",
            str(default_output),
            "--asset-output",
            str(runtime_assets),
            "--java-output",
            str(java_source),
            "--java-contract-hash-output",
            str(java_contract_hash),
            "--no-consumer-output",
        ],
        cwd=ROOT / "packages" / "capture-runtime",
        check=True,
    )

    consumer_root = tmp_path / "consumer-only"
    subprocess.run(
        [
            sys.executable,
            str(GENERATOR),
            "--consumer-only",
            "--consumer-output",
            str(consumer_root),
        ],
        cwd=ROOT / "packages" / "capture-runtime",
        check=True,
    )

    bundle = (runtime_assets / "contract-set.json").read_bytes()
    bundle_sha = hashlib.sha256(bundle).hexdigest()
    assert (runtime_assets / "contract-set.sha256").read_text(
        encoding="ascii"
    ).strip() == bundle_sha
    assert java_contract_hash.read_text(encoding="ascii").strip() == bundle_sha
    assert (
        consumer_root / "packages/capture-runtime-client/src/private/assets/contract-set.json"
    ).read_bytes() == bundle
    assert (
        consumer_root
        / "packages/capture-runtime-client-python/src/capture_runtime_client/private/assets"
        / "contract-set.json"
    ).read_bytes() == bundle
    assert (
        consumer_root / "packages/capture-runtime-client/src/private/assets/contract-set.sha256"
    ).read_text(encoding="ascii").strip() == bundle_sha
    assert (
        consumer_root
        / "packages/capture-runtime-client-python/src/capture_runtime_client/private/assets"
        / "contract-set.sha256"
    ).read_text(encoding="ascii").strip() == bundle_sha

    assert (default_output / "src/generated/contracts.ts").read_bytes() == (
        consumer_root / "packages/capture-runtime-client/src/private/generated-contracts.ts"
    ).read_bytes()
    assert (
        default_output / "python/src/capture_runtime_private/generated_models.py"
    ).read_bytes() == (
        consumer_root
        / "packages/capture-runtime-client-python/src/capture_runtime_client/private"
        / "generated_models.py"
    ).read_bytes()

    for schema in (default_output / "python/src/capture_runtime_private/schemas").glob("*.json"):
        assert (
            schema.read_bytes()
            == (
                consumer_root
                / "packages/capture-runtime-client-python/src/capture_runtime_client/private"
                / "schemas"
                / schema.name
            ).read_bytes()
        )


def test_consumer_only_cannot_be_silently_combined_with_no_consumer_output() -> None:
    result = subprocess.run(
        [sys.executable, str(GENERATOR), "--consumer-only", "--no-consumer-output"],
        cwd=ROOT / "packages/capture-runtime",
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "--consumer-only requires --consumer-output" in result.stderr


def test_java_ocr_projection_is_generated_from_canonical_schema_constraints() -> None:
    generator = _generator_module()
    baseline_schema = _canonical_ocr_schema()
    baseline = generator._java_ocr_block(baseline_schema)
    mutated = copy.deepcopy(baseline_schema)
    mutated["$defs"]["OcrBoxV3"]["properties"]["polygon"]["maxItems"] = 512
    mutated["$defs"]["OcrBoxV3"]["properties"]["confidence"]["anyOf"][0]["maximum"] = 0.5

    generated = generator._java_ocr_block(mutated)

    assert generated != baseline
    assert "polygon.size() > 512" in generated
    assert "confidence > 0.5" in generated
    assert 'OCR_SOURCE_SHA256_PATTERN = Pattern.compile("^[0-9a-f]{64}$")' in generated
    assert 'OCR_FAILURE_CODE_PATTERN = Pattern.compile("^[a-z][a-z0-9_]{1,63}$")' in generated


def test_java_ocr_generation_fails_closed_on_unmapped_required_schema_field() -> None:
    generator = _generator_module()
    mutated = _canonical_ocr_schema()
    mutated["required"].append("foo")
    mutated["properties"]["foo"] = {"type": "string"}

    with pytest.raises(RuntimeError, match="unsupported|canonical|foo"):
        generator._java_ocr_block(mutated)


def test_java_ocr_generation_fails_closed_on_referenced_constraint_drift() -> None:
    generator = _generator_module()

    source_mutation = _canonical_ocr_schema()
    source_mutation["$defs"]["CaptureSource"]["properties"]["sha256"]["pattern"] = "^[0-9A-F]{64}$"
    with pytest.raises(RuntimeError, match="CaptureSource|referenced|incompatible"):
        generator._java_ocr_block(source_mutation)

    source_range_mutation = _canonical_ocr_schema()
    source_range_mutation["$defs"]["CaptureSource"]["properties"]["fileName"]["maxLength"] = 128
    with pytest.raises(RuntimeError, match="CaptureSource|referenced|incompatible"):
        generator._java_ocr_block(source_range_mutation)

    source_required_mutation = _canonical_ocr_schema()
    source_required_mutation["$defs"]["CaptureSource"]["required"].append("foo")
    source_required_mutation["$defs"]["CaptureSource"]["properties"]["foo"] = {"type": "string"}
    with pytest.raises(RuntimeError, match="CaptureSource|referenced|incompatible"):
        generator._java_ocr_block(source_required_mutation)

    failure_mutation = _canonical_ocr_schema()
    failure_mutation["$defs"]["CaptureFailureV2"]["properties"]["code"]["pattern"] = (
        "^[A-Z][A-Z0-9_]{1,63}$"
    )
    with pytest.raises(RuntimeError, match="CaptureFailure|referenced|incompatible"):
        generator._java_ocr_block(failure_mutation)

    failure_union_mutation = _canonical_ocr_schema()
    failure_union_mutation["$defs"]["CaptureFailureV2"]["properties"]["stage"]["anyOf"] = [
        {"type": "string", "minLength": 2},
        {"type": "null"},
    ]
    with pytest.raises(RuntimeError, match="CaptureFailure|referenced|incompatible"):
        generator._java_ocr_block(failure_union_mutation)

    failure_required_mutation = _canonical_ocr_schema()
    failure_required_mutation["$defs"]["CaptureFailureV2"]["required"].append("foo")
    failure_required_mutation["$defs"]["CaptureFailureV2"]["properties"]["foo"] = {"type": "string"}
    with pytest.raises(RuntimeError, match="CaptureFailure|referenced|incompatible"):
        generator._java_ocr_block(failure_required_mutation)


def test_java_ocr_generation_has_no_independent_template_or_semantic_digest() -> None:
    generator = _generator_module()
    generated = generator._java_ocr_block(_canonical_ocr_schema())

    assert "capture_runtime_types_ocr.java" not in generated
    assert "capture-runtime-ocr-projection.sha256" not in generated
    assert not (
        ROOT
        / (
            "packages/capture-runtime-client-java/src/main/resources/"
            "capture-runtime-ocr-projection.sha256"
        )
    ).exists()


def test_java_generation_pins_the_compiled_contract_identity_to_the_canonical_bundle(
    tmp_path: Path,
) -> None:
    generator = _generator_module()
    source_path = tmp_path / "CaptureRuntimeTypes.java"
    source = (
        ROOT
        / "packages/capture-runtime-client-java/src/main/java/com/gx/capture/runtime/client"
        / "CaptureRuntimeTypes.java"
    ).read_bytes()
    canonical_digest = load_contract_set().sha256
    stale_digest = "e" * 64
    source_path.write_bytes(
        source.replace(canonical_digest.encode("ascii"), stale_digest.encode("ascii"))
    )

    generated = generator._java_ocr_files(
        source_path,
        _canonical_ocr_schema(),
        canonical_digest,
    )[source_path]

    assert (
        b'public static final String CONTRACT_SET_SHA256 =\n      "'
        + canonical_digest.encode("ascii")
        + b'";'
    ) in generated
    assert stale_digest.encode("ascii") not in generated


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
