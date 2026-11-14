"""Stale Ollama PID files are kept only when the creation time still matches."""

from __future__ import annotations

import ctypes
import io
import json
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.config import OllamaRuntimeConfig
from capture_runtime.structuring.infrastructure.ollama import (
    IsolatedOllamaLifecycle,
    OllamaOwnershipError,
    OwnedProcess,
)
from capture_runtime.structuring.infrastructure.ollama.lifecycle_impl import (
    _parse_proc_stat_start_time,
    _windows_process_creation_time,
)

_LIVE_PID = "Capture Ollama PID file points to a live process not owned by this runtime"
_STALE = 2**53 + 3
_REUSED = 2**53 + 4
_STARTED = 2**53 + 5


class _Popen:
    def __init__(self, pid: int) -> None:
        self.pid = pid

    def poll(self) -> int | None:
        return None


class _Controller:
    def __init__(
        self,
        *,
        live_pids: set[int] | None = None,
        creation_times: Mapping[int, int | None] | None = None,
    ) -> None:
        self.live_pids = set(live_pids or ())
        self.creation_times = dict(creation_times or {})
        self.spawned: list[list[str]] = []

    def is_pid_running(self, pid: int) -> bool:
        return pid in self.live_pids

    def process_creation_time(self, pid: int) -> int | None:
        return self.creation_times.get(pid)

    def spawn(
        self,
        executable: str,
        arguments: list[str],
        *,
        environment: Mapping[str, str],
        cwd: Path,
        output_path: Path,
    ) -> OwnedProcess:
        del environment, cwd, output_path
        self.spawned.append([executable, *arguments])
        return OwnedProcess(process=_Popen(4242), output=io.BytesIO())  # type: ignore[arg-type]

    def stop_tree(self, process: OwnedProcess) -> None:
        process.output.close()


def _lifecycle(tmp_path: Path, controller: _Controller) -> IsolatedOllamaLifecycle:
    root = tmp_path / "ollama"
    root.mkdir()
    return IsolatedOllamaLifecycle(
        OllamaRuntimeConfig(
            app_data_dir=root,
            pid_file=root / "pid.json",
            models_dir=root / "models",
        ),
        process_controller=controller,
        listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
        executable_resolver=lambda: "ollama.exe",
        clock=SystemClock(),
    )


def _write_pid(lifecycle: IsolatedOllamaLifecycle, text: str) -> None:
    lifecycle.config.pid_file.write_text(text, encoding="utf-8")


