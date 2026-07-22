"""Observed, artifact-bound clean-install release evidence."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    ValidationError,
    field_validator,
    model_validator,
)

from capture_runtime.constants import (
    API_VERSION,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    CAPTURE_OLLAMA_PROFILE_ID,
    RUNTIME_VERSION,
)
from capture_runtime.contracts import CaptureDocumentV1
from capture_runtime.release import sha256_file

_HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_PREFIXED_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
_FIXTURE_ID = re.compile(r"^[a-z0-9][a-z0-9._-]{2,127}$")
_REQUIRED_SCENARIOS = {"pdf", "image", "audio"}


class StrictEvidenceModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class ArtifactBindingV1(StrictEvidenceModel):
    file_name: str = Field(alias="fileName", min_length=1, max_length=255)
    bytes: int = Field(gt=0)
    sha256: str

    @field_validator("file_name")
    @classmethod
    def plain_file_name(cls, value: str) -> str:
        if Path(value).name != value or any(character in value for character in "/\\:"):
            raise ValueError("fileName must be a plain file name")
        return value

    @field_validator("sha256")
    @classmethod
    def lowercase_digest(cls, value: str) -> str:
        if not _HEX_SHA256.fullmatch(value):
            raise ValueError("sha256 must be 64 lowercase hexadecimal characters")
        return value


class ReleaseArtifactsV1(StrictEvidenceModel):
    runtime_executable: ArtifactBindingV1 = Field(alias="runtimeExecutable")
    capture_document_schema: ArtifactBindingV1 = Field(alias="captureDocumentSchema")
    windowsml_bundle: ArtifactBindingV1 = Field(alias="windowsmlBundle")
    tauri_installer: ArtifactBindingV1 = Field(alias="tauriInstaller")


class FixtureBindingV1(StrictEvidenceModel):
    scenario: Literal["pdf", "image", "audio"]
    fixture_id: str = Field(alias="fixtureId")
    source: ArtifactBindingV1
    expected_text_sha256: str = Field(alias="expectedTextSha256")
    result: ArtifactBindingV1
    authorized: Literal[True]
    expected_text_passed: Literal[True] = Field(alias="expectedTextPassed")
    locator_provenance_passed: Literal[True] = Field(alias="locatorProvenancePassed")
    json_round_trip_passed: Literal[True] = Field(alias="jsonRoundTripPassed")
    text_projection_passed: Literal[True] = Field(alias="textProjectionPassed")

    @field_validator("fixture_id")
    @classmethod
    def fixture_id_is_stable(cls, value: str) -> str:
        if not _FIXTURE_ID.fullmatch(value):
            raise ValueError("fixtureId must be a stable lowercase identifier")
        return value

    @field_validator("expected_text_sha256")
    @classmethod
    def expected_text_digest_is_lowercase(cls, value: str) -> str:
        if not _HEX_SHA256.fullmatch(value):
            raise ValueError("expectedTextSha256 must be 64 lowercase hexadecimal characters")
        return value


class RunnerBindingV1(StrictEvidenceModel):
    image: str = Field(min_length=1, max_length=300)
    generated_at: datetime = Field(alias="generatedAt")
    tool_version: str = Field(alias="toolVersion", min_length=1, max_length=100)
    windows_version: str = Field(alias="windowsVersion", min_length=1, max_length=200)

    @field_validator("generated_at")
    @classmethod
    def generated_at_has_timezone(cls, value: datetime) -> datetime:
        if value.utcoffset() is None:
            raise ValueError("generatedAt must include a timezone offset")
        return value


class AttestationBindingV1(StrictEvidenceModel):
    kind: Literal["unsigned-local", "github-artifact-attestation"]
    verified: StrictBool

    @model_validator(mode="after")
    def kind_and_verification_agree(self) -> AttestationBindingV1:
        if self.kind == "unsigned-local" and self.verified:
            raise ValueError("unsigned-local evidence cannot claim verified attestation")
        if self.kind == "github-artifact-attestation" and not self.verified:
            raise ValueError("GitHub-attested evidence must declare verified=true")
        return self


class ReleaseEvidenceV1(StrictEvidenceModel):
    """Evidence subject emitted from observed clean-install artifacts and results."""

    evidence_version: Literal["1"] = Field(alias="evidenceVersion")
    runtime_version: str = Field(alias="runtimeVersion")
    api_version: str = Field(alias="apiVersion")
    capture_document_schema_version: str = Field(alias="captureDocumentSchemaVersion")
    platform: Literal["windows"]
    arch: Literal["x86_64"]
    runner: RunnerBindingV1
    artifacts: ReleaseArtifactsV1
    fixtures: list[FixtureBindingV1] = Field(min_length=3, max_length=3)
    capture_ollama_profile_id: str = Field(alias="captureOllamaProfileId")
    capture_ollama_model_digest: str = Field(alias="captureOllamaModelDigest")
    whisper_model_digests: dict[str, str] = Field(alias="whisperModelDigests")
    isolation_smoke_passed: Literal[True] = Field(alias="isolationSmokePassed")
    attestation: AttestationBindingV1
    releaseable: StrictBool

    @field_validator("capture_ollama_model_digest")
    @classmethod
    def capture_model_digest_is_sha256(cls, value: str) -> str:
        if not _PREFIXED_SHA256.fullmatch(value):
            raise ValueError("captureOllamaModelDigest must be a lowercase sha256 digest")
        return value

    @field_validator("whisper_model_digests")
    @classmethod
    def whisper_digests_are_exact(cls, value: dict[str, str]) -> dict[str, str]:
        if set(value) != {"large-v3-turbo", "small"} or any(
            not _PREFIXED_SHA256.fullmatch(digest) for digest in value.values()
        ):
            raise ValueError(
                "whisperModelDigests must contain lowercase sha256 digests for exactly "
                "large-v3-turbo and small"
            )
        return value

    @model_validator(mode="after")
    def versions_fixtures_and_attestation_are_complete(self) -> ReleaseEvidenceV1:
        if self.runtime_version != RUNTIME_VERSION:
            raise ValueError(f"runtimeVersion must equal {RUNTIME_VERSION}")
        if self.api_version != API_VERSION:
            raise ValueError(f"apiVersion must equal {API_VERSION}")
        if self.capture_document_schema_version != CAPTURE_DOCUMENT_SCHEMA_VERSION:
            raise ValueError(
                f"captureDocumentSchemaVersion must equal {CAPTURE_DOCUMENT_SCHEMA_VERSION}"
            )
        if self.capture_ollama_profile_id != CAPTURE_OLLAMA_PROFILE_ID:
            raise ValueError(f"captureOllamaProfileId must equal {CAPTURE_OLLAMA_PROFILE_ID}")
        if len({fixture.fixture_id for fixture in self.fixtures}) != 3:
            raise ValueError("fixtureId values must be unique")
        if {fixture.scenario for fixture in self.fixtures} != _REQUIRED_SCENARIOS:
            raise ValueError("fixtures must contain pdf, image, and audio exactly once")
        expected_releaseable = self.attestation.kind == "github-artifact-attestation"
        if self.releaseable != expected_releaseable:
            raise ValueError(
                "releaseable must be false for unsigned evidence and true for "
                "GitHub-attested evidence"
            )
        return self


class FixtureExpectationV1(StrictEvidenceModel):
    scenario: Literal["pdf", "image", "audio"]
    fixture_id: str = Field(alias="fixtureId")
    source_sha256: str = Field(alias="sourceSha256")
    expected_text_sha256: str = Field(alias="expectedTextSha256")

    @field_validator("source_sha256", "expected_text_sha256")
    @classmethod
    def expectation_digest_is_lowercase(cls, value: str) -> str:
        if not _HEX_SHA256.fullmatch(value):
            raise ValueError("fixture registry digests must be lowercase SHA-256")
        return value


class FixtureRegistryV1(StrictEvidenceModel):
    registry_version: Literal["1"] = Field(alias="registryVersion")
    fixtures: list[FixtureExpectationV1] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def scenarios_and_ids_are_exact(self) -> FixtureRegistryV1:
        if {fixture.scenario for fixture in self.fixtures} != _REQUIRED_SCENARIOS:
            raise ValueError("fixture registry must contain pdf, image, and audio exactly once")
        if len({fixture.fixture_id for fixture in self.fixtures}) != 3:
            raise ValueError("fixture registry IDs must be unique")
        return self


@dataclass(frozen=True, slots=True)
class FixtureObservation:
    scenario: Literal["pdf", "image", "audio"]
    fixture_id: str
    source_path: Path
    expected_text_path: Path
    result_path: Path
    authorized: bool


def artifact_binding(path: Path, *, file_name: str | None = None) -> ArtifactBindingV1:
    resolved = path.resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"Release evidence path is not a regular file: {path}")
    return ArtifactBindingV1(
        file_name=file_name or resolved.name,
        bytes=resolved.stat().st_size,
        sha256=sha256_file(resolved),
    )


def _fixture_binding(observation: FixtureObservation) -> FixtureBindingV1:
    if not observation.authorized:
        raise ValueError(f"Fixture {observation.fixture_id} lacks explicit usage authorization")
    source = artifact_binding(observation.source_path)
    expected_text_bytes = observation.expected_text_path.resolve(strict=True).read_bytes()
    expected_text = expected_text_bytes.decode("utf-8").strip()
    if not expected_text:
        raise ValueError(f"Fixture {observation.fixture_id} expected text is empty")
    result = artifact_binding(observation.result_path)
    document = CaptureDocumentV1.model_validate_json(
        observation.result_path.read_text(encoding="utf-8")
    )
    if (
        document.source.sha256 != source.sha256
        or document.source.bytes != source.bytes
        or document.source.file_name != source.file_name
    ):
        raise ValueError(f"Fixture {observation.fixture_id} result is not bound to its source")
    if expected_text not in document.source_text:
        raise ValueError(f"Fixture {observation.fixture_id} did not contain its expected text")
    locator_kind = "time" if observation.scenario == "audio" else "page"
    if any(segment.locator.kind != locator_kind for segment in document.raw_segments):
        raise ValueError(f"Fixture {observation.fixture_id} locator provenance is invalid")
    CaptureDocumentV1.model_validate_json(document.model_dump_json(by_alias=True))
    if document.target_text != "\n".join(block.target_text for block in document.blocks):
        raise ValueError(f"Fixture {observation.fixture_id} text projection is invalid")
    return FixtureBindingV1(
        scenario=observation.scenario,
        fixture_id=observation.fixture_id,
        source=source,
        expected_text_sha256=sha256_file(observation.expected_text_path.resolve(strict=True)),
        result=result,
        authorized=True,
        expected_text_passed=True,
        locator_provenance_passed=True,
        json_round_trip_passed=True,
        text_projection_passed=True,
    )


def generate_release_evidence(
    *,
    runtime_executable: Path,
    capture_document_schema: Path,
    windowsml_bundle: Path,
    tauri_installer: Path,
    fixtures: list[FixtureObservation],
    runner_image: str,
    generated_at: datetime,
    tool_version: str,
    windows_version: str,
    capture_ollama_model_digest: str,
    whisper_model_digests: dict[str, str],
    isolation_smoke_passed: bool,
    github_attested_subject: bool = False,
) -> ReleaseEvidenceV1:
    """Generate evidence from files/results; local output is non-releaseable by default."""

    if not isolation_smoke_passed:
        raise ValueError("Isolation smoke must pass before evidence can be generated")
    evidence = ReleaseEvidenceV1(
        evidence_version="1",
        runtime_version=RUNTIME_VERSION,
        api_version=API_VERSION,
        capture_document_schema_version=CAPTURE_DOCUMENT_SCHEMA_VERSION,
        platform="windows",
        arch="x86_64",
        runner=RunnerBindingV1(
            image=runner_image,
            generated_at=generated_at,
            tool_version=tool_version,
            windows_version=windows_version,
        ),
        artifacts=ReleaseArtifactsV1(
            runtime_executable=artifact_binding(runtime_executable),
            capture_document_schema=artifact_binding(capture_document_schema),
            windowsml_bundle=artifact_binding(windowsml_bundle),
            tauri_installer=artifact_binding(tauri_installer),
        ),
        fixtures=[_fixture_binding(fixture) for fixture in fixtures],
        capture_ollama_profile_id=CAPTURE_OLLAMA_PROFILE_ID,
        capture_ollama_model_digest=capture_ollama_model_digest,
        whisper_model_digests=whisper_model_digests,
        isolation_smoke_passed=True,
        attestation=AttestationBindingV1(
            kind=("github-artifact-attestation" if github_attested_subject else "unsigned-local"),
            verified=github_attested_subject,
        ),
        releaseable=github_attested_subject,
    )
    return evidence


def write_release_evidence(path: Path, evidence: ReleaseEvidenceV1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(evidence.model_dump(by_alias=True, mode="json"), indent=2, sort_keys=True)
        + "\n",
        encoding="utf-8",
    )


def release_evidence_problem(
    path: Path,
    *,
    expected_artifacts: ReleaseArtifactsV1,
    expected_fixtures: FixtureRegistryV1,
    expected_whisper_models: set[str],
    attestation_verified_externally: bool,
) -> str | None:
    """Return a redacted validation problem, requiring an external GitHub verification."""

    try:
        evidence = ReleaseEvidenceV1.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError) as error:
        return f"Release evidence is unreadable: {error}"
    except ValidationError as error:
        issues = error.errors(include_url=False, include_input=False)
        summary = "; ".join(
            f"{'.'.join(str(item) for item in issue['loc'])}: {issue['msg']}"
            for issue in issues[:3]
        )
        return "Release evidence does not satisfy CaptureReleaseEvidenceV1: " + summary

    if evidence.artifacts != expected_artifacts:
        return "Release evidence artifact digests or byte counts do not match this build."
    expected_fixture_map = {fixture.fixture_id: fixture for fixture in expected_fixtures.fixtures}
    actual_fixture_map = {fixture.fixture_id: fixture for fixture in evidence.fixtures}
    if set(actual_fixture_map) != set(expected_fixture_map):
        return "Release evidence fixture IDs do not match the protected fixture registry."
    for fixture_id, expected in expected_fixture_map.items():
        actual = actual_fixture_map[fixture_id]
        if (
            actual.scenario != expected.scenario
            or actual.source.sha256 != expected.source_sha256
            or actual.expected_text_sha256 != expected.expected_text_sha256
        ):
            return f"Release evidence fixture binding does not match registry: {fixture_id}."
    if set(evidence.whisper_model_digests) != expected_whisper_models or any(
        not _PREFIXED_SHA256.fullmatch(digest) for digest in evidence.whisper_model_digests.values()
    ):
        return (
            "whisperModelDigests must contain lowercase sha256 digests for exactly "
            + ", ".join(sorted(expected_whisper_models))
            + "."
        )
    if not evidence.releaseable or evidence.attestation.kind != "github-artifact-attestation":
        return "Unsigned local evidence is diagnostic only and cannot authorize a release."
    if not attestation_verified_externally:
        return (
            "GitHub artifact attestation must be verified externally for this exact evidence file."
        )
    return None
