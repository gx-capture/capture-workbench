from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path

import pytest

from capture_runtime.artifact_parts import split_archive
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.provisioning.infrastructure.engine_catalog import canonical_json_bytes
from capture_runtime.release import build_release_artifacts, write_capture_document_schema
from tests.direct_model_fixtures import approved_source_lock


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def artifact(
    engine_dir: Path,
    *,
    requirement_id: str,
    file_name: str,
    entry_point: str,
    part_bytes: int | None = None,
) -> dict[str, object]:
    payload_name = entry_point
    payload = f"{requirement_id}-worker".encode() * (200 if part_bytes else 1)
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
    whole_bytes, whole_sha256 = archive.stat().st_size, sha256(archive)
    url = f"https://example.invalid/v{RUNTIME_VERSION}"
    source: dict[str, object] = {"url": f"{url}/{file_name}"}
    if part_bytes is not None:
        source = {
            "parts": [
                {
                    "fileName": part.name,
                    "bytes": part.stat().st_size,
                    "sha256": sha256(part),
                    "url": f"{url}/{part.name}",
                }
                for part in split_archive(archive, part_bytes=part_bytes)
            ]
        }
    return {
        "role": "worker",
        "requirementId": requirement_id,
        "artifactVersion": RUNTIME_VERSION,
        "workerProtocolVersion": "1",
        "platform": "windows",
        "arch": "x86_64",
        "fileName": file_name,
        "bytes": whole_bytes,
        "sha256": whole_sha256,
        "extractedBytes": extracted_bytes,
        "entryPoint": entry_point,
        "filesManifestSha256": hashlib.sha256(manifest).hexdigest(),
        **source,
    }


def complete_catalog(
    engine_dir: Path,
    catalog_path: Path,
    *,
    speech_part_bytes: int | None = None,
    speech_shape: str = "contents",
) -> None:
    """A release catalog whose speech is the ``cuda`` and ``cpu`` contents by default."""

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
            "speech-recognition",
            "capture-engine-speech-recognition.zip",
            "capture-engine-speech-recognition.exe",
        ),
        # Models only: the OCR profile is derived from this unit's files.
        ("vertical-japanese-reader", None, None),
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
        requirement = {
            "requirementId": requirement_id,
            "artifacts": []
            if worker_name is None or entry_point is None
            else [
                artifact(
                    engine_dir,
                    requirement_id=requirement_id,
                    file_name=worker_name,
                    entry_point=entry_point,
                    part_bytes=(
                        speech_part_bytes if requirement_id == "speech-recognition" else None
                    ),
                ),
            ],
            "modelFiles": {
                "artifactVersion": locked["artifactVersion"],
                "entryCount": len(locked["files"]),
                "entryPoint": locked["entryPoint"],
                "extractedBytes": sum(item["bytes"] for item in locked["files"]),
                "files": locked["files"],
                "manifestSha256": hashlib.sha256(canonical_json_bytes(model_manifest)).hexdigest(),
                "sourceLockSha256": source_lock_sha256,
            },
            "unavailableReason": None,
        }
        if requirement_id == "speech-recognition" and speech_shape != "legacy":
            cuda_delivery = {
                "id": "cuda",
                "artifacts": requirement["artifacts"],
                "modelFiles": requirement["modelFiles"],
                "unavailableReason": None,
            }
            if speech_shape == "incomplete-cpu":
                contents = [
                    cuda_delivery,
                    {
                        "id": "cpu",
                        "artifacts": [],
                        "modelFiles": None,
                        "unavailableReason": "The CPU speech worker archive was not supplied.",
                    },
                ]
            elif speech_shape == "cuda-only":
                contents = [cuda_delivery]
            else:
                cpu_delivery = {
                    "id": "cpu",
                    "artifacts": [
                        artifact(
                            engine_dir,
                            requirement_id=requirement_id,
                            file_name="capture-engine-speech-recognition-cpu.zip",
                            entry_point="capture-engine-speech-recognition-cpu.exe",
                        )
                    ],
                    "modelFiles": requirement["modelFiles"],
                    "unavailableReason": None,
                }
                contents = {
                    "contents": [cuda_delivery, cpu_delivery],
                    "cpu-only": [cpu_delivery],
                }[speech_shape]
            requirements.append({"requirementId": requirement_id, "contents": contents})
        else:
            requirements.append(requirement)
    catalog_path.write_bytes(
        canonical_json_bytes(
            {
                "catalogVersion": "2",
                "runtimeVersion": RUNTIME_VERSION,
                "requirements": requirements,
            }
        )
    )


