"""Shared non-blocking exclusive OS file lock."""

from __future__ import annotations

import importlib
import os
from typing import Any


def lock_descriptor(descriptor: int) -> None:
    os.lseek(descriptor, 0, os.SEEK_SET)
    if os.name == "nt":
        msvcrt: Any = importlib.import_module("msvcrt")
        msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
    else:
        fcntl: Any = importlib.import_module("fcntl")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
