"""Stable runtime requirement and provider identifiers."""

from typing import Final

CAPTURE_OLLAMA_PROFILE_ID: Final = "capture-workbench-qwen3.5-4b-structure-v1"
CAPTURE_OLLAMA_BASE_MODEL: Final = "qwen3.5:4b"

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
