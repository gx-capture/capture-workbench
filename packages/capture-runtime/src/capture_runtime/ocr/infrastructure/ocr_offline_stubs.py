"""Offline stand-ins for the model hubs PaddleOCR imports.

PaddleOCR and PaddleX import ``aistudio_sdk`` and ``huggingface_hub`` to fetch
models. The OCR worker only runs checksum-verified local model assets and does
not package either hub, so it installs these stubs before importing PaddleOCR;
any download attempt fails with ``EngineRuntimeUnavailableError``.
"""

from __future__ import annotations

import sys
from types import ModuleType

from capture_runtime.worker_probe import EngineRuntimeUnavailableError


def install_offline_aistudio_stubs() -> None:
    existing = sys.modules.get("aistudio_sdk")
    if getattr(existing, "_capture_workbench_offline_stub", False):
        return
    package = ModuleType("aistudio_sdk")
    package.__path__ = []
    package._capture_workbench_offline_stub = True  # type: ignore[attr-defined]
    errors = ModuleType("aistudio_sdk.errors")
    downloads = ModuleType("aistudio_sdk.snapshot_download")

    class NotExistError(Exception):
        pass

    def snapshot_download(*_args: object, **_kwargs: object) -> None:
        raise EngineRuntimeUnavailableError(
            "Capture WindowsML OCR only uses checksum-verified local model assets."
        )

    errors.NotExistError = NotExistError  # type: ignore[attr-defined]
    downloads.snapshot_download = snapshot_download  # type: ignore[attr-defined]
    package.errors = errors  # type: ignore[attr-defined]
    package.snapshot_download = downloads  # type: ignore[attr-defined]
    sys.modules["aistudio_sdk"] = package
    sys.modules["aistudio_sdk.errors"] = errors
    sys.modules["aistudio_sdk.snapshot_download"] = downloads


def install_offline_huggingface_stubs() -> None:
    existing = sys.modules.get("huggingface_hub")
    if getattr(existing, "_capture_workbench_offline_stub", False):
        return
    package = ModuleType("huggingface_hub")
    package.__path__ = []
    package._capture_workbench_offline_stub = True  # type: ignore[attr-defined]
    logging = ModuleType("huggingface_hub.logging")
    utils = ModuleType("huggingface_hub.utils")

    class HfHubHTTPError(Exception):
        pass

    class RepositoryNotFoundError(HfHubHTTPError):
        pass

    class EntryNotFoundError(HfHubHTTPError):
        pass

    class RevisionNotFoundError(HfHubHTTPError):
        pass

    def set_verbosity_error() -> None:
        return None

    def snapshot_download(*_args: object, **_kwargs: object) -> None:
        raise EngineRuntimeUnavailableError(
            "Capture WindowsML OCR only uses checksum-verified local model assets."
        )

    logging.set_verbosity_error = set_verbosity_error  # type: ignore[attr-defined]
    utils.HfHubHTTPError = HfHubHTTPError  # type: ignore[attr-defined]
    utils.RepositoryNotFoundError = RepositoryNotFoundError  # type: ignore[attr-defined]
    utils.EntryNotFoundError = EntryNotFoundError  # type: ignore[attr-defined]
    utils.RevisionNotFoundError = RevisionNotFoundError  # type: ignore[attr-defined]
    package.logging = logging  # type: ignore[attr-defined]
    package.snapshot_download = snapshot_download  # type: ignore[attr-defined]
    package.utils = utils  # type: ignore[attr-defined]
    sys.modules["huggingface_hub"] = package
    sys.modules["huggingface_hub.logging"] = logging
    sys.modules["huggingface_hub.utils"] = utils


__all__ = [
    "install_offline_aistudio_stubs",
    "install_offline_huggingface_stubs",
]
