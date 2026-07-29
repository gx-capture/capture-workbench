"""Checksum-pinned optional engine download, extraction, and activation."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import importlib
import json
import os
import shutil
import stat
import tempfile
import unicodedata
import zipfile
from collections.abc import Callable
from pathlib import Path, PurePosixPath
from typing import Protocol
from uuid import uuid4

import httpx

from capture_runtime.engine_catalog import (
    ActivatedArtifact,
    ActiveEngineState,
    EngineArtifactDescriptor,
    EngineCatalog,
    EngineCatalogError,
    EngineRequirementDescriptor,
    canonical_json_bytes,
)
from capture_runtime.worker_client import InstalledEngine, WorkerClient, WorkerProbeResult

MAX_ARCHIVE_FILES = 4096
MAX_SINGLE_EXTRACTED_FILE_BYTES = 512 * 1024 * 1024
MAX_TOTAL_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
FILES_MANIFEST_NAME = "files-manifest.json"
MAX_FILES_MANIFEST_BYTES = 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_DEVICE_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)


class EngineInstallationError(RuntimeError):
    """Raised when an optional engine cannot be safely installed."""


class EngineInstallBusyError(EngineInstallationError):
    """Raised when another process owns the same requirement install lock."""


class ArtifactDownloader(Protocol):
    async def download(
        self,
        descriptor: EngineArtifactDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None: ...


class HttpArtifactDownloader:
    def __init__(
        self,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
    ) -> None:
        self._client_factory = client_factory or (
            lambda: httpx.AsyncClient(timeout=120, follow_redirects=True)
        )

    async def download(
        self,
        descriptor: EngineArtifactDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        copied = 0
        digest = hashlib.sha256()
        try:
            async with self._client_factory() as client:
                async with client.stream("GET", descriptor.url) as response:
                    response.raise_for_status()
                    declared = response.headers.get("content-length")
                    if declared is not None:
                        try:
                            declared_bytes = int(declared)
                        except ValueError as error:
                            raise EngineInstallationError(
                                "engine artifact Content-Length is invalid"
                            ) from error
                        if declared_bytes != descriptor.bytes:
                            raise EngineInstallationError(
                                "engine artifact Content-Length does not match catalog"
                            )
                    with destination.open("xb") as writer:
                        async for chunk in response.aiter_bytes(DOWNLOAD_CHUNK_BYTES):
                            if cancel_event.is_set():
                                raise asyncio.CancelledError
                            copied += len(chunk)
                            if copied > descriptor.bytes:
                                raise EngineInstallationError(
                                    "engine artifact exceeded catalog byte count"
                                )
                            writer.write(chunk)
                            digest.update(chunk)
                            progress(copied)
                        writer.flush()
                        os.fsync(writer.fileno())
            if copied != descriptor.bytes:
                raise EngineInstallationError("engine artifact byte count does not match catalog")
            if digest.hexdigest() != descriptor.sha256:
                raise EngineInstallationError("engine artifact checksum does not match catalog")
        except BaseException:
            destination.unlink(missing_ok=True)
            raise


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(DOWNLOAD_CHUNK_BYTES):
            digest.update(chunk)
    return digest.hexdigest()


def _validated_zip_path(name: str) -> PurePosixPath:
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


def _entry_is_regular_or_directory(info: zipfile.ZipInfo) -> bool:
    unix_mode = (info.external_attr >> 16) & 0xFFFF
    file_type = stat.S_IFMT(unix_mode)
    if info.is_dir():
        return file_type in {0, stat.S_IFDIR}
    return file_type in {0, stat.S_IFREG}


def _validate_files_manifest(
    manifest_bytes: bytes,
    infos: dict[str, zipfile.ZipInfo],
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
        path = _validated_zip_path(raw["path"] if isinstance(raw["path"], str) else "")
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
            or size > MAX_SINGLE_EXTRACTED_FILE_BYTES
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise EngineInstallationError("engine files manifest size/checksum is invalid")
        expected[normalized] = (size, digest)
    actual = {
        name for name, info in infos.items() if not info.is_dir() and name != FILES_MANIFEST_NAME
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
) -> None:
    if archive.stat().st_size != descriptor.bytes or sha256_file(archive) != descriptor.sha256:
        raise EngineInstallationError("engine archive does not match its catalog descriptor")
    if destination.exists():
        raise EngineInstallationError("engine extraction destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as source:
            raw_infos = source.infolist()
            if len(raw_infos) > MAX_ARCHIVE_FILES:
                raise EngineInstallationError("engine archive contains too many entries")
            infos: dict[str, zipfile.ZipInfo] = {}
            folded: set[str] = set()
            total = 0
            for info in raw_infos:
                path = _validated_zip_path(info.filename)
                normalized = path.as_posix()
                casefolded = normalized.casefold()
                if normalized in infos or casefolded in folded:
                    raise EngineInstallationError(
                        "engine archive contains duplicate or case-colliding paths"
                    )
                folded.add(casefolded)
                if info.flag_bits & 0x1:
                    raise EngineInstallationError("encrypted engine archives are unsupported")
                if not _entry_is_regular_or_directory(info):
                    raise EngineInstallationError(
                        "engine archive contains a symlink or non-regular entry"
                    )
                if info.external_attr & 0x400:
                    raise EngineInstallationError(
                        "engine archive contains a Windows reparse-point entry"
                    )
                if info.file_size > MAX_SINGLE_EXTRACTED_FILE_BYTES:
                    raise EngineInstallationError("engine archive file exceeds size limit")
                if normalized == FILES_MANIFEST_NAME and info.file_size > MAX_FILES_MANIFEST_BYTES:
                    raise EngineInstallationError("engine files manifest exceeds size limit")
                total += info.file_size
                if total > min(descriptor.extracted_bytes, MAX_TOTAL_EXTRACTED_BYTES):
                    raise EngineInstallationError("engine archive exceeds extracted byte limit")
                if (
                    info.file_size > 0
                    and info.compress_size == 0
                    or info.compress_size > 0
                    and info.file_size > info.compress_size * MAX_COMPRESSION_RATIO
                ):
                    raise EngineInstallationError("engine archive compression ratio is unsafe")
                infos[normalized] = info
            if total != descriptor.extracted_bytes:
                raise EngineInstallationError("engine archive extracted bytes do not match catalog")
            manifest_info = infos.get(FILES_MANIFEST_NAME)
            if manifest_info is None or manifest_info.is_dir():
                raise EngineInstallationError("engine archive files manifest is missing")
            manifest_bytes = source.read(manifest_info)
            if hashlib.sha256(manifest_bytes).hexdigest() != descriptor.files_manifest_sha256:
                raise EngineInstallationError(
                    "engine files manifest checksum does not match catalog"
                )
            expected = _validate_files_manifest(manifest_bytes, infos)
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
                    while chunk := reader.read(DOWNLOAD_CHUNK_BYTES):
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
                if normalized != FILES_MANIFEST_NAME:
                    expected_size, expected_sha = expected[normalized]
                    if copied != expected_size or digest.hexdigest() != expected_sha:
                        raise EngineInstallationError(
                            "extracted engine file does not match inner manifest"
                        )
    except BaseException:
        shutil.rmtree(destination, ignore_errors=True)
        raise


def verify_extracted_artifact(root: Path, descriptor: EngineArtifactDescriptor) -> None:
    manifest = root / FILES_MANIFEST_NAME
    if not manifest.is_file():
        raise EngineInstallationError("installed engine files manifest is missing")
    if manifest.stat().st_size > MAX_FILES_MANIFEST_BYTES:
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
    expected_paths: set[str] = {FILES_MANIFEST_NAME}
    total = len(manifest_bytes)
    for raw in payload["files"]:
        if not isinstance(raw, dict):
            raise EngineInstallationError("installed engine manifest entry is invalid")
        relative = _validated_zip_path(str(raw.get("path", ""))).as_posix()
        path = root.joinpath(*PurePosixPath(relative).parts)
        if not path.is_file() or path.is_symlink():
            raise EngineInstallationError("installed engine file is missing or unsafe")
        if path.stat().st_size != raw.get("bytes") or sha256_file(path) != raw.get("sha256"):
            raise EngineInstallationError("installed engine file checksum changed")
        expected_paths.add(relative)
        total += path.stat().st_size
    actual_paths = {item.relative_to(root).as_posix() for item in root.rglob("*") if item.is_file()}
    if actual_paths != expected_paths or total != descriptor.extracted_bytes:
        raise EngineInstallationError("installed engine files do not match catalog")


def _atomic_write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as writer:
            writer.write(canonical_json_bytes(payload))
            writer.flush()
            os.fsync(writer.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


class _ExclusiveInstallFile:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._descriptor: int | None = None

    def __enter__(self) -> _ExclusiveInstallFile:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            os.lseek(descriptor, 0, os.SEEK_SET)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            else:
                fcntl = importlib.import_module("fcntl")
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            os.close(descriptor)
            if error.errno in {errno.EACCES, errno.EAGAIN}:
                raise EngineInstallBusyError("another engine installation is active") from error
            raise EngineInstallationError("engine install lock could not be acquired") from error
        self._descriptor = descriptor
        return self

    def __exit__(self, *_errors: object) -> None:
        if self._descriptor is not None:
            os.close(self._descriptor)
            self._descriptor = None


class EngineInstallationManager:
    def __init__(
        self,
        root: Path,
        catalog: EngineCatalog,
        *,
        worker_client: WorkerClient,
        downloader: ArtifactDownloader | None = None,
    ) -> None:
        self.root = root
        self.catalog = catalog
        self.worker_client = worker_client
        self.downloader = downloader or HttpArtifactDownloader()
        self._locks: dict[str, asyncio.Lock] = {}

    def requirement(self, requirement_id: str) -> EngineRequirementDescriptor:
        return self.catalog.requirement(requirement_id)

    def active_engine(self, requirement_id: str) -> InstalledEngine | None:
        requirement = self.requirement(requirement_id)
        if not requirement.complete:
            return None
        state_path = self._requirement_root(requirement_id) / "active.json"
        try:
            state = ActiveEngineState.from_dict(json.loads(state_path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError, EngineCatalogError):
            return None
        if (
            state.requirement_id != requirement_id
            or state.artifact_version != requirement.artifact_version
        ):
            return None
        expected_digests = {item.role: item.sha256 for item in requirement.artifacts}
        if {item.role: item.sha256 for item in state.activated_artifacts} != expected_digests:
            return None
        version_root = self._requirement_root(requirement_id) / "versions" / state.artifact_version
        worker_descriptor = requirement.artifact("worker")
        model_descriptor = requirement.artifact("model")
        worker_root = version_root / "worker"
        model_root = version_root / "model"
        try:
            verify_extracted_artifact(worker_root, worker_descriptor)
            verify_extracted_artifact(model_root, model_descriptor)
        except EngineInstallationError:
            return None
        executable = self._resolved_child(self._requirement_root(requirement_id), state.entry_point)
        model_dir = self._resolved_child(model_root, model_descriptor.entry_point)
        if not executable.is_file() or not model_dir.is_dir():
            return None
        return InstalledEngine(
            requirement_id=requirement_id,
            artifact_version=state.artifact_version,
            executable=executable,
            model_dir=model_dir,
        )

    async def probe(
        self,
        requirement_id: str,
        *,
        probe_options: dict[str, object] | None = None,
    ) -> WorkerProbeResult | None:
        engine = self.active_engine(requirement_id)
        if engine is None:
            return None
        try:
            return await self.worker_client.probe(
                engine,
                include_model=True,
                options=probe_options,
            )
        except Exception:
            return None

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        probe_options: dict[str, object] | None = None,
    ) -> None:
        requirement = self.requirement(requirement_id)
        if not requirement.complete:
            raise EngineInstallationError(
                requirement.unavailable_reason or "engine catalog entry is incomplete"
            )
        lock = self._locks.setdefault(requirement_id, asyncio.Lock())
        async with lock:
            requirement_root = self._requirement_root(requirement_id)
            with _ExclusiveInstallFile(requirement_root / ".install.lock"):
                await self._install_locked(
                    requirement,
                    cancel_event=cancel_event,
                    report_progress=report_progress,
                    probe_options=probe_options,
                )

    async def _install_locked(
        self,
        requirement: EngineRequirementDescriptor,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        probe_options: dict[str, object] | None,
    ) -> None:
        assert requirement.artifact_version is not None
        if self.active_engine(requirement.requirement_id) is not None:
            report_progress(1)
            return
        requirement_root = self._requirement_root(requirement.requirement_id)
        staging = requirement_root / ".staging" / uuid4().hex
        version = requirement_root / "versions" / requirement.artifact_version
        new_version = (
            requirement_root / "versions" / f".{requirement.artifact_version}.{uuid4().hex}"
        )
        staging.mkdir(parents=True)
        new_version.parent.mkdir(parents=True, exist_ok=True)
        activated = False
        try:
            for index, role in enumerate(("worker", "model")):
                descriptor = requirement.artifact(role)  # type: ignore[arg-type]
                archive = staging / descriptor.file_name
                base = index * 0.4

                def artifact_progress(
                    copied: int,
                    *,
                    progress_base: float = base,
                    total: int = descriptor.bytes,
                ) -> None:
                    report_progress(progress_base + 0.25 * (copied / total))

                await self.downloader.download(
                    descriptor,
                    archive,
                    cancel_event=cancel_event,
                    progress=artifact_progress,
                )
                safe_extract_artifact(
                    archive,
                    new_version / role,
                    descriptor,
                    cancel_event=cancel_event,
                )
                report_progress(base + 0.3)
                if role == "worker":
                    probe_engine = InstalledEngine(
                        requirement_id=requirement.requirement_id,
                        artifact_version=requirement.artifact_version,
                        executable=self._resolved_child(
                            new_version / "worker", descriptor.entry_point
                        ),
                        model_dir=new_version / "model" / "model",
                    )
                    code_probe = await self.worker_client.probe(
                        probe_engine,
                        include_model=False,
                        options=probe_options,
                    )
                    if not code_probe.code_ready:
                        raise EngineInstallationError(
                            f"engine worker code probe failed: {code_probe.detail}"
                        )
            worker_descriptor = requirement.artifact("worker")
            model_descriptor = requirement.artifact("model")
            engine = InstalledEngine(
                requirement_id=requirement.requirement_id,
                artifact_version=requirement.artifact_version,
                executable=self._resolved_child(
                    new_version / "worker", worker_descriptor.entry_point
                ),
                model_dir=self._resolved_child(new_version / "model", model_descriptor.entry_point),
            )
            probe = await self.worker_client.probe(
                engine,
                include_model=True,
                options=probe_options,
            )
            if not probe.ready:
                raise EngineInstallationError(f"engine post-install probe failed: {probe.detail}")
            if cancel_event.is_set():
                raise asyncio.CancelledError
            if version.exists():
                shutil.rmtree(version)
            os.replace(new_version, version)
            state = ActiveEngineState(
                requirement_id=requirement.requirement_id,
                artifact_version=requirement.artifact_version,
                worker_protocol_version=worker_descriptor.worker_protocol_version,
                entry_point=(
                    Path("versions")
                    / requirement.artifact_version
                    / "worker"
                    / worker_descriptor.entry_point
                ).as_posix(),
                activated_artifacts=tuple(
                    ActivatedArtifact(item.role, item.sha256) for item in requirement.artifacts
                ),
            )
            _atomic_write_json(requirement_root / "active.json", state.to_dict())
            activated = True
            report_progress(1)
            self._remove_inactive_versions(requirement_root, requirement.artifact_version)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            if not activated:
                shutil.rmtree(new_version, ignore_errors=True)

    async def shutdown(self) -> None:
        await self.worker_client.shutdown()

    def _requirement_root(self, requirement_id: str) -> Path:
        if not requirement_id or any(
            character not in "abcdefghijklmnopqrstuvwxyz0123456789-" for character in requirement_id
        ):
            raise EngineInstallationError("engine requirement ID is unsafe")
        return self.root / requirement_id

    @staticmethod
    def _resolved_child(root: Path, relative: str) -> Path:
        candidate = root.joinpath(*PurePosixPath(relative).parts).resolve()
        resolved_root = root.resolve()
        if candidate != resolved_root and resolved_root not in candidate.parents:
            raise EngineInstallationError("engine path escaped its version root")
        return candidate

    @staticmethod
    def _remove_inactive_versions(root: Path, active_version: str) -> None:
        versions = root / "versions"
        if not versions.is_dir():
            return
        for item in versions.iterdir():
            if item.is_dir() and item.name != active_version and not item.name.startswith("."):
                shutil.rmtree(item, ignore_errors=True)


__all__ = [
    "EngineInstallBusyError",
    "EngineInstallationError",
    "EngineInstallationManager",
    "HttpArtifactDownloader",
    "safe_extract_artifact",
    "sha256_file",
    "verify_extracted_artifact",
]
