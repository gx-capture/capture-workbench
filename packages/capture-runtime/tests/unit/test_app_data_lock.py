from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

import pytest

import capture_runtime.__main__ as runtime_main
from capture_runtime.storage.app_data_lock import (
    APP_DATA_LOCK_FILENAME,
    AppDataDirectoryLock,
    AppDataInUseError,
)

_HOLD_LOCK_SCRIPT = """
import sys
from pathlib import Path

from capture_runtime.storage.app_data_lock import AppDataDirectoryLock

with AppDataDirectoryLock.acquire(Path(sys.argv[1])):
    print("locked", flush=True)
    sys.stdin.read()
"""


@contextmanager
def _held_lock_subprocess(app_data_dir: Path) -> Iterator[subprocess.Popen[str]]:
    src_root = Path(__file__).resolve().parents[2] / "src"
    env = os.environ.copy()
    existing_pythonpath = env.get("PYTHONPATH")
    env["PYTHONPATH"] = (
        f"{src_root}{os.pathsep}{existing_pythonpath}" if existing_pythonpath else str(src_root)
    )
    process = subprocess.Popen(
        [sys.executable, "-c", _HOLD_LOCK_SCRIPT, str(app_data_dir)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )
    try:
        assert process.stdout is not None
        ready_line = process.stdout.readline().strip()
        if ready_line != "locked":
            stderr = process.stderr.read() if process.stderr is not None else ""
            raise AssertionError(
                f"Lock-holder child exited unexpectedly ({process.poll()}): {stderr}"
            )
        yield process
    finally:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe is not None:
                pipe.close()


def test_second_process_fails_while_holder_is_alive_and_succeeds_after_normal_exit(
    tmp_path: Path,
) -> None:
    app_data_dir = tmp_path / "app-data"

    with _held_lock_subprocess(app_data_dir) as holder:
        with pytest.raises(AppDataInUseError):
            AppDataDirectoryLock.acquire(app_data_dir)

        assert holder.stdin is not None
        holder.stdin.close()
        assert holder.wait(timeout=5) == 0

    with AppDataDirectoryLock.acquire(app_data_dir):
        pass
    # Windows byte-range locks are mandatory: the PID is readable once the lock is released.
    assert (app_data_dir / APP_DATA_LOCK_FILENAME).read_text(encoding="ascii").strip() == str(
        os.getpid()
    )


def test_new_acquisition_succeeds_after_holder_is_killed(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "app-data"

    with _held_lock_subprocess(app_data_dir) as holder:
        with pytest.raises(AppDataInUseError):
            AppDataDirectoryLock.acquire(app_data_dir)

        holder.kill()
        holder.wait(timeout=5)

    # Windows releases a killed process's lock asynchronously; the wait absorbs that.
    with AppDataDirectoryLock.acquire(app_data_dir, wait_seconds=10):
        assert (app_data_dir / APP_DATA_LOCK_FILENAME).is_file()


def test_acquisition_waits_for_a_holder_that_releases_during_the_wait(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "app-data"

    with _held_lock_subprocess(app_data_dir) as holder:
        assert holder.stdin is not None
        threading.Timer(0.5, holder.stdin.close).start()
        with AppDataDirectoryLock.acquire(app_data_dir, wait_seconds=10):
            assert holder.wait(timeout=5) == 0


def test_acquisition_gives_up_after_the_wait(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "app-data"

    with _held_lock_subprocess(app_data_dir):
        started = time.monotonic()
        with pytest.raises(AppDataInUseError):
            AppDataDirectoryLock.acquire(app_data_dir, wait_seconds=0.3)
        assert time.monotonic() - started >= 0.3


def test_acquire_creates_missing_directory_and_releases_on_exit(tmp_path: Path) -> None:
    missing_dir = tmp_path / "nested" / "app-data"

    with AppDataDirectoryLock.acquire(missing_dir):
        assert missing_dir.is_dir()
        assert (missing_dir / APP_DATA_LOCK_FILENAME).is_file()

    with AppDataDirectoryLock.acquire(missing_dir):
        pass


def test_failure_leaves_existing_directory_files_untouched(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "runtime-data"
    staging_dir = app_data_dir / "jobs" / "staging"
    staging_dir.mkdir(parents=True)
    upload_file = staging_dir / "in-progress.upload"
    state_file = app_data_dir / "state.json"
    upload_file.write_bytes(b"partial-chunk")
    state_file.write_text('{"ok": true}\n', encoding="utf-8")

    with _held_lock_subprocess(app_data_dir):
        lock_file = app_data_dir / APP_DATA_LOCK_FILENAME
        # The holder's lock is mandatory on Windows, so compare metadata rather than bytes.
        before = lock_file.stat()

        with pytest.raises(AppDataInUseError):
            AppDataDirectoryLock.acquire(app_data_dir)

        assert upload_file.read_bytes() == b"partial-chunk"
        assert state_file.read_text(encoding="utf-8") == '{"ok": true}\n'
        after = lock_file.stat()
        assert (after.st_size, after.st_mtime_ns) == (before.st_size, before.st_mtime_ns)


def test_main_exits_without_sweeps_or_app_creation_when_locked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    app_data_dir = tmp_path / "locked-app-data"
    monkeypatch.setenv("CAPTURE_APP_DATA_DIR", str(app_data_dir))
    called: list[str] = []

    def fail_sweep() -> None:
        called.append("sweep")

    def fail_create_app(_settings: object) -> object:
        called.append("create_app")
        return object()

    def fail_uvicorn_run(*_args: object, **_kwargs: object) -> None:
        called.append("uvicorn")

    monkeypatch.setattr(runtime_main, "start_stale_extraction_sweep", fail_sweep)
    monkeypatch.setattr(runtime_main, "create_app", fail_create_app)
    monkeypatch.setattr(runtime_main.uvicorn, "run", fail_uvicorn_run)
    monkeypatch.setattr(runtime_main, "APP_DATA_LOCK_WAIT_SECONDS", 0.2)

    with _held_lock_subprocess(app_data_dir):
        with pytest.raises(SystemExit) as exit_info:
            runtime_main.main(["serve"])

    assert exit_info.value.code == runtime_main.EXIT_APP_DATA_IN_USE
    assert called == []
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.strip() == (
        "capture-runtime: the app data directory is in use by another Capture Runtime."
    )
    assert str(app_data_dir) not in captured.err


def test_main_holds_lock_across_sweep_and_server_run_and_releases_on_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    app_data_dir = tmp_path / "app-data"
    monkeypatch.setenv("CAPTURE_APP_DATA_DIR", str(app_data_dir))
    events: list[str] = []

    def fake_sweep() -> None:
        with pytest.raises(AppDataInUseError):
            AppDataDirectoryLock.acquire(app_data_dir)
        events.append("sweep")

    def fake_create_app(_settings: object) -> object:
        events.append("create_app")
        return object()

    def fake_uvicorn_run(*_args: object, **_kwargs: object) -> None:
        with pytest.raises(AppDataInUseError):
            AppDataDirectoryLock.acquire(app_data_dir)
        events.append("run")

    monkeypatch.setattr(runtime_main, "start_stale_extraction_sweep", fake_sweep)
    monkeypatch.setattr(runtime_main, "create_app", fake_create_app)
    monkeypatch.setattr(runtime_main.uvicorn, "run", fake_uvicorn_run)

    runtime_main.main(["serve"])

    assert events == ["sweep", "create_app", "run"]
    with AppDataDirectoryLock.acquire(app_data_dir):
        pass
