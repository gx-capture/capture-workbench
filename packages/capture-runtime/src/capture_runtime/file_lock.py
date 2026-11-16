"""Shared non-blocking exclusive OS file lock."""

from __future__ import annotations

import importlib
import os
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any


def lock_descriptor(descriptor: int) -> None:
    os.lseek(descriptor, 0, os.SEEK_SET)
    if os.name == "nt":
        msvcrt: Any = importlib.import_module("msvcrt")
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        fcntl: Any = importlib.import_module("fcntl")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)


def replace_with_retry(
    source: Path,
    target: Path,
    *,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Replace off the event loop, tolerating brief Windows sharing violations."""

    deadline = clock() + 2.0
    delay = 0.02
    for attempt in range(8):
        try:
            os.replace(source, target)
            return
        except PermissionError as error:
            remaining = deadline - clock()
            if (
                sys.platform != "win32"
                or getattr(error, "winerror", None) not in {5, 32}
                or attempt == 7
                or remaining <= 0
            ):
                raise
            sleep(min(delay, remaining))
            delay = min(delay * 2, 0.4)
