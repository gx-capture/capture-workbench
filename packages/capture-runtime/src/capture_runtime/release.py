"""Deterministic schema and release-manifest generation."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from capture_runtime.constants import (
    API_VERSION,
    CAPTURE_DOCUMENT_SCHEMA_VERSION,
    MAX_RUNTIME_ARTIFACT_BYTES,
    RUNTIME_VERSION,
)
from capture_runtime.contracts import CaptureDocumentV1
from capture_runtime.engine_adapters import WINDOWSML_REQUIRED_MODEL_FILES

_LOWERCASE_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_NON_RELEASE_HOST_SUFFIXES = (".invalid", ".example", ".test", ".localhost")
MAX_WINDOWSML_BUNDLE_BYTES = 512 * 1024 * 1024
CAPTURE_DOCUMENT_SCHEMA_ID = (
    "https://github.com/WodenWang820118/capture-workbench/schema/capture-document-v1.schema.json"
)
CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256 = (
    "da8565b0a4611042f62f96202d0f167ba0923d88e12b9be22832f3ee320920c3"
)


def _canonical_public_https_artifact(url: str) -> tuple[str, str]:
    if "%" in url or "\\" in url or any(ord(character) < 0x20 for character in url):
        raise ValueError("Artifact URL must not contain escapes, backslashes, or controls")
    parsed = urlsplit(url)
    hostname = (parsed.hostname or "").lower()
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise ValueError("Artifact URL must use a public DNS hostname, not an IP literal")
    if (
        parsed.scheme != "https"
        or not hostname
        or hostname != parsed.hostname
        or parsed.netloc != hostname
        or hostname in {"localhost"}
        or hostname.endswith(_NON_RELEASE_HOST_SUFFIXES)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.query
        or parsed.fragment
        or re.fullmatch(
            r"(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}",
            hostname,
        )
        is None
    ):
        raise ValueError(
            "Artifact URL must be canonical public HTTPS without credentials, port, "
            "query, or fragment"
        )
    raw_file_name = parsed.path.rsplit("/", 1)[-1]
    file_name = unquote(raw_file_name)
    path_segments = parsed.path.split("/")[1:]
    if (
        not file_name
        or raw_file_name != file_name
        or not path_segments
        or any(
            segment in {".", ".."} or re.fullmatch(r"[A-Za-z0-9._~-]+", segment) is None
            for segment in path_segments
        )
        or re.fullmatch(r"[A-Za-z0-9._-]+\.zip", file_name, re.IGNORECASE) is None
    ):
        raise ValueError("Artifact URL must end in an unescaped plain .zip file name")
    return hostname, file_name


class WindowsMlRequirementDescriptorV1(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    artifact_url: str = Field(alias="artifactUrl")
    artifact_file_name: str = Field(alias="artifactFileName")
    bytes: int
    sha256: str

    @field_validator("artifact_url")
    @classmethod
    def validate_url(cls, value: str) -> str:
        _canonical_public_https_artifact(value)
        return value

    @field_validator("bytes")
    @classmethod
    def validate_bytes(cls, value: int) -> int:
        if not 1 <= value <= MAX_WINDOWSML_BUNDLE_BYTES:
            raise ValueError("bytes must be between 1 and 536870912")
        return value

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if not _LOWERCASE_SHA256.fullmatch(value):
            raise ValueError("sha256 must be 64 lowercase hexadecimal characters")
        return value

    @model_validator(mode="after")
    def file_name_matches_url(self) -> WindowsMlRequirementDescriptorV1:
        _, url_file_name = _canonical_public_https_artifact(self.artifact_url)
        if self.artifact_file_name != url_file_name:
            raise ValueError("artifactFileName must exactly match artifactUrl")
        return self


class RuntimeRequirementsManifestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    windowsml_ocr: WindowsMlRequirementDescriptorV1 = Field(alias="windowsml-ocr")


class RuntimeReleaseManifestV1(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, strict=True)

    manifest_version: str = Field(alias="manifestVersion")
    runtime_version: str = Field(alias="runtimeVersion")
    api_version: str = Field(alias="apiVersion")
    capture_document_schema_version: str = Field(alias="captureDocumentSchemaVersion")
    platform: str
    arch: str
    file_name: str = Field(alias="fileName")
    bytes: int
    sha256: str
    schema_file_name: str = Field(alias="schemaFileName")
    schema_sha256: str = Field(alias="schemaSha256")
    runtime_requirements: RuntimeRequirementsManifestV1 = Field(alias="runtimeRequirements")

    @field_validator("manifest_version")
    @classmethod
    def validate_manifest_version(cls, value: str) -> str:
        if value != "1":
            raise ValueError("manifestVersion must equal 1")
        return value

    @field_validator("runtime_version")
    @classmethod
    def validate_runtime_version(cls, value: str) -> str:
        if value != RUNTIME_VERSION:
            raise ValueError(f"runtimeVersion must equal {RUNTIME_VERSION}")
        return value

    @field_validator("api_version")
    @classmethod
    def validate_api_version(cls, value: str) -> str:
        if value != API_VERSION:
            raise ValueError(f"apiVersion must equal {API_VERSION}")
        return value

    @field_validator("capture_document_schema_version")
    @classmethod
    def validate_schema_version(cls, value: str) -> str:
        if value != CAPTURE_DOCUMENT_SCHEMA_VERSION:
            raise ValueError(
                f"captureDocumentSchemaVersion must equal {CAPTURE_DOCUMENT_SCHEMA_VERSION}"
            )
        return value

    @field_validator("platform")
    @classmethod
    def validate_platform(cls, value: str) -> str:
        if value != "windows":
            raise ValueError("platform must equal windows")
        return value

    @field_validator("arch")
    @classmethod
    def validate_arch(cls, value: str) -> str:
        if value != "x86_64":
            raise ValueError("arch must equal x86_64")
        return value

    @field_validator("file_name")
    @classmethod
    def validate_file_name(cls, value: str) -> str:
        if value != "capture-runtime-x86_64-pc-windows-msvc.exe":
            raise ValueError("fileName is not canonical")
        return value

    @field_validator("schema_file_name")
    @classmethod
    def validate_schema_file_name(cls, value: str) -> str:
        if value != "capture-document-v1.schema.json":
            raise ValueError("schemaFileName is not canonical")
        return value

    @field_validator("bytes")
    @classmethod
    def validate_runtime_bytes(cls, value: int) -> int:
        if not 1 <= value <= MAX_RUNTIME_ARTIFACT_BYTES:
            raise ValueError("bytes must be between 1 and 536870912")
        return value

    @field_validator("sha256", "schema_sha256")
    @classmethod
    def validate_digest(cls, value: str) -> str:
        if not _LOWERCASE_SHA256.fullmatch(value):
            raise ValueError("digest must be 64 lowercase hexadecimal characters")
        return value


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def capture_document_schema() -> dict[str, Any]:
    """Return the authoritative semantic CaptureDocumentV1 JSON Schema."""

    schema = CaptureDocumentV1.model_json_schema(by_alias=True)
    schema["$schema"] = "https://json-schema.org/draft/2020-12/schema"
    schema["$id"] = CAPTURE_DOCUMENT_SCHEMA_ID
    return schema


def capture_document_schema_release_bytes() -> bytes:
    """Serialize the v1 release schema with deterministic Windows CRLF bytes."""

    serialized = json.dumps(capture_document_schema(), ensure_ascii=False, indent=2, sort_keys=True)
    return (serialized.replace("\n", "\r\n") + "\r\n").encode("utf-8")


def capture_document_schema_release_sha256() -> str:
    return hashlib.sha256(capture_document_schema_release_bytes()).hexdigest()


def write_capture_document_schema(output: Path) -> Path:
    schema_bytes = capture_document_schema_release_bytes()
    digest = hashlib.sha256(schema_bytes).hexdigest()
    if digest != CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256:
        raise ValueError(
            "CaptureDocumentV1 schema bytes changed without an intentional schema release"
        )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(schema_bytes)
    return output


def windowsml_requirement_descriptor(url: str, bytes: int, sha256: str) -> dict[str, str | int]:
    """Build a public, checksum-pinned descriptor safe to embed in release metadata."""

    _, file_name = _canonical_public_https_artifact(url)
    descriptor = WindowsMlRequirementDescriptorV1.model_validate(
        {"artifactUrl": url, "artifactFileName": file_name, "bytes": bytes, "sha256": sha256}
    )
    return descriptor.model_dump(by_alias=True)


def build_windowsml_bundle(
    *,
    source_dir: Path,
    output: Path,
    artifact_url: str,
) -> dict[str, Any]:
    """Build a byte-reproducible stored ZIP from the allowlisted OCR model files."""

    source = source_dir.resolve(strict=True)
    if not source.is_dir() or source.is_symlink():
        raise ValueError("WindowsML bundle source must be a real directory")
    destination = output.resolve(strict=False)
    if destination == source or source in destination.parents:
        raise ValueError("WindowsML bundle output must be outside its source directory")

    files: list[tuple[str, Path]] = []
    for relative in WINDOWSML_REQUIRED_MODEL_FILES:
        path = source / Path(relative)
        if not path.is_file() or path.is_symlink() or source not in path.resolve().parents:
            raise ValueError(f"WindowsML bundle source is missing a safe regular file: {relative}")
        files.append((relative, path))

    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.tmp")
    temporary.unlink(missing_ok=True)
    try:
        with zipfile.ZipFile(temporary, "x", compression=zipfile.ZIP_STORED) as archive:
            for relative, path in files:
                entry = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_STORED
                entry.create_system = 3
                entry.external_attr = 0o100644 << 16
                with path.open("rb") as reader, archive.open(entry, "w") as writer:
                    shutil.copyfileobj(reader, writer, length=1024 * 1024)
        with zipfile.ZipFile(temporary, "r") as archive:
            if archive.namelist() != list(WINDOWSML_REQUIRED_MODEL_FILES):
                raise ValueError("WindowsML bundle file list is not canonical")
            if archive.testzip() is not None:
                raise ValueError("WindowsML bundle failed its CRC verification")
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)

    descriptor = windowsml_requirement_descriptor(
        artifact_url, destination.stat().st_size, sha256_file(destination)
    )
    if descriptor["artifactFileName"] != destination.name:
        destination.unlink(missing_ok=True)
        raise ValueError("WindowsML artifact URL file name must match the staged bundle")
    return {
        "manifestVersion": "1",
        "requirementId": "windowsml-ocr",
        "artifact": descriptor,
        "bytes": destination.stat().st_size,
        "files": list(WINDOWSML_REQUIRED_MODEL_FILES),
    }


def build_release_artifacts(
    *,
    executable: Path,
    schema: Path,
    output_dir: Path,
    windowsml_bundle_url: str,
    windowsml_bundle_bytes: int,
    windowsml_bundle_sha256: str,
) -> dict[str, Any]:
    if not executable.is_file():
        raise FileNotFoundError(executable)
    if not schema.is_file():
        raise FileNotFoundError(schema)
    json.loads(schema.read_text(encoding="utf-8"))
    output_dir.mkdir(parents=True, exist_ok=True)
    released_executable = output_dir / "capture-runtime-x86_64-pc-windows-msvc.exe"
    released_schema = output_dir / "capture-document-v1.schema.json"
    shutil.copy2(executable, released_executable)
    shutil.copy2(schema, released_schema)
    manifest: dict[str, Any] = {
        "manifestVersion": "1",
        "runtimeVersion": RUNTIME_VERSION,
        "apiVersion": API_VERSION,
        "captureDocumentSchemaVersion": CAPTURE_DOCUMENT_SCHEMA_VERSION,
        "platform": "windows",
        "arch": "x86_64",
        "fileName": released_executable.name,
        "bytes": released_executable.stat().st_size,
        "sha256": sha256_file(released_executable),
        "schemaFileName": released_schema.name,
        "schemaSha256": sha256_file(released_schema),
        "runtimeRequirements": {
            "windowsml-ocr": windowsml_requirement_descriptor(
                windowsml_bundle_url,
                windowsml_bundle_bytes,
                windowsml_bundle_sha256,
            )
        },
    }
    manifest = RuntimeReleaseManifestV1.model_validate(manifest).model_dump(by_alias=True)
    (output_dir / "capture-runtime-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output_dir / f"{released_executable.name}.sha256").write_text(
        f"{manifest['sha256']}  {released_executable.name}\n",
        encoding="utf-8",
    )
    return manifest
