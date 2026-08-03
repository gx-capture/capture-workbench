from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

from direct_model_fixtures import approved_source_lock, pending_source_lock

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
        "capture-engine-ocr-0.3.9-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    whisper_worker, whisper_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-whisper-0.3.9-windows-x64.zip",
        "capture-engine-whisper.exe",
    )
    source_lock, _content = approved_source_lock()
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    environment = dict(os.environ)
    environment["CAPTURE_OCR_MODEL_ARCHIVE"] = str(tmp_path / "ambient-model.zip")
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[1] / "src")
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


def test_pending_source_lock_release_generation_fails_closed(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-ocr-0.3.9-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    whisper_worker, whisper_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-whisper-0.3.9-windows-x64.zip",
        "capture-engine-whisper.exe",
    )
    source_lock_path = tmp_path / "pending-model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(pending_source_lock()))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    result = subprocess.run(
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
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
        stdin=subprocess.DEVNULL,
        shell=False,
        check=False,
    )
    assert result.returncode != 0
    assert not catalog_path.exists()


def test_pending_source_lock_generates_only_preflight_catalog_with_explicit_flag(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-ocr-0.3.9-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    whisper_worker, whisper_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-whisper-0.3.9-windows-x64.zip",
        "capture-engine-whisper.exe",
    )
    source_lock_path = tmp_path / "pending-model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(pending_source_lock()))
    catalog_path = tmp_path / "catalog" / "preflight-capture-engine-catalog.json"
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--allow-pending-preflight",
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
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
        stdin=subprocess.DEVNULL,
        shell=False,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    catalog = EngineCatalog.from_dict(json.loads(catalog_path.read_text(encoding="utf-8")))
    assert [item.requirement_id for item in catalog.requirements] == [
        "windowsml-ocr",
        "whisper-primary",
    ]
    assert all(item.complete for item in catalog.requirements)


def test_pending_preflight_rejects_unrelated_blockers_and_approved_lock(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-ocr-0.3.9-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    whisper_worker, whisper_worker_manifest = archive_pair(
        engine_dir,
        "capture-engine-whisper-0.3.9-windows-x64.zip",
        "capture-engine-whisper.exe",
    )
    pending_payload = pending_source_lock()
    pending_payload["approval"]["blockers"].append("Unrelated approval blocker.")
    approved_payload, _content = approved_source_lock()
    for label, payload in (("extra-blocker", pending_payload), ("approved", approved_payload)):
        source_lock_path = tmp_path / f"{label}-source-lock.json"
        source_lock_path.write_bytes(canonical_json_bytes(payload))
        catalog_path = tmp_path / f"{label}-catalog.json"
        result = subprocess.run(
            [
                sys.executable,
                str(SCRIPT_PATH),
                "--allow-pending-preflight",
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
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[1] / "src")},
            stdin=subprocess.DEVNULL,
            shell=False,
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert not catalog_path.exists()
