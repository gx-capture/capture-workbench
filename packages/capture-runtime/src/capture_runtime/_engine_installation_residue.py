"""Internal cleanup and path-safety helpers for engine installation roots."""

from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path, PurePosixPath

from ._engine_installation_errors import EngineInstallationError


def resolved_child(root: Path, relative: str) -> Path:
    candidate = root.joinpath(*PurePosixPath(relative).parts).resolve()
    resolved_root = root.resolve()
    if candidate != resolved_root and resolved_root not in candidate.parents:
        raise EngineInstallationError("engine path escaped its version root")
    return candidate


def remove_inactive_versions(root: Path, active_version: str) -> None:
    versions = root / "versions"
    if not versions.is_dir():
        return
    for item in versions.iterdir():
        if item.is_dir() and item.name != active_version and not item.name.startswith("."):
            shutil.rmtree(item, ignore_errors=True)


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
        raise EngineInstallationError(
            f"stale engine install residue could not be removed: {path.name}"
        ) from error


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
    "remove_residue_path",
    "remove_stale_install_residue",
    "resolved_child",
]
