"""Public Capture Runtime package surface."""

from __future__ import annotations

from importlib import import_module
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from capture_runtime.app import create_app
    from capture_runtime.contracts import CaptureDocument, RawCapture
    from capture_runtime.structuring_provider import CaptureStructuringProvider

__all__ = [
    "CaptureDocument",
    "CaptureStructuringProvider",
    "RawCapture",
    "create_app",
]


def __getattr__(name: str) -> object:
    module_name = {
        "CaptureDocument": "capture_runtime.contracts",
        "CaptureStructuringProvider": "capture_runtime.structuring_provider",
        "RawCapture": "capture_runtime.contracts",
        "create_app": "capture_runtime.app",
    }.get(name)
    if module_name is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(module_name), name)
    globals()[name] = value
    return value
