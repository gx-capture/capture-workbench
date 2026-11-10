"""Remove an installed engine unit and the cached downloads only it used."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from capture_runtime.provisioning.infrastructure.engine_catalog import (
    EngineArtifactDescriptor,
    EngineModelDeliveryDescriptor,
    EngineRequirementDescriptor,
)

from ._engine_download_cache import VerifiedDownloadCache
from ._engine_installation_residue import remove_residue_path
from ._engine_model_units import STATE_FILE_NAME

# The files that make a unit installed: a worker unit's and a models-only unit's.
_INSTALLED_MARKERS = ("active.json", STATE_FILE_NAME)
# The lock file stays: the caller holds it while the unit is removed.
_KEPT_NAMES = frozenset({".install.lock"})


def _delivery_digests(
    artifacts: tuple[EngineArtifactDescriptor, ...],
    model_files: EngineModelDeliveryDescriptor | None,
) -> set[str]:
    digests: set[str] = set()
    for artifact in artifacts:
        digests.add(artifact.sha256)
        digests.update(part.sha256 for part in artifact.parts)
    if model_files is not None:
        digests.update(item.sha256 for item in model_files.files)
    return digests


def download_digests(requirement: EngineRequirementDescriptor) -> frozenset[str]:
    """SHA-256 of every download the cache can hold for a unit.

    A requirement with several contents frees every content, including one
    that was not the content installed on this machine.
    """

    if requirement.contents:
        digests: set[str] = set()
        for content in requirement.contents:
            digests |= _delivery_digests(content.artifacts, content.model_files)
        return frozenset(digests)
    return frozenset(_delivery_digests(requirement.artifacts, requirement.model_files))


def digests_used_only_by(
    requirement: EngineRequirementDescriptor,
    others: Iterable[EngineRequirementDescriptor],
) -> frozenset[str]:
    shared: set[str] = set()
    for other in others:
        if other.requirement_id != requirement.requirement_id:
            shared |= download_digests(other)
    return download_digests(requirement) - shared


def remove_installed_markers(root: Path) -> None:
    """Make the unit not installed; done first, so a crash later leaves it not installed."""

    for marker in _INSTALLED_MARKERS:
        remove_residue_path(root / marker)


def has_unit_files(root: Path) -> bool:
    try:
        return any(item.name not in _KEPT_NAMES for item in root.iterdir())
    except FileNotFoundError:
        return False


def remove_unit_files(root: Path) -> None:
    """Delete every file of the unit except the install lock the caller holds."""

    if not root.is_dir():
        return
    for item in root.iterdir():
        if item.name not in _KEPT_NAMES:
            remove_residue_path(item)


def remove_cached_downloads(
    cache: VerifiedDownloadCache | None,
    requirement: EngineRequirementDescriptor,
    others: Iterable[EngineRequirementDescriptor],
) -> None:
    """Free cached bytes no other catalog entry references; another unit's stay cached."""

    if cache is None:
        return
    for digest in digests_used_only_by(requirement, others):
        cache.remove(digest)


__all__ = [
    "has_unit_files",
    "remove_cached_downloads",
    "remove_installed_markers",
    "remove_unit_files",
]
