"""Stable public version and requirement identifiers."""

from typing import Final

RUNTIME_VERSION: Final = "0.1.0"
API_VERSION: Final = "1.0"
CAPTURE_DOCUMENT_SCHEMA_VERSION: Final = "1"
MAX_RUNTIME_ARTIFACT_BYTES: Final = 536_870_912
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
