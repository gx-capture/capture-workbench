"""Compatibility facade for this Ollama package."""

import shutil as _shutil

from capture_runtime.structuring.infrastructure.ollama.installer_impl import (
    CommandResult,
    CommandRunner,
    FakeRuntimeInstaller,
    RuntimeInstaller,
    SystemRuntimeInstaller,
    _extract_safe_zip,
)
from capture_runtime.structuring.infrastructure.ollama.lifecycle_impl import (
    IsolatedOllamaLifecycle,
    ManualActionRequiredError,
    OllamaOwnershipError,
    OwnedProcess,
    ProcessController,
    RuntimeUnavailableError,
    SubprocessController,
)
from capture_runtime.structuring.infrastructure.ollama.provider_impl import (
    OllamaCaptureStructuringProvider,
)

shutil = _shutil

__all__ = [
    "CommandResult",
    "CommandRunner",
    "FakeRuntimeInstaller",
    "IsolatedOllamaLifecycle",
    "ManualActionRequiredError",
    "OllamaCaptureStructuringProvider",
    "OllamaOwnershipError",
    "OwnedProcess",
    "ProcessController",
    "RuntimeInstaller",
    "RuntimeUnavailableError",
    "SubprocessController",
    "SystemRuntimeInstaller",
    "_extract_safe_zip",
]
