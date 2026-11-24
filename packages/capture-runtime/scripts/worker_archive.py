from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import stat
import zipfile
from pathlib import Path

from capture_runtime.artifact_parts import JoinedParts, archive_parts, split_archive
from capture_runtime.provisioning.infrastructure._engine_installation_artifacts import (
    entry_is_regular_or_directory,
    validated_zip_path,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    MAX_ARCHIVE_FILES,
    MAX_FILES_MANIFEST_BYTES,
)

ZIP_TIMESTAMP = (1980, 1, 1, 0, 0, 0)
# zlib's default level, stated explicitly: writestr() with a prebuilt ZipInfo
# ignores ZipFile(compresslevel=...). A higher level would slow the multi-GB
# speech worker archive for little gain.
ZIP_COMPRESSLEVEL = 6


def worker_build_environment() -> dict[str, str]:
    # PyInstaller otherwise stamps the PE header with the build time; Python hash
    # randomisation can change ordering. Override inherited values in the child only.
    return {**os.environ, "SOURCE_DATE_EPOCH": "315532800", "PYTHONHASHSEED": "0"}


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def build_worker_archive(source: Path, archive: Path, manifest_output: Path) -> None:
    files = sorted(
        (
            (item.relative_to(source).as_posix(), item)
            for item in source.rglob("*")
            if item.is_file()
        ),
        key=lambda entry: entry[0],
    )
    if not files:
        raise ValueError(f"worker directory is empty: {source}")
    if len(files) + 1 > MAX_ARCHIVE_FILES:
        raise ValueError(f"worker has more files than the installer accepts: {len(files)}")
    folded_paths: set[str] = set()
    for relative, _item in files:
        folded = relative.casefold()
        if folded in folded_paths:
            raise ValueError(f"worker directory contains a case-colliding path: {relative}")
        folded_paths.add(folded)
    manifest = {
        "manifestVersion": "1",
        "files": [
            {
                "path": relative,
                "bytes": item.stat().st_size,
                "sha256": sha256_file(item),
            }
            for relative, item in files
        ],
    }
    manifest_bytes = canonical_json_bytes(manifest)
    if len(manifest_bytes) > MAX_FILES_MANIFEST_BYTES:
        raise ValueError(
            f"worker files manifest is larger than the installer accepts: {len(manifest_bytes)}"
        )
    manifest_output.parent.mkdir(parents=True, exist_ok=True)
    manifest_output.write_bytes(manifest_bytes)
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(
        archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=ZIP_COMPRESSLEVEL
    ) as destination:
        for relative, item in files:
            info = zipfile.ZipInfo(relative, ZIP_TIMESTAMP)
            # MS-DOS creator (the win32 default, stated so other hosts match). The
            # Unix mode bits stay: the installer's regular-file check reads them.
            info.create_system = 0
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            destination.writestr(
                info,
                item.read_bytes(),
                compress_type=zipfile.ZIP_DEFLATED,
                compresslevel=ZIP_COMPRESSLEVEL,
            )
        info = zipfile.ZipInfo("files-manifest.json", ZIP_TIMESTAMP)
        info.create_system = 0
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        destination.writestr(
            info,
            manifest_bytes,
            compress_type=zipfile.ZIP_DEFLATED,
            compresslevel=ZIP_COMPRESSLEVEL,
        )
    # One release asset must stay under 2 GB; larger archives ship as parts.
    split_archive(archive)


def _is_link(info: os.stat_result) -> bool:
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
    )


def _tree_matches(root: Path, expected: dict[str, tuple[int, str]]) -> bool:
    if not root.is_dir():
        return False
    found: set[str] = set()
    pending = [root]
    while pending:
        for item in pending.pop().iterdir():
            info = item.lstat()
            if _is_link(info):
                return False
            if stat.S_ISDIR(info.st_mode):
                pending.append(item)
                continue
            relative = item.relative_to(root).as_posix()
            match = expected.get(relative)
            if not stat.S_ISREG(info.st_mode) or match is None:
                return False
            size, digest = match
            if info.st_size != size or sha256_file(item) != digest:
                return False
            found.add(relative)
    return found == expected.keys()


def ensure_worker_tree(project_root: Path, executable: Path, archive: Path, manifest: Path) -> None:
    """Keep an exact onedir tree or restore it from the published worker ZIP."""
    stem = executable.stem
    if (
        not re.fullmatch(r"capture-engine-[a-z0-9]+(?:-[a-z0-9]+)*", stem)
        or executable.suffix != ".exe"
    ):
        raise ValueError(f"invalid worker executable: {executable}")
    project_root = project_root.absolute()
    if project_root.resolve() != project_root or _is_link(project_root.lstat()):
        raise ValueError(f"project root must be a plain directory: {project_root}")
    dist = project_root / "dist"
    workers = dist / "workers"
    tree = workers / stem
    if executable.absolute() != tree / f"{stem}.exe":
        raise ValueError(f"worker executable must be in {tree}: {executable}")
    for directory in (dist, workers, tree):
        try:
            directory_info = directory.lstat()
        except FileNotFoundError:
            break
        if _is_link(directory_info) or not stat.S_ISDIR(directory_info.st_mode):
            raise ValueError(f"worker path must be a plain directory: {directory}")

    manifest_bytes = manifest.read_bytes()
    expected = {
        validated_zip_path(entry["path"]).as_posix(): (entry["bytes"], entry["sha256"])
        for entry in json.loads(manifest_bytes)["files"]
    }
    if executable.name not in expected:
        raise ValueError(f"worker manifest is missing {executable.name}")
    if _tree_matches(tree, expected):
        return

    with JoinedParts(archive_parts(archive.parent, archive.name)) as parts:
        with zipfile.ZipFile(parts) as packaged:
            entries = {}
            for info in packaged.infolist():
                path = validated_zip_path(info.filename).as_posix()
                if path in entries or info.is_dir() or not entry_is_regular_or_directory(info):
                    raise ValueError(f"invalid worker archive entry: {info.filename}")
                entries[path] = info
            embedded_manifest = entries.pop("files-manifest.json")
            if (
                entries.keys() != expected.keys()
                or embedded_manifest.file_size != len(manifest_bytes)
                or packaged.read(embedded_manifest) != manifest_bytes
                or any(info.file_size != expected[path][0] for path, info in entries.items())
            ):
                raise ValueError(f"worker archive does not match {manifest}")

            if tree.exists():
                # Python 3.13's rmtree removes nested links and junctions without traversing them.
                shutil.rmtree(tree)
            tree.mkdir(parents=True)
            for path, info in entries.items():
                destination = tree / path
                destination.parent.mkdir(parents=True, exist_ok=True)
                with packaged.open(info) as source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output, length=1024 * 1024)

    if not _tree_matches(tree, expected):
        raise ValueError(f"restored worker tree does not match {manifest}")


__all__ = ["build_worker_archive", "canonical_json_bytes", "ensure_worker_tree", "sha256_file"]
