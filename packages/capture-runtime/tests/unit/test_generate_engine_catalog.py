from __future__ import annotations

import hashlib
import json
import os
import shlex
import subprocess
import sys
import zipfile
from pathlib import Path
from typing import Any

from capture_runtime.artifact_parts import split_archive
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    EngineCatalog,
    canonical_json_bytes,
)
from capture_runtime.release import build_release_artifacts, write_capture_document_schema
from tests.direct_model_fixtures import approved_source_lock, pending_source_lock

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "generate_engine_catalog.py"


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
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    speech_recognition_worker, speech_recognition_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition.exe",
    )
    cpu_speech_worker, cpu_speech_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-cpu-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition-cpu.exe",
    )
    source_lock, _content = approved_source_lock()
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    environment = dict(os.environ)
    environment["CAPTURE_OCR_MODEL_ARCHIVE"] = str(tmp_path / "ambient-model.zip")
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[2] / "src")
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
            "--speech-recognition-worker-archive",
            str(speech_recognition_worker),
            "--speech-recognition-worker-manifest",
            str(speech_recognition_worker_manifest),
            "--speech-recognition-cpu-worker-archive",
            str(cpu_speech_worker),
            "--speech-recognition-cpu-worker-manifest",
            str(cpu_speech_worker_manifest),
        ],
        env=environment,
        stdin=subprocess.DEVNULL,
        shell=False,
        check=True,
    )

    catalog = EngineCatalog.from_dict(json.loads(catalog_path.read_text(encoding="utf-8")))
    assert catalog.catalog_version == "2"
    deliveries = {
        requirement.requirement_id: requirement.contents or (requirement,)
        for requirement in catalog.requirements
    }
    assert all(delivery.complete for items in deliveries.values() for delivery in items)
    # The vertical reader is models only; every other delivery has one worker.
    assert {
        requirement_id: [[artifact.role for artifact in item.artifacts] for item in items]
        for requirement_id, items in deliveries.items()
    } == {
        "windowsml-ocr": [["worker"]],
        "speech-recognition": [["worker"], ["worker"]],
        "vertical-japanese-reader": [[]],
    }
    assert all(
        delivery.model_delivery().files for items in deliveries.values() for delivery in items
    )

    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v2.schema.json")
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
        speech_recognition_worker,
        cpu_speech_worker,
        ocr_worker_manifest,
        speech_recognition_worker_manifest,
        cpu_speech_worker_manifest,
    ):
        assert (release / artifact.name).is_file()
        assert not (release / f"{artifact.name}.sha256").exists()
    assert not list(release.glob("capture-model-*"))


def test_catalog_generation_rejects_first_party_git_blob_drift(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    speech_recognition_worker, speech_recognition_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition.exe",
    )
    source_lock, _content = approved_source_lock()
    provenance = next(
        item
        for item in source_lock["requirements"][0]["files"]
        if item["path"] == "provenance/commit-a.json"
    )
    provenance["sha256"] = "0" * 64
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
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
            "--speech-recognition-worker-archive",
            str(speech_recognition_worker),
            "--speech-recognition-worker-manifest",
            str(speech_recognition_worker_manifest),
        ],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
        stdin=subprocess.DEVNULL,
        shell=False,
        check=False,
        capture_output=True,
        text=True,
    )
    assert result.returncode != 0
    assert "first-party Git blob" in result.stderr
    assert not catalog_path.exists()


def test_pending_source_lock_release_generation_fails_closed(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    speech_recognition_worker, speech_recognition_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition.exe",
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
            "--speech-recognition-worker-archive",
            str(speech_recognition_worker),
            "--speech-recognition-worker-manifest",
            str(speech_recognition_worker_manifest),
        ],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
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
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    speech_recognition_worker, speech_recognition_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition.exe",
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
            "--speech-recognition-worker-archive",
            str(speech_recognition_worker),
            "--speech-recognition-worker-manifest",
            str(speech_recognition_worker_manifest),
        ],
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
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
        "speech-recognition",
        "vertical-japanese-reader",
    ]
    assert all(item.complete for item in catalog.requirements)


