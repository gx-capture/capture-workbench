from __future__ import annotations

import hashlib

from capture_runtime.release import capture_document_schema_release_bytes


def capture_document_schema_release_sha256() -> str:
    return hashlib.sha256(capture_document_schema_release_bytes()).hexdigest()
