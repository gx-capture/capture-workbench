"""Process-lifetime exclusive lock on the Capture Runtime app-data directory."""

from __future__ import annotations

import errno
import os
import time
from pathlib import Path

from capture_runtime.file_lock import lock_descriptor

APP_DATA_LOCK_FILENAME = "runtime.lock"
_RETRY_INTERVAL_SECONDS = 0.1
_LOCK_CONTENTION_ERRNOS = frozenset({errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK})


class AppDataLockError(RuntimeError):
    """Raised when the runtime app-data directory lock cannot be acquired."""


class AppDataInUseError(AppDataLockError):
    """Raised when another Capture Runtime already holds the app-data lock."""


class AppDataDirectoryLock:
    """Exclusive non-blocking lock held for the lifetime of the runtime process."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._descriptor: int | None = None

    @classmethod
    def acquire(cls, app_data_dir: Path, *, wait_seconds: float = 0.0) -> AppDataDirectoryLock:
        """Create ``app_data_dir`` if needed and acquire its exclusive OS lock.

        Windows releases the byte-range lock of a killed process only some time
        after the process is gone, so a runtime started right after its predecessor
        was stopped retries contention for up to ``wait_seconds``.
        """
        lock = cls(app_data_dir / APP_DATA_LOCK_FILENAME)
        deadline = time.monotonic() + max(wait_seconds, 0.0)
        while True:
            try:
                lock._acquire()
                return lock
            except AppDataInUseError:
                if time.monotonic() >= deadline:
                    raise
                time.sleep(_RETRY_INTERVAL_SECONDS)

    def _acquire(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR, 0o600)
        except OSError as error:
            raise AppDataLockError("the app data directory lock could not be opened") from error

        try:
            lock_descriptor(descriptor)
        except OSError as error:
            os.close(descriptor)
            if error.errno in _LOCK_CONTENTION_ERRNOS:
                raise AppDataInUseError(
                    "the app data directory is in use by another Capture Runtime"
                ) from error
            raise AppDataLockError("the app data directory lock could not be acquired") from error

        try:
            _write_pid(descriptor)
        except OSError as error:
            os.close(descriptor)
            raise AppDataLockError(
                "the app data directory lock could not be initialized"
            ) from error

        self._descriptor = descriptor

    def release(self) -> None:
        """Release the OS lock by closing its open file descriptor."""
        descriptor = self._descriptor
        if descriptor is not None:
            self._descriptor = None
            os.close(descriptor)

    def __enter__(self) -> AppDataDirectoryLock:
        return self

    def __exit__(self, *_errors: object) -> None:
        self.release()


def _write_pid(descriptor: int) -> None:
    payload = f"{os.getpid()}\n".encode("ascii")
    os.lseek(descriptor, 0, os.SEEK_SET)
    os.write(descriptor, payload)
    os.ftruncate(descriptor, len(payload))
