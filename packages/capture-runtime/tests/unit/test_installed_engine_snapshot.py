"""The installed-engine snapshot that every requirements read compares with the verified one."""

from __future__ import annotations

import os
import shutil
from pathlib import Path

import pytest

from capture_runtime.provisioning.infrastructure._engine_installation_activation import (
    installed_engine_snapshot,
)


def _tree(root: Path) -> tuple[Path, Path]:
    worker = root / "worker"
    model = root / "model"
    for path, content in (
        (worker / "capture-engine.exe", b"worker"),
        (worker / "_internal" / "lib" / "native.dll", b"native"),
        (worker / "_internal" / "lib" / "deeper" / "data.bin", b"data" * 10),
        (model / "weights" / "model.safetensors", b"weights"),
        (model / "tokenizer.json", b"{}"),
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    (worker / "empty-directory").mkdir()
    return worker, model


def _pathlib_snapshot(worker: Path, model: Path) -> tuple[tuple[str, int, int, int], ...]:
    """The snapshot as it was defined before the walk used os.scandir, which records keep."""

    files = []
    for role, root in (("worker", worker), ("model", model)):
        for path in root.rglob("*"):
            if path.is_file():
                metadata = path.stat()
                files.append(
                    (
                        f"{role}/{path.relative_to(root).as_posix()}",
                        metadata.st_size,
                        metadata.st_mtime_ns,
                        metadata.st_ctime_ns,
                    )
                )
    return tuple(sorted(files))


def test_snapshot_lists_every_file_with_the_fields_records_were_written_with(
    tmp_path: Path,
) -> None:
    worker, model = _tree(tmp_path)

    snapshot = installed_engine_snapshot(worker, model)

    assert snapshot == _pathlib_snapshot(worker, model)
    assert [entry[0] for entry in snapshot or ()] == [
        "model/tokenizer.json",
        "model/weights/model.safetensors",
        "worker/_internal/lib/deeper/data.bin",
        "worker/_internal/lib/native.dll",
        "worker/capture-engine.exe",
    ]


def test_snapshot_changes_when_an_installed_file_changes(tmp_path: Path) -> None:
    worker, model = _tree(tmp_path)
    before = installed_engine_snapshot(worker, model)

    (worker / "_internal" / "lib" / "native.dll").write_bytes(b"replaced native library")

    assert installed_engine_snapshot(worker, model) != before


@pytest.mark.parametrize("missing", ["worker", "model"])
def test_snapshot_is_none_without_both_trees(tmp_path: Path, missing: str) -> None:
    worker, model = _tree(tmp_path)
    shutil.rmtree(worker if missing == "worker" else model)

    assert installed_engine_snapshot(worker, model) is None


def test_snapshot_is_none_when_a_root_is_a_file(tmp_path: Path) -> None:
    worker, model = _tree(tmp_path)
    file_root = tmp_path / "not-a-directory"
    file_root.write_bytes(b"")

    assert installed_engine_snapshot(file_root, model) is None
    assert installed_engine_snapshot(worker, file_root) is None


def test_snapshot_is_none_when_a_directory_cannot_be_listed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    worker, model = _tree(tmp_path)
    unreadable = os.fspath(worker / "_internal" / "lib")
    list_directory = os.scandir

    def scandir(path: str):
        if os.fspath(path) == unreadable:
            raise PermissionError(13, "Access is denied", unreadable)
        return list_directory(path)

    monkeypatch.setattr(os, "scandir", scandir)

    assert installed_engine_snapshot(worker, model) is None


def test_snapshot_is_none_for_a_link_inside_a_tree(tmp_path: Path) -> None:
    worker, model = _tree(tmp_path)
    try:
        os.symlink(model / "tokenizer.json", worker / "linked.json")
    except OSError as error:
        pytest.skip(f"this machine cannot create symbolic links: {error}")

    assert installed_engine_snapshot(worker, model) is None
