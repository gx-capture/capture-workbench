"""Stable runtime requirement and provider identifiers."""

from typing import Final

DEFAULT_OLLAMA_PROFILE_ID: Final = "qwen3.5-4b-structure-v1"
CAPTURE_OLLAMA_BASE_MODEL: Final = "qwen3.5:4b"

TEXT_RECOGNITION_REQUIREMENT_ID: Final = "text-recognition"
SPEECH_RECOGNITION_REQUIREMENT_ID: Final = "speech-recognition"
DIARIZATION_REQUIREMENT_ID: Final = "speaker-diarization"
# Models only: the reader runs inside the OCR worker.
VERTICAL_READER_REQUIREMENT_ID: Final = "vertical-japanese-reader"
STRUCTURING_RUNTIME_REQUIREMENT_ID: Final = "structuring-runtime"
STRUCTURING_MODEL_REQUIREMENT_ID: Final = "structuring-model"

# Stored records and validation messages share the retired requirement spellings.
RETIRED_STRUCTURING_REQUIREMENT_IDS: Final = {
    "ollama-runtime": STRUCTURING_RUNTIME_REQUIREMENT_ID,
    "capture-ollama-model": STRUCTURING_MODEL_REQUIREMENT_ID,
}
