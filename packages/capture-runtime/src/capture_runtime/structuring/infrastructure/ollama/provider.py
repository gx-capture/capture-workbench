"""Runtime structuring provider seam."""

from capture_runtime.structuring.infrastructure.ollama.external_provider import (
    ExternalOllamaCaptureStructuringProvider,
)
from capture_runtime.structuring.infrastructure.ollama.provider_impl import (
    OllamaCaptureStructuringProvider,
)

__all__ = [
    "ExternalOllamaCaptureStructuringProvider",
    "OllamaCaptureStructuringProvider",
]
