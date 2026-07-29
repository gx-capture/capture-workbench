from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path

import pytest

from capture_runtime.engine_catalog import canonical_json_bytes
from capture_runtime.release import build_release_artifacts, write_capture_document_schema


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact(
    engine_dir: Path,
    *,
    requirement_id: str,
    role: str,
    file_name: str,
    entry_point: str,
) -> dict[str, object]:
    payload_name = entry_point if role == "worker" else "model/model.bin"
    payload = f"{requirement_id}-{role}".encode()
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
        "role": role,
        "requirementId": requirement_id,
        "artifactVersion": "0.3.2",
        "workerProtocolVersion": "1",
        "platform": "windows",
        "arch": "x86_64",
        "fileName": file_name,
        "bytes": archive.stat().st_size,
        "sha256": sha256(archive),
        "extractedBytes": extracted_bytes,
        "entryPoint": entry_point,
        "filesManifestSha256": hashlib.sha256(manifest).hexdigest(),
        "url": f"https://example.invalid/v0.3.2/{file_name}",
    }


def complete_catalog(engine_dir: Path, catalog_path: Path) -> None:
    requirements = []
    for requirement_id, worker_name, model_name, entry_point in (
        (
            "windowsml-ocr",
            "capture-engine-ocr.zip",
            "capture-model-ocr.zip",
            "capture-engine-ocr.exe",
        ),
        (
            "whisper-primary",
            "capture-engine-whisper.zip",
            "capture-model-whisper.zip",
            "capture-engine-whisper.exe",
        ),
    ):
        requirements.append(
            {
                "requirementId": requirement_id,
                "artifacts": [
                    artifact(
                        engine_dir,
                        requirement_id=requirement_id,
                        role="worker",
                        file_name=worker_name,
                        entry_point=entry_point,
                    ),
                    artifact(
                        engine_dir,
                        requirement_id=requirement_id,
                        role="model",
                        file_name=model_name,
                        entry_point="model",
                    ),
                ],
                "unavailableReason": None,
            }
        )
    catalog_path.write_bytes(
        canonical_json_bytes(
            {
                "catalogVersion": "1",
                "runtimeVersion": "0.3.2",
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
