"""Checksum-pinned optional engine download, extraction, and activation."""

from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from threading import Lock
from uuid import uuid4

from capture_runtime.engine_catalog import (
    ActivatedArtifact,
    ActiveEngineState,
    EngineArtifactDescriptor,
    EngineCatalog,
    EngineCatalogError,
    EngineModelDeliveryDescriptor,
    EngineRequirementDescriptor,
)
from capture_runtime.worker_client import InstalledEngine, WorkerClient, WorkerProbeResult
from capture_runtime.worker_process import WorkerExecutionError

from . import _engine_installation_limits as _installation_limits
from ._engine_installation_activation import (
    InstalledFileSnapshot as _InstalledFileSnapshot,
)
from ._engine_installation_activation import (
    activate_version as _activate_version_impl,
)
from ._engine_installation_activation import (
    atomic_write_json as _atomic_write_json_impl,
)
from ._engine_installation_activation import (
    cleanup_install_attempt as _cleanup_install_attempt_impl,
)
from ._engine_installation_activation import (
    installed_engine_snapshot as _installed_engine_snapshot_impl,
)
from ._engine_installation_artifacts import (
    ArtifactValidationLimits,
)
from ._engine_installation_artifacts import (
    safe_extract_artifact as _safe_extract_artifact_impl,
)
from ._engine_installation_artifacts import (
    sha256_file as _sha256_file_impl,
)
from ._engine_installation_artifacts import (
    verify_direct_model_files as _verify_direct_model_files_impl,
)
from ._engine_installation_artifacts import (
    verify_extracted_artifact as _verify_extracted_artifact_impl,
)
from ._engine_installation_download import (
    ArtifactDownloader,
    HttpArtifactDownloader,
    HttpModelFileDownloader,
    ModelFileDownloader,
)
from ._engine_installation_download import (
    smoke_worker_mirror_url as _smoke_worker_mirror_url_impl,
)
from ._engine_installation_errors import (
    EngineInstallationError,
    EngineInstallBusyError,
    EngineResolutionTimeoutError,
)
from ._engine_installation_lock import ExclusiveInstallFile
from ._engine_installation_residue import (
    is_reparse_point as _is_reparse_point_impl,
)
from ._engine_installation_residue import (
    is_temporary_version_name as _is_temporary_version_name_impl,
)
from ._engine_installation_residue import (
    remove_inactive_versions as _remove_inactive_versions_impl,
)
from ._engine_installation_residue import (
    remove_residue_path as _remove_residue_path_impl,
)
from ._engine_installation_residue import (
    remove_stale_install_residue as _remove_stale_install_residue_impl,
)
from ._engine_installation_residue import (
    resolved_child as _resolved_child_impl,
)

DEFAULT_ACTIVE_ENGINE_RESOLUTION_TIMEOUT_SECONDS = (
    _installation_limits.DEFAULT_ACTIVE_ENGINE_RESOLUTION_TIMEOUT_SECONDS
)
DOWNLOAD_CHUNK_BYTES = _installation_limits.DOWNLOAD_CHUNK_BYTES
FILES_MANIFEST_NAME = _installation_limits.FILES_MANIFEST_NAME
MAX_ARCHIVE_FILES = _installation_limits.MAX_ARCHIVE_FILES
MAX_COMPRESSION_RATIO = _installation_limits.MAX_COMPRESSION_RATIO
MAX_DIRECT_MODEL_REDIRECTS = _installation_limits.MAX_DIRECT_MODEL_REDIRECTS
MAX_FILES_MANIFEST_BYTES = _installation_limits.MAX_FILES_MANIFEST_BYTES
MAX_SINGLE_EXTRACTED_FILE_BYTES = _installation_limits.MAX_SINGLE_EXTRACTED_FILE_BYTES
MAX_TOTAL_EXTRACTED_BYTES = _installation_limits.MAX_TOTAL_EXTRACTED_BYTES
WINDOWS_FORBIDDEN_PATH_CHARACTERS = _installation_limits.WINDOWS_FORBIDDEN_PATH_CHARACTERS
WINDOWS_RESERVED_DEVICE_BASENAMES = _installation_limits.WINDOWS_RESERVED_DEVICE_BASENAMES

_SMOKE_WORKER_MIRROR_OPT_IN = "CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN"
_SMOKE_WORKER_MIRROR_URL = "CAPTURE_SMOKE_WORKER_MIRROR_URL"
_ExclusiveInstallFile = ExclusiveInstallFile


@dataclass(frozen=True, slots=True)
class _VerifiedActiveEngine:
    state: ActiveEngineState
    engine: InstalledEngine
    files: _InstalledFileSnapshot


