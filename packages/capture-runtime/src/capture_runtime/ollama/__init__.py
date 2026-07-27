"""Ollama lifecycle, installation and structuring provider public facade."""

import shutil as _shutil

from capture_runtime.ollama.installer import (
    CommandResult,
    FakeRuntimeInstaller,
    RuntimeInstaller,
    SystemRuntimeInstaller,
)
from capture_runtime.ollama.installer_impl import _extract_safe_zip
from capture_runtime.ollama.lifecycle import (
    IsolatedOllamaLifecycle,
    ManualActionRequiredError,
    OllamaOwnershipError,
    OwnedProcess,
    ProcessController,
    RuntimeUnavailableError,
    SubprocessController,
)
from capture_runtime.ollama.provider import (
    ExternalOllamaCaptureStructuringProvider,
    OllamaCaptureStructuringProvider,
)

# Preserve the old module-level test seam while the implementation migrates.
shutil = _shutil

__all__ = [
    "FakeRuntimeInstaller",
    "CommandResult",
    "ExternalOllamaCaptureStructuringProvider",
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
