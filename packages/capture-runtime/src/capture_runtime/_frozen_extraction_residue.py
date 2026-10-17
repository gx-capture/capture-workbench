"""Reclaims onefile extractions left behind by force-terminated runtimes.

The PyInstaller onefile bootloader deletes its ``_MEI*`` extraction only when
the bootloader process itself exits normally. Hosts and harnesses end the
runtime with ``TerminateProcess`` or ``taskkill /F``, so each such launch
leaves a full extraction in the temp directory. A later runtime removes the
ones that no live process holds.
"""

from __future__ import annotations

import logging
import re
import shutil
import sys
import threading
import time
from pathlib import Path

from ._engine_installation_residue import is_reparse_point

_LOGGER = logging.getLogger(__name__)

_EXTRACTION_NAME = re.compile(r"_MEI[0-9A-Za-z]+")
_TOMBSTONE_SUFFIX = ".capture-stale"
# A sibling younger than this may still be extracting, when no file inside is
# open yet and the rename probe below would wrongly succeed.
MINIMUM_AGE_SECONDS = 600.0


def sweep_stale_extractions(
    current: Path,
    *,
    now: float | None = None,
    minimum_age_seconds: float = MINIMUM_AGE_SECONDS,
) -> int:
    """Remove dead Capture extractions next to ``current``; returns how many."""

    parent = current.parent
    checked_at = time.time() if now is None else now
    try:
        entries = list(parent.iterdir())
    except OSError:
        return 0
    removed = 0
    for entry in entries:
        if entry.name == current.name:
            continue
        try:
            if _sweep_entry(entry, checked_at, minimum_age_seconds):
                removed += 1
        except OSError:
            continue
    return removed


def _sweep_entry(entry: Path, now: float, minimum_age_seconds: float) -> bool:
    if entry.name.endswith(_TOMBSTONE_SUFFIX):
        name = entry.name.removesuffix(_TOMBSTONE_SUFFIX)
        if not _EXTRACTION_NAME.fullmatch(name) or not _is_capture_extraction(entry):
            return False
        # A tombstone was already proven unused by its rename.
        shutil.rmtree(entry)
        return True
    if not _EXTRACTION_NAME.fullmatch(entry.name) or not _is_capture_extraction(entry):
        return False
    if now - entry.lstat().st_mtime < minimum_age_seconds:
        return False
    tombstone = entry.with_name(entry.name + _TOMBSTONE_SUFFIX)
    # Windows refuses to rename a directory while any file inside it is open,
    # and a live runtime keeps its extracted python DLL loaded.
    entry.rename(tombstone)
    shutil.rmtree(tombstone)
    return True


def _is_capture_extraction(entry: Path) -> bool:
    metadata = entry.lstat()
    if is_reparse_point(entry, metadata) or not entry.is_dir():
        return False
    return (entry / "capture_runtime").is_dir() and (entry / "base_library.zip").is_file()


def start_stale_extraction_sweep() -> threading.Thread | None:
    """Sweep in the background when running from a onefile bundle."""

    extraction = getattr(sys, "_MEIPASS", None)
    if not getattr(sys, "frozen", False) or not isinstance(extraction, str):
        return None
    current = Path(extraction)
    # Onedir bundles also set _MEIPASS, to an install directory that is not ours to sweep.
    if not _EXTRACTION_NAME.fullmatch(current.name):
        return None
    thread = threading.Thread(
        target=_sweep_quietly,
        args=(current,),
        name="capture-extraction-sweep",
        daemon=True,
    )
    thread.start()
    return thread


def _sweep_quietly(current: Path) -> None:
    removed = sweep_stale_extractions(current)
    if removed:
        _LOGGER.info("Removed %d stale Capture Runtime extraction directories.", removed)
