from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from capture_runtime.release_evidence import (
    FixtureObservation,
    generate_release_evidence,
    write_release_evidence,
)


class FixtureRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    scenario: Literal["pdf", "image", "audio"]
    fixture_id: str = Field(alias="fixtureId")
    source_path: Path = Field(alias="sourcePath")
    expected_text_path: Path = Field(alias="expectedTextPath")
    result_path: Path = Field(alias="resultPath")
    authorized: bool


class EvidenceRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    runtime_executable_path: Path = Field(alias="runtimeExecutablePath")
    capture_document_schema_path: Path = Field(alias="captureDocumentSchemaPath")
    windowsml_bundle_path: Path = Field(alias="windowsmlBundlePath")
    tauri_installer_path: Path = Field(alias="tauriInstallerPath")
    fixtures: list[FixtureRequest]
    runner_image: str = Field(alias="runnerImage")
    generated_at: datetime = Field(alias="generatedAt")
    tool_version: str = Field(alias="toolVersion")
    windows_version: str = Field(alias="windowsVersion")
    capture_ollama_model_digest: str = Field(alias="captureOllamaModelDigest")
    whisper_model_digests: dict[str, str] = Field(alias="whisperModelDigests")
    isolation_smoke_passed: bool = Field(alias="isolationSmokePassed")
    github_attested_subject: bool = Field(alias="githubAttestedSubject", default=False)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    request = EvidenceRequest.model_validate_json(
        arguments.request.resolve(strict=True).read_text(encoding="utf-8")
    )
    evidence = generate_release_evidence(
        runtime_executable=request.runtime_executable_path,
        capture_document_schema=request.capture_document_schema_path,
        windowsml_bundle=request.windowsml_bundle_path,
        tauri_installer=request.tauri_installer_path,
        fixtures=[
            FixtureObservation(
                scenario=fixture.scenario,
                fixture_id=fixture.fixture_id,
                source_path=fixture.source_path,
                expected_text_path=fixture.expected_text_path,
                result_path=fixture.result_path,
                authorized=fixture.authorized,
            )
            for fixture in request.fixtures
        ],
        runner_image=request.runner_image,
        generated_at=request.generated_at,
        tool_version=request.tool_version,
        windows_version=request.windows_version,
        capture_ollama_model_digest=request.capture_ollama_model_digest,
        whisper_model_digests=request.whisper_model_digests,
        isolation_smoke_passed=request.isolation_smoke_passed,
        github_attested_subject=request.github_attested_subject,
    )
    write_release_evidence(arguments.output, evidence)


if __name__ == "__main__":
    main()
