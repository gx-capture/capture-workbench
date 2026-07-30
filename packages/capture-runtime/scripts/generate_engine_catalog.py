from __future__ import annotations

import argparse
import hashlib
import zipfile
from pathlib import Path
from urllib.parse import quote

from model_source_lock import load_source_lock, model_delivery

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


def requirement(
    *,
    requirement_id: str,
    worker_archive: Path,
    worker_manifest: Path,
    worker_entry_point: str,
    direct_model_files: dict[str, object] | None,
    release_base_url: str,
) -> dict[str, object]:
    if direct_model_files is None:
        return {
            "requirementId": requirement_id,
            "artifacts": [],
            "modelFiles": None,
            "unavailableReason": (
                f"An approved exact {requirement_id} direct model source lock "
                "was not supplied at catalog generation time."
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
        ],
        "modelFiles": direct_model_files,
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
    parser.add_argument("--model-source-lock", type=Path)
    parser.add_argument("--require-complete", action="store_true")
    arguments = parser.parse_args()
    if arguments.require_complete and arguments.model_source_lock is None:
        raise SystemExit("release catalog requires an approved exact direct model source lock")
    source_lock = (
        None
        if arguments.model_source_lock is None
        else load_source_lock(arguments.model_source_lock)
    )
    if (
        arguments.whisper_worker_archive.parent.resolve()
        != arguments.ocr_worker_archive.parent.resolve()
    ):
        raise SystemExit("OCR and Whisper worker archives must share one engine directory")
    payload = {
        "catalogVersion": "2",
        "runtimeVersion": RUNTIME_VERSION,
        "requirements": [
            requirement(
                requirement_id="windowsml-ocr",
                worker_archive=arguments.ocr_worker_archive,
                worker_manifest=arguments.ocr_worker_manifest,
                worker_entry_point="capture-engine-ocr.exe",
                direct_model_files=(
                    None if source_lock is None else model_delivery(source_lock, "windowsml-ocr")
                ),
                release_base_url=arguments.release_base_url,
            ),
            requirement(
                requirement_id="whisper-primary",
                worker_archive=arguments.whisper_worker_archive,
                worker_manifest=arguments.whisper_worker_manifest,
                worker_entry_point="capture-engine-whisper.exe",
                direct_model_files=(
                    None if source_lock is None else model_delivery(source_lock, "whisper-primary")
                ),
                release_base_url=arguments.release_base_url,
            ),
        ],
    }
    EngineCatalog.from_dict(payload)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(canonical_json_bytes(payload))


if __name__ == "__main__":
    main()
