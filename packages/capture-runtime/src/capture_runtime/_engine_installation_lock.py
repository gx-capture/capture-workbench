"""Internal cross-process lock for one requirement's installation."""

from __future__ import annotations

import errno
import importlib
import os
from pathlib import Path

from ._engine_installation_errors import EngineInstallationError, EngineInstallBusyError


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


ExclusiveInstallFile = _ExclusiveInstallFile
_ExclusiveInstallFile.__module__ = "capture_runtime.engine_installation"


__all__ = ["ExclusiveInstallFile"]
