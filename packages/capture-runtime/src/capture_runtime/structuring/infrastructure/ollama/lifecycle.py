"""Process ownership and isolated Ollama lifecycle seam."""

from capture_runtime.structuring.infrastructure.ollama.lifecycle_impl import (
    IsolatedOllamaLifecycle,
    OllamaOwnershipError,
    OwnedProcess,
    ProcessController,
    RuntimeUnavailableError,
    SubprocessController,
)

__all__ = [
    "IsolatedOllamaLifecycle",
    "OllamaOwnershipError",
    "OwnedProcess",
    "ProcessController",
    "RuntimeUnavailableError",
    "SubprocessController",
]
