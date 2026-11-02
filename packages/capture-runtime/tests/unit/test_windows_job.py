"""Failure-path handle closure for the Windows Job Object helpers.

The kernel32 surface is faked, so these run on every platform.
"""

from __future__ import annotations

import ctypes
from types import SimpleNamespace
from typing import Any

import pytest

from capture_runtime import worker_process
from capture_runtime.ollama import lifecycle_impl

JOB = 4242
PROCESS_HANDLE = 777


class FakeKernel32:
    def __init__(self, **results: Any) -> None:
        self.results = {
            "CreateJobObjectW": JOB,
            "SetInformationJobObject": 1,
            "AssignProcessToJobObject": 1,
            "TerminateJobObject": 1,
            "WaitForSingleObject": 0,
        } | results
        self.closed: list[int] = []
        for name in (
            "CreateJobObjectW",
            "SetInformationJobObject",
            "AssignProcessToJobObject",
            "TerminateJobObject",
            "WaitForSingleObject",
            "CloseHandle",
        ):
            setattr(self, name, self._call(name))

    def _call(self, name: str) -> Any:
        def call(*args: Any) -> Any:
            if name == "CloseHandle":
                self.closed.append(_value(args[0]))
                return 1
            return self.results[name]

        call.argtypes = None  # type: ignore[attr-defined]
        call.restype = None  # type: ignore[attr-defined]
        return call


def _value(handle: Any) -> int:
    return int(handle.value if isinstance(handle, ctypes.c_void_p) else handle)


@pytest.fixture
def kernel32(monkeypatch: pytest.MonkeyPatch) -> Any:
    def install(**results: Any) -> FakeKernel32:
        fake = FakeKernel32(**results)
        monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **k: fake, raising=False)
        monkeypatch.setattr(
            ctypes, "WinError", lambda code=None: OSError(f"winerror {code}"), raising=False
        )
        monkeypatch.setattr(ctypes, "get_last_error", lambda: 5, raising=False)
        return fake

    return install


def _create_worker_job() -> int:
    process = SimpleNamespace(
        _transport=SimpleNamespace(
            get_extra_info=lambda _name: SimpleNamespace(_handle=PROCESS_HANDLE)
        )
    )
    return worker_process._create_windows_kill_on_close_job(process)  # type: ignore[arg-type]


def _create_ollama_job() -> int:
    process = SimpleNamespace(_handle=PROCESS_HANDLE)
    return lifecycle_impl._create_windows_kill_on_close_job(process)  # type: ignore[arg-type]


CREATORS = [_create_worker_job, _create_ollama_job]
TERMINATORS = [
    worker_process._terminate_windows_job,
    lifecycle_impl._terminate_windows_job,
]


@pytest.mark.parametrize("create", CREATORS)
def test_create_returns_open_job(create: Any, kernel32: Any) -> None:
    fake = kernel32()
    assert create() == JOB
    assert fake.closed == []


@pytest.mark.parametrize("create", CREATORS)
def test_create_failure_without_job_closes_nothing(create: Any, kernel32: Any) -> None:
    fake = kernel32(CreateJobObjectW=0)
    with pytest.raises(OSError):
        create()
    assert fake.closed == []


@pytest.mark.parametrize("create", CREATORS)
@pytest.mark.parametrize("failing", ["SetInformationJobObject", "AssignProcessToJobObject"])
def test_create_failure_closes_job(create: Any, failing: str, kernel32: Any) -> None:
    fake = kernel32(**{failing: 0})
    with pytest.raises(OSError):
        create()
    assert fake.closed == [JOB]


@pytest.mark.parametrize("terminate", TERMINATORS)
def test_terminate_closes_job(terminate: Any, kernel32: Any) -> None:
    fake = kernel32()
    terminate(JOB)
    assert fake.closed == [JOB]


@pytest.mark.parametrize("terminate", TERMINATORS)
def test_terminate_failure_closes_job(terminate: Any, kernel32: Any) -> None:
    fake = kernel32(TerminateJobObject=0)
    with pytest.raises(OSError):
        terminate(JOB)
    assert fake.closed == [JOB]


@pytest.mark.parametrize("terminate", TERMINATORS)
def test_terminate_wait_timeout_closes_job(terminate: Any, kernel32: Any) -> None:
    fake = kernel32(WaitForSingleObject=0x102)
    with pytest.raises(TimeoutError, match="did not terminate within 15 seconds"):
        terminate(JOB)
    assert fake.closed == [JOB]


@pytest.mark.parametrize("terminate", TERMINATORS)
def test_terminate_wait_failure_closes_job(terminate: Any, kernel32: Any) -> None:
    fake = kernel32(WaitForSingleObject=0xFFFFFFFF)
    with pytest.raises(OSError):
        terminate(JOB)
    assert fake.closed == [JOB]


def test_timeout_wording_stays_per_caller(kernel32: Any) -> None:
    kernel32(WaitForSingleObject=0x102)
    with pytest.raises(TimeoutError, match="^worker Windows job"):
        worker_process._terminate_windows_job(JOB)
    with pytest.raises(TimeoutError, match="^owned Windows job"):
        lifecycle_impl._terminate_windows_job(JOB)


def test_primitives_are_shared_by_both_callers() -> None:
    from capture_runtime import _windows_job

    assert worker_process.create_kill_on_close_job is _windows_job.create_kill_on_close_job
    assert lifecycle_impl.terminate_and_close_job is _windows_job.terminate_and_close_job
