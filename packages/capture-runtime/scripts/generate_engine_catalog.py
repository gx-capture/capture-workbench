from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import zipfile
from pathlib import Path
from urllib.parse import quote

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.engine_catalog import EngineCatalog, canonical_json_bytes
from capture_runtime.worker_contracts import WORKER_PROTOCOL_VERSION


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def descriptor(
    *,
    requirement_id: str,
    role: str,
    archive: Path,
    manifest: Path,
    entry_point: str,
    release_base_url: str,
) -> dict[str, object]:
    if not archive.is_file() or not manifest.is_file():
        raise FileNotFoundError(archive if not archive.is_file() else manifest)
    manifest_bytes = manifest.read_bytes()
    with zipfile.ZipFile(archive) as source:
        inner = source.read("files-manifest.json")
        if inner != manifest_bytes:
            raise ValueError(f"{archive.name} inner files manifest does not match {manifest.name}")
        extracted_bytes = sum(info.file_size for info in source.infolist())
        names = {info.filename.rstrip("/") for info in source.infolist()}
        if entry_point not in names:
            prefix = f"{entry_point.rstrip('/')}/"
            if not any(name.startswith(prefix) for name in names):
                raise ValueError(f"{archive.name} does not contain entryPoint {entry_point}")
    return {
        "role": role,
        "requirementId": requirement_id,
        "artifactVersion": RUNTIME_VERSION,
        "workerProtocolVersion": WORKER_PROTOCOL_VERSION,
        "platform": "windows",
        "arch": "x86_64",
        "fileName": archive.name,
        "bytes": archive.stat().st_size,
        "sha256": sha256_file(archive),
        "extractedBytes": extracted_bytes,
        "entryPoint": entry_point,
        "filesManifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "url": f"{release_base_url.rstrip('/')}/{quote(archive.name)}",
    }


def optional_path(cli_value: Path | None, environment_name: str) -> Path | None:
    if cli_value is not None:
        return cli_value
    value = os.environ.get(environment_name)
    return Path(value) if value else None


def stage_model_pair(
    archive: Path | None,
    manifest: Path | None,
    *,
    engine_dir: Path,
) -> tuple[Path | None, Path | None]:
    if archive is None or manifest is None:
        return None, None
    if not archive.is_file() or not manifest.is_file():
        raise FileNotFoundError(archive if not archive.is_file() else manifest)
    staged: list[Path] = []
    for source in (archive, manifest):
        destination = engine_dir / source.name
        if source.resolve() != destination.resolve():
            if destination.exists() and sha256_file(destination) != sha256_file(source):
                raise ValueError(f"model artifact staging collision: {destination.name}")
            shutil.copy2(source, destination)
        staged.append(destination)
    return staged[0], staged[1]


def requirement(
    *,
    requirement_id: str,
    worker_archive: Path,
    worker_manifest: Path,
    worker_entry_point: str,
    model_archive: Path | None,
    model_manifest: Path | None,
    release_base_url: str,
) -> dict[str, object]:
    if model_archive is None or model_manifest is None:
        return {
            "requirementId": requirement_id,
            "artifacts": [],
            "unavailableReason": (
                f"Exact pinned {requirement_id} model artifact bytes were not supplied "
                "at catalog generation time."
            ),
        }
    return {
        "requirementId": requirement_id,
        "artifacts": [
            descriptor(
                requirement_id=requirement_id,
                role="worker",
                archive=worker_archive,
                manifest=worker_manifest,
                entry_point=worker_entry_point,
                release_base_url=release_base_url,
            ),
            descriptor(
                requirement_id=requirement_id,
                role="model",
                archive=model_archive,
                manifest=model_manifest,
                entry_point="model",
                release_base_url=release_base_url,
            ),
        ],
        "unavailableReason": None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--release-base-url",
        default=(
            f"https://github.com/gx-capture/capture-workbench/releases/download/v{RUNTIME_VERSION}"
        ),
    )
    parser.add_argument("--ocr-worker-archive", type=Path, required=True)
    parser.add_argument("--ocr-worker-manifest", type=Path, required=True)
    parser.add_argument("--whisper-worker-archive", type=Path, required=True)
    parser.add_argument("--whisper-worker-manifest", type=Path, required=True)
    parser.add_argument("--ocr-model-archive", type=Path)
    parser.add_argument("--ocr-model-manifest", type=Path)
    parser.add_argument("--whisper-model-archive", type=Path)
    parser.add_argument("--whisper-model-manifest", type=Path)
    parser.add_argument("--require-complete", action="store_true")
    arguments = parser.parse_args()
    ocr_model_archive = optional_path(arguments.ocr_model_archive, "CAPTURE_OCR_MODEL_ARCHIVE")
    ocr_model_manifest = optional_path(arguments.ocr_model_manifest, "CAPTURE_OCR_MODEL_MANIFEST")
    whisper_model_archive = optional_path(
        arguments.whisper_model_archive, "CAPTURE_WHISPER_MODEL_ARCHIVE"
    )
    whisper_model_manifest = optional_path(
        arguments.whisper_model_manifest, "CAPTURE_WHISPER_MODEL_MANIFEST"
    )
    if (ocr_model_archive is None) != (ocr_model_manifest is None):
        raise SystemExit("OCR model archive and manifest must be supplied together")
    if (whisper_model_archive is None) != (whisper_model_manifest is None):
        raise SystemExit("Whisper model archive and manifest must be supplied together")
    if arguments.require_complete and (ocr_model_archive is None or whisper_model_archive is None):
        raise SystemExit("release catalog requires exact OCR and Whisper model archives/manifests")
    engine_dir = arguments.ocr_worker_archive.parent
    if arguments.whisper_worker_archive.parent.resolve() != engine_dir.resolve():
        raise SystemExit("OCR and Whisper worker archives must share one engine directory")
    ocr_model_archive, ocr_model_manifest = stage_model_pair(
        ocr_model_archive,
        ocr_model_manifest,
        engine_dir=engine_dir,
    )
    whisper_model_archive, whisper_model_manifest = stage_model_pair(
        whisper_model_archive,
        whisper_model_manifest,
        engine_dir=engine_dir,
    )
    payload = {
        "catalogVersion": "1",
        "runtimeVersion": RUNTIME_VERSION,
        "requirements": [
            requirement(
                requirement_id="windowsml-ocr",
                worker_archive=arguments.ocr_worker_archive,
                worker_manifest=arguments.ocr_worker_manifest,
                worker_entry_point="capture-engine-ocr.exe",
                model_archive=ocr_model_archive,
                model_manifest=ocr_model_manifest,
                release_base_url=arguments.release_base_url,
            ),
            requirement(
                requirement_id="whisper-primary",
                worker_archive=arguments.whisper_worker_archive,
                worker_manifest=arguments.whisper_worker_manifest,
                worker_entry_point="capture-engine-whisper.exe",
                model_archive=whisper_model_archive,
                model_manifest=whisper_model_manifest,
                release_base_url=arguments.release_base_url,
            ),
        ],
    }
    EngineCatalog.from_dict(payload)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(canonical_json_bytes(payload))


if __name__ == "__main__":
    main()
