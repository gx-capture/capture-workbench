"""Internal safety limits shared by engine installation modules."""

from __future__ import annotations

MAX_ARCHIVE_FILES = 4096
# A pinned Whisper primary model is larger than the worker/archive guard but
# remains bounded below the direct-model aggregate limit.
MAX_SINGLE_EXTRACTED_FILE_BYTES = 2 * 1024 * 1024 * 1024
MAX_TOTAL_EXTRACTED_BYTES = 2 * 1024 * 1024 * 1024
MAX_COMPRESSION_RATIO = 200
FILES_MANIFEST_NAME = "files-manifest.json"
MAX_FILES_MANIFEST_BYTES = 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
MAX_DIRECT_MODEL_REDIRECTS = 5
DEFAULT_ACTIVE_ENGINE_RESOLUTION_TIMEOUT_SECONDS = 60.0
WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_DEVICE_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)
