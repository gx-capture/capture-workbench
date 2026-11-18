"""Ollama lifecycle, installation and structuring provider public facade."""

import shutil as _shutil

from capture_runtime.structuring.infrastructure.ollama.installer import (
    CommandResult,
    RuntimeInstaller,
    SystemRuntimeInstaller,
)
from capture_runtime.structuring.infrastructure.ollama.lifecycle import (
    IsolatedOllamaLifecycle,
    ManualActionRequiredError,
    OllamaOwnershipError,
    OwnedProcess,
    ProcessController,
    RuntimeUnavailableError,
    SubprocessController,
)
from capture_runtime.structuring.infrastructure.ollama.provider import (
    ExternalOllamaCaptureStructuringProvider,
    OllamaCaptureStructuringProvider,
)

# Preserve the old module-level test seam while the implementation migrates.
shutil = _shutil

__all__ = [
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
]