def test_release_copies_only_catalogued_engine_assets_with_checksums(
    tmp_path: Path,
) -> None:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v2.schema.json")
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
    assert "capture-runtime-manifest.json" in released
    assert not any(
        name.endswith(".sha256") or name == "runtime-size-report.json" for name in released
    )
    assert all(item.name in released for item in engine_dir.iterdir() if item.is_file())


def test_release_rejects_catalog_archive_drift_before_copying(tmp_path: Path) -> None:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v2.schema.json")
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


def test_release_publishes_a_split_worker_archive_as_its_checked_parts(tmp_path: Path) -> None:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v2.schema.json")
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog, speech_part_bytes=300)

    build_release_artifacts(
        executable=executable,
        schema=schema,
        output_dir=tmp_path / "release",
        engine_dir=engine_dir,
        engine_catalog=catalog,
    )

    released = {item.name for item in (tmp_path / "release").iterdir()}
    speech = "capture-engine-speech-recognition.zip"
    assert speech not in released
    assert {f"{speech}.001", f"{speech}.002"} <= released
    assert f"{speech}.001.sha256" not in released
    assert f"{speech}.002.sha256" not in released


def test_release_rejects_a_drifted_archive_part(tmp_path: Path) -> None:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v2.schema.json")
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog, speech_part_bytes=300)
    part = engine_dir / "capture-engine-speech-recognition.zip.002"
    part.write_bytes(b"\x00" * part.stat().st_size)

    with pytest.raises(ValueError, match="part mismatch"):
        build_release_artifacts(
            executable=executable,
            schema=schema,
            output_dir=tmp_path / "release",
            engine_dir=engine_dir,
            engine_catalog=catalog,
        )


def _release_build(tmp_path: Path, engine_dir: Path, catalog: Path) -> set[str]:
    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"runtime")
    schema = write_capture_document_schema(tmp_path / "capture-document-v2.schema.json")
    build_release_artifacts(
        executable=executable,
        schema=schema,
        output_dir=tmp_path / "release",
        engine_dir=engine_dir,
        engine_catalog=catalog,
    )
    return {item.name for item in (tmp_path / "release").iterdir()}


def test_release_accepts_a_contents_catalog_with_both_speech_archives(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog, speech_shape="contents")

    released = _release_build(tmp_path, engine_dir, catalog)

    assert "capture-engine-speech-recognition.zip" in released
    assert "capture-engine-speech-recognition-files.json" in released
    assert "capture-engine-speech-recognition-cpu.zip" in released
    assert "capture-engine-speech-recognition-cpu-files.json" in released


def test_release_rejects_a_contents_catalog_missing_the_cpu_archive(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog, speech_shape="contents")
    (engine_dir / "capture-engine-speech-recognition-cpu.zip").unlink()
    output = tmp_path / "release"

    with pytest.raises(ValueError, match="absent from engine directory"):
        _release_build(tmp_path, engine_dir, catalog)

    assert not output.exists()


def test_release_rejects_an_uncatalogued_zip_beside_a_contents_catalog(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog, speech_shape="contents")
    (engine_dir / "extra.zip").write_bytes(b"extra")

    with pytest.raises(ValueError, match="uncatalogued"):
        _release_build(tmp_path, engine_dir, catalog)


def test_release_rejects_an_incomplete_speech_content(tmp_path: Path) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog, speech_shape="incomplete-cpu")
    output = tmp_path / "release"

    with pytest.raises(ValueError, match="catalog is incomplete"):
        _release_build(tmp_path, engine_dir, catalog)

    assert not output.exists()


@pytest.mark.parametrize("speech_shape", ["legacy", "cuda-only", "cpu-only"])
def test_release_requires_both_speech_contents(tmp_path: Path, speech_shape: str) -> None:
    engine_dir = tmp_path / "engines"
    engine_dir.mkdir()
    catalog = tmp_path / "capture-engine-catalog.json"
    complete_catalog(engine_dir, catalog, speech_shape=speech_shape)
    output = tmp_path / "release"

    with pytest.raises(ValueError, match="speech-recognition as the cuda and cpu contents"):
        _release_build(tmp_path, engine_dir, catalog)

    assert not output.exists()
