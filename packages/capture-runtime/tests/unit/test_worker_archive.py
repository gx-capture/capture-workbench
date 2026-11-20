from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import json
import os
import struct
import sys
import zipfile
import zlib
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

import pytest

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.provisioning.infrastructure import (
    engine_installation as engine_installation_module,
)
from capture_runtime.provisioning.infrastructure.engine_catalog import EngineArtifactDescriptor
from capture_runtime.provisioning.infrastructure.engine_installation import safe_extract_artifact

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "worker_archive.py"


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
            "requirementId": "text-recognition",
            "artifactVersion": RUNTIME_VERSION,
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


def test_worker_archive_rejects_what_the_installer_would_reject(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "worker"
    source.mkdir()
    for index in range(3):
        (source / f"file-{index}.bin").write_bytes(b"x")

    monkeypatch.setattr(worker_archive, "MAX_ARCHIVE_FILES", 3)
    with pytest.raises(ValueError, match="more files than the installer accepts"):
        worker_archive.build_worker_archive(
            source, tmp_path / "files.zip", tmp_path / "files-manifest.json"
        )

    monkeypatch.setattr(worker_archive, "MAX_ARCHIVE_FILES", 8192)
    monkeypatch.setattr(worker_archive, "MAX_FILES_MANIFEST_BYTES", 256)
    with pytest.raises(ValueError, match="manifest is larger than the installer accepts"):
        worker_archive.build_worker_archive(
            source, tmp_path / "manifest.zip", tmp_path / "files-manifest.json"
        )
    assert not (tmp_path / "manifest.zip").exists()


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


def test_worker_archive_is_reproducible(tmp_path: Path) -> None:
    source = tmp_path / "worker"
    source.mkdir()
    # Real source text: unlike a repeating byte pattern, levels 6 and 9 compress
    # it to different bytes, so the level check below can fail.
    payload = Path(engine_installation_module.__file__).read_bytes()
    level_6, level_9 = (zlib.compressobj(level=level, wbits=-15) for level in (6, 9))
    assert (
        level_6.compress(payload) + level_6.flush() != level_9.compress(payload) + level_9.flush()
    )
    (source / "worker.exe").write_bytes(payload)
    archives = [tmp_path / "first.zip", tmp_path / "second.zip"]
    manifests = [tmp_path / "first.json", tmp_path / "second.json"]
    for archive, manifest in zip(archives, manifests, strict=True):
        worker_archive.build_worker_archive(source, archive, manifest)
    assert archives[0].read_bytes() == archives[1].read_bytes()
    assert manifests[0].read_bytes() == manifests[1].read_bytes()
    with zipfile.ZipFile(archives[0]) as packaged:
        for entry in packaged.infolist():
            assert entry.create_system == 0
            assert entry.date_time == (1980, 1, 1, 0, 0, 0)
            assert entry.external_attr == 0o100644 << 16
            assert entry.compress_type == zipfile.ZIP_DEFLATED
            # The level is not stored in ZIP metadata: check the compressed bytes.
            compressor = zlib.compressobj(level=worker_archive.ZIP_COMPRESSLEVEL, wbits=-15)
            expected = compressor.compress(packaged.read(entry)) + compressor.flush()
            raw = archives[0].read_bytes()
            name_length, extra_length = struct.unpack_from("<HH", raw, entry.header_offset + 26)
            offset = entry.header_offset + 30 + name_length + extra_length
            assert raw[offset : offset + entry.compress_size] == expected


def test_worker_build_environment_overrides_without_mutating_parent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "999")
    monkeypatch.setenv("PYTHONHASHSEED", "random")
    monkeypatch.setenv("WORKER_BUILD_TEST", "preserved")
    environment = worker_archive.worker_build_environment()
    assert environment["SOURCE_DATE_EPOCH"] == "315532800"
    assert environment["PYTHONHASHSEED"] == "0"
    assert environment["WORKER_BUILD_TEST"] == "preserved"
    assert os.environ["SOURCE_DATE_EPOCH"] == "999"
    assert os.environ["PYTHONHASHSEED"] == "random"


@pytest.mark.parametrize(
    "name", ["ocr", "speech_recognition", "speech_recognition_cpu", "diarization"]
)
def test_worker_builder_passes_fixed_child_environment(
    name: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    spec = importlib.util.spec_from_file_location(
        f"build_{name}_worker", SCRIPT_PATH.with_name(f"build_{name}_worker.py")
    )
    assert spec is not None and spec.loader is not None
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    monkeypatch.setattr(builder, "__file__", str(tmp_path / "scripts" / "build_worker.py"))
    monkeypatch.setattr(builder.sys, "version_info", (3, 13))
    monkeypatch.setattr(builder.platform, "system", lambda: "Windows")
    monkeypatch.setattr(builder.platform, "machine", lambda: "AMD64")
    monkeypatch.setenv("SOURCE_DATE_EPOCH", "999")
    monkeypatch.setenv("PYTHONHASHSEED", "random")
    run = Mock()
    monkeypatch.setattr(builder.subprocess, "run", run)
    monkeypatch.setattr(builder, "build_worker_archive", Mock())
    builder.main()
    run.assert_called_once()
    assert run.call_args.args[0][1:3] == ["-m", "PyInstaller"]
    assert run.call_args.kwargs["env"]["SOURCE_DATE_EPOCH"] == "315532800"
    assert run.call_args.kwargs["env"]["PYTHONHASHSEED"] == "0"
