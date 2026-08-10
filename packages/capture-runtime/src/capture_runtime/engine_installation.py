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
from dataclasses import replace
from pathlib import Path, PurePosixPath
from typing import Protocol
from urllib.parse import urlsplit
from uuid import uuid4

import httpx

from capture_runtime.engine_catalog import (
    ActivatedArtifact,
    ActiveEngineState,
    EngineArtifactDescriptor,
    EngineCatalog,
    EngineCatalogError,
    EngineModelDeliveryDescriptor,
    EngineModelFileDescriptor,
    EngineRequirementDescriptor,
    canonical_json_bytes,
)
from capture_runtime.worker_client import InstalledEngine, WorkerClient, WorkerProbeResult
from capture_runtime.worker_process import WorkerExecutionError

MAX_ARCHIVE_FILES = 4096
# A pinned Whisper primary model is larger than the worker/archive guard but
# remains bounded below the direct-model aggregate limit.
MAX_SINGLE_EXTRACTED_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
FILES_MANIFEST_NAME = "files-manifest.json"
MAX_FILES_MANIFEST_BYTES = 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
MAX_DIRECT_MODEL_REDIRECTS = 5
WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_DEVICE_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)

_SMOKE_WORKER_MIRROR_OPT_IN = "CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN"
_SMOKE_WORKER_MIRROR_URL = "CAPTURE_SMOKE_WORKER_MIRROR_URL"


def _smoke_worker_mirror_url(environ: dict[str, str] | None = None) -> str | None:
    """Resolve the intentionally narrow pre-release worker mirror override.

    The production catalog remains immutable and model downloads always use the
    catalog's HTTPS URLs.  This opt-in exists solely so the local packaged smoke
    can serve the exact worker bytes before the GitHub release is published.
    """

    source = os.environ if environ is None else environ
    if source.get(_SMOKE_WORKER_MIRROR_OPT_IN, "").strip() != "1":
        return None
    raw = source.get(_SMOKE_WORKER_MIRROR_URL, "").strip()
    try:
        parsed = urlsplit(raw)
        port = parsed.port
    except ValueError as error:
        raise EngineInstallationError("smoke worker mirror URL is invalid") from error
    if (
        parsed.scheme != "http"
        or parsed.hostname != "127.0.0.1"
        or port is None
        or not 1 <= port <= 65535
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in {"", "/"}
    ):
        raise EngineInstallationError("smoke worker mirror must be a numeric loopback HTTP origin")
    return f"http://127.0.0.1:{port}"


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


