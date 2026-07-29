from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

from capture_runtime.engine_catalog import EngineCatalog, canonical_json_bytes
from capture_runtime.release import build_release_artifacts, write_capture_document_schema

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "generate_engine_catalog.py"
SPEC = importlib.util.spec_from_file_location("capture_generate_engine_catalog", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
generate_engine_catalog = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(generate_engine_catalog)


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


def test_external_models_stage_into_complete_release_candidate(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    external_dir = tmp_path / "external-models"
    engine_dir.mkdir()
    external_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-ocr-0.3.2-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    whisper_worker, whisper_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-whisper-0.3.2-windows-x64.zip",
        "capture-engine-whisper.exe",
    )
    ocr_model, ocr_model_manifest = archive_pair(
        external_dir,
        "capture-model-ocr-0.3.2.zip",
        "model/detection.onnx",
    )
    whisper_model, whisper_model_manifest = archive_pair(
        external_dir,
        "capture-model-whisper-0.3.2.zip",
        "model/model.bin",
    )
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    environment = dict(os.environ)
    environment.update(
        {
            "CAPTURE_OCR_MODEL_ARCHIVE": str(ocr_model),
            "CAPTURE_OCR_MODEL_MANIFEST": str(ocr_model_manifest),
            "CAPTURE_WHISPER_MODEL_ARCHIVE": str(whisper_model),
            "CAPTURE_WHISPER_MODEL_MANIFEST": str(whisper_model_manifest),
        }
    )
    subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--require-complete",
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
    assert all(requirement.complete for requirement in catalog.requirements)
    assert (engine_dir / ocr_model.name).read_bytes() == ocr_model.read_bytes()
    assert (engine_dir / whisper_model_manifest.name).read_bytes() == (
        whisper_model_manifest.read_bytes()
    )
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
        ocr_model,
        whisper_model,
        ocr_worker_manifest,
        whisper_worker_manifest,
        ocr_model_manifest,
        whisper_model_manifest,
    ):
        assert (release / artifact.name).is_file()
        assert (release / f"{artifact.name}.sha256").is_file()


def test_external_model_staging_rejects_same_name_different_bytes(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    external_dir = tmp_path / "external"
    engine_dir.mkdir()
    external_dir.mkdir()
    source = external_dir / "capture-model.zip"
    manifest = external_dir / "capture-model-files.json"
    source.write_bytes(b"new")
    manifest.write_bytes(b"manifest")
    (engine_dir / source.name).write_bytes(b"old")

    with pytest.raises(ValueError, match="staging collision"):
        generate_engine_catalog.stage_model_pair(
            source,
            manifest,
            engine_dir=engine_dir,
        )
