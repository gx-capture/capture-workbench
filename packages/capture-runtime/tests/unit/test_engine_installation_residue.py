"""Uninstall reports files in use only for a real sharing or lock violation."""

from __future__ import annotations

from pathlib import Path

import pytest

from capture_runtime.provisioning.infrastructure._engine_installation_residue import (
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
