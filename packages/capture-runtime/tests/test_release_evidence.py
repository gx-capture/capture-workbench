from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from capture_runtime.release_evidence import (
    ArtifactBindingV1,
    FixtureExpectationV1,
    FixtureObservation,
    FixtureRegistryV1,
    ReleaseArtifactsV1,
    generate_release_evidence,
    release_evidence_problem,
    write_release_evidence,
)

EXPECTED_WHISPER_MODELS = {"large-v3-turbo", "small"}


def _digest(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _engine(name: str) -> dict[str, str]:
    return {
        "engine": name,
        "model": "model-v1",
        "digest": "sha256:" + _digest(name.encode()),
    }


def _result(
    source: Path,
    scenario: Literal["pdf", "image", "audio"],
    expected_text: str,
) -> dict[str, object]:
    content = source.read_bytes()
    locator = (
        {"kind": "time", "startMs": 0, "endMs": 900}
        if scenario == "audio"
        else {"kind": "page", "page": 1}
    )
    media_type = {
        "pdf": "application/pdf",
        "image": "image/png",
        "audio": "audio/wav",
    }[scenario]
    segment = {
        "segmentId": "segment-1",
        "order": 0,
        "locator": locator,
        "text": expected_text,
    }
    block = {
        "blockId": "block-1",
        "order": 0,
        "type": "transcript" if scenario == "audio" else "paragraph",
        "sourceSegmentId": "segment-1",
        "locator": locator,
        "sourceText": expected_text,
        "targetText": expected_text,
    }
    return {
        "schemaVersion": "1",
        "source": {
            "sha256": _digest(content),
            "fileName": source.name,
            "mediaType": media_type,
            "bytes": len(content),
        },
        "rawSegments": [segment],
        "blocks": [block],
        "sourceText": expected_text,
        "targetText": expected_text,
        "extractionEngine": _engine("windowsml" if scenario != "audio" else "whisper"),
        "structuringEngine": _engine("capture-ollama"),
        "warnings": [],
        "createdAt": "2026-07-22T01:00:00Z",
        "completedAt": "2026-07-22T01:01:00Z",
    }


def _observed_evidence(tmp_path: Path, *, attested: bool):
    artifacts = {}
    for name, content in {
        "capture-runtime-x86_64-pc-windows-msvc.exe": b"runtime executable",
        "capture-document-v1.schema.json": b'{"type":"object"}\n',
        "capture-windowsml-ocr-windows-x64.zip": b"windowsml bundle",
        "capture-workbench_0.3.0_x64-setup.exe": b"nsis installer",
    }.items():
        path = tmp_path / name
        path.write_bytes(content)
        artifacts[name] = path

    observations: list[FixtureObservation] = []
    for scenario, suffix in (("pdf", "pdf"), ("image", "png"), ("audio", "wav")):
        fixture_id = f"capture-v1-{scenario}-001"
        source = tmp_path / f"{fixture_id}.{suffix}"
        source.write_bytes(f"authorized {scenario} fixture".encode())
        expected = tmp_path / f"{fixture_id}.expected.txt"
        expected_text = f"Expected {scenario} text"
        expected.write_text(expected_text, encoding="utf-8")
        result = tmp_path / f"{fixture_id}.result.json"
        result.write_text(
            json.dumps(_result(source, scenario, expected_text)),  # type: ignore[arg-type]
            encoding="utf-8",
        )
        observations.append(
            FixtureObservation(
                scenario=scenario,  # type: ignore[arg-type]
                fixture_id=fixture_id,
                source_path=source,
                expected_text_path=expected,
                result_path=result,
                authorized=True,
            )
        )

    evidence = generate_release_evidence(
        runtime_executable=artifacts["capture-runtime-x86_64-pc-windows-msvc.exe"],
        capture_document_schema=artifacts["capture-document-v1.schema.json"],
        windowsml_bundle=artifacts["capture-windowsml-ocr-windows-x64.zip"],
        tauri_installer=artifacts["capture-workbench_0.3.0_x64-setup.exe"],
        fixtures=observations,
        runner_image="windows-2025/20260720.1",
        generated_at=datetime(2026, 7, 22, 1, 2, 3, tzinfo=UTC),
        tool_version="capture-clean-install-evidence/1.0.0",
        windows_version="Windows 11 24H2 build 26100",
        capture_ollama_model_digest="sha256:" + "4" * 64,
        whisper_model_digests={
            "large-v3-turbo": "sha256:" + "5" * 64,
            "small": "sha256:" + "6" * 64,
        },
        isolation_smoke_passed=True,
        github_attested_subject=attested,
    )
    registry = FixtureRegistryV1(
        registryVersion="1",
        fixtures=[
            FixtureExpectationV1(
                scenario=fixture.scenario,
                fixtureId=fixture.fixture_id,
                sourceSha256=fixture.source.sha256,
                expectedTextSha256=fixture.expected_text_sha256,
            )
            for fixture in evidence.fixtures
        ],
    )
    return evidence, registry


def _validate(
    tmp_path: Path,
    *,
    attested: bool,
    external_verification: bool,
    expected_artifacts: ReleaseArtifactsV1 | None = None,
    expected_registry: FixtureRegistryV1 | None = None,
) -> str | None:
    evidence, registry = _observed_evidence(tmp_path, attested=attested)
    path = tmp_path / "release-evidence.json"
    write_release_evidence(path, evidence)
    return release_evidence_problem(
        path,
        expected_artifacts=expected_artifacts or evidence.artifacts,
        expected_fixtures=expected_registry or registry,
        expected_whisper_models=EXPECTED_WHISPER_MODELS,
        attestation_verified_externally=external_verification,
    )


def test_generator_output_is_accepted_only_after_external_github_verification(
    tmp_path: Path,
) -> None:
    assert _validate(tmp_path, attested=True, external_verification=True) is None
    problem = _validate(tmp_path, attested=True, external_verification=False)
    assert problem is not None and "verified externally" in problem


def test_unsigned_generator_output_is_non_releaseable(tmp_path: Path) -> None:
    problem = _validate(tmp_path, attested=False, external_verification=True)
    assert problem is not None and "Unsigned local evidence" in problem


def test_evidence_is_bound_to_exact_runtime_schema_bundle_and_installer(tmp_path: Path) -> None:
    evidence, registry = _observed_evidence(tmp_path, attested=True)
    path = tmp_path / "release-evidence.json"
    write_release_evidence(path, evidence)
    wrong_runtime = ArtifactBindingV1(
        fileName=evidence.artifacts.runtime_executable.file_name,
        bytes=evidence.artifacts.runtime_executable.bytes,
        sha256="f" * 64,
    )
    expected = ReleaseArtifactsV1(
        runtimeExecutable=wrong_runtime,
        captureDocumentSchema=evidence.artifacts.capture_document_schema,
        windowsmlBundle=evidence.artifacts.windowsml_bundle,
        tauriInstaller=evidence.artifacts.tauri_installer,
    )
    problem = release_evidence_problem(
        path,
        expected_artifacts=expected,
        expected_fixtures=registry,
        expected_whisper_models=EXPECTED_WHISPER_MODELS,
        attestation_verified_externally=True,
    )
    assert problem is not None and "artifact digests or byte counts" in problem


def test_evidence_is_bound_to_protected_fixture_ids_and_text_digests(tmp_path: Path) -> None:
    evidence, registry = _observed_evidence(tmp_path, attested=True)
    first = registry.fixtures[0]
    registry.fixtures[0] = first.model_copy(update={"expected_text_sha256": "e" * 64})
    path = tmp_path / "release-evidence.json"
    write_release_evidence(path, evidence)
    problem = release_evidence_problem(
        path,
        expected_artifacts=evidence.artifacts,
        expected_fixtures=registry,
        expected_whisper_models=EXPECTED_WHISPER_MODELS,
        attestation_verified_externally=True,
    )
    assert problem is not None and "fixture binding" in problem


def test_unknown_evidence_fields_are_rejected(tmp_path: Path) -> None:
    evidence, registry = _observed_evidence(tmp_path, attested=True)
    payload = evidence.model_dump(by_alias=True, mode="json")
    payload["token"] = "must never be accepted"
    path = tmp_path / "release-evidence.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    problem = release_evidence_problem(
        path,
        expected_artifacts=evidence.artifacts,
        expected_fixtures=registry,
        expected_whisper_models=EXPECTED_WHISPER_MODELS,
        attestation_verified_externally=True,
    )
    assert problem is not None and "Extra inputs are not permitted" in problem
