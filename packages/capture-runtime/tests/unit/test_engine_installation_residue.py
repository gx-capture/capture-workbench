"""Uninstall reports files in use only for a real sharing or lock violation."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

from capture_runtime.provisioning.infrastructure._engine_installation_residue import (
    remove_inactive_versions,
    remove_residue_path,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineFilesInUseError,
    EngineInstallationError,
)


def _refusal(winerror: int | None) -> PermissionError:
    error = PermissionError(13, "refused")
    if winerror is not None:
        error.winerror = winerror  # type: ignore[attr-defined]
    return error


@pytest.mark.parametrize("winerror", [32, 33])
def test_a_sharing_or_lock_violation_means_the_files_are_in_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, winerror: int
) -> None:
    target = tmp_path / "worker.exe"
    target.write_bytes(b"worker")

    def refuse(_self: Path, *_args: object, **_kwargs: object) -> None:
        raise _refusal(winerror)

    monkeypatch.setattr(Path, "unlink", refuse)
    with pytest.raises(EngineFilesInUseError):
        remove_residue_path(target)


@pytest.mark.parametrize("winerror", [5, None])
def test_another_permission_error_is_an_uninstall_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, winerror: int | None
) -> None:
    target = tmp_path / "worker.exe"
    target.write_bytes(b"worker")

    def refuse(_self: Path, *_args: object, **_kwargs: object) -> None:
        raise _refusal(winerror)

    monkeypatch.setattr(Path, "unlink", refuse)
    with pytest.raises(EngineInstallationError) as caught:
        remove_residue_path(target)
    # An access-denied or read-only file is not a file another process holds.
    assert not isinstance(caught.value, EngineFilesInUseError)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows junctions")
@pytest.mark.parametrize("location", ["versions", "old", "child"])
def test_inactive_cleanup_never_follows_junctions(tmp_path: Path, location: str) -> None:
    import _winapi

    root = tmp_path / "unit"
    target = tmp_path / "target"
    target.mkdir()
    sentinel = target / "keep"
    sentinel.write_bytes(b"keep")
    versions = root / "versions"
    link = {"versions": versions, "old": versions / "old", "child": versions / "old" / "link"}[
        location
    ]
    link.parent.mkdir(parents=True)
    _winapi.CreateJunction(str(target), str(link))
    remove_inactive_versions(root, "active")
    assert sentinel.read_bytes() == b"keep"
    if location != "versions":
        assert not link.exists()
    else:
        assert link.is_dir()
        link.rmdir()


def test_inactive_cleanup_continues_after_a_locked_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    old = tmp_path / "versions" / "old"
    old.mkdir(parents=True)
    locked = old / "locked"
    locked.write_bytes(b"locked")
    other = old / "nested" / "removable"
    other.parent.mkdir()
    other.write_bytes(b"remove")
    another = tmp_path / "versions" / "another"
    another.mkdir()
    original_unlink = Path.unlink

    def unlink(path: Path, missing_ok: bool = False) -> None:
        if path == locked:
            raise PermissionError("locked")
        original_unlink(path, missing_ok=missing_ok)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", unlink)
        remove_inactive_versions(tmp_path, "active")
    assert locked.read_bytes() == b"locked"
    assert not other.parent.exists()
    assert not another.exists()
    assert "Inactive version old could not be completely removed" in caplog.text
