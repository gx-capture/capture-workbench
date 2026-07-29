"""Stable runtime requirement and provider identifiers."""

from typing import Final

CAPTURE_OLLAMA_PROFILE_ID: Final = "capture-workbench-qwen3.5-4b-structure-v1"
CAPTURE_OLLAMA_BASE_MODEL: Final = "qwen3.5:4b"

# The consented WindowsML download is a runtime-release invariant. It is not
# configured by CI, the desktop host, or the renderer.
WINDOWSML_BUNDLE_URL: Final = (
    "https://github.com/gx-capture/capture-workbench/releases/download/"
    "v0.3.2/capture-windowsml-ocr-windows-x64.zip"
)
WINDOWSML_BUNDLE_BYTES: Final = 138_837_175
WINDOWSML_BUNDLE_SHA256: Final = "a88c9a3097771d07bd1d940db6acdcbb5336e7c6c85406f5c22655ed6930704a"

WINDOWSML_REQUIREMENT_ID: Final = "windowsml-ocr"
WHISPER_REQUIREMENT_ID: Final = "whisper-primary"
OLLAMA_RUNTIME_REQUIREMENT_ID: Final = "ollama-runtime"
OLLAMA_MODEL_REQUIREMENT_ID: Final = "capture-ollama-model"

REQUIREMENT_IDS: Final = (
    WINDOWSML_REQUIREMENT_ID,
    WHISPER_REQUIREMENT_ID,
    OLLAMA_RUNTIME_REQUIREMENT_ID,
    OLLAMA_MODEL_REQUIREMENT_ID,
)
