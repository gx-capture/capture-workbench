"""Install units that are models only and run inside another unit's worker.

A model unit has no worker to download, probe or start, so it does not go
through the engine activation path: its files are downloaded beside the final
location, verified against the catalog, and moved into place in one rename.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from collections.abc import Callable
from pathlib import Path
from uuid import uuid4

from capture_runtime.engine_catalog import (
    EngineCatalogError,
    EngineModelDeliveryDescriptor,
    EngineRequirementDescriptor,
)

from ._engine_installation_artifacts import verify_direct_model_files
from ._engine_installation_download import ModelFileDownloader
from ._engine_installation_errors import EngineInstallationError

STATE_FILE_NAME = "active-model.json"
STATE_VERSION = "1"

ModelUnitSnapshot = tuple[tuple[str, int, int], ...]


def _delivery(requirement: EngineRequirementDescriptor) -> EngineModelDeliveryDescriptor:
    if not requirement.model_only:
        raise EngineCatalogError(f"{requirement.requirement_id} is not a model unit")
    return requirement.model_delivery()


def _model_root(root: Path, delivery: EngineModelDeliveryDescriptor) -> Path:
    return root / "versions" / delivery.artifact_version / "model"


def model_unit_snapshot(root: Path, requirement: EngineRequirementDescriptor) -> ModelUnitSnapshot:
    """Names, sizes and modification times of the installed files; cheap to compare."""

    model_root = _model_root(root, _delivery(requirement))
    try:
        return tuple(
            sorted(
                (path.relative_to(model_root).as_posix(), stat.st_size, stat.st_mtime_ns)
                for path in model_root.rglob("*")
                if path.is_file()
                for stat in (path.stat(),)
            )
        )
    except OSError:
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
    if state != {
        "stateVersion": STATE_VERSION,
        "requirementId": requirement.requirement_id,
        "artifactVersion": delivery.artifact_version,
        "manifestSha256": delivery.manifest_sha256,
    }:
        return None
    model_root = _model_root(root, delivery)
    try:
        verify_direct_model_files(model_root, delivery)
    except EngineInstallationError:
        return None
    model_dir = model_root / delivery.entry_point
    return model_dir if model_dir.is_dir() else None


async def install_model_unit(
    root: Path,
    requirement: EngineRequirementDescriptor,
    downloader: ModelFileDownloader,
    *,
    cancel_event: asyncio.Event,
    report_progress: Callable[[float], None],
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

            await downloader.download(
                descriptor, destination, cancel_event=cancel_event, progress=progress
            )
            completed += descriptor.bytes
        verify_direct_model_files(model_root, delivery)
        if cancel_event.is_set():
            raise asyncio.CancelledError
        state_path = root / STATE_FILE_NAME
        # Without its state file the previous copy is no longer active, so it can
        # be replaced; the new copy becomes active only once its state is written.
        state_path.unlink(missing_ok=True)
        if final.exists():
            shutil.rmtree(final)
        os.replace(staging, final)
        pending = state_path.with_suffix(f".{uuid4().hex}.tmp")
        pending.write_text(
            json.dumps(
                {
                    "stateVersion": STATE_VERSION,
                    "requirementId": requirement.requirement_id,
                    "artifactVersion": delivery.artifact_version,
                    "manifestSha256": delivery.manifest_sha256,
                },
                indent=2,
                sort_keys=True,
            ),
            encoding="utf-8",
        )
        os.replace(pending, state_path)
        report_progress(1)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


__all__ = [
    "ModelUnitSnapshot",
    "active_model_unit_dir",
    "install_model_unit",
    "model_unit_snapshot",
    "model_unit_state",
    "requirement_model_dir",
]
