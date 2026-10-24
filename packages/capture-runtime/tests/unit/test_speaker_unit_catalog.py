from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.engine_catalog import (
    EngineCatalog,
    EngineCatalogError,
    canonical_json_bytes,
)
from capture_runtime.release import build_release_artifacts, write_capture_document_schema
from tests.direct_model_fixtures import approved_source_lock

RUNTIME_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = RUNTIME_ROOT / "scripts" / "generate_engine_catalog.py"
REVISION = "e" * 40


def _lock_module() -> Any:
    spec = importlib.util.spec_from_file_location(
        "model_source_lock", RUNTIME_ROOT / "scripts" / "model_source_lock.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _speaker_requirement(requirement_id: str = "speaker-diarization") -> dict[str, Any]:
    def entry(path: str, kind: str) -> dict[str, Any]:
        content = path.encode()
        licensed = kind not in {"license", "notice"}
        return {
            "bytes": len(content),
            "derivation": None,
            "kind": kind,
            "licensePath": "licenses/LICENSE-OpenMDW-1.1.txt" if licensed else None,
            "noticePath": "licenses/NOTICE-speaker-diarization.md" if licensed else None,
            "owner": "example/model-sources",
            "path": path,
            "redirectHosts": [],
            "revision": REVISION,
            "sha256": hashlib.sha256(content).hexdigest(),
            "spdx": "OpenMDW-1.1",
            "url": f"https://downloads.example.test/{REVISION}/{path}",
        }

    return {
        "artifactVersion": RUNTIME_VERSION,
        "entryPoint": "model",
        "files": [
            entry("licenses/LICENSE-OpenMDW-1.1.txt", "license"),
            entry("licenses/NOTICE-speaker-diarization.md", "notice"),
            entry("model/config.json", "source"),
            entry("model/model.safetensors", "source"),
            entry("model/processor_config.json", "source"),
        ],
        "requirementId": requirement_id,
    }


def _lock_with(*speaker_units: dict[str, Any]) -> dict[str, Any]:
    """The required units, then the given ones, then the vertical reader."""

    lock, _content = approved_source_lock()
    required, reader = lock["requirements"][:2], lock["requirements"][2:]
    lock["requirements"] = [*required, *speaker_units, *reader]
    return lock


def test_lock_accepts_the_optional_speaker_unit_after_the_required_ones() -> None:
    module = _lock_module()

    lock = module.validate_source_lock(_lock_with(_speaker_requirement()))

    assert [item["requirementId"] for item in lock["requirements"]] == [
        "windowsml-ocr",
        "whisper-primary",
        "speaker-diarization",
        "vertical-japanese-reader",
    ]
    assert module.model_delivery(lock, "speaker-diarization")["entryCount"] == 5


@pytest.mark.parametrize(
    "requirements",
    [
        lambda base: [base[0], _speaker_requirement(), *base[1:]],
        lambda base: [base[0], _speaker_requirement(), *base[2:]],
        lambda base: [*base, _speaker_requirement("another-unit")],
        lambda base: [*base[:2], _speaker_requirement(), _speaker_requirement(), *base[2:]],
        lambda base: [*base, _speaker_requirement()],
        lambda base: [*base, base[2]],
    ],
    ids=[
        "before-whisper",
        "replacing-whisper",
        "unknown-unit",
        "listed-twice",
        "after-the-reader",
        "reader-twice",
    ],
)
def test_lock_rejects_misplaced_or_unknown_units(requirements: Any) -> None:
    module = _lock_module()
    lock, _content = approved_source_lock()
    lock["requirements"] = requirements(lock["requirements"])

    with pytest.raises(module.ModelSourceLockError):
        module.validate_source_lock(lock)


def _archive(directory: Path, engine: str) -> tuple[Path, Path]:
    import zipfile

    entry_point = f"capture-engine-{engine}.exe"
    payload = engine.encode()
    manifest = canonical_json_bytes(
        {
            "manifestVersion": "1",
            "files": [
                {
                    "path": entry_point,
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                }
            ],
        }
    )
    archive = directory / f"capture-engine-{engine}-{RUNTIME_VERSION}-windows-x64.zip"
    sidecar = directory / f"{archive.stem}-files.json"
    sidecar.write_bytes(manifest)
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("files-manifest.json", manifest)
        output.writestr(entry_point, payload)
    return archive, sidecar


def _generate(tmp_path: Path, lock: dict[str, Any], *, with_speaker_worker: bool) -> Any:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    arguments = [sys.executable, str(SCRIPT_PATH)]
    for engine in ("ocr", "whisper", *(("diarization",) if with_speaker_worker else ())):
        archive, manifest = _archive(engine_dir, engine)
        arguments += [f"--{engine}-worker-archive", str(archive)]
        arguments += [f"--{engine}-worker-manifest", str(manifest)]
    lock_path = tmp_path / "model-source-lock.json"
    lock_path.write_bytes(canonical_json_bytes(lock))
    catalog_path = tmp_path / "catalog.json"
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(RUNTIME_ROOT / "src")
    completed = subprocess.run(
        [*arguments, "--model-source-lock", str(lock_path), "--output", str(catalog_path)],
        env=environment,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        shell=False,
        check=False,
    )
    return completed, catalog_path, engine_dir


def test_catalog_and_release_include_the_speaker_unit_when_the_lock_has_it(
    tmp_path: Path,
) -> None:
    completed, catalog_path, engine_dir = _generate(
        tmp_path, _lock_with(_speaker_requirement()), with_speaker_worker=True
    )

    assert completed.returncode == 0, completed.stderr
    catalog = EngineCatalog.from_dict(json.loads(catalog_path.read_text(encoding="utf-8")))
    unit = catalog.requirement("speaker-diarization")
    assert unit.complete
    assert unit.worker_artifact().entry_point == "capture-engine-diarization.exe"
    assert {
        item.path for item in unit.model_delivery().files if item.path.startswith("model/")
    } == {
        "model/config.json",
        "model/model.safetensors",
        "model/processor_config.json",
    }

    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    release = tmp_path / "release"
    build_release_artifacts(
        executable=executable,
        schema=write_capture_document_schema(tmp_path / "capture-document-v2.schema.json"),
        output_dir=release,
        engine_dir=engine_dir,
        engine_catalog=catalog_path,
    )
    archive = f"capture-engine-diarization-{RUNTIME_VERSION}-windows-x64.zip"
    assert (release / archive).is_file()
    assert (release / f"{archive}.sha256").is_file()


def test_catalog_generation_fails_when_the_locked_unit_has_no_worker_archive(
    tmp_path: Path,
) -> None:
    completed, catalog_path, _engine_dir = _generate(
        tmp_path, _lock_with(_speaker_requirement()), with_speaker_worker=False
    )

    assert completed.returncode != 0
    assert "speaker-diarization" in completed.stderr
    assert not catalog_path.exists()


def test_catalog_leaves_the_unit_out_when_the_lock_does_not_have_it(tmp_path: Path) -> None:
    completed, catalog_path, _engine_dir = _generate(
        tmp_path, _lock_with(), with_speaker_worker=True
    )

    assert completed.returncode == 0, completed.stderr
    catalog = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert [item["requirementId"] for item in catalog["requirements"]] == [
        "windowsml-ocr",
        "whisper-primary",
        "vertical-japanese-reader",
    ]


def test_a_models_only_unit_enters_the_catalog_and_the_release_without_an_archive(
    tmp_path: Path,
) -> None:
    completed, catalog_path, engine_dir = _generate(
        tmp_path, _lock_with(), with_speaker_worker=False
    )

    assert completed.returncode == 0, completed.stderr
    catalog = EngineCatalog.from_dict(json.loads(catalog_path.read_text(encoding="utf-8")))
    unit = catalog.requirement("vertical-japanese-reader")
    assert (unit.complete, unit.model_only, unit.artifacts) == (True, True, ())
    assert unit.model_delivery().entry_count == 9
    # The OCR profile is derived from the reader's files, which this unit delivers.
    profile = next(
        item
        for item in catalog.requirement("windowsml-ocr").model_delivery().files
        if item.kind == "derived"
    )
    assert profile.derivation is not None
    assert {item.path for item in unit.model_delivery().files} >= {
        path for path in profile.derivation["inputs"] if path.startswith("model/vertical/")
    }

    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    release = tmp_path / "release"
    build_release_artifacts(
        executable=executable,
        schema=write_capture_document_schema(tmp_path / "capture-document-v2.schema.json"),
        output_dir=release,
        engine_dir=engine_dir,
        engine_catalog=catalog_path,
    )
    assert sorted(path.name for path in release.glob("capture-engine-*.zip")) == [
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        f"capture-engine-whisper-{RUNTIME_VERSION}-windows-x64.zip",
    ]


def test_lock_orders_both_optional_units_after_the_required_ones() -> None:
    module = _lock_module()
    module.validate_source_lock(_lock_with(_speaker_requirement()))
    module.validate_source_lock(_lock_with())


def test_the_ocr_profile_needs_the_reader_unit_in_the_same_lock_and_catalog() -> None:
    module = _lock_module()
    lock = _lock_with()
    lock["requirements"] = lock["requirements"][:2]

    with pytest.raises(module.ModelSourceLockError):
        module.validate_source_lock(lock)

    catalog = {
        "catalogVersion": "2",
        "runtimeVersion": RUNTIME_VERSION,
        "requirements": [
            {
                "requirementId": "windowsml-ocr",
                "artifacts": [],
                "modelFiles": module.model_delivery(_lock_with(), "windowsml-ocr"),
                "unavailableReason": None,
            }
        ],
    }
    with pytest.raises(EngineCatalogError, match="derivation inputs"):
        EngineCatalog.from_dict(catalog)
