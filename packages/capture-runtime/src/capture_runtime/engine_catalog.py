"""Runtime-owned optional engine catalog and installed-state contracts."""

from __future__ import annotations

import hashlib
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import urlsplit

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.worker_contracts import WORKER_PROTOCOL_VERSION

CATALOG_VERSION = "1"
ENGINE_STATE_VERSION = "1"
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
type EngineArtifactRole = Literal["worker", "model"]


class EngineCatalogError(ValueError):
    """Raised when embedded catalog or installed state is malformed."""


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _mapping(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise EngineCatalogError(f"{label} must be a JSON object")
    return value


def _exact_keys(payload: dict[str, Any], expected: set[str], label: str) -> None:
    if set(payload) != expected:
        raise EngineCatalogError(
            f"{label} fields must be {sorted(expected)}; found {sorted(payload)}"
        )


def _safe_relative_path(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise EngineCatalogError(f"{label} must be a non-empty POSIX relative path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise EngineCatalogError(f"{label} must not escape its artifact root")
    return value


def _sha256(value: object, label: str) -> str:
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        raise EngineCatalogError(f"{label} must contain 64 lowercase hexadecimal characters")
    return value


def _positive_int(value: object, label: str, *, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or not 1 <= value <= maximum:
        raise EngineCatalogError(f"{label} must be an integer from 1 through {maximum}")
    return value


def _artifact_url(value: object) -> str:
    if not isinstance(value, str):
        raise EngineCatalogError("artifact url must be a string")
    try:
        parsed = urlsplit(value)
    except ValueError as error:
        raise EngineCatalogError("artifact url must be an absolute HTTPS URL") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise EngineCatalogError(
            "artifact url must be absolute HTTPS without credentials, query, or fragment"
        )
    return value


@dataclass(frozen=True, slots=True)
class EngineArtifactDescriptor:
    role: EngineArtifactRole
    requirement_id: str
    artifact_version: str
    worker_protocol_version: str
    platform: Literal["windows"]
    arch: Literal["x86_64"]
    file_name: str
    bytes: int
    sha256: str
    extracted_bytes: int
    entry_point: str
    files_manifest_sha256: str
    url: str

    @classmethod
    def from_dict(cls, value: object) -> EngineArtifactDescriptor:
        payload = _mapping(value, "engine artifact")
        _exact_keys(
            payload,
            {
                "role",
                "requirementId",
                "artifactVersion",
                "workerProtocolVersion",
                "platform",
                "arch",
                "fileName",
                "bytes",
                "sha256",
                "extractedBytes",
                "entryPoint",
                "filesManifestSha256",
                "url",
            },
            "engine artifact",
        )
        role = payload["role"]
        if role not in {"worker", "model"}:
            raise EngineCatalogError("engine artifact role must be worker or model")
        requirement_id = payload["requirementId"]
        artifact_version = payload["artifactVersion"]
        if not isinstance(requirement_id, str) or not requirement_id:
            raise EngineCatalogError("requirementId must be non-empty")
        if not isinstance(artifact_version, str) or not artifact_version:
            raise EngineCatalogError("artifactVersion must be non-empty")
        if payload["workerProtocolVersion"] != WORKER_PROTOCOL_VERSION:
            raise EngineCatalogError("engine artifact workerProtocolVersion is unsupported")
        if payload["platform"] != "windows" or payload["arch"] != "x86_64":
            raise EngineCatalogError("engine artifact must target Windows x86_64")
        file_name = _safe_relative_path(payload["fileName"], "fileName")
        if "/" in file_name:
            raise EngineCatalogError("fileName must contain only a file name")
        return cls(
            role=role,
            requirement_id=requirement_id,
            artifact_version=artifact_version,
            worker_protocol_version=payload["workerProtocolVersion"],
            platform=payload["platform"],
            arch=payload["arch"],
            file_name=file_name,
            bytes=_positive_int(payload["bytes"], "bytes", maximum=2 * 1024**3),
            sha256=_sha256(payload["sha256"], "sha256"),
            extracted_bytes=_positive_int(
                payload["extractedBytes"], "extractedBytes", maximum=2 * 1024**3
            ),
            entry_point=_safe_relative_path(payload["entryPoint"], "entryPoint"),
            files_manifest_sha256=_sha256(payload["filesManifestSha256"], "filesManifestSha256"),
            url=_artifact_url(payload["url"]),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "role": self.role,
            "requirementId": self.requirement_id,
            "artifactVersion": self.artifact_version,
            "workerProtocolVersion": self.worker_protocol_version,
            "platform": self.platform,
            "arch": self.arch,
            "fileName": self.file_name,
            "bytes": self.bytes,
            "sha256": self.sha256,
            "extractedBytes": self.extracted_bytes,
            "entryPoint": self.entry_point,
            "filesManifestSha256": self.files_manifest_sha256,
            "url": self.url,
        }


@dataclass(frozen=True, slots=True)
class EngineRequirementDescriptor:
    requirement_id: str
    artifacts: tuple[EngineArtifactDescriptor, ...]
    unavailable_reason: str | None = None

    @classmethod
    def from_dict(cls, value: object) -> EngineRequirementDescriptor:
        payload = _mapping(value, "engine requirement")
        _exact_keys(
            payload,
            {"requirementId", "artifacts", "unavailableReason"},
            "engine requirement",
        )
        requirement_id = payload["requirementId"]
        if not isinstance(requirement_id, str) or not requirement_id:
            raise EngineCatalogError("engine requirementId must be non-empty")
        raw_artifacts = payload["artifacts"]
        if not isinstance(raw_artifacts, list):
            raise EngineCatalogError("engine requirement artifacts must be a list")
        artifacts = tuple(EngineArtifactDescriptor.from_dict(item) for item in raw_artifacts)
        if any(item.requirement_id != requirement_id for item in artifacts):
            raise EngineCatalogError("artifact requirementId must match its requirement")
        roles = [item.role for item in artifacts]
        if len(roles) != len(set(roles)):
            raise EngineCatalogError("engine requirement artifact roles must be unique")
        if artifacts and set(roles) != {"worker", "model"}:
            raise EngineCatalogError("complete engine requirement needs worker and model artifacts")
        versions = {item.artifact_version for item in artifacts}
        if len(versions) > 1:
            raise EngineCatalogError("engine requirement artifacts must share one version")
        unavailable_reason = payload["unavailableReason"]
        if unavailable_reason is not None and (
            not isinstance(unavailable_reason, str) or not unavailable_reason.strip()
        ):
            raise EngineCatalogError("unavailableReason must be non-empty when present")
        if bool(artifacts) == bool(unavailable_reason):
            raise EngineCatalogError(
                "engine requirement must be complete or have an unavailableReason"
            )
        return cls(requirement_id, artifacts, unavailable_reason)

    @property
    def complete(self) -> bool:
        return len(self.artifacts) == 2

    @property
    def artifact_version(self) -> str | None:
        return self.artifacts[0].artifact_version if self.artifacts else None

    def artifact(self, role: EngineArtifactRole) -> EngineArtifactDescriptor:
        try:
            return next(item for item in self.artifacts if item.role == role)
        except StopIteration as error:
            raise EngineCatalogError(
                f"{self.requirement_id} does not have a {role} artifact"
            ) from error

    def to_dict(self) -> dict[str, Any]:
        return {
            "requirementId": self.requirement_id,
            "artifacts": [item.to_dict() for item in self.artifacts],
            "unavailableReason": self.unavailable_reason,
        }


@dataclass(frozen=True, slots=True)
class EngineCatalog:
    runtime_version: str
    requirements: tuple[EngineRequirementDescriptor, ...]
    catalog_version: str = CATALOG_VERSION

    @classmethod
    def from_dict(cls, value: object) -> EngineCatalog:
        payload = _mapping(value, "engine catalog")
        _exact_keys(
            payload,
            {"catalogVersion", "runtimeVersion", "requirements"},
            "engine catalog",
        )
        if payload["catalogVersion"] != CATALOG_VERSION:
            raise EngineCatalogError("engine catalog version is unsupported")
        if payload["runtimeVersion"] != RUNTIME_VERSION:
            raise EngineCatalogError("engine catalog runtime version does not match core")
        raw_requirements = payload["requirements"]
        if not isinstance(raw_requirements, list):
            raise EngineCatalogError("engine catalog requirements must be a list")
        requirements = tuple(
            EngineRequirementDescriptor.from_dict(item) for item in raw_requirements
        )
        identifiers = [item.requirement_id.casefold() for item in requirements]
        if len(identifiers) != len(set(identifiers)):
            raise EngineCatalogError("engine catalog requirement IDs must be unique")
        return cls(
            runtime_version=payload["runtimeVersion"],
            requirements=requirements,
            catalog_version=payload["catalogVersion"],
        )

    def requirement(self, requirement_id: str) -> EngineRequirementDescriptor:
        try:
            return next(item for item in self.requirements if item.requirement_id == requirement_id)
        except StopIteration as error:
            raise EngineCatalogError(f"unknown engine requirement: {requirement_id}") from error

    def to_dict(self) -> dict[str, Any]:
        return {
            "catalogVersion": self.catalog_version,
            "runtimeVersion": self.runtime_version,
            "requirements": [item.to_dict() for item in self.requirements],
        }


@dataclass(frozen=True, slots=True)
class ActivatedArtifact:
    role: EngineArtifactRole
    sha256: str


@dataclass(frozen=True, slots=True)
class ActiveEngineState:
    requirement_id: str
    artifact_version: str
    worker_protocol_version: str
    entry_point: str
    activated_artifacts: tuple[ActivatedArtifact, ...]
    state_version: str = ENGINE_STATE_VERSION

    @classmethod
    def from_dict(cls, value: object) -> ActiveEngineState:
        payload = _mapping(value, "active engine state")
        _exact_keys(
            payload,
            {
                "stateVersion",
                "requirementId",
                "artifactVersion",
                "workerProtocolVersion",
                "entryPoint",
                "activatedArtifacts",
            },
            "active engine state",
        )
        if payload["stateVersion"] != ENGINE_STATE_VERSION:
            raise EngineCatalogError("active engine state version is unsupported")
        if payload["workerProtocolVersion"] != WORKER_PROTOCOL_VERSION:
            raise EngineCatalogError("active engine worker protocol is unsupported")
        requirement_id = payload["requirementId"]
        artifact_version = payload["artifactVersion"]
        if not isinstance(requirement_id, str) or not requirement_id:
            raise EngineCatalogError("active engine requirementId must be non-empty")
        if not isinstance(artifact_version, str) or not artifact_version:
            raise EngineCatalogError("active engine artifactVersion must be non-empty")
        raw_artifacts = payload["activatedArtifacts"]
        if not isinstance(raw_artifacts, list):
            raise EngineCatalogError("activatedArtifacts must be a list")
        artifacts: list[ActivatedArtifact] = []
        for raw in raw_artifacts:
            item = _mapping(raw, "activated artifact")
            _exact_keys(item, {"role", "sha256"}, "activated artifact")
            if item["role"] not in {"worker", "model"}:
                raise EngineCatalogError("activated artifact role is invalid")
            artifacts.append(ActivatedArtifact(item["role"], _sha256(item["sha256"], "sha256")))
        if {item.role for item in artifacts} != {"worker", "model"} or len(artifacts) != 2:
            raise EngineCatalogError("active engine state requires worker and model artifacts")
        return cls(
            requirement_id=requirement_id,
            artifact_version=artifact_version,
            worker_protocol_version=payload["workerProtocolVersion"],
            entry_point=_safe_relative_path(payload["entryPoint"], "entryPoint"),
            activated_artifacts=tuple(artifacts),
            state_version=payload["stateVersion"],
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "stateVersion": self.state_version,
            "requirementId": self.requirement_id,
            "artifactVersion": self.artifact_version,
            "workerProtocolVersion": self.worker_protocol_version,
            "entryPoint": self.entry_point,
            "activatedArtifacts": [
                {"role": item.role, "sha256": item.sha256} for item in self.activated_artifacts
            ],
        }


def default_catalog_path() -> Path:
    frozen_root = getattr(sys, "_MEIPASS", None)
    if isinstance(frozen_root, str):
        generated = Path(frozen_root) / "capture-engine-catalog.json"
        if generated.is_file():
            return generated
    return Path(__file__).resolve().parent / "assets" / "engine-catalog.json"


def load_engine_catalog(path: Path | None = None) -> EngineCatalog:
    source = path or default_catalog_path()
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise EngineCatalogError(
            f"could not load runtime-owned engine catalog: {source}"
        ) from error
    return EngineCatalog.from_dict(payload)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


__all__ = [
    "ActiveEngineState",
    "ActivatedArtifact",
    "EngineArtifactDescriptor",
    "EngineCatalog",
    "EngineCatalogError",
    "EngineRequirementDescriptor",
    "canonical_json_bytes",
    "load_engine_catalog",
    "sha256_bytes",
]
