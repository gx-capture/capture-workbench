from __future__ import annotations

import os
import sys
import time
from pathlib import Path

import pytest

import capture_runtime._frozen_extraction_residue as residue
from capture_runtime._frozen_extraction_residue import (
    MINIMUM_AGE_SECONDS,
    start_stale_extraction_sweep,
    sweep_stale_extractions,
)

NOW = 2_000_000_000.0
OLD = NOW - MINIMUM_AGE_SECONDS - 60


def extraction(parent: Path, name: str, *, capture: bool = True, mtime: float = OLD) -> Path:
    root = parent / name
    (root / ("capture_runtime" if capture else "other_app")).mkdir(parents=True)
    (root / "base_library.zip").write_bytes(b"zip")
    (root / "python312.dll").write_bytes(b"dll")
    os.utime(root, (mtime, mtime))
    return root


def test_sweep_removes_dead_capture_extractions_but_never_the_current_one(
    tmp_path: Path,
) -> None:
    current = extraction(tmp_path, "_MEI4242")
    dead = [extraction(tmp_path, "_MEI1001"), extraction(tmp_path, "_MEI0000d142")]

    assert sweep_stale_extractions(current, now=NOW) == 2

    assert current.is_dir()
    assert not any(path.exists() for path in dead)
    assert sorted(path.name for path in tmp_path.iterdir()) == ["_MEI4242"]


def test_sweep_keeps_foreign_young_and_unrelated_entries(tmp_path: Path) -> None:
    current = extraction(tmp_path, "_MEI4242")
    foreign = extraction(tmp_path, "_MEI1001", capture=False)
    young = extraction(tmp_path, "_MEI1002", mtime=NOW - 5)
    unrelated = extraction(tmp_path, "capture-runtime-data")
    loose_file = tmp_path / "_MEI1003"
    loose_file.write_bytes(b"not a directory")

    assert sweep_stale_extractions(current, now=NOW) == 0

    assert all(path.exists() for path in (foreign, young, unrelated, loose_file))


def test_sweep_keeps_an_extraction_that_a_live_process_still_holds(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = extraction(tmp_path, "_MEI4242")
    held = extraction(tmp_path, "_MEI1001")
    dead = extraction(tmp_path, "_MEI1002")
    original_rename = Path.rename

    def rename(path: Path, target: Path) -> Path:
        if path == held:
            raise PermissionError("in use")
        return original_rename(path, target)

    monkeypatch.setattr(Path, "rename", rename)

    assert sweep_stale_extractions(current, now=NOW) == 1

    assert held.is_dir()
    assert not dead.exists()


@pytest.mark.skipif(sys.platform != "win32", reason="Windows rename semantics")
def test_windows_refuses_to_rename_an_extraction_with_an_open_file(tmp_path: Path) -> None:
    current = extraction(tmp_path, "_MEI4242")
    held = extraction(tmp_path, "_MEI1001")

    with (held / "python312.dll").open("rb"):
        assert sweep_stale_extractions(current, now=NOW) == 0
        assert held.is_dir()

    assert sweep_stale_extractions(current, now=NOW) == 1
    assert not held.exists()


def test_sweep_finishes_a_tombstone_left_by_an_interrupted_sweep(tmp_path: Path) -> None:
    current = extraction(tmp_path, "_MEI4242")
    tombstone = extraction(tmp_path, "_MEI1001.capture-stale", mtime=NOW)
    foreign_tombstone = extraction(tmp_path, "_MEI1002.capture-stale", capture=False)

    assert sweep_stale_extractions(current, now=NOW) == 1

    assert not tombstone.exists()
    assert foreign_tombstone.is_dir()


def test_sweep_continues_after_one_removal_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    current = extraction(tmp_path, "_MEI4242")
    extraction(tmp_path, "_MEI1001")
    extraction(tmp_path, "_MEI1002")
    original_rmtree = residue.shutil.rmtree
    calls: list[str] = []

    def rmtree(path: Path) -> None:
        calls.append(Path(path).name)
        if len(calls) == 1:
            raise PermissionError("antivirus scan")
        original_rmtree(path)

    monkeypatch.setattr(residue.shutil, "rmtree", rmtree)

    assert sweep_stale_extractions(current, now=NOW) == 1
    assert len(calls) == 2


def test_background_sweep_runs_only_from_a_onefile_extraction(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.delattr(sys, "_MEIPASS", raising=False)
    assert start_stale_extraction_sweep() is None

    onedir = tmp_path / "capture-runtime" / "_internal"
    onedir.mkdir(parents=True)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(onedir), raising=False)
    assert start_stale_extraction_sweep() is None

    current = extraction(tmp_path, "_MEI4242", mtime=time.time())
    dead = extraction(tmp_path, "_MEI1001", mtime=time.time() - MINIMUM_AGE_SECONDS - 60)
    monkeypatch.setattr(sys, "_MEIPASS", str(current), raising=False)
    thread = start_stale_extraction_sweep()

    assert thread is not None and thread.daemon
    thread.join(timeout=10)
    assert not dead.exists()
    assert current.is_dir()
