"""Install units that are models only and run inside another unit's worker.

A model unit has no worker to download, probe or start, so it does not go
through the engine activation path: its files are downloaded beside the final
location, verified against the catalog, and moved into place in one rename.
"""

from __future__ import annotations

import asyncio
import json
import shutil
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from capture_runtime.file_lock import replace_with_retry
from capture_runtime.install_progress import DownloadedBytes, DownloadProgress
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    EngineCatalogError,
    EngineModelDeliveryDescriptor,
    EngineRequirementDescriptor,
)

from ._engine_installation_activation import (
    VERIFICATION_RECORD_NAME,
    discard_verification_record,
    matches_verification_record,
    verification_record,
    write_verification_record,
)
from ._engine_installation_artifacts import verify_direct_model_files
from ._engine_installation_download import (
    ModelFileDownloader,
    _cancellable_file_operation,
    _commit_operation,
    _file_operation,
)
from ._engine_installation_errors import EngineInstallationError
from ._engine_installation_residue import remove_inactive_versions
from ._install_stop import InstallStop

STATE_FILE_NAME = "active-model.json"
STATE_VERSION = "1"

ModelUnitSnapshot = tuple[tuple[str, int, int, int], ...]


def _delivery(requirement: EngineRequirementDescriptor) -> EngineModelDeliveryDescriptor:
    if not requirement.model_only:
        raise EngineCatalogError(f"{requirement.requirement_id} is not a model unit")
    return requirement.model_delivery()


def _model_root(root: Path, delivery: EngineModelDeliveryDescriptor) -> Path:
    return root / "versions" / delivery.artifact_version / "model"


def _verification_record_path(root: Path, delivery: EngineModelDeliveryDescriptor) -> Path:
    # Beside the version's model directory, outside the files it describes, and
    # removed with the version, so a verification that finishes after an
    # uninstall cannot write it back.
    return root / "versions" / delivery.artifact_version / VERIFICATION_RECORD_NAME


def _model_unit_state(requirement: EngineRequirementDescriptor) -> dict[str, str]:
    delivery = _delivery(requirement)
    return {
        "stateVersion": STATE_VERSION,
        "requirementId": requirement.requirement_id,
        "artifactVersion": delivery.artifact_version,
        "manifestSha256": delivery.manifest_sha256,
    }


def model_unit_snapshot(root: Path, requirement: EngineRequirementDescriptor) -> ModelUnitSnapshot:
    """Paths, sizes, modification times and Windows creation times; cheap to compare."""

    return _model_files_snapshot(_model_root(root, _delivery(requirement)))


def _model_files_snapshot(model_root: Path) -> ModelUnitSnapshot:
    files: list[tuple[str, int, int, int]] = []
    try:
        if not model_root.is_dir() or model_root.is_symlink():
            return ()
        for path in model_root.rglob("*"):
            if path.is_symlink():
                return ()
            if path.is_file():
                stat = path.stat()
                files.append(
                    (
                        path.relative_to(model_root).as_posix(),
                        stat.st_size,
                        stat.st_mtime_ns,
                        stat.st_ctime_ns,
                    )
                )
        return tuple(sorted(files))
    except (OSError, RuntimeError):
        return ()


def model_unit_state(root: Path) -> str:
    """The raw state file, to notice a reinstall between two cheap checks."""

    try:
        return (root / STATE_FILE_NAME).read_text(encoding="utf-8")
    except OSError:
        return ""


def requirement_model_dir(root: Path, requirement: EngineRequirementDescriptor) -> Path:
    delivery = _delivery(requirement)
    return _model_root(root, delivery) / delivery.entry_point


