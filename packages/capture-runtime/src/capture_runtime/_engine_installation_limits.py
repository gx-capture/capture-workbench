"""Internal safety limits shared by engine installation modules."""

from __future__ import annotations

# The speaker diarization worker carries PyTorch, which ships about 2,100
# Python source files on disk; that worker has roughly 4,000 entries.
MAX_ARCHIVE_FILES = 8192
# Worker archive extraction remains bounded independently of direct model files.
MAX_SINGLE_EXTRACTED_FILE_BYTES = 2 * 1024 * 1024 * 1024
# The speech recognition worker carries CUDA PyTorch, about 4.5 GB extracted.
MAX_TOTAL_EXTRACTED_BYTES = 8 * 1024 * 1024 * 1024
MAX_SINGLE_MODEL_FILE_BYTES = 4 * 1024**3
MAX_TOTAL_MODEL_BYTES = 8 * 1024**3
MAX_COMPRESSION_RATIO = 200
FILES_MANIFEST_NAME = "files-manifest.json"
MAX_FILES_MANIFEST_BYTES = 1024 * 1024
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
# Artifacts at least this large download as concurrent byte ranges when the
# host supports them; release CDNs throttle each connection.
PARALLEL_DOWNLOAD_MIN_BYTES = 16 * 1024 * 1024
PARALLEL_DOWNLOAD_SEGMENTS = 4
MAX_DIRECT_MODEL_REDIRECTS = 5
DEFAULT_ACTIVE_ENGINE_RESOLUTION_TIMEOUT_SECONDS = 60.0
WINDOWS_FORBIDDEN_PATH_CHARACTERS = frozenset('<>:"|?*')
WINDOWS_RESERVED_DEVICE_BASENAMES = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{index}" for index in range(1, 10)}
    | {f"LPT{index}" for index in range(1, 10)}
)
