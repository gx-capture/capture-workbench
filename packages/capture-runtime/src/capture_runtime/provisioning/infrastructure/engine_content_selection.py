"""Choose a cuda or cpu content without importing torch.

The desktop launcher treats ``nvcuda.dll`` in ``%SystemRoot%\\System32`` as an
NVIDIA driver (``compute.rs``). This process uses that file check. It does not
decide again after install: the chosen content is written into ``active.json``.

``capture_runtime.config`` cannot import provisioning, so the environment
variable is validated there. This module only answers which content id a
fresh install would use, and which speech models that installed content can
run. The rule stays here because import-linter forbids provisioning from
importing the speech adapter, while capture and the requirement listing are
downstream and may import this module. Tests pass their own driver callable
into ``EngineInstallationManager`` and never call :func:`detect_nvidia_driver`
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


# ``auto`` on a cpu content loads mini. The full checkpoint is not in that pack.
_CPU_SPEECH_MODELS = frozenset({"auto", "tea-asr-1.1-mini"})


def speech_content_allows_model(content_id: str | None, model: str) -> bool:
    """Whether this installed content can run the model the worker would receive.

    ``cpu`` can run ``auto`` and ``tea-asr-1.1-mini``. ``cuda`` and a legacy
    engine with no content id can run every model. An unknown content id is
    not treated as ``cuda``; callers leave that failure to the worker.
    """

    if content_id == "cpu":
        return model in _CPU_SPEECH_MODELS
    if content_id in {None, "cuda"}:
        return True
    return False


def speech_model_not_installed_message(content_id: str | None, model: str) -> str | None:
    """The host-facing sentence when an installed ``cpu`` content lacks ``model``.

    ``cuda``, a legacy engine, and a model the content can run return None.
    """

    if content_id != "cpu" or speech_content_allows_model(content_id, model):
        return None
    return (
        f"Speech recognition model {model} is not in the installed cpu content. "
        "Set CAPTURE_SPEECH_RECOGNITION_MODEL to auto or tea-asr-1.1-mini, "
        "or uninstall speech-recognition and install it with "
        "CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda."
    )


__all__ = [
    "content_id_for_variant",
    "detect_nvidia_driver",
    "speech_content_allows_model",
    "speech_model_not_installed_message",
]