def active_model_unit_dir(root: Path, requirement: EngineRequirementDescriptor) -> Path | None:
    """The unit's model directory when the catalog's exact files are installed."""

    delivery = _delivery(requirement)
    try:
        state = json.loads((root / STATE_FILE_NAME).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if state != _model_unit_state(requirement):
        return None
    model_root = _model_root(root, delivery)
    record_path = _verification_record_path(root, delivery)
    files = model_unit_snapshot(root, requirement)
    record = verification_record({**state, "modelDelivery": delivery.to_dict()}, files or None)
    record_matches = matches_verification_record(record_path, record)
    if not record_matches:
        discard_verification_record(record_path)
        try:
            verify_direct_model_files(model_root, delivery)
        except EngineInstallationError:
            return None
    if not files or model_unit_snapshot(root, requirement) != files:
        discard_verification_record(record_path)
        return None
    model_dir = model_root / delivery.entry_point
    if not model_dir.is_dir():
        return None
    if not record_matches:
        write_verification_record(record_path, record)
    return model_dir


async def install_model_unit(
    root: Path,
    requirement: EngineRequirementDescriptor,
    downloader: ModelFileDownloader,
    *,
    cancel_event: asyncio.Event,
    report_progress: Callable[[float], None],
    report_download: DownloadProgress | None = None,
) -> None:
    delivery = _delivery(requirement)
    final = root / "versions" / delivery.artifact_version
    staging = root / "versions" / f".{delivery.artifact_version}.{uuid4().hex}"
    model_root = staging / "model"
    model_root.mkdir(parents=True)
    try:
        completed = 0
        for descriptor in delivery.files:
            if cancel_event.is_set():
                raise asyncio.CancelledError
            destination = (model_root / descriptor.path).resolve()
            if not destination.is_relative_to(model_root.resolve()):
                raise EngineInstallationError("direct model destination is unsafe")
            destination.parent.mkdir(parents=True, exist_ok=True)

            def progress(copied: int, *, done: int = completed) -> None:
                report_progress(0.95 * (done + copied) / delivery.extracted_bytes)
                if report_download is not None:
                    total = delivery.extracted_bytes
                    report_download(DownloadedBytes(min(done + copied, total), total))

            await downloader.download(
                descriptor, destination, cancel_event=cancel_event, progress=progress
            )
            completed += descriptor.bytes
        # Hashing and deleting gigabytes run in a worker thread so that the
        # event loop keeps answering requests, installation status included.
        stop = InstallStop(cancel_event)
        await _cancellable_file_operation(
            stop, verify_direct_model_files, model_root, delivery, cancel_event=stop
        )
        verified_files = await _file_operation(_model_files_snapshot, model_root)
        state = _model_unit_state(requirement)
        if cancel_event.is_set():
            raise asyncio.CancelledError
        state_path = root / STATE_FILE_NAME
        # Without its state file the previous copy is no longer active, so it can
        # be replaced; the new copy becomes active only once its state is written.
        for record_path in (root / "versions").glob(f"*/{VERIFICATION_RECORD_NAME}"):
            discard_verification_record(record_path)
        state_path.unlink(missing_ok=True)
        if final.exists():
            await _file_operation(shutil.rmtree, final)
        await _file_operation(replace_with_retry, staging, final)
        if cancel_event.is_set():
            raise asyncio.CancelledError
        pending = state_path.with_suffix(f".{uuid4().hex}.tmp")
        pending.write_text(
            json.dumps(
                state,
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        try:
            await _commit_operation(replace_with_retry, pending, state_path)
        finally:
            pending.unlink(missing_ok=True)
        files = model_unit_snapshot(root, requirement)
        if files and files == verified_files:
            await _commit_operation(
                write_verification_record,
                _verification_record_path(root, delivery),
                verification_record(
                    {**state, "modelDelivery": delivery.to_dict()},
                    files,
                ),
            )
        # The state file makes the unit active; a cancel after it is too late.
        report_progress(1)
        await _commit_operation(remove_inactive_versions, root, delivery.artifact_version)
    finally:
        # Left behind only by a cancel or a failure: the files it holds can be
        # gigabytes. The drain finishes the removal before a cancel propagates.
        if staging.exists():
            await _file_operation(shutil.rmtree, staging, ignore_errors=True)


__all__ = [
    "ModelUnitSnapshot",
    "active_model_unit_dir",
    "install_model_unit",
    "model_unit_snapshot",
    "model_unit_state",
    "requirement_model_dir",
]
