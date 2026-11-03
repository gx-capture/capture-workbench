"""Readiness records and model identity shared by every engine worker.

Each engine adapter (OCR, speech recognition, speaker diarization) reports its
readiness as an ``EngineProbe``, fails with ``EngineRuntimeUnavailableError``
when its code or local assets cannot serve a request, and identifies its model
directory by ``directory_digest``. None of this depends on a particular engine.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path


class EngineRuntimeUnavailableError(RuntimeError):
    """Raised when an engine's runtime code or local model assets are unavailable or invalid."""


@dataclass(frozen=True, slots=True)
class EngineProbe:
    ready: bool
    code_ready: bool
    assets_ready: bool
    detail: str
    code_detail: str | None = None
    assets_detail: str | None = None


def directory_digest(root: Path, relative_files: Iterable[str] | None = None) -> str:
    """Hash each file's relative path and bytes; ``relative_files`` fixes the set and order."""

    digest = hashlib.sha256()
    paths = (
        [root / relative for relative in relative_files]
        if relative_files is not None
        else sorted(path for path in root.rglob("*") if path.is_file())
    )
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(path)
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


__all__ = [
    "EngineProbe",
    "EngineRuntimeUnavailableError",
    "directory_digest",
]
