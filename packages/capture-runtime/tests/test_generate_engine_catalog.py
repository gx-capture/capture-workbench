from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from direct_model_fixtures import approved_source_lock

from capture_runtime.engine_catalog import EngineCatalog, canonical_json_bytes
from capture_runtime.release import build_release_artifacts, write_capture_document_schema

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "generate_engine_catalog.py"


def archive_pair(directory: Path, name: str, payload_path: str) -> tuple[Path, Path]:
    payload = name.encode()
    manifest = canonical_json_bytes(
        {
            "manifestVersion": "1",
            "files": [
                {
                    "path": payload_path,
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            ],
        }
    )
    archive = directory / name
    sidecar = directory / f"{archive.stem}-files.json"
    sidecar.write_bytes(manifest)
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as output:
        output.writestr("files-manifest.json", manifest)
        output.writestr(payload_path, payload)
    return archive, sidecar


def test_direct_source_lock_generates_catalog_without_model_release_assets(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-ocr-0.3.5-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    whisper_worker, whisper_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-whisper-0.3.5-windows-x64.zip",
        "capture-engine-whisper.exe",
    )
    source_lock, _content = approved_source_lock()
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    environment = dict(os.environ)
    environment["CAPTURE_OCR_MODEL_ARCHIVE"] = str(tmp_path / "ambient-model.zip")
    subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--model-source-lock",
            str(source_lock_path),
            "--output",
            str(catalog_path),
            "--ocr-worker-archive",
            str(ocr_worker),
            "--ocr-worker-manifest",
            str(ocr_worker_manifest),
            "--whisper-worker-archive",
            str(whisper_worker),
            "--whisper-worker-manifest",
            str(whisper_worker_manifest),
        ],
        env=environment,
        stdin=subprocess.DEVNULL,
        shell=False,
        check=True,
    )

    catalog = EngineCatalog.from_dict(json.loads(catalog_path.read_text(encoding="utf-8")))
    assert catalog.catalog_version == "2"
    assert all(requirement.complete for requirement in catalog.requirements)
    assert all(
        [artifact.role for artifact in requirement.artifacts] == ["worker"]
        for requirement in catalog.requirements
    )
    assert all(requirement.model_delivery().files for requirement in catalog.requirements)

    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    release = tmp_path / "release"
    build_release_artifacts(
        executable=executable,
        schema=schema,
        output_dir=release,
        engine_dir=engine_dir,
        engine_catalog=catalog_path,
    )
    for artifact in (
        ocr_worker,
        whisper_worker,
        ocr_worker_manifest,
        whisper_worker_manifest,
    ):
        assert (release / artifact.name).is_file()
        assert (release / f"{artifact.name}.sha256").is_file()
    assert not list(release.glob("capture-model-*"))


def test_empty_source_lock_generates_core_only_catalog_and_release(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-ocr-0.3.5-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    whisper_worker, whisper_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-whisper-0.3.5-windows-x64.zip",
        "capture-engine-whisper.exe",
    )
    qa_fixture = engine_dir / "real-ocr-fixture.png"
    qa_fixture.write_bytes(b"qa-only")
    source_lock_path = (
        Path(__file__).resolve().parents[1] / "model-sources" / "release-model-source-lock.json"
    )
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--model-source-lock",
            str(source_lock_path),
            "--output",
            str(catalog_path),
            "--ocr-worker-archive",
            str(ocr_worker),
            "--ocr-worker-manifest",
            str(ocr_worker_manifest),
            "--whisper-worker-archive",
            str(whisper_worker),
            "--whisper-worker-manifest",
            str(whisper_worker_manifest),
        ],
        stdin=subprocess.DEVNULL,
        shell=False,
        check=True,
    )

    catalog = EngineCatalog.from_dict(json.loads(catalog_path.read_text(encoding="utf-8")))
    assert catalog.requirements == ()

    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    release = tmp_path / "release"
    release.mkdir()
    for stale in (
        ocr_worker,
        whisper_worker,
        ocr_worker_manifest,
        whisper_worker_manifest,
        qa_fixture,
    ):
        (release / stale.name).write_bytes(b"stale release payload")
    build_release_artifacts(
        executable=executable,
        schema=schema,
        output_dir=release,
        engine_dir=engine_dir,
        engine_catalog=catalog_path,
    )
    released = {item.name for item in release.iterdir()}
    assert "capture-engine-catalog.json" in released
    assert "capture-engine-catalog.json.sha256" in released
    for excluded in (
        ocr_worker,
        whisper_worker,
        ocr_worker_manifest,
        whisper_worker_manifest,
        qa_fixture,
    ):
        assert excluded.name not in released

    with pytest.raises(ValueError, match="cannot contain release inputs"):
        build_release_artifacts(
            executable=executable,
            schema=schema,
            output_dir=engine_dir,
            engine_dir=engine_dir,
            engine_catalog=catalog_path,
        )
    assert all(
        item.is_file()
        for item in (
            ocr_worker,
            whisper_worker,
            ocr_worker_manifest,
            whisper_worker_manifest,
            qa_fixture,
        )
    )