class ModelFileDownloader(Protocol):
    async def download(
        self,
        descriptor: EngineModelFileDescriptor,
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


def _validate_direct_model_url(
    descriptor: EngineModelFileDescriptor,
    url: httpx.URL,
    *,
    initial: bool,
) -> None:
    initial_url = httpx.URL(descriptor.url)
    initial_host = (initial_url.host or "").lower()
    allowed_redirect_hosts = set(descriptor.redirect_hosts)
    host = (url.host or "").lower()
    if (
        url.scheme != "https"
        or url.username
        or url.password
        or url.fragment
        or host not in {initial_host, *allowed_redirect_hosts}
        or (url.query and host not in allowed_redirect_hosts)
    ):
        raise EngineInstallationError(
            "direct model redirect is downgraded, credentialed, or outside the lock"
        )
    if initial and str(url) != descriptor.url:
        raise EngineInstallationError("direct model request URL drifted from catalog")


class HttpModelFileDownloader:
    def __init__(
        self,
        client_factory: Callable[[], httpx.AsyncClient] | None = None,
        *,
        retry_delays: tuple[float, ...] = (0, 1, 2),
    ) -> None:
        if not 1 <= len(retry_delays) <= 5 or any(
            isinstance(delay, bool)
            or not isinstance(delay, (int, float))
            or delay < 0
            or delay > 30
            for delay in retry_delays
        ):
            raise ValueError("direct model retry schedule must be bounded")
        self._client_factory = client_factory or (
            lambda: httpx.AsyncClient(timeout=120, follow_redirects=False)
        )
        self._retry_delays = retry_delays

    async def download(
        self,
        descriptor: EngineModelFileDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        if descriptor.bytes > MAX_SINGLE_EXTRACTED_FILE_BYTES:
            raise EngineInstallationError("direct model file exceeds the 2 GiB single-file limit")
        last_error: BaseException | None = None
        for attempt, delay in enumerate(self._retry_delays):
            last_error = None
            destination.unlink(missing_ok=True)
            if cancel_event.is_set():
                raise asyncio.CancelledError
            if delay:
                await asyncio.sleep(delay)
            if cancel_event.is_set():
                raise asyncio.CancelledError
            try:
                await self._download_once(
                    descriptor,
                    destination,
                    cancel_event=cancel_event,
                    progress=progress,
                )
                return
            except asyncio.CancelledError:
                raise
            except httpx.HTTPStatusError as error:
                last_error = error
                if error.response.status_code < 500 and error.response.status_code not in {
                    408,
                    429,
                }:
                    raise EngineInstallationError(
                        "direct model source returned a non-retryable response"
                    ) from error
            except httpx.InvalidURL as error:
                raise EngineInstallationError(
                    "direct model redirect Location is invalid"
                ) from error
            except httpx.TransportError as error:
                last_error = error
            except OSError as error:
                # Windows HTTP/file IO can surface a connection abort as a bare
                # OSError. Treat it like the other bounded transport failures;
                # integrity checks still run after a complete retry succeeds.
                last_error = error
            except BaseException:
                destination.unlink(missing_ok=True)
                raise
            finally:
                if attempt + 1 == len(self._retry_delays) and last_error is not None:
                    destination.unlink(missing_ok=True)
        raise EngineInstallationError("direct model download exhausted bounded retries") from (
            last_error
        )

    async def _download_once(
        self,
        descriptor: EngineModelFileDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        copied = 0
        digest = hashlib.sha256()
        try:
            async with self._client_factory() as client:
                if "authorization" in client.headers:
                    raise EngineInstallationError(
                        "direct model client must not send authorization material"
                    )
                current = httpx.URL(descriptor.url)
                _validate_direct_model_url(descriptor, current, initial=True)
                for redirect_count in range(MAX_DIRECT_MODEL_REDIRECTS + 1):
                    async with client.stream(
                        "GET",
                        current,
                        follow_redirects=False,
                        headers={"Accept-Encoding": "identity"},
                    ) as response:
                        if 300 <= response.status_code < 400:
                            if redirect_count == MAX_DIRECT_MODEL_REDIRECTS:
                                raise EngineInstallationError(
                                    "direct model redirect limit exceeded"
                                )
                            location = response.headers.get("location")
                            if (
                                response.status_code not in {301, 302, 303, 307, 308}
                                or location is None
                            ):
                                raise EngineInstallationError(
                                    "direct model redirect is missing or unsupported"
                                )
                            try:
                                redirected = response.url.join(location)
                            except (httpx.InvalidURL, ValueError) as error:
                                raise EngineInstallationError(
                                    "direct model redirect Location is invalid"
                                ) from error
                            _validate_direct_model_url(
                                descriptor,
                                redirected,
                                initial=False,
                            )
                            current = redirected
                            continue
                        response.raise_for_status()
                        declared = response.headers.get("content-length")
                        if declared is not None:
                            try:
                                declared_bytes = int(declared)
                            except ValueError as error:
                                raise EngineInstallationError(
                                    "direct model Content-Length is invalid"
                                ) from error
                            if declared_bytes != descriptor.bytes:
                                raise EngineInstallationError(
                                    "direct model Content-Length does not match catalog"
                                )
                        with destination.open("xb") as writer:
                            async for chunk in response.aiter_bytes(DOWNLOAD_CHUNK_BYTES):
                                if cancel_event.is_set():
                                    raise asyncio.CancelledError
                                copied += len(chunk)
                                if copied > descriptor.bytes:
                                    raise EngineInstallationError(
                                        "direct model file exceeded catalog byte count"
                                    )
                                writer.write(chunk)
                                digest.update(chunk)
                                progress(copied)
                                if cancel_event.is_set():
                                    raise asyncio.CancelledError
                            writer.flush()
                            os.fsync(writer.fileno())
                        break
                else:
                    raise EngineInstallationError("direct model redirect chain did not terminate")
            if copied != descriptor.bytes:
                raise EngineInstallationError("direct model file byte count does not match catalog")
            if digest.hexdigest() != descriptor.sha256:
                raise EngineInstallationError("direct model file checksum does not match catalog")
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


def _entry_size_limit(
    _descriptor: EngineArtifactDescriptor,
    _path: str,
) -> int:
    return MAX_SINGLE_EXTRACTED_FILE_BYTES


def _validate_files_manifest(
    manifest_bytes: bytes,
    infos: dict[str, zipfile.ZipInfo],
    descriptor: EngineArtifactDescriptor,
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
            or size > _entry_size_limit(descriptor, normalized)
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
                if info.file_size > _entry_size_limit(descriptor, normalized):
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
            expected = _validate_files_manifest(manifest_bytes, infos, descriptor)
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
        if not isinstance(raw, dict) or set(raw) != {"path", "bytes", "sha256"}:
            raise EngineInstallationError("installed engine manifest entry is invalid")
        relative = _validated_zip_path(str(raw.get("path", ""))).as_posix()
        path = root.joinpath(*PurePosixPath(relative).parts)
        if not path.is_file() or path.is_symlink():
            raise EngineInstallationError("installed engine file is missing or unsafe")
        size = raw.get("bytes")
        digest = raw.get("sha256")
        if (
            not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or size > _entry_size_limit(descriptor, relative)
            or not isinstance(digest, str)
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
        ):
            raise EngineInstallationError("installed engine manifest size/checksum is invalid")
        if path.stat().st_size != size or sha256_file(path) != digest:
            raise EngineInstallationError("installed engine file checksum changed")
        expected_paths.add(relative)
        total += path.stat().st_size
    actual_paths = {item.relative_to(root).as_posix() for item in root.rglob("*") if item.is_file()}
    if actual_paths != expected_paths or total != descriptor.extracted_bytes:
        raise EngineInstallationError("installed engine files do not match catalog")


def verify_direct_model_files(
    root: Path,
    descriptor: EngineModelDeliveryDescriptor,
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
        if path.stat().st_size != item.bytes or sha256_file(path) != item.sha256:
            raise EngineInstallationError("installed direct model file checksum changed")
        if item.bytes > MAX_SINGLE_EXTRACTED_FILE_BYTES:
            raise EngineInstallationError(
                "installed direct file exceeds the 2 GiB single-file limit"
            )
        total += item.bytes
        if total > MAX_TOTAL_EXTRACTED_BYTES:
            raise EngineInstallationError("installed direct models exceed aggregate limit")
    if total != descriptor.extracted_bytes:
        raise EngineInstallationError("installed direct model bytes do not match catalog")


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
        model_downloader: ModelFileDownloader | None = None,
    ) -> None:
        self.root = root
        self.catalog = catalog
        self.worker_client = worker_client
        self.downloader = downloader or HttpArtifactDownloader()
        self.model_downloader = model_downloader or HttpModelFileDownloader()
        self._smoke_worker_mirror_url = _smoke_worker_mirror_url()
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
        worker_descriptor = requirement.worker_artifact()
        model_descriptor = requirement.model_delivery()
        expected_digests = {
            "worker": worker_descriptor.sha256,
            "model": model_descriptor.manifest_sha256,
        }
        if {item.role: item.sha256 for item in state.activated_artifacts} != expected_digests:
            return None
        version_root = self._requirement_root(requirement_id) / "versions" / state.artifact_version
        worker_root = version_root / "worker"
        model_root = version_root / "model"
        try:
            verify_extracted_artifact(worker_root, worker_descriptor)
            verify_direct_model_files(model_root, model_descriptor)
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
        requirement_root = self._requirement_root(requirement.requirement_id)
        self._remove_stale_install_residue(requirement_root)
        if self.active_engine(requirement.requirement_id) is not None:
            report_progress(1)
            return
        staging = requirement_root / ".staging" / uuid4().hex
        version = requirement_root / "versions" / requirement.artifact_version
        new_version = (
            requirement_root / "versions" / f".{requirement.artifact_version}.{uuid4().hex}"
        )
        previous_version = requirement_root / f".previous-{uuid4().hex}"
        staging.mkdir(parents=True)
        new_version.parent.mkdir(parents=True, exist_ok=True)
        activated = False
        try:
            worker_descriptor = requirement.worker_artifact()
            model_descriptor = requirement.model_delivery()
            worker_archive = staging / worker_descriptor.file_name

            def worker_progress(copied: int) -> None:
                report_progress(0.25 * (copied / worker_descriptor.bytes))

            # Keep the catalog descriptor (and therefore all integrity checks)
            # untouched. Only the transport URL is mapped for the explicit local
            # smoke opt-in; model delivery continues to use its locked HTTPS URLs.
            download_descriptor = (
                replace(
                    worker_descriptor,
                    url=f"{self._smoke_worker_mirror_url}/{worker_descriptor.file_name}",
                )
                if self._smoke_worker_mirror_url is not None
                else worker_descriptor
            )
            await self.downloader.download(
                download_descriptor,
                worker_archive,
                cancel_event=cancel_event,
                progress=worker_progress,
            )
            safe_extract_artifact(
                worker_archive,
                new_version / "worker",
                worker_descriptor,
                cancel_event=cancel_event,
            )
            probe_engine = InstalledEngine(
                requirement_id=requirement.requirement_id,
                artifact_version=requirement.artifact_version,
                executable=self._resolved_child(
                    new_version / "worker", worker_descriptor.entry_point
                ),
                model_dir=new_version / "model" / model_descriptor.entry_point,
            )
            try:
                code_probe = await self.worker_client.probe(
                    probe_engine,
                    include_model=False,
                    options=probe_options,
                )
            except asyncio.CancelledError:
                raise
            except WorkerExecutionError as error:
                raise EngineInstallationError(
                    f"engine worker code probe failed: {error}"
                ) from error
            except Exception as error:
                raise EngineInstallationError("engine worker code probe failed") from error
            if not code_probe.code_ready:
                raise EngineInstallationError(
                    f"engine worker code probe failed: {code_probe.detail}"
                )
            report_progress(0.35)

            model_root = new_version / "model"
            model_root.mkdir()
            completed_model_bytes = 0
            for file_descriptor in model_descriptor.files:
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                destination = self._resolved_child(model_root, file_descriptor.path)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists() or destination.is_symlink():
                    raise EngineInstallationError(
                        "direct model destination already exists or is unsafe"
                    )

                def model_progress(
                    copied: int,
                    *,
                    completed: int = completed_model_bytes,
                ) -> None:
                    report_progress(
                        0.35 + 0.5 * ((completed + copied) / model_descriptor.extracted_bytes)
                    )

                await self.model_downloader.download(
                    file_descriptor,
                    destination,
                    cancel_event=cancel_event,
                    progress=model_progress,
                )
                completed_model_bytes += file_descriptor.bytes
            verify_direct_model_files(model_root, model_descriptor)
            report_progress(0.85)
            engine = InstalledEngine(
                requirement_id=requirement.requirement_id,
                artifact_version=requirement.artifact_version,
                executable=self._resolved_child(
                    new_version / "worker", worker_descriptor.entry_point
                ),
                model_dir=self._resolved_child(model_root, model_descriptor.entry_point),
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
                activated_artifacts=(
                    ActivatedArtifact("worker", worker_descriptor.sha256),
                    ActivatedArtifact("model", model_descriptor.manifest_sha256),
                ),
            )
            if version.exists():
                os.replace(version, previous_version)
            try:
                os.replace(new_version, version)
                _atomic_write_json(requirement_root / "active.json", state.to_dict())
            except BaseException:
                shutil.rmtree(version, ignore_errors=True)
                if previous_version.exists():
                    os.replace(previous_version, version)
                raise
            if previous_version.exists():
                shutil.rmtree(previous_version, ignore_errors=True)
            activated = True
            report_progress(1)
            self._remove_inactive_versions(requirement_root, requirement.artifact_version)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
            if not activated:
                shutil.rmtree(new_version, ignore_errors=True)
                if previous_version.exists() and not version.exists():
                    os.replace(previous_version, version)

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

    @staticmethod
    def _is_reparse_point(path: Path, metadata: os.stat_result) -> bool:
        reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
        return stat.S_ISLNK(metadata.st_mode) or bool(
            getattr(metadata, "st_file_attributes", 0) & reparse_flag
        )

    @classmethod
    def _remove_residue_path(cls, path: Path) -> None:
        try:
            metadata = path.lstat()
        except FileNotFoundError:
            return
        try:
            if cls._is_reparse_point(path, metadata):
                if stat.S_ISDIR(metadata.st_mode):
                    os.rmdir(path)
                else:
                    path.unlink()
            elif stat.S_ISDIR(metadata.st_mode):
                shutil.rmtree(path)
            else:
                path.unlink()
        except OSError as error:
            raise EngineInstallationError(
                f"stale engine install residue could not be removed: {path.name}"
            ) from error

    @staticmethod
    def _is_temporary_version_name(name: str) -> bool:
        if not name.startswith("."):
            return False
        version, separator, identifier = name[1:].rpartition(".")
        return (
            separator == "."
            and bool(version)
            and version[0].isascii()
            and version[0].isalnum()
            and all(
                character.isascii() and (character.isalnum() or character in {".", "-", "_", "+"})
                for character in version
            )
            and len(identifier) == 32
            and all(character in "0123456789abcdef" for character in identifier)
        )

    @classmethod
    def _remove_stale_install_residue(cls, root: Path) -> None:
        for item in root.glob(".previous-*"):
            if item.name.startswith(".previous-") and len(item.name) == len(".previous-") + 32:
                cls._remove_residue_path(item)
        staging = root / ".staging"
        versions = root / "versions"
        for directory, is_owned_name in (
            (
                staging,
                lambda name: (
                    len(name) == 32 and all(character in "0123456789abcdef" for character in name)
                ),
            ),
            (versions, cls._is_temporary_version_name),
        ):
            try:
                metadata = directory.lstat()
            except FileNotFoundError:
                continue
            if cls._is_reparse_point(directory, metadata) or not stat.S_ISDIR(metadata.st_mode):
                raise EngineInstallationError(
                    f"engine install residue root is unsafe: {directory.name}"
                )
            for item in directory.iterdir():
                if is_owned_name(item.name):
                    cls._remove_residue_path(item)


__all__ = [
    "EngineInstallBusyError",
    "EngineInstallationError",
    "EngineInstallationManager",
    "HttpArtifactDownloader",
    "safe_extract_artifact",
    "sha256_file",
    "verify_extracted_artifact",
]
