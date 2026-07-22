"""Fail-closed release gate for exact artifacts and externally attested evidence."""

from __future__ import annotations

import os
import platform
from pathlib import Path

from pydantic import ValidationError

from capture_runtime.release import RuntimeReleaseManifestV1, windowsml_requirement_descriptor
from capture_runtime.release_evidence import (
    ArtifactBindingV1,
    FixtureRegistryV1,
    ReleaseArtifactsV1,
    artifact_binding,
    release_evidence_problem,
)


def _required_path(name: str) -> Path:
    configured = os.environ.get(name, "").strip()
    if not configured:
        raise ValueError(f"{name} is required")
    path = Path(configured).resolve(strict=True)
    if not path.is_file():
        raise ValueError(f"{name} must identify a regular file")
    return path


def main() -> None:
    failures: list[str] = []
    if platform.system() != "Windows" or platform.machine().lower() not in {"amd64", "x86_64"}:
        failures.append("platform: capture-runtime v1 release gate must run on Windows x64")

    if os.environ.get("CAPTURE_EXTRACTION_PROVIDER", "runtime").strip().lower() != "runtime":
        failures.append("configuration: CAPTURE_EXTRACTION_PROVIDER must be runtime")
    if os.environ.get("CAPTURE_STRUCTURING_PROVIDER", "ollama").strip().lower() != "ollama":
        failures.append("configuration: CAPTURE_STRUCTURING_PROVIDER must be ollama")

    try:
        runtime_path = _required_path("CAPTURE_RELEASE_RUNTIME_PATH")
        schema_path = _required_path("CAPTURE_RELEASE_SCHEMA_PATH")
        manifest_path = _required_path("CAPTURE_RELEASE_MANIFEST_PATH")
        installer_path = _required_path("CAPTURE_RELEASE_INSTALLER_PATH")
        evidence_path = _required_path("CAPTURE_RELEASE_EVIDENCE_PATH")
        fixture_registry_path = _required_path("CAPTURE_RELEASE_FIXTURE_REGISTRY_PATH")
    except (OSError, ValueError) as error:
        failures.append(f"release_inputs: {error}")
    else:
        try:
            manifest = RuntimeReleaseManifestV1.model_validate_json(
                manifest_path.read_text(encoding="utf-8")
            )
            fixture_registry = FixtureRegistryV1.model_validate_json(
                fixture_registry_path.read_text(encoding="utf-8")
            )
        except (OSError, UnicodeError, ValidationError) as error:
            failures.append(f"release_contracts: {error}")
        else:
            runtime_binding = artifact_binding(runtime_path)
            schema_binding = artifact_binding(schema_path)
            manifest_runtime = ArtifactBindingV1(
                fileName=manifest.file_name,
                bytes=manifest.bytes,
                sha256=manifest.sha256,
            )
            manifest_schema = ArtifactBindingV1(
                fileName=manifest.schema_file_name,
                bytes=schema_binding.bytes,
                sha256=manifest.schema_sha256,
            )
            windowsml = manifest.runtime_requirements.windowsml_ocr
            expected_artifacts = ReleaseArtifactsV1(
                runtimeExecutable=runtime_binding,
                captureDocumentSchema=schema_binding,
                windowsmlBundle=ArtifactBindingV1(
                    fileName=windowsml.artifact_file_name,
                    bytes=windowsml.bytes,
                    sha256=windowsml.sha256,
                ),
                tauriInstaller=artifact_binding(installer_path),
            )
            if runtime_binding != manifest_runtime:
                failures.append("runtime_artifact: executable does not match release manifest")
            if schema_binding != manifest_schema:
                failures.append("schema_artifact: schema does not match release manifest")
            configured_url = os.environ.get("CAPTURE_WINDOWSML_BUNDLE_URL", "").strip()
            configured_sha256 = os.environ.get("CAPTURE_WINDOWSML_BUNDLE_SHA256", "").strip()
            configured_bytes = os.environ.get("CAPTURE_WINDOWSML_BUNDLE_BYTES", "").strip()
            if not configured_url or not configured_sha256 or not configured_bytes:
                failures.append("windowsml_descriptor: URL, bytes, and SHA-256 are required")
            else:
                try:
                    descriptor = windowsml_requirement_descriptor(
                        configured_url,
                        int(configured_bytes),
                        configured_sha256,
                    )
                except ValueError as error:
                    failures.append(f"windowsml_descriptor: {error}")
                else:
                    if descriptor != windowsml.model_dump(by_alias=True):
                        failures.append(
                            "windowsml_descriptor: configuration differs from release manifest"
                        )
            evidence_problem = release_evidence_problem(
                evidence_path,
                expected_artifacts=expected_artifacts,
                expected_fixtures=fixture_registry,
                expected_whisper_models={"large-v3-turbo", "small"},
                attestation_verified_externally=(
                    os.environ.get("CAPTURE_RELEASE_ATTESTATION_VERIFIED") == "true"
                ),
            )
            if evidence_problem:
                failures.append("external_release_evidence: " + evidence_problem)

    if failures:
        raise SystemExit("Production preflight failed.\n- " + "\n- ".join(failures))
    print(
        "Production preflight passed: exact runtime/schema/WindowsML/installer bindings and "
        "externally verified clean-install evidence agree."
    )


if __name__ == "__main__":
    main()
