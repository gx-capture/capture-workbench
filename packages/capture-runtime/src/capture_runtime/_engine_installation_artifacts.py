"""Internal artifact integrity, ZIP validation, and installed-file checks."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import stat
import unicodedata
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from capture_runtime.engine_catalog import (
    EngineArtifactDescriptor,
    EngineModelDeliveryDescriptor,
)

from ._engine_installation_errors import EngineInstallationError
from ._engine_installation_limits import (
    DOWNLOAD_CHUNK_BYTES,
    FILES_MANIFEST_NAME,
    MAX_ARCHIVE_FILES,
    MAX_COMPRESSION_RATIO,
    MAX_FILES_MANIFEST_BYTES,
    MAX_SINGLE_EXTRACTED_FILE_BYTES,
    MAX_TOTAL_EXTRACTED_BYTES,
    WINDOWS_FORBIDDEN_PATH_CHARACTERS,
    WINDOWS_RESERVED_DEVICE_BASENAMES,
)


@dataclass(frozen=True, slots=True)
class ArtifactValidationLimits:
    max_archive_files: int = MAX_ARCHIVE_FILES
    max_single_extracted_file_bytes: int = MAX_SINGLE_EXTRACTED_FILE_BYTES
    max_total_extracted_bytes: int = MAX_TOTAL_EXTRACTED_BYTES
    max_compression_ratio: int = MAX_COMPRESSION_RATIO
    files_manifest_name: str = FILES_MANIFEST_NAME
    max_files_manifest_bytes: int = MAX_FILES_MANIFEST_BYTES
    download_chunk_bytes: int = DOWNLOAD_CHUNK_BYTES


DEFAULT_ARTIFACT_VALIDATION_LIMITS = ArtifactValidationLimits()


def sha256_file(path: Path, *, chunk_bytes: int = DOWNLOAD_CHUNK_BYTES) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(chunk_bytes):
            digest.update(chunk)
    return digest.hexdigest()


def validated_zip_path(name: str) -> PurePosixPath:
    if not name or "\\" in name or name.startswith(("/", "\\")) or name.startswith("//"):
        raise EngineInstallationError("engine archive contains a rooted or drive path")
    normalized_name = name[:-1] if name.endswith("/") else name
    if not normalized_name or normalized_name.endswith("/"):
        raise EngineInstallationError("engine archive contains path traversal")
    parts = normalized_name.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise EngineInstallationError("engine archive contains path traversal")
    for part in parts:
        if (
            part.endswith((".", " "))
            or any(
                character in WINDOWS_FORBIDDEN_PATH_CHARACTERS
                or unicodedata.category(character) == "Cc"
                for character in part
            )
            or part.split(".", 1)[0].rstrip(" .").upper() in WINDOWS_RESERVED_DEVICE_BASENAMES
        ):
            raise EngineInstallationError("engine archive contains a Windows-unsafe path component")
    return PurePosixPath(*parts)


def entry_is_regular_or_directory(info: zipfile.ZipInfo) -> bool:
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(unix_mode)
    if info.is_dir():
        return file_type in {0, stat.S_IFDIR}
    return file_type in {0, stat.S_IFREG}


def entry_size_limit(
    _descriptor: EngineArtifactDescriptor,
    _path: str,
    *,
    limits: ArtifactValidationLimits = DEFAULT_ARTIFACT_VALIDATION_LIMITS,
) -> int:
    return limits.max_single_extracted_file_bytes


def validate_files_manifest(
    manifest_bytes: bytes,
    infos: dict[str, zipfile.ZipInfo],
    descriptor: EngineArtifactDescriptor,
    *,
    limits: ArtifactValidationLimits = DEFAULT_ARTIFACT_VALIDATION_LIMITS,
) -> dict[str, tuple[int, str]]:
    try:
        payload = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EngineInstallationError("engine files manifest is not valid UTF-8 JSON") from error
    if not isinstance(payload, dict) or set(payload) != {"manifestVersion", "files"}:
        raise EngineInstallationError("engine files manifest fields are invalid")
    if payload["manifestVersion"] != "1" or not isinstance(payload["files"], list):
        raise EngineInstallationError("engine files manifest version/files are invalid")
    expected: dict[str, tuple[int, str]] = {}
    folded: set[str] = set()
    previous = ""
    for raw in payload["files"]:
        if not isinstance(raw, dict) or set(raw) != {"path", "bytes", "sha256"}:
            raise EngineInstallationError("engine files manifest entry is invalid")
        path = validated_zip_path(raw["path"] if isinstance(raw["path"], str) else "")
        normalized = path.as_posix()
        if normalized <= previous:
            raise EngineInstallationError("engine files manifest paths must be sorted and unique")
        previous = normalized
        casefolded = normalized.casefold()
        if casefolded in folded:
            raise EngineInstallationError("engine files manifest has a case collision")
        folded.add(casefolded)
        size = raw["bytes"]
        digest = raw["sha256"]
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or size > entry_size_limit(descriptor, normalized, limits=limits)
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise EngineInstallationError("engine files manifest size/checksum is invalid")
        expected[normalized] = (size, digest)
    actual = {
        name
        for name, info in infos.items()
        if not info.is_dir() and name != limits.files_manifest_name
    }
    if actual != set(expected):
        raise EngineInstallationError("engine archive files do not match inner manifest")
    return expected


def safe_extract_artifact(
    archive: Path,
    destination: Path,
    descriptor: EngineArtifactDescriptor,
    *,
    cancel_event: asyncio.Event,
    limits: ArtifactValidationLimits = DEFAULT_ARTIFACT_VALIDATION_LIMITS,
) -> None:
    if (
        archive.stat().st_size != descriptor.bytes
        or sha256_file(archive, chunk_bytes=limits.download_chunk_bytes) != descriptor.sha256
    ):
        raise EngineInstallationError("engine archive does not match its catalog descriptor")
    if destination.exists():
        raise EngineInstallationError("engine extraction destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as source:
            raw_infos = source.infolist()
            if len(raw_infos) > limits.max_archive_files:
                raise EngineInstallationError("engine archive contains too many entries")
            infos: dict[str, zipfile.ZipInfo] = {}
            folded: set[str] = set()
            total = 0
            for info in raw_infos:
                path = validated_zip_path(info.filename)
                normalized = path.as_posix()
                casefolded = normalized.casefold()
                if normalized in infos or casefolded in folded:
                    raise EngineInstallationError(
                        "engine archive contains duplicate or case-colliding paths"
                    )
                folded.add(casefolded)
                if info.flag_bits & 0x1:
                    raise EngineInstallationError("encrypted engine archives are unsupported")
                if not entry_is_regular_or_directory(info):
                    raise EngineInstallationError(
                        "engine archive contains a symlink or non-regular entry"
                    )
                if info.external_attr & 0x400:
                    raise EngineInstallationError(
                        "engine archive contains a Windows reparse-point entry"
                    )
                if info.file_size > entry_size_limit(descriptor, normalized, limits=limits):
                    raise EngineInstallationError("engine archive file exceeds size limit")
                if (
                    normalized == limits.files_manifest_name
                    and info.file_size > limits.max_files_manifest_bytes
                ):
                    raise EngineInstallationError("engine files manifest exceeds size limit")
                total += info.file_size
                if total > min(descriptor.extracted_bytes, limits.max_total_extracted_bytes):
                    raise EngineInstallationError("engine archive exceeds extracted byte limit")
                if (
                    info.file_size > 0
                    and info.compress_size == 0
                    or info.compress_size > 0
                    and info.file_size > info.compress_size * limits.max_compression_ratio
                ):
                    raise EngineInstallationError("engine archive compression ratio is unsafe")
                infos[normalized] = info
            if total != descriptor.extracted_bytes:
                raise EngineInstallationError("engine archive extracted bytes do not match catalog")
            manifest_info = infos.get(limits.files_manifest_name)
            if manifest_info is None or manifest_info.is_dir():
                raise EngineInstallationError("engine archive files manifest is missing")
            manifest_bytes = source.read(manifest_info)
            if hashlib.sha256(manifest_bytes).hexdigest() != descriptor.files_manifest_sha256:
                raise EngineInstallationError(
                    "engine files manifest checksum does not match catalog"
                )
            expected = validate_files_manifest(
                manifest_bytes,
                infos,
                descriptor,
                limits=limits,
            )
            destination.mkdir()
            root = destination.resolve()
            for normalized, info in infos.items():
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                target = destination.joinpath(*PurePosixPath(normalized).parts)
                resolved_parent = target.parent.resolve()
                if resolved_parent != root and root not in resolved_parent.parents:
                    raise EngineInstallationError("engine archive escaped extraction root")
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                digest = hashlib.sha256()
                copied = 0
                with source.open(info) as reader, target.open("xb") as writer:
                    while chunk := reader.read(limits.download_chunk_bytes):
                        if cancel_event.is_set():
                            raise asyncio.CancelledError
                        copied += len(chunk)
                        if copied > info.file_size:
                            raise EngineInstallationError(
                                "engine archive entry exceeded declared bytes"
                            )
                        writer.write(chunk)
                        digest.update(chunk)
                    writer.flush()
                    os.fsync(writer.fileno())
                if normalized != limits.files_manifest_name:
                    expected_size, expected_sha = expected[normalized]
                    if copied != expected_size or digest.hexdigest() != expected_sha:
                        raise EngineInstallationError(
                            "extracted engine file does not match inner manifest"
                        )
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def verify_extracted_artifact(
    root: Path,
    descriptor: EngineArtifactDescriptor,
    *,
    limits: ArtifactValidationLimits = DEFAULT_ARTIFACT_VALIDATION_LIMITS,
) -> None:
    manifest = root / limits.files_manifest_name
    if not manifest.is_file():
        raise EngineInstallationError("installed engine files manifest is missing")
    if manifest.stat().st_size > limits.max_files_manifest_bytes:
        raise EngineInstallationError("installed engine files manifest exceeds size limit")
    manifest_bytes = manifest.read_bytes()
    if hashlib.sha256(manifest_bytes).hexdigest() != descriptor.files_manifest_sha256:
        raise EngineInstallationError("installed engine files manifest checksum changed")
    try:
        payload = json.loads(manifest_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise EngineInstallationError("installed engine files manifest is invalid") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("files"), list):
        raise EngineInstallationError("installed engine files manifest fields are invalid")
    expected_paths: set[str] = {limits.files_manifest_name}
    total = len(manifest_bytes)
    for raw in payload["files"]:
        if not isinstance(raw, dict) or set(raw) != {"path", "bytes", "sha256"}:
            raise EngineInstallationError("installed engine manifest entry is invalid")
        relative = validated_zip_path(str(raw.get("path", ""))).as_posix()
        path = root.joinpath(*PurePosixPath(relative).parts)
        if not path.is_file() or path.is_symlink():
            raise EngineInstallationError("installed engine file is missing or unsafe")
        size = raw.get("bytes")
        digest = raw.get("sha256")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or size > entry_size_limit(descriptor, relative, limits=limits)
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise EngineInstallationError("installed engine manifest size/checksum is invalid")
        if (
            path.stat().st_size != size
            or sha256_file(path, chunk_bytes=limits.download_chunk_bytes) != digest
        ):
            raise EngineInstallationError("installed engine file checksum changed")
        expected_paths.add(relative)
        total += path.stat().st_size
    actual_paths = {item.relative_to(root).as_posix() for item in root.rglob("*") if item.is_file()}
    if actual_paths != expected_paths or total != descriptor.extracted_bytes:
        raise EngineInstallationError("installed engine files do not match catalog")


def verify_direct_model_files(
    root: Path,
    descriptor: EngineModelDeliveryDescriptor,
    *,
    limits: ArtifactValidationLimits = DEFAULT_ARTIFACT_VALIDATION_LIMITS,
) -> None:
    if not root.is_dir() or root.is_symlink():
        raise EngineInstallationError("installed direct model root is missing or unsafe")
    expected = {item.path: item for item in descriptor.files}
    actual = {item.relative_to(root).as_posix() for item in root.rglob("*") if item.is_file()}
    if actual != set(expected):
        raise EngineInstallationError("installed direct model files do not match catalog")
    total = 0
    resolved_root = root.resolve()
    for relative, item in expected.items():
        path = root.joinpath(*PurePosixPath(relative).parts)
        if path.is_symlink() or any(
            parent != root and parent.is_symlink()
            for parent in path.parents
            if parent == root or resolved_root in parent.resolve().parents
        ):
            raise EngineInstallationError("installed direct model file is unsafe")
        if (
            path.stat().st_size != item.bytes
            or sha256_file(path, chunk_bytes=limits.download_chunk_bytes) != item.sha256
        ):
            raise EngineInstallationError("installed direct model file checksum changed")
        if item.bytes > limits.max_single_extracted_file_bytes:
            raise EngineInstallationError(
                "installed direct file exceeds the 2 GiB single-file limit"
            )
        total += item.bytes
        if total > limits.max_total_extracted_bytes:
            raise EngineInstallationError("installed direct models exceed aggregate limit")
    if total != descriptor.extracted_bytes:
        raise EngineInstallationError("installed direct model bytes do not match catalog")


__all__ = [
    "ArtifactValidationLimits",
    "DEFAULT_ARTIFACT_VALIDATION_LIMITS",
    "entry_is_regular_or_directory",
    "entry_size_limit",
    "safe_extract_artifact",
    "sha256_file",
    "validate_files_manifest",
    "validated_zip_path",
    "verify_direct_model_files",
    "verify_extracted_artifact",
]
