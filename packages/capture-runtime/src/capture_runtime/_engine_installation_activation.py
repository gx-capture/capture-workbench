"""Internal active-version swap, rollback, and verification snapshot logic."""

from __future__ import annotations

import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from capture_runtime.engine_catalog import ActiveEngineState, canonical_json_bytes

type InstalledFileSnapshot = tuple[tuple[str, int, int, int], ...]


class ActivationFilesystemError(OSError):
    """A filesystem failure with a safe activation operation label."""

    def __init__(self, operation: str, cause: OSError) -> None:
        super().__init__(f"activation_{operation}")
        self.activation_operation = operation
        if isinstance(cause.errno, int):
            self.errno = cause.errno
        if isinstance(getattr(cause, "winerror", None), int):
            self.winerror = cause.winerror


def installed_engine_snapshot(worker_root: Path, model_root: Path) -> InstalledFileSnapshot | None:
    files: list[tuple[str, int, int, int]] = []
    try:
        for role, root in (("worker", worker_root), ("model", model_root)):
            if not root.is_dir() or root.is_symlink():
                return None
            for path in root.rglob("*"):
                if path.is_symlink():
                    return None
                if not path.is_file():
                    continue
                metadata = path.stat()
                files.append(
                    (
                        f"{role}/{path.relative_to(root).as_posix()}",
                        metadata.st_size,
                        metadata.st_mtime_ns,
                        metadata.st_ctime_ns,
                    )
                )
    except (OSError, RuntimeError):
        return None
    return tuple(sorted(files))


def atomic_write_json(path: Path, payload: object) -> None:
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


def activate_version(
    *,
    version: Path,
    new_version: Path,
    previous_version: Path,
    active_state_path: Path,
    state: ActiveEngineState,
    write_state: Callable[[Path, object], None],
) -> None:
    if new_version == version:
        write_state(active_state_path, state.to_dict())
        return
    if version.exists():
        try:
            os.replace(version, previous_version)
        except OSError as error:
            raise ActivationFilesystemError("move_existing_version", error) from error
    try:
        try:
            os.replace(new_version, version)
        except OSError as error:
            raise ActivationFilesystemError("move_new_version", error) from error
        write_state(active_state_path, state.to_dict())
    except BaseException:
        shutil.rmtree(version, ignore_errors=True)
        if previous_version.exists():
            os.replace(previous_version, version)
        raise
    if previous_version.exists():
        shutil.rmtree(previous_version, ignore_errors=True)


def cleanup_install_attempt(
    *,
    staging: Path,
    new_version: Path,
    previous_version: Path,
    version: Path,
    activated: bool,
) -> None:
    shutil.rmtree(staging, ignore_errors=True)
    if not activated:
        shutil.rmtree(new_version, ignore_errors=True)
        if previous_version.exists() and not version.exists():
            os.replace(previous_version, version)


__all__ = [
    "InstalledFileSnapshot",
    "activate_version",
    "atomic_write_json",
    "cleanup_install_attempt",
    "installed_engine_snapshot",
]
