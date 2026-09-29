from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

from capture_runtime._engine_download_cache import (
    CachingDownloader,
    VerifiedDownloadCache,
    default_cache_root,
    with_shared_cache,
)

PAYLOAD = b"engine worker bytes" * 1000


@dataclass(frozen=True)
class Descriptor:
    sha256: str
    bytes: int


class CountingDownloader:
    def __init__(self, payload: bytes = PAYLOAD, *, fail: bool = False) -> None:
        self.payload = payload
        self.fail = fail
        self.calls = 0

    async def download(self, descriptor, destination, *, cancel_event, progress) -> None:
        self.calls += 1
        if self.fail:
            raise RuntimeError("network down")
        destination.write_bytes(self.payload)
        progress(len(self.payload))


def descriptor(payload: bytes = PAYLOAD) -> Descriptor:
    return Descriptor(sha256=hashlib.sha256(payload).hexdigest(), bytes=len(payload))


def fetch(downloader, destination: Path, item: Descriptor | None = None) -> list[int]:
    reported: list[int] = []
    asyncio.run(
        downloader.download(
            item or descriptor(),
            destination,
            cancel_event=asyncio.Event(),
            progress=reported.append,
        )
    )
    return reported


def test_second_download_is_served_from_the_cache(tmp_path: Path) -> None:
    inner = CountingDownloader()
    downloader = CachingDownloader(inner, VerifiedDownloadCache(tmp_path / "cache"))

    fetch(downloader, tmp_path / "first.zip")
    reported = fetch(downloader, tmp_path / "second.zip")

    assert inner.calls == 1
    assert (tmp_path / "second.zip").read_bytes() == PAYLOAD
    assert reported[-1] == len(PAYLOAD)


def test_a_tampered_entry_is_discarded_and_downloaded_again(tmp_path: Path) -> None:
    inner = CountingDownloader()
    cache_root = tmp_path / "cache"
    downloader = CachingDownloader(inner, VerifiedDownloadCache(cache_root))
    fetch(downloader, tmp_path / "first.zip")
    entry = cache_root / descriptor().sha256[:2] / descriptor().sha256
    entry.write_bytes(b"x" * len(PAYLOAD))

    fetch(downloader, tmp_path / "second.zip")

    assert inner.calls == 2
    assert (tmp_path / "second.zip").read_bytes() == PAYLOAD
    assert entry.read_bytes() == PAYLOAD


def test_a_failed_download_is_not_cached(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    downloader = CachingDownloader(CountingDownloader(fail=True), VerifiedDownloadCache(cache_root))

    with pytest.raises(RuntimeError, match="network down"):
        fetch(downloader, tmp_path / "artifact.zip")

    assert not any(path.is_file() for path in cache_root.rglob("*"))


def test_idle_entries_are_evicted_when_a_new_entry_is_stored(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    cache = VerifiedDownloadCache(cache_root, max_idle_seconds=60)
    old_payload = b"old release"
    downloader = CachingDownloader(CountingDownloader(old_payload), cache)
    fetch(downloader, tmp_path / "old.zip", descriptor(old_payload))
    old_entry = cache_root / descriptor(old_payload).sha256[:2] / descriptor(old_payload).sha256
    stale = time.time() - 3600
    os.utime(old_entry, (stale, stale))

    fetch(CachingDownloader(CountingDownloader(), cache), tmp_path / "new.zip")

    assert not old_entry.exists()


def test_cache_root_honors_the_override_and_can_be_disabled(tmp_path: Path) -> None:
    assert default_cache_root({"CAPTURE_ENGINE_CACHE_DIR": str(tmp_path)}) == tmp_path
    assert default_cache_root({"CAPTURE_ENGINE_CACHE_DIR": "off"}) is None
    assert default_cache_root({"LOCALAPPDATA": str(tmp_path)}) == (
        tmp_path / "gx-capture" / "engine-cache"
    )
    inner = CountingDownloader()
    assert with_shared_cache(inner, {"CAPTURE_ENGINE_CACHE_DIR": "off"}) is inner
