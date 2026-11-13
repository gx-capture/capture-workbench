from __future__ import annotations

import asyncio
import hashlib
import os
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import pytest

import capture_runtime.provisioning.infrastructure._engine_download_cache as cache_module
from capture_runtime.provisioning.infrastructure._engine_download_cache import (
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


class PartialDownloader:
    """The second call finishes the partial the first call left beside the destination."""

    def __init__(self) -> None:
        self.destinations: list[Path] = []

    async def download(self, descriptor, destination, *, cancel_event, progress) -> None:
        self.destinations.append(destination)
        partial = destination.with_name(destination.name + ".part")
        if partial.is_file():
            destination.write_bytes(PAYLOAD)
            progress(len(PAYLOAD))
            return
        partial.write_bytes(PAYLOAD[:10])
        raise RuntimeError("interrupted")


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

    assert not any(
        path.is_file() for path in cache_root.glob("*/*") if path.parent.name != ".locks"
    )


def test_idle_entries_are_evicted_when_a_new_entry_is_stored(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    cache = VerifiedDownloadCache(cache_root, max_idle_seconds=60)
    old_payload = b"old release"
    downloader = CachingDownloader(CountingDownloader(old_payload), cache)
    fetch(downloader, tmp_path / "old.zip", descriptor(old_payload))
    old_entry = cache_root / descriptor(old_payload).sha256[:2] / descriptor(old_payload).sha256
    (tmp_path / "old.zip").unlink()  # the install that linked it was removed
    stale = time.time() - 3600
    os.utime(old_entry, (stale, stale))

    fetch(CachingDownloader(CountingDownloader(), cache), tmp_path / "new.zip")

    assert not old_entry.exists()


def test_entries_share_bytes_with_installs_through_hard_links(tmp_path: Path) -> None:
    cache_root = tmp_path / "cache"
    downloader = CachingDownloader(CountingDownloader(), VerifiedDownloadCache(cache_root))
    entry = cache_root / descriptor().sha256[:2] / descriptor().sha256

    fetch(downloader, tmp_path / "first.zip")
    reported = fetch(downloader, tmp_path / "second.zip")

    assert os.path.samefile(tmp_path / "first.zip", entry)
    assert os.path.samefile(tmp_path / "second.zip", entry)
    assert reported[-1] == len(PAYLOAD)


def test_bytes_are_copied_where_links_are_unavailable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_links(*_args: object) -> None:
        raise OSError("cross-device link")

    monkeypatch.setattr(os, "link", no_links)
    inner = CountingDownloader()
    downloader = CachingDownloader(inner, VerifiedDownloadCache(tmp_path / "cache"))

    fetch(downloader, tmp_path / "first.zip")
    fetch(downloader, tmp_path / "second.zip")

    assert inner.calls == 1
    assert (tmp_path / "second.zip").read_bytes() == PAYLOAD
    assert not os.path.samefile(tmp_path / "first.zip", tmp_path / "second.zip")


def test_an_entry_an_install_links_to_is_kept_however_idle(tmp_path: Path) -> None:
    # It costs no space; a worker archive, deleted once extracted, does.
    cache_root = tmp_path / "cache"
    cache = VerifiedDownloadCache(cache_root, max_idle_seconds=60)
    archive, model = b"worker archive", b"model weights"
    for payload, name in ((archive, "archive.zip"), (model, "model.bin")):
        downloader = CachingDownloader(CountingDownloader(payload), cache)
        fetch(downloader, tmp_path / name, descriptor(payload))
    (tmp_path / "archive.zip").unlink()
    entries = {
        payload: cache_root / descriptor(payload).sha256[:2] / descriptor(payload).sha256
        for payload in (archive, model)
    }
    stale = time.time() - 3600
    for entry in entries.values():
        os.utime(entry, (stale, stale))

    fetch(CachingDownloader(CountingDownloader(), cache), tmp_path / "new.zip")

    assert not entries[archive].exists()
    assert entries[model].exists()


def test_cache_root_honors_the_override_and_can_be_disabled(tmp_path: Path) -> None:
    assert default_cache_root({"CAPTURE_ENGINE_CACHE_DIR": str(tmp_path)}) == tmp_path
    assert default_cache_root({"CAPTURE_ENGINE_CACHE_DIR": "off"}) is None
    assert default_cache_root({"LOCALAPPDATA": str(tmp_path)}) == (
        tmp_path / "gx-capture" / "engine-cache"
    )
    inner = CountingDownloader()
    assert with_shared_cache(inner, {"CAPTURE_ENGINE_CACHE_DIR": "off"}) is inner


def test_an_interrupted_download_resumes_inside_the_cache(tmp_path: Path) -> None:
    inner = PartialDownloader()
    cache_root = tmp_path / "cache"
    downloader = CachingDownloader(inner, VerifiedDownloadCache(cache_root))

    with pytest.raises(RuntimeError, match="interrupted"):
        fetch(downloader, tmp_path / "first.zip")

    assert not (tmp_path / "first.zip").exists()
    fetch(downloader, tmp_path / "second.zip")

    assert inner.destinations[0] == inner.destinations[1]
    assert cache_root in inner.destinations[0].parents
    assert (tmp_path / "second.zip").read_bytes() == PAYLOAD
    assert not (tmp_path / "first.zip").exists()


def test_concurrent_downloads_share_one_transfer(tmp_path: Path) -> None:
    class YieldingDownloader(CountingDownloader):
        async def download(self, *args, **kwargs) -> None:
            await asyncio.sleep(0.05)
            await super().download(*args, **kwargs)

    async def run() -> None:
        inner = YieldingDownloader()
        await asyncio.wait_for(
            asyncio.gather(
                *(
                    CachingDownloader(inner, VerifiedDownloadCache(tmp_path / "cache")).download(
                        descriptor(),
                        tmp_path / name,
                        cancel_event=asyncio.Event(),
                        progress=lambda _: None,
                    )
                    for name in ("first", "second")
                )
            ),
            timeout=10,
        )
        assert inner.calls == 1
        for name in ("first", "second"):
            assert (tmp_path / name).read_bytes() == PAYLOAD

    asyncio.run(run())


_HOLD_CACHE_LOCK = """
import os
import sys
import threading
from pathlib import Path
from capture_runtime.file_lock import lock_descriptor
from capture_runtime.provisioning.infrastructure._engine_download_cache import VerifiedDownloadCache
root, sha, source = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
path = root / '.locks' / (sha + '.lock')
path.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
lock_descriptor(fd)
print('locked', flush=True)
command = sys.stdin.readline().strip()
if command == 'store':
    VerifiedDownloadCache(root).store(sha, source)
os.close(fd)
"""


@pytest.mark.parametrize("outcome", ["store", "kill", "cancel", "task_cancel"])
def test_process_lock_waiting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    root = tmp_path / "cache"
    source = tmp_path / "source"
    source.write_bytes(PAYLOAD)
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path(__file__).resolve().parents[2] / "src")
    holder = subprocess.Popen(
        [sys.executable, "-c", _HOLD_CACHE_LOCK, str(root), descriptor().sha256, str(source)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "locked"

        async def run() -> None:
            contended = asyncio.Event()
            original = cache_module.lock_descriptor

            def observed_lock(fd: int) -> None:
                try:
                    original(fd)
                except OSError:
                    contended.set()
                    raise

            monkeypatch.setattr(cache_module, "lock_descriptor", observed_lock)
            inner = CountingDownloader()
            destination = tmp_path / "destination"
            cancel = asyncio.Event()
            task = asyncio.create_task(
                CachingDownloader(inner, VerifiedDownloadCache(root)).download(
                    descriptor(),
                    destination,
                    cancel_event=cancel,
                    progress=lambda _: None,
                )
            )
            try:
                await asyncio.wait_for(contended.wait(), timeout=10)
                assert not task.done()
                assert inner.calls == 0
                assert not destination.exists()
                if outcome in {"cancel", "task_cancel"}:
                    if outcome == "cancel":
                        cancel.set()
                    else:
                        task.cancel()
                    with pytest.raises(asyncio.CancelledError):
                        await asyncio.wait_for(task, timeout=10)
                    assert not destination.exists()
                else:
                    if outcome == "store":
                        assert holder.stdin is not None
                        holder.stdin.write("store\n")
                        holder.stdin.flush()
                    else:
                        holder.kill()
                    await asyncio.wait_for(task, timeout=10)
                    assert inner.calls == (0 if outcome == "store" else 1)
                    assert destination.read_bytes() == PAYLOAD
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)

        asyncio.run(run())
    finally:
        if holder.poll() is None:
            holder.kill()
        holder.wait(timeout=5)
        for pipe in (holder.stdin, holder.stdout, holder.stderr):
            if pipe is not None:
                pipe.close()


def test_eviction_preserves_lock_files(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    lock = root / ".locks" / f"{descriptor().sha256}.lock"
    lock.parent.mkdir(parents=True)
    lock.touch()
    os.utime(lock, (1, 1))
    cache = VerifiedDownloadCache(root, max_idle_seconds=0)
    source = tmp_path / "source"
    source.write_bytes(PAYLOAD)
    cache.store(descriptor().sha256, source)
    assert lock.is_file()
    assert lock.parent.is_dir()


@pytest.mark.parametrize("cancel_file_task", [False, True])
def test_cancelled_holder_drains_file_work_before_unlocking(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, cancel_file_task: bool
) -> None:
    from capture_runtime.provisioning.infrastructure._engine_installation_download import (
        _file_operation,
    )

    async def run() -> None:
        started = asyncio.Event()
        contended = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()
        original = cache_module.lock_descriptor
        acquired = 0
        file_task = None

        def observed_lock(fd: int) -> None:
            nonlocal acquired
            try:
                original(fd)
            except OSError:
                contended.set()
                raise
            acquired += 1

        class SlowDownloader(CountingDownloader):
            async def download(self, item, destination, *, cancel_event, progress) -> None:
                nonlocal file_task
                self.calls += 1
                partial = destination.with_name(destination.name + ".part")
                partial.write_bytes(PAYLOAD)

                def commit() -> None:
                    loop.call_soon_threadsafe(started.set)
                    if not release.wait(timeout=10):
                        raise TimeoutError("commit was not released")
                    partial.replace(destination)

                if cancel_file_task:
                    file_task = asyncio.create_task(_file_operation(commit))
                    await file_task
                else:
                    await asyncio.to_thread(commit)

        monkeypatch.setattr(cache_module, "lock_descriptor", observed_lock)
        inner = SlowDownloader()
        downloader = CachingDownloader(inner, VerifiedDownloadCache(tmp_path / "cache"))

        def download(name):
            return asyncio.create_task(
                downloader.download(
                    descriptor(),
                    tmp_path / name,
                    cancel_event=asyncio.Event(),
                    progress=lambda _: None,
                )
            )

        holder = download("holder")
        waiter = None
        try:
            await asyncio.wait_for(started.wait(), timeout=5)
            holder.cancel()
            if cancel_file_task:
                assert file_task is not None
                file_task.cancel()
            waiter = download("waiter")
            await asyncio.wait_for(contended.wait(), timeout=5)
            # Allow another lock poll and a repeated caller cancellation while draining.
            holder.cancel()
            await asyncio.sleep(0.3)
            assert not holder.done()
            assert not waiter.done()
            assert acquired == 1
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(holder, timeout=5)
            await asyncio.wait_for(waiter, timeout=5)
            assert acquired == 2
            assert inner.calls == 1
            assert (tmp_path / "waiter").read_bytes() == PAYLOAD
        finally:
            release.set()
            await asyncio.gather(holder, *([waiter] if waiter else []), return_exceptions=True)

    asyncio.run(run())