def _smoke_worker_mirror_url(environ: dict[str, str] | None = None) -> str | None:
    return _smoke_worker_mirror_url_impl(environ)


def _artifact_validation_limits() -> ArtifactValidationLimits:
    return ArtifactValidationLimits(
        max_archive_files=MAX_ARCHIVE_FILES,
        max_single_extracted_file_bytes=MAX_SINGLE_EXTRACTED_FILE_BYTES,
        max_total_extracted_bytes=MAX_TOTAL_EXTRACTED_BYTES,
        max_compression_ratio=MAX_COMPRESSION_RATIO,
        files_manifest_name=FILES_MANIFEST_NAME,
        max_files_manifest_bytes=MAX_FILES_MANIFEST_BYTES,
        download_chunk_bytes=DOWNLOAD_CHUNK_BYTES,
    )


def sha256_file(path: Path) -> str:
    return _sha256_file_impl(path, chunk_bytes=DOWNLOAD_CHUNK_BYTES)


def _entry_size_limit(_descriptor: EngineArtifactDescriptor, _path: str) -> int:
    return MAX_SINGLE_EXTRACTED_FILE_BYTES


def safe_extract_artifact(
    archive: Path,
    destination: Path,
    descriptor: EngineArtifactDescriptor,
    *,
    cancel_event: asyncio.Event,
) -> None:
    _safe_extract_artifact_impl(
        archive,
        destination,
        descriptor,
        cancel_event=cancel_event,
        limits=_artifact_validation_limits(),
    )


def verify_extracted_artifact(root: Path, descriptor: EngineArtifactDescriptor) -> None:
    _verify_extracted_artifact_impl(
        root,
        descriptor,
        limits=_artifact_validation_limits(),
    )


def verify_direct_model_files(
    root: Path,
    descriptor: EngineModelDeliveryDescriptor,
) -> None:
    _verify_direct_model_files_impl(
        root,
        descriptor,
        limits=_artifact_validation_limits(),
    )


def _installed_engine_snapshot(
    worker_root: Path, model_root: Path
) -> _InstalledFileSnapshot | None:
    return _installed_engine_snapshot_impl(worker_root, model_root)


def _atomic_write_json(path: Path, payload: object) -> None:
    _atomic_write_json_impl(path, payload)


def _activate_version(
    *,
    version: Path,
    new_version: Path,
    previous_version: Path,
    active_state_path: Path,
    state: ActiveEngineState,
) -> None:
    _activate_version_impl(
        version=version,
        new_version=new_version,
        previous_version=previous_version,
        active_state_path=active_state_path,
        state=state,
        write_state=_atomic_write_json,
    )


def _cleanup_install_attempt(
    *,
    staging: Path,
    new_version: Path,
    previous_version: Path,
    version: Path,
    activated: bool,
) -> None:
    _cleanup_install_attempt_impl(
        staging=staging,
        new_version=new_version,
        previous_version=previous_version,
        version=version,
        activated=activated,
    )


