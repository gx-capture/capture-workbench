"""Internal active-version swap, rollback, and verification snapshot logic."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from collections.abc import Callable
from pathlib import Path

from capture_runtime.file_lock import replace_with_retry
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    ActiveEngineState,
    canonical_json_bytes,
)

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
    """Size, mtime and ctime of every installed file, or None for a link or an unreadable tree.

    Every requirements read compares this snapshot with the verified one, so it walks with
    os.scandir: on Windows the directory listing already carries each file's size and times,
    so no file is opened again. The tuples are the ones Path.stat gave, so verification
    records written before stay valid.
    """

    files: list[tuple[str, int, int, int]] = []
    try:
        for role, root in (("worker", worker_root), ("model", model_root)):
            if not root.is_dir() or root.is_symlink():
                return None
            pending = [(os.fspath(root), "")]
            while pending:
                directory, prefix = pending.pop()
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if entry.is_symlink():
                            return None
                        relative = f"{prefix}{entry.name}"
                        if entry.is_dir(follow_symlinks=False):
                            pending.append((entry.path, f"{relative}/"))
                        elif entry.is_file(follow_symlinks=False):
                            metadata = entry.stat(follow_symlinks=False)
                            files.append(
                                (
                                    f"{role}/{relative}",
                                    metadata.st_size,
                                    metadata.st_mtime_ns,
                                    metadata.st_ctime_ns,
                                )
                            )
    except (OSError, RuntimeError):
        return None
    return tuple(sorted(files))


VERIFICATION_RECORD_NAME = "verified-files.json"


def verification_record(binding: object, files: InstalledFileSnapshot | None) -> dict[str, object]:
    return {"schemaVersion": "1", "binding": binding, "files": files}


def matches_verification_record(path: Path, payload: dict[str, object]) -> bool:
    if payload["files"] is None:
        return False
    try:
        recorded = json.loads(path.read_text(encoding="utf-8"))
        return canonical_json_bytes(recorded) == canonical_json_bytes(payload)
    except (OSError, ValueError, UnicodeError, RecursionError):
        return False


def discard_verification_record(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        # An unreadable or unwritable record still requires full verification.
        pass


def write_verification_record(path: Path, payload: dict[str, object]) -> None:
    try:
        atomic_write_json(path, payload, create_parent=False)
    except OSError:
        # Persistence is optional: the next process can verify the files again.
        pass


def atomic_write_json(path: Path, payload: object, *, create_parent: bool = True) -> None:
    if create_parent:
        path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as writer:
            writer.write(canonical_json_bytes(payload))
            writer.flush()
            os.fsync(writer.fileno())
        replace_with_retry(temporary, path)
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
            replace_with_retry(version, previous_version)
        except OSError as error:
            raise ActivationFilesystemError("move_existing_version", error) from error
    try:
        try:
            replace_with_retry(new_version, version)
        except OSError as error:
            raise ActivationFilesystemError("move_new_version", error) from error
        try:
            write_state(active_state_path, state.to_dict())
        except BaseException:
            discard_verification_record(version / VERIFICATION_RECORD_NAME)
            raise
    except BaseException:
        shutil.rmtree(version, ignore_errors=True)
        if previous_version.exists():
            replace_with_retry(previous_version, version)
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
        # An open worker handle can prevent removing the rest of the tree.
        discard_verification_record(new_version / VERIFICATION_RECORD_NAME)
        shutil.rmtree(new_version, ignore_errors=True)
        if previous_version.exists() and not version.exists():
            replace_with_retry(previous_version, version)


__all__ = [
    "InstalledFileSnapshot",
    "activate_version",
    "atomic_write_json",
    "cleanup_install_attempt",
    "installed_engine_snapshot",
]
