"""Runtime structuring provider seam."""

from capture_runtime.ollama.external_provider import ExternalOllamaCaptureStructuringProvider
from capture_runtime.ollama.provider_impl import OllamaCaptureStructuringProvider

__all__ = [
    "ExternalOllamaCaptureStructuringProvider",
    "OllamaCaptureStructuringProvider",
]