class EngineInstallationManager:
    def __init__(
        self,
        root: Path,
        catalog: EngineCatalog,
        *,
        worker_client: WorkerClient,
        downloader: ArtifactDownloader | None = None,
        model_downloader: ModelFileDownloader | None = None,
        active_engine_resolution_timeout_seconds: float = (
            DEFAULT_ACTIVE_ENGINE_RESOLUTION_TIMEOUT_SECONDS
        ),
    ) -> None:
        if not 0 < active_engine_resolution_timeout_seconds <= 300:
            raise ValueError("active engine resolution timeout must be between 0 and 300 seconds")
        self.root = root
        self.catalog = catalog
        self.worker_client = worker_client
        self.downloader = downloader or HttpArtifactDownloader()
        self.model_downloader = model_downloader or HttpModelFileDownloader()
        self._smoke_worker_mirror_url = _smoke_worker_mirror_url()
        self._locks: dict[str, asyncio.Lock] = {}
        self._verified_active_engines: dict[str, _VerifiedActiveEngine] = {}
        self._verified_active_engines_lock = Lock()
        self._active_engine_resolution_timeout_seconds = active_engine_resolution_timeout_seconds

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
        files_before_verification = _installed_engine_snapshot(worker_root, model_root)
        with self._verified_active_engines_lock:
            cached = self._verified_active_engines.get(requirement_id)
        if (
            cached is not None
            and cached.state == state
            and cached.files == files_before_verification
            and cached.engine.executable.is_file()
            and cached.engine.model_dir.is_dir()
        ):
            return cached.engine
        try:
            verify_extracted_artifact(worker_root, worker_descriptor)
            verify_direct_model_files(model_root, model_descriptor)
        except EngineInstallationError:
            return None
        files_after_verification = _installed_engine_snapshot(worker_root, model_root)
        if (
            files_before_verification is None
            or files_after_verification != files_before_verification
        ):
            return None
        executable = self._resolved_child(self._requirement_root(requirement_id), state.entry_point)
        model_dir = self._resolved_child(model_root, model_descriptor.entry_point)
        if not executable.is_file() or not model_dir.is_dir():
            return None
        engine = InstalledEngine(
            requirement_id=requirement_id,
            artifact_version=state.artifact_version,
            executable=executable,
            model_dir=model_dir,
        )
        with self._verified_active_engines_lock:
            self._verified_active_engines[requirement_id] = _VerifiedActiveEngine(
                state=state,
                engine=engine,
                files=files_after_verification,
            )
        return engine

    async def resolve_active_engine(self, requirement_id: str) -> InstalledEngine | None:
        """Resolve and cold-verify an engine without blocking the runtime event loop."""

        try:
            async with asyncio.timeout(self._active_engine_resolution_timeout_seconds):
                return await asyncio.to_thread(self.active_engine, requirement_id)
        except TimeoutError as error:
            raise EngineResolutionTimeoutError(
                f"active engine resolution timed out for requirement {requirement_id}"
            ) from error

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
        # On a first install there is no active version to preserve. Probe the
        # candidate at its final path and activate by writing active.json only;
        # this avoids a transient Windows directory rename denial when a native
        # worker or endpoint scanner still holds a handle in the candidate tree.
        # Upgrades retain the hidden-directory swap so the previous version can
        # be rolled back atomically.
        new_version = (
            version
            if not version.exists()
            else requirement_root / "versions" / f".{requirement.artifact_version}.{uuid4().hex}"
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
            # The post-install probe may load native OCR DLLs in a packaged
            # worker. Ensure every process handle is released before Windows
            # attempts the atomic version swap below.
            await self.worker_client.shutdown()
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
            activation_error: OSError | None = None
            for activation_attempt in range(3):
                try:
                    _activate_version(
                        version=version,
                        new_version=new_version,
                        previous_version=previous_version,
                        active_state_path=requirement_root / "active.json",
                        state=state,
                    )
                    activation_error = None
                    break
                except OSError as error:
                    activation_error = error
                    operation = getattr(error, "activation_operation", None)
                    if operation not in {"move_existing_version", "move_new_version"}:
                        raise
                    if activation_attempt == 2:
                        raise
                    await asyncio.sleep(1)
            if activation_error is not None:
                raise activation_error
            activated = True
            active_engine = InstalledEngine(
                requirement_id=requirement.requirement_id,
                artifact_version=requirement.artifact_version,
                executable=self._resolved_child(version / "worker", worker_descriptor.entry_point),
                model_dir=self._resolved_child(version / "model", model_descriptor.entry_point),
            )
            installed_files = _installed_engine_snapshot(version / "worker", version / "model")
            if installed_files is not None:
                with self._verified_active_engines_lock:
                    self._verified_active_engines[requirement.requirement_id] = (
                        _VerifiedActiveEngine(
                            state=state,
                            engine=active_engine,
                            files=installed_files,
                        )
                    )
            report_progress(1)
            self._remove_inactive_versions(requirement_root, requirement.artifact_version)
        finally:
            _cleanup_install_attempt(
                staging=staging,
                new_version=new_version,
                previous_version=previous_version,
                version=version,
                activated=activated,
            )

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
        return _resolved_child_impl(root, relative)

    @staticmethod
    def _remove_inactive_versions(root: Path, active_version: str) -> None:
        _remove_inactive_versions_impl(root, active_version)

    @staticmethod
    def _is_reparse_point(path: Path, metadata: os.stat_result) -> bool:
        return _is_reparse_point_impl(path, metadata)

    @classmethod
    def _remove_residue_path(cls, path: Path) -> None:
        _remove_residue_path_impl(path)

    @staticmethod
    def _is_temporary_version_name(name: str) -> bool:
        return _is_temporary_version_name_impl(name)

    @classmethod
    def _remove_stale_install_residue(cls, root: Path) -> None:
        _remove_stale_install_residue_impl(root)


__all__ = [
    "EngineInstallBusyError",
    "EngineInstallationError",
    "EngineInstallationManager",
    "EngineResolutionTimeoutError",
    "HttpArtifactDownloader",
    "safe_extract_artifact",
    "sha256_file",
    "verify_extracted_artifact",
]