def _read_pid(lifecycle: IsolatedOllamaLifecycle) -> dict[str, object]:
    payload = json.loads(lifecycle.config.pid_file.read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    return payload


def test_same_process_creation_time_still_refuses_start(tmp_path: Path) -> None:
    controller = _Controller(live_pids={7331}, creation_times={7331: _STALE})
    lifecycle = _lifecycle(tmp_path, controller)
    text = json.dumps({"pid": 7331, "processCreationTime": _STALE})
    _write_pid(lifecycle, text)

    with pytest.raises(OllamaOwnershipError, match=_LIVE_PID):
        lifecycle.start()

    assert lifecycle.config.pid_file.read_text(encoding="utf-8") == text
    assert controller.spawned == []


def test_zero_creation_time_still_identifies_the_same_process(tmp_path: Path) -> None:
    controller = _Controller(live_pids={7331}, creation_times={7331: 0})
    lifecycle = _lifecycle(tmp_path, controller)
    text = '{"pid": 7331, "processCreationTime": 0}'
    _write_pid(lifecycle, text)

    with pytest.raises(OllamaOwnershipError, match=_LIVE_PID):
        lifecycle.start()

    assert lifecycle.config.pid_file.read_text(encoding="utf-8") == text
    assert controller.spawned == []


def test_reused_pid_removes_the_stale_file_and_starts(tmp_path: Path) -> None:
    controller = _Controller(
        live_pids={7331},
        creation_times={7331: _REUSED, 4242: _STARTED},
    )
    lifecycle = _lifecycle(tmp_path, controller)
    _write_pid(lifecycle, json.dumps({"pid": 7331, "processCreationTime": _STALE}))

    assert lifecycle.start() == 4242

    assert controller.spawned == [["ollama.exe", "serve"]]
    payload = _read_pid(lifecycle)
    assert payload["pid"] == 4242
    assert payload["processCreationTime"] == _STARTED


def test_old_pid_file_with_a_live_pid_still_refuses_start(tmp_path: Path) -> None:
    controller = _Controller(live_pids={7331}, creation_times={7331: _STALE})
    lifecycle = _lifecycle(tmp_path, controller)
    text = '{"pid": 7331}'
    _write_pid(lifecycle, text)

    with pytest.raises(OllamaOwnershipError, match=_LIVE_PID):
        lifecycle.start()

    assert lifecycle.config.pid_file.read_text(encoding="utf-8") == text
    assert controller.spawned == []


def test_non_integer_creation_time_still_refuses_a_live_pid(tmp_path: Path) -> None:
    controller = _Controller(live_pids={7331}, creation_times={7331: 999})
    lifecycle = _lifecycle(tmp_path, controller)
    text = '{"pid": 7331, "processCreationTime": 1.5}'
    _write_pid(lifecycle, text)

    with pytest.raises(OllamaOwnershipError, match=_LIVE_PID):
        lifecycle.start()

    assert lifecycle.config.pid_file.read_text(encoding="utf-8") == text
    assert controller.spawned == []


def test_unreadable_creation_time_still_refuses_a_live_pid(tmp_path: Path) -> None:
    controller = _Controller(live_pids={7331}, creation_times={7331: None})
    lifecycle = _lifecycle(tmp_path, controller)
    text = json.dumps({"pid": 7331, "processCreationTime": _STALE})
    _write_pid(lifecycle, text)

    with pytest.raises(OllamaOwnershipError, match=_LIVE_PID):
        lifecycle.start()

    assert lifecycle.config.pid_file.read_text(encoding="utf-8") == text
    assert controller.spawned == []


def test_dead_pid_is_removed_and_start_continues(tmp_path: Path) -> None:
    controller = _Controller(creation_times={7331: _STALE, 4242: _STARTED})
    lifecycle = _lifecycle(tmp_path, controller)
    _write_pid(lifecycle, json.dumps({"pid": 7331, "processCreationTime": _STALE}))

    assert lifecycle.start() == 4242

    payload = _read_pid(lifecycle)
    assert payload["pid"] == 4242
    assert payload["processCreationTime"] == _STARTED
    assert controller.spawned == [["ollama.exe", "serve"]]


@pytest.mark.parametrize("text", ["not-json", '{"processCreationTime": 1}'])
def test_malformed_pid_file_is_removed_and_start_continues(tmp_path: Path, text: str) -> None:
    controller = _Controller(creation_times={4242: _STARTED})
    lifecycle = _lifecycle(tmp_path, controller)
    _write_pid(lifecycle, text)

    assert lifecycle.start() == 4242

    payload = _read_pid(lifecycle)
    assert payload["pid"] == 4242
    assert payload["processCreationTime"] == _STARTED


def test_writer_records_the_started_process_creation_time(tmp_path: Path) -> None:
    controller = _Controller(creation_times={4242: _STARTED})
    lifecycle = _lifecycle(tmp_path, controller)

    assert lifecycle.start() == 4242

    payload = _read_pid(lifecycle)
    assert payload["pid"] == 4242
    assert payload["processCreationTime"] == _STARTED
    assert payload["profileId"] == lifecycle.config.profile_id
    assert isinstance(payload["startedAt"], str) and payload["startedAt"]
    names = [path.name for path in lifecycle.config.pid_file.parent.iterdir()]
    assert all(not name.endswith(".tmp") for name in names)


def test_writer_omits_creation_time_when_it_cannot_be_read(tmp_path: Path) -> None:
    lifecycle = _lifecycle(tmp_path, _Controller())

    assert lifecycle.start() == 4242

    payload = _read_pid(lifecycle)
    assert payload["pid"] == 4242
    assert "processCreationTime" not in payload
    assert "profileId" in payload
    assert "startedAt" in payload


def _stat_after_comm(starttime: bytes, comm: bytes = b"ollama") -> bytes:
    fields = [
        b"S",  # 3 state
        b"1",  # 4 ppid
        b"1",  # 5 pgrp
        b"1",  # 6 session
        b"0",  # 7 tty_nr
        b"-1",  # 8 tpgid
        b"0",  # 9 flags
        b"0",  # 10 minflt
        b"0",  # 11 cminflt
        b"0",  # 12 majflt
        b"0",  # 13 cmajflt
        b"0",  # 14 utime
        b"0",  # 15 stime
        b"0",  # 16 cutime
        b"0",  # 17 cstime
        b"20",  # 18 priority
        b"0",  # 19 nice
        b"1",  # 20 num_threads
        b"0",  # 21 itrealvalue
        starttime,  # 22 starttime
        b"123",
    ]
    assert fields[19] == starttime
    return b"42 (" + comm + b") " + b" ".join(fields)


def test_proc_stat_start_time_is_the_raw_integer_after_comm() -> None:
    encoded = str(_STALE).encode()
    assert _parse_proc_stat_start_time(_stat_after_comm(encoded)) == _STALE
    assert _parse_proc_stat_start_time(_stat_after_comm(encoded, b"ollama (serve) 2")) == _STALE
    assert _parse_proc_stat_start_time(_stat_after_comm(b"0")) == 0


def test_proc_stat_start_time_is_absent_when_the_record_cannot_be_read() -> None:
    assert _parse_proc_stat_start_time(b"42 (ollama) S 1") is None
    assert _parse_proc_stat_start_time(b"42 ollama S 1 2 3") is None
    assert _parse_proc_stat_start_time(_stat_after_comm(b"abc")) is None
    assert _parse_proc_stat_start_time(_stat_after_comm(b"-5")) is None


def _install_kernel(monkeypatch: pytest.MonkeyPatch, **methods: Any) -> None:
    monkeypatch.setattr(
        ctypes,
        "WinDLL",
        lambda *_args, **_kwargs: SimpleNamespace(**methods),
    )


def test_windows_creation_time_is_the_raw_filetime(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[tuple[object, ...]] = []
    closed: list[object] = []

    def open_process(access: int, inherit: object, pid: int) -> int:
        opened.append((access, inherit, pid))
        return 77

    def get_process_times(
        handle: object,
        created: Any,
        _exited: object,
        _kernel: object,
        _user: object,
    ) -> int:
        assert handle == 77
        created._obj.dwLowDateTime = 0xFFFFFFFF
        created._obj.dwHighDateTime = 0xFFFFFFFF
        return 1

    def close_handle(handle: object) -> int:
        closed.append(handle)
        return 1

    _install_kernel(
        monkeypatch,
        OpenProcess=open_process,
        GetProcessTimes=get_process_times,
        CloseHandle=close_handle,
    )

    assert _windows_process_creation_time(7331) == 2**64 - 1
    assert opened == [(0x1000, False, 7331)]
    assert closed == [77]


def test_windows_creation_time_is_unreadable_when_the_process_cannot_be_opened(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[object] = []

    def close_handle(handle: object) -> int:
        closed.append(handle)
        return 1

    _install_kernel(
        monkeypatch,
        OpenProcess=lambda *_args: 0,
        GetProcessTimes=lambda *_args: 1,
        CloseHandle=close_handle,
    )

    assert _windows_process_creation_time(7331) is None
    assert closed == []


def test_windows_creation_time_is_unreadable_when_get_process_times_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    closed: list[object] = []

    def close_handle(handle: object) -> int:
        closed.append(handle)
        return 1

    _install_kernel(
        monkeypatch,
        OpenProcess=lambda *_args: 77,
        GetProcessTimes=lambda *_args: 0,
        CloseHandle=close_handle,
    )

    assert _windows_process_creation_time(7331) is None
    assert closed == [77]
