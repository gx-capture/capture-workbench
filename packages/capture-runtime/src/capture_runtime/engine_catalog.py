"""Runtime-owned optional engine catalog and installed-state contracts."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Literal
from urllib.parse import urlsplit

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.worker_contracts import WORKER_PROTOCOL_VERSION

CATALOG_VERSION = "2"
ENGINE_STATE_VERSION = "1"
SHA256_PATTERN = re.compile(r"^[a-f0-9]{64}$")
IMMUTABLE_REVISION_PATTERN = re.compile(r"^[a-f0-9]{40,64}$")
WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_DEVICE_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)
type EngineArtifactRole = Literal["worker"]
type ActivatedArtifactRole = Literal["worker", "model"]


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
    for part in path.parts:
        if (
            part.endswith((".", " "))
            or any(
                character in WINDOWS_FORBIDDEN_PATH_CHARACTERS
                or unicodedata.category(character) == "Cc"
                for character in part
            )
            or part.split(".", 1)[0].rstrip(" .").upper() in WINDOWS_RESERVED_DEVICE_BASENAMES
        ):
            raise EngineCatalogError(f"{label} contains a Windows-unsafe path component")
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
        if role != "worker":
            raise EngineCatalogError("release engine artifacts may contain only worker archives")
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
class EngineModelFileDescriptor:
    path: str
    kind: Literal["source", "derived", "license", "notice", "provenance"]
    bytes: int
    sha256: str
    url: str
    revision: str
    owner: str
    spdx: str
    redirect_hosts: tuple[str, ...]
    license_path: str | None
    notice_path: str | None
    derivation: dict[str, Any] | None

    @classmethod
    def from_dict(cls, value: object) -> EngineModelFileDescriptor:
        payload = _mapping(value, "direct model file")
        _exact_keys(
            payload,
            {
                "bytes",
                "derivation",
                "kind",
                "licensePath",
                "noticePath",
                "owner",
                "path",
                "redirectHosts",
                "revision",
                "sha256",
                "spdx",
                "url",
            },
            "direct model file",
        )
        path = _safe_relative_path(payload["path"], "direct model file path")
        kind = payload["kind"]
        if kind not in {"source", "derived", "license", "notice", "provenance"}:
            raise EngineCatalogError("direct model file kind is invalid")
        size = _positive_int(
            payload["bytes"],
            "direct model file bytes",
            maximum=2 * 1024**3,
        )
        if size > 512 * 1024**2 and not (
            kind in {"source", "derived"} and path.startswith("model/")
        ):
            raise EngineCatalogError("direct file is not eligible for the large-model exception")
        url = _artifact_url(payload["url"])
        revision = payload["revision"]
        if (
            not isinstance(revision, str)
            or IMMUTABLE_REVISION_PATTERN.fullmatch(revision) is None
            or revision not in url
        ):
            raise EngineCatalogError(
                "direct model URL must contain its immutable lowercase revision"
            )
        redirect_hosts = payload["redirectHosts"]
        initial_host = (urlsplit(url).hostname or "").lower()
        if (
            not isinstance(redirect_hosts, list)
            or redirect_hosts != sorted(set(redirect_hosts))
            or any(
                not isinstance(host, str)
                or not host
                or host != host.lower()
                or "@" in host
                or "/" in host
                for host in redirect_hosts
            )
            or initial_host in redirect_hosts
        ):
            raise EngineCatalogError("direct model redirectHosts must be sorted unique extra hosts")
        license_path = payload["licensePath"]
        notice_path = payload["noticePath"]
        if kind in {"license", "notice"}:
            if license_path is not None or notice_path is not None:
                raise EngineCatalogError("license/NOTICE files cannot reference themselves")
        else:
            license_path = _safe_relative_path(license_path, "direct model licensePath")
            notice_path = _safe_relative_path(notice_path, "direct model noticePath")
        derivation = payload["derivation"]
        if kind == "derived":
            derivation_payload = _mapping(derivation, "direct model derivation")
            _exact_keys(
                derivation_payload,
                {"algorithm", "generator", "inputs", "sourceCommit", "toolVersions"},
                "direct model derivation",
            )
            if (
                not isinstance(derivation_payload["algorithm"], str)
                or not derivation_payload["algorithm"]
                or not isinstance(derivation_payload["generator"], str)
                or not derivation_payload["generator"]
                or not isinstance(derivation_payload["sourceCommit"], str)
                or len(derivation_payload["sourceCommit"]) != 40
                or any(
                    character not in "0123456789abcdef"
                    for character in derivation_payload["sourceCommit"]
                )
                or not isinstance(derivation_payload["inputs"], list)
                or not derivation_payload["inputs"]
                or not isinstance(derivation_payload["toolVersions"], dict)
                or not derivation_payload["toolVersions"]
            ):
                raise EngineCatalogError("direct model derivation metadata is invalid")
            for item in derivation_payload["inputs"]:
                _safe_relative_path(item, "direct model derivation input")
            if derivation_payload["inputs"] != sorted(set(derivation_payload["inputs"])):
                raise EngineCatalogError("direct model derivation inputs must be sorted and unique")
            if any(
                not isinstance(key, str) or not key or not isinstance(item, str) or not item
                for key, item in derivation_payload["toolVersions"].items()
            ):
                raise EngineCatalogError("direct model derivation toolVersions are invalid")
            derivation = derivation_payload
        elif derivation is not None:
            raise EngineCatalogError("only derived direct model files have derivation metadata")
        owner = payload["owner"]
        spdx = payload["spdx"]
        if not isinstance(owner, str) or not owner or not isinstance(spdx, str) or not spdx:
            raise EngineCatalogError("direct model owner/SPDX metadata is invalid")
        return cls(
            path=path,
            kind=kind,
            bytes=size,
            sha256=_sha256(payload["sha256"], "direct model file sha256"),
            url=url,
            revision=revision,
            owner=owner,
            spdx=spdx,
            redirect_hosts=tuple(redirect_hosts),
            license_path=license_path,
            notice_path=notice_path,
            derivation=derivation,
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "bytes": self.bytes,
            "derivation": self.derivation,
            "kind": self.kind,
            "licensePath": self.license_path,
            "noticePath": self.notice_path,
            "owner": self.owner,
            "path": self.path,
            "redirectHosts": list(self.redirect_hosts),
            "revision": self.revision,
            "sha256": self.sha256,
            "spdx": self.spdx,
            "url": self.url,
        }


@dataclass(frozen=True, slots=True)
class EngineModelDeliveryDescriptor:
    artifact_version: str
    entry_point: str
    entry_count: int
    extracted_bytes: int
    manifest_sha256: str
    source_lock_sha256: str
    files: tuple[EngineModelFileDescriptor, ...]

    @classmethod
    def from_dict(cls, value: object) -> EngineModelDeliveryDescriptor:
        payload = _mapping(value, "direct model delivery")
        _exact_keys(
            payload,
            {
                "artifactVersion",
                "entryCount",
                "entryPoint",
                "extractedBytes",
                "files",
                "manifestSha256",
                "sourceLockSha256",
            },
            "direct model delivery",
        )
        artifact_version = payload["artifactVersion"]
        if not isinstance(artifact_version, str) or not artifact_version:
            raise EngineCatalogError("direct model artifactVersion must be non-empty")
        entry_point = _safe_relative_path(payload["entryPoint"], "direct model entryPoint")
        if entry_point != "model":
            raise EngineCatalogError("direct model entryPoint must remain model")
        raw_files = payload["files"]
        if not isinstance(raw_files, list):
            raise EngineCatalogError("direct model files must be a list")
        files = tuple(EngineModelFileDescriptor.from_dict(item) for item in raw_files)
        if not files or len(files) != _positive_int(
            payload["entryCount"], "direct model entryCount", maximum=4096
        ):
            raise EngineCatalogError("direct model entryCount does not match files")
        paths = [item.path for item in files]
        if paths != sorted(paths) or len({path.casefold() for path in paths}) != len(paths):
            raise EngineCatalogError("direct model file paths must be sorted and unique")
        extracted_bytes = _positive_int(
            payload["extractedBytes"],
            "direct model extractedBytes",
            maximum=2 * 1024**3,
        )
        if sum(item.bytes for item in files) != extracted_bytes:
            raise EngineCatalogError("direct model extractedBytes does not match files")
        licenses = {item.path for item in files if item.kind == "license"}
        notices = {item.path for item in files if item.kind == "notice"}
        if not licenses or not notices:
            raise EngineCatalogError("direct model delivery needs license and NOTICE files")
        if any(
            item.kind not in {"license", "notice"}
            and (item.license_path not in licenses or item.notice_path not in notices)
            for item in files
        ):
            raise EngineCatalogError(
                "direct model files must reference pinned license and NOTICE files"
            )
        known_paths = set(paths)
        if any(
            item.kind == "derived"
            and item.derivation is not None
            and any(source not in known_paths for source in item.derivation["inputs"])
            for item in files
        ):
            raise EngineCatalogError("direct model derivation inputs are not locked files")
        descriptor = cls(
            artifact_version=artifact_version,
            entry_point=entry_point,
            entry_count=len(files),
            extracted_bytes=extracted_bytes,
            manifest_sha256=_sha256(payload["manifestSha256"], "direct model manifestSha256"),
            source_lock_sha256=_sha256(
                payload["sourceLockSha256"], "direct model sourceLockSha256"
            ),
            files=files,
        )
        if hashlib.sha256(canonical_json_bytes(descriptor.to_manifest_dict())).hexdigest() != (
            descriptor.manifest_sha256
        ):
            raise EngineCatalogError("direct model manifestSha256 does not match files")
        return descriptor

    def to_manifest_dict(self) -> dict[str, Any]:
        return {
            "artifactVersion": self.artifact_version,
            "entryPoint": self.entry_point,
            "files": [item.to_dict() for item in self.files],
            "manifestVersion": "1",
        }

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifactVersion": self.artifact_version,
            "entryCount": self.entry_count,
            "entryPoint": self.entry_point,
            "extractedBytes": self.extracted_bytes,
            "files": [item.to_dict() for item in self.files],
            "manifestSha256": self.manifest_sha256,
            "sourceLockSha256": self.source_lock_sha256,
        }


@dataclass(frozen=True, slots=True)
class EngineRequirementDescriptor:
    requirement_id: str
    artifacts: tuple[EngineArtifactDescriptor, ...]
    model_files: EngineModelDeliveryDescriptor | None
    unavailable_reason: str | None = None

    @classmethod
    def from_dict(cls, value: object) -> EngineRequirementDescriptor:
        payload = _mapping(value, "engine requirement")
        _exact_keys(
            payload,
            {"requirementId", "artifacts", "modelFiles", "unavailableReason"},
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
        if artifacts and (len(artifacts) != 1 or roles != ["worker"]):
            raise EngineCatalogError("complete engine requirement needs exactly one worker archive")
        model_files = (
            None
            if payload["modelFiles"] is None
            else EngineModelDeliveryDescriptor.from_dict(payload["modelFiles"])
        )
        if artifacts and model_files is not None:
            if artifacts[0].artifact_version != model_files.artifact_version:
                raise EngineCatalogError(
                    "worker and direct model files must share one artifactVersion"
                )
            if requirement_id == "windowsml-ocr" and not any(
                item.path == "model/pipeline.json" and item.kind == "derived"
                for item in model_files.files
            ):
                raise EngineCatalogError("OCR direct delivery needs derived model/pipeline.json")
        unavailable_reason = payload["unavailableReason"]
        if unavailable_reason is not None and (
            not isinstance(unavailable_reason, str) or not unavailable_reason.strip()
        ):
            raise EngineCatalogError("unavailableReason must be non-empty when present")
        complete = bool(artifacts) and model_files is not None
        if complete == bool(unavailable_reason):
            raise EngineCatalogError(
                "engine requirement must be complete or have an unavailableReason"
            )
        if not complete and (artifacts or model_files is not None):
            raise EngineCatalogError("incomplete engine requirement cannot expose partial delivery")
        return cls(requirement_id, artifacts, model_files, unavailable_reason)

    @property
    def complete(self) -> bool:
        return len(self.artifacts) == 1 and self.model_files is not None

    @property
    def artifact_version(self) -> str | None:
        return self.artifacts[0].artifact_version if self.complete else None

    def worker_artifact(self) -> EngineArtifactDescriptor:
        if not self.complete:
            raise EngineCatalogError(f"{self.requirement_id} does not have a worker artifact")
        return self.artifacts[0]

    def model_delivery(self) -> EngineModelDeliveryDescriptor:
        if not self.complete or self.model_files is None:
            raise EngineCatalogError(f"{self.requirement_id} does not have direct model files")
        return self.model_files

    def to_dict(self) -> dict[str, Any]:
        return {
            "requirementId": self.requirement_id,
            "artifacts": [item.to_dict() for item in self.artifacts],
            "modelFiles": None if self.model_files is None else self.model_files.to_dict(),
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
    role: ActivatedArtifactRole
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
    "EngineModelDeliveryDescriptor",
    "EngineModelFileDescriptor",
    "EngineRequirementDescriptor",
    "canonical_json_bytes",
    "load_engine_catalog",
    "sha256_bytes",
]
