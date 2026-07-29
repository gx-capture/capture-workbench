from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def build_worker_archive(source: Path, archive: Path, manifest_output: Path) -> None:
    files = sorted(item for item in source.rglob("*") if item.is_file())
    if not files:
        raise ValueError(f"worker directory is empty: {source}")
    manifest = {
        "manifestVersion": "1",
        "files": [
            {
                "path": item.relative_to(source).as_posix(),
                "bytes": item.stat().st_size,
                "sha256": sha256_file(item),
            }
            for item in files
        ],
    }
    manifest_bytes = canonical_json_bytes(manifest)
    manifest_output.parent.mkdir(parents=True, exist_ok=True)
    manifest_output.write_bytes(manifest_bytes)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9
    ) as destination:
        for item in files:
            relative = item.relative_to(source).as_posix()
            info = zipfile.ZipInfo(relative, ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            destination.writestr(info, item.read_bytes())
        info = zipfile.ZipInfo("files-manifest.json", ZIP_TIMESTAMP)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        destination.writestr(info, manifest_bytes)


__all__ = ["build_worker_archive", "canonical_json_bytes", "sha256_file"]