def test_pending_preflight_rejects_unrelated_blockers_and_approved_lock(
    tmp_path: Path,
) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    speech_recognition_worker, speech_recognition_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition.exe",
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
                "--speech-recognition-worker-archive",
                str(speech_recognition_worker),
                "--speech-recognition-worker-manifest",
                str(speech_recognition_worker_manifest),
            ],
            env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
            stdin=subprocess.DEVNULL,
            shell=False,
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode != 0
        assert not catalog_path.exists()


def test_split_worker_archive_is_catalogued_as_parts_and_released(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    ocr_worker, ocr_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    speech_worker, speech_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition.exe",
    )
    cpu_worker, cpu_worker_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-cpu-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition-cpu.exe",
    )
    whole = speech_worker.read_bytes()
    parts = split_archive(speech_worker, part_bytes=200)
    source_lock, _content = approved_source_lock()
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(Path(__file__).resolve().parents[2] / "src")
    subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--model-source-lock",
            str(source_lock_path),
            "--output",
            str(catalog_path),
            "--release-base-url",
            "https://example.test/download",
            "--ocr-worker-archive",
            str(ocr_worker),
            "--ocr-worker-manifest",
            str(ocr_worker_manifest),
            "--speech-recognition-worker-archive",
            str(speech_worker),
            "--speech-recognition-worker-manifest",
            str(speech_worker_manifest),
            "--speech-recognition-cpu-worker-archive",
            str(cpu_worker),
            "--speech-recognition-cpu-worker-manifest",
            str(cpu_worker_manifest),
        ],
        env=environment,
        stdin=subprocess.DEVNULL,
        shell=False,
        check=True,
    )

    catalog = EngineCatalog.from_dict(json.loads(catalog_path.read_text(encoding="utf-8")))
    cuda = catalog.requirement("speech-recognition").find_content("cuda")
    assert cuda is not None
    speech = cuda.worker_artifact()
    assert speech.url is None
    assert (speech.bytes, speech.sha256) == (len(whole), hashlib.sha256(whole).hexdigest())
    assert [(part.file_name, part.url) for part in speech.parts] == [
        (part.name, f"https://example.test/download/{part.name}") for part in parts
    ]

    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v2.schema.json")
    build_release_artifacts(
        executable=executable,
        schema=schema,
        output_dir=tmp_path / "release",
        engine_dir=engine_dir,
        engine_catalog=catalog_path,
    )
    assert all((tmp_path / "release" / part.name).is_file() for part in parts)


_CPU_MODEL_ROOTS = ("model/aligner", "model/fallback", "model/fallback-architecture")
_PRIMARY_MODEL_ROOTS = ("model/primary", "model/primary-architecture")


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(f"{root}/")


