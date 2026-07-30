from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path

import pytest
from direct_model_fixtures import approved_source_lock

from capture_runtime.engine_catalog import canonical_json_bytes
from capture_runtime.release import build_release_artifacts, write_capture_document_schema


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact(
    engine_dir: Path,
    *,
    requirement_id: str,
    file_name: str,
    entry_point: str,
) -> dict[str, object]:
    payload_name = entry_point
    payload = f"{requirement_id}-worker".encode()
    manifest = canonical_json_bytes(
        {
            "manifestVersion": "1",
            "files": [
                {
                    "path": payload_name,
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            ],
        }
    )
    archive = engine_dir / file_name
    sidecar = engine_dir / f"{archive.stem}-files.json"
    sidecar.write_bytes(manifest)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        output.writestr("files-manifest.json", manifest)
        output.writestr(payload_name, payload)
    with zipfile.ZipFile(archive) as source:
        extracted_bytes = sum(item.file_size for item in source.infolist())
    return {
        "role": "worker",
        "requirementId": requirement_id,
        "artifactVersion": "0.3.6",
        "workerProtocolVersion": "1",
        "platform": "windows",
        "arch": "x86_64",
        "fileName": file_name,
        "bytes": archive.stat().st_size,
        "sha256": sha256(archive),
        "extractedBytes": extracted_bytes,
        "entryPoint": entry_point,
        "filesManifestSha256": hashlib.sha256(manifest).hexdigest(),
        "url": f"https://example.invalid/v0.3.6/{file_name}",
    }


def complete_catalog(engine_dir: Path, catalog_path: Path) -> None:
    source_lock, _content = approved_source_lock()
    source_lock_sha256 = hashlib.sha256(canonical_json_bytes(source_lock)).hexdigest()
    requirements = []
    for requirement_id, worker_name, entry_point in (
        (
            "windowsml-ocr",
            "capture-engine-ocr.zip",
            "capture-engine-ocr.exe",
        ),
        (
            "whisper-primary",
            "capture-engine-whisper.zip",
            "capture-engine-whisper.exe",
        ),
    ):
        locked = next(
            item for item in source_lock["requirements"] if item["requirementId"] == requirement_id
        )
        model_manifest = {
            "artifactVersion": locked["artifactVersion"],
            "entryPoint": locked["entryPoint"],
            "files": locked["files"],
            "manifestVersion": "1",
        }
        requirements.append(
            {
                "requirementId": requirement_id,
                "artifacts": [
                    artifact(
                        engine_dir,
                        requirement_id=requirement_id,
                        file_name=worker_name,
                        entry_point=entry_point,
                    ),
                ],
                "modelFiles": {
                    "artifactVersion": locked["artifactVersion"],
                    "entryCount": len(locked["files"]),
                    "entryPoint": locked["entryPoint"],
                    "extractedBytes": sum(item["bytes"] for item in locked["files"]),
                    "files": locked["files"],
                    "manifestSha256": hashlib.sha256(
                        canonical_json_bytes(model_manifest)
                    ).hexdigest(),
                    "sourceLockSha256": source_lock_sha256,
                },
                "unavailableReason": None,
            }
        )
    catalog_path.write_bytes(
        canonical_json_bytes(
            {
                "catalogVersion": "2",
                "runtimeVersion": "0.3.6",
                "requirements": requirements,
            }
        )
    )


def test_release_copies_only_catalogued_engine_assets_with_checksums(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog)

    build_release_artifacts(
        executable=executable,
        schema=schema,
        output_dir=tmp_path / "release",
        engine_dir=engine_dir,
        engine_catalog=catalog,
    )

    released = {item.name for item in (tmp_path / "release").iterdir()}
    assert "capture-engine-catalog.json" in released
    assert "capture-engine-catalog.json.sha256" in released
    assert all(f"{item.name}.sha256" in released for item in engine_dir.iterdir() if item.is_file())


def test_release_rejects_catalog_archive_drift_before_copying(tmp_path: Path) -> None:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog)
    (engine_dir / "capture-engine-ocr.zip").write_bytes(b"drift")
    output = tmp_path / "release"

    with pytest.raises(ValueError, match="byte count mismatch"):
        build_release_artifacts(
            executable=executable,
            schema=schema,
            output_dir=output,
            engine_dir=engine_dir,
            engine_catalog=catalog,
        )

    assert not output.exists()
