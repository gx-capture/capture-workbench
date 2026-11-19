"""Stable runtime requirement and provider identifiers."""

from typing import Final

CAPTURE_OLLAMA_PROFILE_ID: Final = "capture-workbench-qwen3.5-4b-structure-v1"
CAPTURE_OLLAMA_BASE_MODEL: Final = "qwen3.5:4b"

TEXT_RECOGNITION_REQUIREMENT_ID: Final = "text-recognition"
SPEECH_RECOGNITION_REQUIREMENT_ID: Final = "speech-recognition"
DIARIZATION_REQUIREMENT_ID: Final = "speaker-diarization"
# Models only: the reader runs inside the OCR worker.
VERTICAL_READER_REQUIREMENT_ID: Final = "vertical-japanese-reader"
OLLAMA_RUNTIME_REQUIREMENT_ID: Final = "ollama-runtime"
OLLAMA_MODEL_REQUIREMENT_ID: Final = "capture-ollama-model"
