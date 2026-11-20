"""Internal cleanup and path-safety helpers for engine installation roots."""

from __future__ import annotations

import logging
import os
import shutil
import stat
from pathlib import Path, PurePosixPath

from ._engine_installation_errors import EngineFilesInUseError, EngineInstallationError

_LOGGER = logging.getLogger(__name__)

# ERROR_SHARING_VIOLATION and ERROR_LOCK_VIOLATION: another process holds the
# file open or locked. Other permission errors (an ACL, a read-only file) are not.
_FILE_IN_USE_WINERRORS = frozenset({32, 33})


def resolved_child(root: Path, relative: str) -> Path:
    candidate = root.joinpath(*PurePosixPath(relative).parts).resolve()
    resolved_root = root.resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise EngineInstallationError("engine path escaped its version root")
    return candidate


def remove_inactive_versions(root: Path, active_version: str) -> None:
    versions = root / "versions"
    try:
        metadata = versions.lstat()
        if is_reparse_point(versions, metadata) or not stat.S_ISDIR(metadata.st_mode):
            return
        for item in versions.iterdir():
            if item.name == active_version or item.name.startswith("."):
                continue
            try:
                metadata = item.lstat()
                if is_reparse_point(item, metadata) or not stat.S_ISDIR(metadata.st_mode):
                    continue
                _remove_retired_engine_tree(item)
            except (EngineInstallationError, OSError):
                # Activation is committed; a locked old version can be retried later.
                continue
    except OSError:
        # Cleanup must not fail an already active installation.
        return


def is_reparse_point(path: Path, metadata: os.stat_result) -> bool:
    reparse_flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISLNK(metadata.st_mode) or bool(
        getattr(metadata, "st_file_attributes", 0) & reparse_flag
    )


def remove_residue_path(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    try:
        if is_reparse_point(path, metadata):
            if stat.S_ISDIR(metadata.st_mode):
                os.rmdir(path)
            else:
                path.unlink()
        elif stat.S_ISDIR(metadata.st_mode):
            shutil.rmtree(path)
        else:
            path.unlink()
    except OSError as error:
        if getattr(error, "winerror", None) in _FILE_IN_USE_WINERRORS:
            # Windows refuses to delete a file another process holds open.
            raise EngineFilesInUseError(
                f"engine file is in use and could not be removed: {path.name}"
            ) from error
        raise EngineInstallationError(
            f"stale engine install residue could not be removed: {path.name}"
        ) from error


def _remove_retired_engine_tree(path: Path) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if not is_reparse_point(path, metadata) and stat.S_ISDIR(metadata.st_mode):
        for child in path.iterdir():
            _remove_retired_engine_tree(child)
        path.rmdir()
    else:
        remove_residue_path(path)


def remove_retired_ocr_installation(app_data: Path) -> None:
    """Remove legacy OCR storage while the caller holds the app-data lock."""
    for directory_name in ("engines", "runtime-assets"):
        parent = app_data / directory_name
        try:
            for directory in (app_data, parent):
                try:
                    metadata = directory.lstat()
                except FileNotFoundError:
                    break
                if is_reparse_point(directory, metadata) or not stat.S_ISDIR(metadata.st_mode):
                    raise EngineInstallationError("unsafe legacy OCR storage parent")
            else:
                _remove_retired_engine_tree(parent / "windowsml-ocr")
        except (EngineInstallationError, OSError):
            _LOGGER.warning("Retired OCR cleanup in %s will retry at startup", directory_name)


def is_temporary_version_name(name: str) -> bool:
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


def remove_stale_install_residue(root: Path) -> None:
    for item in root.glob(".previous-*"):
        if item.name.startswith(".previous-") and len(item.name) == len(".previous-") + 32:
            remove_residue_path(item)
    staging = root / ".staging"
    versions = root / "versions"
    for directory, is_owned_name in (
        (
            staging,
            lambda name: (
                len(name) == 32 and all(character in "0123456789abcdef" for character in name)
            ),
        ),
        (versions, is_temporary_version_name),
    ):
        try:
            metadata = directory.lstat()
        except FileNotFoundError:
            continue
        if is_reparse_point(directory, metadata) or not stat.S_ISDIR(metadata.st_mode):
            raise EngineInstallationError(
                f"engine install residue root is unsafe: {directory.name}"
            )
        for item in directory.iterdir():
            if is_owned_name(item.name):
                remove_residue_path(item)


__all__ = [
    "is_reparse_point",
    "is_temporary_version_name",
    "remove_inactive_versions",
    "remove_retired_ocr_installation",
    "remove_residue_path",
    "remove_stale_install_residue",
    "resolved_child",
]
