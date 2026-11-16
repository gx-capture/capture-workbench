from __future__ import annotations

import errno
from types import SimpleNamespace

import pytest

from capture_runtime import file_lock
from capture_runtime.provisioning.infrastructure import (
    _engine_installation_activation as activation,
)
from capture_runtime.provisioning.infrastructure._engine_download_cache import VerifiedDownloadCache


def sharing_error(code=32):
    error = PermissionError(errno.EACCES, "sharing violation")
    error.winerror = code
    return error


@pytest.mark.parametrize("code", [5, 32])
@pytest.mark.parametrize("failures", [1, 3, 7, 8])
def test_replace_retry_bounds(tmp_path, monkeypatch, code, failures):
    source, target = tmp_path / "source", tmp_path / "target"
    source.write_bytes(b"verified")
    original = file_lock.os.replace
    calls = []
    waits = []
    error = sharing_error(code)

    def replace(src, dst):
        calls.append((src, dst))
        if len(calls) <= failures:
            raise error
        original(src, dst)

    monkeypatch.setattr(file_lock.sys, "platform", "win32")
    monkeypatch.setattr(file_lock.os, "replace", replace)
    if failures == 8:
        with pytest.raises(PermissionError) as caught:
            file_lock.replace_with_retry(
                source, target, clock=lambda: sum(waits), sleep=waits.append
            )
        assert caught.value is error
    else:
        file_lock.replace_with_retry(source, target, clock=lambda: sum(waits), sleep=waits.append)
        assert target.read_bytes() == b"verified"
    assert len(calls) == min(failures + 1, 8)
    assert sum(waits) <= 2


@pytest.mark.parametrize(
    "platform,error",
    [
        ("linux", sharing_error()),
        ("win32", PermissionError("no Windows code")),
        ("win32", sharing_error(33)),
        ("win32", OSError(errno.EIO, "disk failure")),
    ],
)
def test_replace_does_not_retry_other_errors(tmp_path, monkeypatch, platform, error):
    calls = []
    waits = []

    def replace(source, target):
        calls.append((source, target))
        raise error

    monkeypatch.setattr(file_lock.sys, "platform", platform)
    monkeypatch.setattr(file_lock.os, "replace", replace)
    with pytest.raises(OSError) as caught:
        file_lock.replace_with_retry(tmp_path / "a", tmp_path / "b", sleep=waits.append)
    assert caught.value is error
    assert len(calls) == 1
    assert not waits


def test_replace_obeys_clock_deadline(tmp_path, monkeypatch):
    times = iter([0.0, 2.0])
    waits = []
    error = sharing_error()

    def replace(source, target):
        raise error

    monkeypatch.setattr(file_lock.sys, "platform", "win32")
    monkeypatch.setattr(file_lock.os, "replace", replace)
    with pytest.raises(PermissionError) as caught:
        file_lock.replace_with_retry(
            tmp_path / "a", tmp_path / "b", clock=lambda: next(times), sleep=waits.append
        )
    assert caught.value is error
    assert not waits


@pytest.mark.parametrize("failed_step", ["old", "new", "state", "rollback"])
def test_activation_retries_each_step_and_preserves_rollback(tmp_path, monkeypatch, failed_step):
    version, new, previous = [tmp_path / name for name in ("version", "new", "previous")]
    version.mkdir()
    (version / "old").write_bytes(b"old")
    new.mkdir()
    (new / "new").write_bytes(b"new")
    state_path = tmp_path / "active.json"
    original = file_lock.os.replace
    seen = set()

    def replace(source, target):
        step = (
            "old"
            if source == version
            else "new"
            if source == new
            else "rollback"
            if source == previous
            else "state"
        )
        if step == failed_step and step not in seen:
            seen.add(step)
            raise sharing_error()
        original(source, target)

    monkeypatch.setattr(file_lock.sys, "platform", "win32")
    monkeypatch.setattr(file_lock.os, "replace", replace)

    def write_state(path, payload):
        if failed_step == "rollback":
            raise ValueError("state failed")
        activation.atomic_write_json(path, payload)

    kwargs = dict(
        version=version,
        new_version=new,
        previous_version=previous,
        active_state_path=state_path,
        state=SimpleNamespace(to_dict=lambda: {}),
        write_state=write_state,
    )
    if failed_step == "rollback":
        with pytest.raises(ValueError, match="state failed"):
            activation.activate_version(**kwargs)
        assert (version / "old").read_bytes() == b"old"
    else:
        activation.activate_version(**kwargs)
        assert (version / "new").read_bytes() == b"new"
        assert state_path.read_text().strip() == "{}"
    assert seen == {failed_step}
    assert not previous.exists()


def test_cache_store_retries_replacement(tmp_path, monkeypatch):
    source = tmp_path / "source"
    source.write_bytes(b"verified")
    cache = VerifiedDownloadCache(tmp_path / "cache")
    original = file_lock.os.replace
    calls = []

    def replace(src, dst):
        calls.append(dst)
        if len(calls) == 1:
            raise sharing_error(5)
        original(src, dst)

    monkeypatch.setattr(file_lock.sys, "platform", "win32")
    monkeypatch.setattr(file_lock.os, "replace", replace)
    cache.store("a" * 64, source)
    assert len(calls) == 2
    assert calls[-1].read_bytes() == b"verified"


@pytest.mark.parametrize("outcome", ["success", "failure", "cancelled"])
def test_commit_operation_drains_thread_and_resolves_late_cancellation(outcome):
    import asyncio
    import threading

    from capture_runtime.provisioning.infrastructure._engine_installation_download import (
        _commit_operation,
    )

    async def scenario():
        started = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()

        def operation():
            loop.call_soon_threadsafe(started.set)
            assert release.wait(5)
            if outcome == "failure":
                raise ValueError("commit failed")
            if outcome == "cancelled":
                raise asyncio.CancelledError
            return "committed"

        task = asyncio.create_task(_commit_operation(operation))
        try:
            await asyncio.wait_for(started.wait(), 5)
            task.cancel()
            await asyncio.sleep(0)
            task.cancel()
            await asyncio.sleep(0)
            assert not task.done()
        finally:
            release.set()
        if outcome == "success":
            assert await asyncio.wait_for(task, 5) == "committed"
            assert task.cancelling() == 0
            assert not task.cancelled()
        else:
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 5)
            assert task.cancelled()

    asyncio.run(scenario())
