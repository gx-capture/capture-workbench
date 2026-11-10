"""Choose a cuda or cpu content without importing torch.

The desktop launcher treats ``nvcuda.dll`` in ``%SystemRoot%\\System32`` as an
NVIDIA driver (``compute.rs``). This process uses that file check. It does not
decide again after install: the chosen content is written into ``active.json``.

``capture_runtime.config`` cannot import provisioning, so the environment
variable is validated there. This module only answers which content id a
fresh install would use. Tests pass their own driver callable into
``EngineInstallationManager`` and never call :func:`detect_nvidia_driver`
against this machine.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from pathlib import Path


def detect_nvidia_driver(
    environ: Mapping[str, str] | None = None,
    *,
    platform_name: str | None = None,
) -> bool:
    """True when ``System32/nvcuda.dll`` is a file under ``SystemRoot``.

    Non-Windows, a missing ``SystemRoot``, or anything that is not a file
    counts as no driver. ``platform_name`` lets a test pretend to be Windows
    without reading this machine.
    """

    system = sys.platform if platform_name is None else platform_name
    if system != "win32":
        return False
    env = os.environ if environ is None else environ
    system_root = _system_root(env)
    if system_root is None:
        return False
    return (Path(system_root) / "System32" / "nvcuda.dll").is_file()


def content_id_for_variant(variant: str, *, driver_present: bool) -> str:
    """The content id a fresh install prefers.

    ``cuda`` and ``cpu`` are honored even when the driver disagrees. ``auto``
    is ``cuda`` only when a driver is present. Settings and
    ``EngineInstallationManager`` have already rejected any other variant.
    """

    if variant in {"cuda", "cpu"}:
        return variant
    return "cuda" if driver_present else "cpu"


def _system_root(environ: Mapping[str, str]) -> str | None:
    for key, value in environ.items():
        if key.upper() == "SYSTEMROOT" and value.strip():
            return value
    return None


__all__ = [
    "content_id_for_variant",
    "detect_nvidia_driver",
]