def _cpu_speech_files(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The CPU subset: three model directories plus the license and notice they name."""

    model_paths = {
        item["path"]
        for item in files
        if any(_under(item["path"], root) for root in _CPU_MODEL_ROOTS)
    }
    referenced: set[str] = set()
    for item in files:
        if item["path"] not in model_paths:
            continue
        for key in ("licensePath", "noticePath"):
            referenced_path = item[key]
            if isinstance(referenced_path, str):
                referenced.add(referenced_path)
    chosen = model_paths | referenced
    return [item for item in files if item["path"] in chosen]


def _prepare_speech_engines(engine_dir: Path) -> dict[str, Path]:
    engine_dir.mkdir()
    ocr_archive, ocr_manifest = archive_pair(
        engine_dir,
        f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-ocr.exe",
    )
    speech_archive, speech_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition.exe",
    )
    cpu_archive, cpu_manifest = archive_pair(
        engine_dir,
        f"capture-engine-speech-recognition-cpu-{RUNTIME_VERSION}-windows-x64.zip",
        "capture-engine-speech-recognition-cpu.exe",
    )
    return {
        "ocr_archive": ocr_archive,
        "ocr_manifest": ocr_manifest,
        "speech_archive": speech_archive,
        "speech_manifest": speech_manifest,
        "cpu_archive": cpu_archive,
        "cpu_manifest": cpu_manifest,
    }


def _run_catalog(
    engines: dict[str, Path],
    source_lock_path: Path,
    catalog_path: Path,
    *,
    include_cpu: bool,
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(SCRIPT_PATH),
        "--model-source-lock",
        str(source_lock_path),
        "--output",
        str(catalog_path),
        "--ocr-worker-archive",
        str(engines["ocr_archive"]),
        "--ocr-worker-manifest",
        str(engines["ocr_manifest"]),
        "--speech-recognition-worker-archive",
        str(engines["speech_archive"]),
        "--speech-recognition-worker-manifest",
        str(engines["speech_manifest"]),
    ]
    if include_cpu:
        command.extend(
            [
                "--speech-recognition-cpu-worker-archive",
                str(engines["cpu_archive"]),
                "--speech-recognition-cpu-worker-manifest",
                str(engines["cpu_manifest"]),
            ]
        )
    return subprocess.run(
        command,
        env={**os.environ, "PYTHONPATH": str(Path(__file__).resolve().parents[2] / "src")},
        stdin=subprocess.DEVNULL,
        shell=False,
        check=False,
        capture_output=True,
        text=True,
    )


def _speech_requirement(source_lock: dict[str, Any]) -> dict[str, Any]:
    return next(
        item
        for item in source_lock["requirements"]
        if item["requirementId"] == "speech-recognition"
    )


def test_omitting_the_cpu_archive_keeps_the_single_speech_delivery(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engines = _prepare_speech_engines(engine_dir)
    source_lock, _content = approved_source_lock()
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    # The CPU zip is in the engine directory. Only the arguments select it.
    result = _run_catalog(engines, source_lock_path, catalog_path, include_cpu=False)

    assert result.returncode == 0, result.stderr
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    catalog = EngineCatalog.from_dict(payload)
    assert {
        requirement.requirement_id: [artifact.role for artifact in requirement.artifacts]
        for requirement in catalog.requirements
    } == {
        "windowsml-ocr": ["worker"],
        "speech-recognition": ["worker"],
        "vertical-japanese-reader": [],
    }
    speech = next(
        item for item in payload["requirements"] if item["requirementId"] == "speech-recognition"
    )
    assert set(speech) == {"requirementId", "artifacts", "modelFiles", "unavailableReason"}
    assert speech["unavailableReason"] is None
    assert [item["entryPoint"] for item in speech["artifacts"]] == [
        "capture-engine-speech-recognition.exe"
    ]
    locked_files = _speech_requirement(source_lock)["files"]
    assert speech["modelFiles"]["files"] == locked_files
    assert any(item["path"] == "model/primary/model.safetensors" for item in locked_files)


def test_cpu_archive_emits_cuda_and_cpu_speech_contents(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engines = _prepare_speech_engines(engine_dir)
    source_lock, _content = approved_source_lock()
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    legacy_path = tmp_path / "legacy" / "capture-engine-catalog.json"
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"
    legacy = _run_catalog(engines, source_lock_path, legacy_path, include_cpu=False)
    generated = _run_catalog(engines, source_lock_path, catalog_path, include_cpu=True)

    assert legacy.returncode == 0, legacy.stderr
    assert generated.returncode == 0, generated.stderr
    legacy_payload = json.loads(legacy_path.read_text(encoding="utf-8"))
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    assert [
        item for item in payload["requirements"] if item["requirementId"] != "speech-recognition"
    ] == [
        item
        for item in legacy_payload["requirements"]
        if item["requirementId"] != "speech-recognition"
    ]
    legacy_speech = next(
        item
        for item in legacy_payload["requirements"]
        if item["requirementId"] == "speech-recognition"
    )
    speech = next(
        item for item in payload["requirements"] if item["requirementId"] == "speech-recognition"
    )
    assert set(speech) == {"requirementId", "contents"}
    assert [item["id"] for item in speech["contents"]] == ["cuda", "cpu"]
    cuda, cpu = speech["contents"]
    assert cuda["artifacts"] == legacy_speech["artifacts"]
    assert cuda["modelFiles"] == legacy_speech["modelFiles"]
    assert cuda["unavailableReason"] is None
    assert cpu["unavailableReason"] is None
    assert [item["entryPoint"] for item in cpu["artifacts"]] == [
        "capture-engine-speech-recognition-cpu.exe"
    ]
    assert [item["fileName"] for item in cpu["artifacts"]] == [engines["cpu_archive"].name]
    assert [item["artifactVersion"] for item in cuda["artifacts"]] == [RUNTIME_VERSION]
    assert [item["artifactVersion"] for item in cpu["artifacts"]] == [RUNTIME_VERSION]
    assert cuda["modelFiles"]["artifactVersion"] == RUNTIME_VERSION
    assert cpu["modelFiles"]["artifactVersion"] == RUNTIME_VERSION
    expected = _cpu_speech_files(_speech_requirement(source_lock)["files"])
    assert cpu["modelFiles"]["files"] == expected
    published = {item["path"] for item in cpu["modelFiles"]["files"]}
    assert not any(_under(path, root) for path in published for root in _PRIMARY_MODEL_ROOTS)
    assert "licenses/NOTICE-primary.md" not in published
    assert "licenses/NOTICE-primary-architecture.md" not in published
    assert "licenses/LICENSE-Qwen3-ASR.txt" in published
    assert "licenses/NOTICE-fallback.md" in published
    assert "licenses/NOTICE-fallback-architecture.md" in published
    assert "licenses/NOTICE-aligner.md" in published
    parsed = EngineCatalog.from_dict(payload)
    cpu_content = parsed.requirement("speech-recognition").find_content("cpu")
    assert cpu_content is not None
    assert cpu_content.model_delivery().artifact_version == RUNTIME_VERSION
    assert cpu_content.worker_artifact().artifact_version == RUNTIME_VERSION


def test_cpu_catalog_fails_when_an_expected_speech_path_is_missing(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engines = _prepare_speech_engines(engine_dir)
    source_lock, _content = approved_source_lock()
    speech = _speech_requirement(source_lock)
    speech["files"] = [
        item for item in speech["files"] if item["path"] != "model/fallback/model.safetensors"
    ]
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"

    result = _run_catalog(engines, source_lock_path, catalog_path, include_cpu=True)

    assert result.returncode != 0
    assert "model/fallback/model.safetensors" in result.stderr
    assert not catalog_path.exists()


def test_cpu_catalog_fails_when_a_primary_path_would_be_included(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engines = _prepare_speech_engines(engine_dir)
    source_lock, _content = approved_source_lock()
    speech = _speech_requirement(source_lock)
    revision = "a" * 40
    speech["files"].append(
        {
            "bytes": 10,
            "derivation": None,
            "kind": "license",
            "licensePath": None,
            "noticePath": None,
            "owner": "example",
            "path": "model/primary/LICENSE.txt",
            "redirectHosts": [],
            "revision": revision,
            "sha256": "b" * 64,
            "spdx": "Apache-2.0",
            "url": f"https://example.test/license/{revision}",
        }
    )
    speech["files"].sort(key=lambda item: item["path"])
    fallback = next(
        item for item in speech["files"] if item["path"] == "model/fallback/model.safetensors"
    )
    fallback["licensePath"] = "model/primary/LICENSE.txt"
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    catalog_path = tmp_path / "catalog" / "capture-engine-catalog.json"

    result = _run_catalog(engines, source_lock_path, catalog_path, include_cpu=True)

    assert result.returncode != 0
    assert "model/primary/LICENSE.txt" in result.stderr
    assert not catalog_path.exists()


def test_core_only_lock_ignores_a_passed_cpu_speech_archive(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engines = _prepare_speech_engines(engine_dir)
    source_lock, _content = approved_source_lock()
    source_lock["requirements"] = []
    source_lock["fixtures"] = []
    source_lock_path = tmp_path / "model-source-lock.json"
    source_lock_path.write_bytes(canonical_json_bytes(source_lock))
    without_cpu = tmp_path / "without" / "capture-engine-catalog.json"
    with_cpu = tmp_path / "with" / "capture-engine-catalog.json"
    missing = tmp_path / "missing" / "capture-engine-catalog.json"
    omitted = _run_catalog(engines, source_lock_path, without_cpu, include_cpu=False)
    passed = _run_catalog(engines, source_lock_path, with_cpu, include_cpu=True)
    elsewhere = {
        **engines,
        "cpu_archive": tmp_path / "other-dir" / "capture-engine-speech-recognition-cpu.zip",
        "cpu_manifest": (
            tmp_path / "other-dir" / "capture-engine-speech-recognition-cpu-files.json"
        ),
    }
    ignored = _run_catalog(elsewhere, source_lock_path, missing, include_cpu=True)

    assert omitted.returncode == 0, omitted.stderr
    assert passed.returncode == 0, passed.stderr
    assert ignored.returncode == 0, ignored.stderr
    assert without_cpu.read_bytes() == with_cpu.read_bytes() == missing.read_bytes()
    assert json.loads(without_cpu.read_text(encoding="utf-8"))["requirements"] == []


def _release_catalog_target_arguments() -> list[str]:
    """The generator arguments of the Nx ``generate-release-engine-catalog`` target."""

    project = json.loads((SCRIPT_PATH.parents[1] / "project.json").read_text(encoding="utf-8"))
    command = project["targets"]["generate-release-engine-catalog"]["options"]["command"]
    words = shlex.split(command)
    arguments = words[words.index("scripts/generate_engine_catalog.py") + 1 :]
    return [item.replace("{releaseVersion}", RUNTIME_VERSION) for item in arguments]


def test_release_catalog_target_offers_the_cuda_and_cpu_speech_contents(tmp_path: Path) -> None:
    # Run the generator with the target's own arguments, from a package root
    # whose dist/engines holds a fixture for every worker archive it names.
    arguments = _release_catalog_target_arguments()
    options = dict(zip(arguments[::2], arguments[1::2], strict=True))
    engine_dir = tmp_path / "dist" / "engines"
    engine_dir.mkdir(parents=True)
    for flag, value in options.items():
        if flag.endswith("-worker-archive"):
            name = Path(value).name
            archive_pair(engine_dir, name, name.split(f"-{RUNTIME_VERSION}-")[0] + ".exe")
    source_lock, _content = approved_source_lock()
    lock_path = tmp_path / options["--model-source-lock"]
    lock_path.parent.mkdir(parents=True)
    lock_path.write_bytes(canonical_json_bytes(source_lock))

    completed = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), *arguments],
        cwd=tmp_path,
        env={**os.environ, "PYTHONPATH": str(SCRIPT_PATH.parents[1] / "src")},
        stdin=subprocess.DEVNULL,
        shell=False,
        check=False,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 0, completed.stderr
    catalog_path = tmp_path / options["--output"]
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    speech = next(
        item for item in payload["requirements"] if item["requirementId"] == "speech-recognition"
    )
    assert [item["id"] for item in speech["contents"]] == ["cuda", "cpu"]
    # The test lock has no speaker unit, so that archive is not a release file here.
    for path in engine_dir.glob("capture-engine-diarization-*"):
        path.unlink()
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
    cpu_zip = Path(options["--speech-recognition-cpu-worker-archive"]).name
    assert (release / cpu_zip).is_file()
    assert (release / Path(options["--speech-recognition-cpu-worker-manifest"]).name).is_file()
