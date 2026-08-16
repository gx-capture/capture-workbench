from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import sys
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

from capture_runtime.engine_catalog import EngineArtifactDescriptor
from capture_runtime.engine_installation import safe_extract_artifact

SCRIPT_PATH = Path(__file__).resolve().parents[1] / "scripts" / "worker_archive.py"


def _load_worker_archive() -> ModuleType:
    spec = importlib.util.spec_from_file_location("worker_archive", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


worker_archive = _load_worker_archive()


def _descriptor(archive: Path, manifest: bytes) -> EngineArtifactDescriptor:
    with zipfile.ZipFile(archive) as source:
        extracted_bytes = sum(item.file_size for item in source.infolist())
    return EngineArtifactDescriptor.from_dict(
        {
            "role": "worker",
            "requirementId": "windowsml-ocr",
            "artifactVersion": "0.4.1",
            "workerProtocolVersion": "1",
            "platform": "windows",
            "arch": "x86_64",
            "fileName": archive.name,
            "bytes": archive.stat().st_size,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "extractedBytes": extracted_bytes,
            "entryPoint": "capture-engine-test.exe",
            "filesManifestSha256": hashlib.sha256(manifest).hexdigest(),
            "url": f"https://downloads.example.test/{archive.name}",
        }
    )


def test_worker_archive_uses_installer_ordinal_path_order(tmp_path: Path) -> None:
    source = tmp_path / "worker"
    (source / "_internal" / "package.dist-info" / "licenses").mkdir(parents=True)
    (source / "capture-engine-test.exe").write_bytes(b"worker")
    (source / "_internal" / "package.dist-info" / "licenses" / "LICENSE").write_bytes(b"license")
    (source / "_internal" / "package.dist-info" / "METADATA").write_bytes(b"metadata")
    archive = tmp_path / "worker.zip"
    manifest_path = tmp_path / "files-manifest.json"

    worker_archive.build_worker_archive(source, archive, manifest_path)

    manifest = manifest_path.read_bytes()
    paths = [entry["path"] for entry in json.loads(manifest)["files"]]
    assert paths == sorted(paths)
    assert paths.index("_internal/package.dist-info/METADATA") < paths.index(
        "_internal/package.dist-info/licenses/LICENSE"
    )
    with zipfile.ZipFile(archive) as packaged:
        assert packaged.namelist() == [*paths, "files-manifest.json"]
    destination = tmp_path / "installed"
    safe_extract_artifact(
        archive,
        destination,
        _descriptor(archive, manifest),
        cancel_event=asyncio.Event(),
    )
    assert (destination / "capture-engine-test.exe").read_bytes() == b"worker"


def test_worker_archive_rejects_case_collisions(tmp_path: Path) -> None:
    source = tmp_path / "worker"
    source.mkdir()
    (source / "Worker.exe").write_bytes(b"upper")
    try:
        (source / "worker.exe").write_bytes(b"lower")
    except OSError:
        pytest.skip("filesystem does not support case-distinct paths")
    if len(list(source.iterdir())) < 2:
        pytest.skip("filesystem does not support case-distinct paths")

    with pytest.raises(ValueError, match="case-colliding path"):
        worker_archive.build_worker_archive(
            source,
            tmp_path / "worker.zip",
            tmp_path / "files-manifest.json",
        )
