"""Machine-wide cache of verified engine and model downloads.

Every Capture host (Capture Workbench, Cert Prep, LAW) runs its own runtime
with its own app data, and tests start from fresh app data. Without a shared
cache each of them downloads the same worker archives and model files again.
Entries are named by their SHA-256 and re-verified on every read, so a
modified or partial entry is discarded instead of installed.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import time
from collections.abc import Callable
from pathlib import Path
from typing import Protocol
from uuid import uuid4

CACHE_DIR_ENV = "CAPTURE_ENGINE_CACHE_DIR"
CACHE_ENTRY_MAX_IDLE_SECONDS = 60 * 24 * 60 * 60
_CHUNK_BYTES = 1024 * 1024
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class _VerifiedDescriptor(Protocol):
    @property
    def sha256(self) -> str: ...

    @property
    def bytes(self) -> int: ...


class _Downloader[Descriptor: _VerifiedDescriptor](Protocol):
    async def download(
        self,
        descriptor: Descriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None: ...


def default_cache_root(environ: dict[str, str] | None = None) -> Path | None:
    """Resolve the cache root, or None when `CAPTURE_ENGINE_CACHE_DIR=off`."""

    source = os.environ if environ is None else environ
    configured = source.get(CACHE_DIR_ENV, "").strip()
    if configured.lower() == "off":
        return None
    if configured:
        return Path(configured)
    local_app_data = source.get("LOCALAPPDATA", "").strip()
    if local_app_data:
        # Short on purpose: Windows MAX_PATH applies to these paths.
        return Path(local_app_data) / "gx-capture" / "engine-cache"
    return Path.home() / ".cache" / "gx-capture" / "engine-cache"


class VerifiedDownloadCache:
    def __init__(
        self, root: Path, *, max_idle_seconds: float = CACHE_ENTRY_MAX_IDLE_SECONDS
    ) -> None:
        self._root = root
        self._max_idle_seconds = max_idle_seconds

    def _entry(self, sha256: str) -> Path | None:
        if not _SHA256.fullmatch(sha256):
            return None
        return self._root / sha256[:2] / sha256

    def restore(
        self,
        sha256: str,
        size: int,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> bool:
        """Copy a matching entry to `destination`; return False on any miss."""

        entry = self._entry(sha256)
        if entry is None or not entry.is_file() or entry.is_symlink():
            return False
        try:
            if entry.stat().st_size != size:
                entry.unlink(missing_ok=True)
                return False
            digest = hashlib.sha256()
            copied = 0
            destination.parent.mkdir(parents=True, exist_ok=True)
            with entry.open("rb") as reader, destination.open("xb") as writer:
                while chunk := reader.read(_CHUNK_BYTES):
                    if cancel_event.is_set():
                        raise asyncio.CancelledError
                    writer.write(chunk)
                    digest.update(chunk)
                    copied += len(chunk)
                    progress(copied)
                writer.flush()
                os.fsync(writer.fileno())
            if copied != size or digest.hexdigest() != sha256:
                destination.unlink(missing_ok=True)
                entry.unlink(missing_ok=True)
                return False
            # A read refreshes the entry so idle eviction keeps it.
            os.utime(entry)
            return True
        except asyncio.CancelledError:
            destination.unlink(missing_ok=True)
            raise
        except OSError:
            destination.unlink(missing_ok=True)
            return False

    def store(self, sha256: str, source: Path) -> None:
        """Keep a copy of already verified bytes. Failures never fail an install."""

        entry = self._entry(sha256)
        if entry is None:
            return
        temporary = entry.with_name(f".{entry.name}.{uuid4().hex}.tmp")
        try:
            entry.parent.mkdir(parents=True, exist_ok=True)
            if not entry.is_file():
                with source.open("rb") as reader, temporary.open("xb") as writer:
                    while chunk := reader.read(_CHUNK_BYTES):
                        writer.write(chunk)
                    writer.flush()
                    os.fsync(writer.fileno())
                os.replace(temporary, entry)
            self._evict_idle(keep=entry)
        except OSError:
            pass
        finally:
            temporary.unlink(missing_ok=True)

    def _evict_idle(self, *, keep: Path) -> None:
        cutoff = time.time() - self._max_idle_seconds
        for path in self._root.glob("*/*"):
            try:
                if path != keep and path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
            except OSError:
                pass


class CachingDownloader[Descriptor: _VerifiedDescriptor]:
    """Serve verified bytes from the shared cache before downloading them."""

    def __init__(self, inner: _Downloader[Descriptor], cache: VerifiedDownloadCache) -> None:
        self._inner = inner
        self._cache = cache

    async def download(
        self,
        descriptor: Descriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None],
    ) -> None:
        if await asyncio.to_thread(
            self._cache.restore,
            descriptor.sha256,
            descriptor.bytes,
            destination,
            cancel_event=cancel_event,
            progress=progress,
        ):
            return
        # The inner downloader verifies byte count and SHA-256 before returning.
        await self._inner.download(
            descriptor,
            destination,
            cancel_event=cancel_event,
            progress=progress,
        )
        await asyncio.to_thread(self._cache.store, descriptor.sha256, destination)


def with_shared_cache[Descriptor: _VerifiedDescriptor](
    downloader: _Downloader[Descriptor], environ: dict[str, str] | None = None
) -> _Downloader[Descriptor]:
    root = default_cache_root(environ)
    return (
        downloader if root is None else CachingDownloader(downloader, VerifiedDownloadCache(root))
    )
