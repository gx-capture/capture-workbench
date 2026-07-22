from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from capture_runtime.release import (
    CAPTURE_DOCUMENT_SCHEMA_ID,
    CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
    capture_document_schema,
    capture_document_schema_release_bytes,
    capture_document_schema_release_sha256,
    write_capture_document_schema,
)

ANGULAR_GENERATED_ROOT = (
    Path(__file__).resolve().parents[2] / "capture-angular" / "src" / "lib" / "generated"
)


def test_angular_package_schema_is_the_runtime_generated_contract(tmp_path: Path) -> None:
    angular_schema = ANGULAR_GENERATED_ROOT / "capture-document-v1.schema.json"
    angular_metadata = ANGULAR_GENERATED_ROOT / "capture-document-v1-schema.generated.ts"
    schema_bytes = angular_schema.read_bytes()

    assert json.loads(schema_bytes) == capture_document_schema()
    assert schema_bytes == capture_document_schema_release_bytes()
    assert schema_bytes.endswith(b"\r\n")
    assert b"\n" not in schema_bytes.replace(b"\r\n", b"")
    assert b"\r" not in schema_bytes.replace(b"\r\n", b"")
    assert json.loads(schema_bytes)["$id"] == CAPTURE_DOCUMENT_SCHEMA_ID

    digest = hashlib.sha256(schema_bytes).hexdigest()
    assert digest == capture_document_schema_release_sha256()
    assert digest == CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256

    metadata_match = re.search(r"'([0-9a-f]{64})' as const", angular_metadata.read_text())
    assert metadata_match is not None
    assert metadata_match.group(1) == digest

    generated = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    assert generated.read_bytes() == schema_bytes
