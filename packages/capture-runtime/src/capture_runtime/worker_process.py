"""Owned worker subprocess lifecycle with bounded JSON-lines framing."""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import subprocess
import sys
from collections.abc import Mapping
from contextlib import suppress
from pathlib import Path

from capture_runtime.config import sanitized_child_environment
from capture_runtime.worker_contracts import (
    MAX_WORKER_INPUT_BYTES,
    MAX_WORKER_OUTPUT_BYTES,
    WorkerProtocolError,
    WorkerRequest,
    WorkerResponse,
)

DEFAULT_PROBE_TIMEOUT_SECONDS = 30.0
DEFAULT_RUN_TIMEOUT_SECONDS = 15 * 60.0
WORKER_CANCEL_GRACE_SECONDS = 2.0
WORKER_TERMINATE_GRACE_SECONDS = 3.0
MAX_WORKER_STDERR_BYTES = 64 * 1024
WORKER_STAGE_PATTERN = re.compile(r"(?m)^capture-worker-stage:([a-z0-9]+(?:-[a-z0-9]+)*)\r?$")
MAX_WORKER_DIAGNOSTIC_STAGES = 16
WORKER_BOOTLOADER_PATTERN = re.compile(
    r"(?im)^\s*(?:\[PYI-[^\r\n]{0,80}|fatal error[^\r\n]{0,160})$"
)


class WorkerExecutionError(RuntimeError):
    """Raised when a checksum-pinned worker cannot produce a valid result."""


class WorkerCancelledError(asyncio.CancelledError):
    """Raised after the owned worker acknowledges or is stopped for cancellation."""


def _request_id() -> str:
    return secrets.token_hex(16)


def _frame(request: WorkerRequest) -> bytes:
    encoded = (
        json.dumps(request.to_dict(), ensure_ascii=False, separators=(",", ":")) + "\n"
    ).encode("utf-8")
    if len(encoded) > MAX_WORKER_INPUT_BYTES:
        raise WorkerProtocolError("worker request exceeds the framing limit")
    return encoded


def _subprocess_path(path: Path) -> str:
    """Pass Win32 paths to native children, while keeping extended paths for checks."""

    value = os.fspath(path)
    if os.name != "nt":
        return value
    if value.startswith("\\\\?\\UNC\\"):
        return "\\\\" + value[8:]
    if value.startswith("\\\\?\\"):
        return value[4:]
    return value


class WorkerProcess:
    """Launch and clean up only subprocesses created by this owner."""

    def __init__(
        self,
        *,
        base_environment: Mapping[str, str] | None = None,
    ) -> None:
        self._base_environment = sanitized_child_environment(base_environment)
        self._active: set[asyncio.subprocess.Process] = set()
        self._windows_job_handles: dict[int, int] = {}
        self._lock = asyncio.Lock()

    @property
    def active_process_count(self) -> int:
        return len(self._active)

    async def request(
        self,
        executable: Path,
        operation: str,
        payload: dict[str, object],
        *,
        cancel_event: asyncio.Event | None = None,
        timeout_seconds: float,
    ) -> WorkerResponse:
        if not executable.is_file():
            raise WorkerExecutionError(
                "installed worker entry point is missing at stage worker-process-entry-missing"
            )
        if timeout_seconds <= 0:
            raise ValueError("worker timeout must be positive")
        request = WorkerRequest(_request_id(), operation, payload)  # type: ignore[arg-type]
        executable_path = _subprocess_path(executable)
        command = (
            [sys.executable, executable_path]
            if executable.suffix.casefold() in {".py", ".pyw"}
            else [executable_path]
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(self._base_environment),
            cwd=_subprocess_path(executable.parent),
            limit=MAX_WORKER_OUTPUT_BYTES + 2,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
        if os.name == "nt":
            try:
                self._windows_job_handles[process.pid] = _create_windows_kill_on_close_job(process)
            except BaseException:
                await self._stop(process, initial_grace=0)
                raise
        async with self._lock:
            self._active.add(process)
        try:
            assert process.stdin is not None
            assert process.stdout is not None
            assert process.stderr is not None
            stderr_task = asyncio.create_task(self._drain_stderr(process.stderr))
            process.stdin.write(_frame(request))
            await process.stdin.drain()
            read_task = asyncio.create_task(process.stdout.readline())
            exit_task = asyncio.create_task(process.wait())
            cancel_task = (
                asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
            )
            timeout_task = asyncio.create_task(asyncio.sleep(timeout_seconds))
            waiters: set[asyncio.Task[object]] = {read_task, exit_task, timeout_task}
            if cancel_task is not None:
                waiters.add(cancel_task)
            done, _pending = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            if (
                cancel_task is not None
                and cancel_task in done
                and cancel_event is not None
                and cancel_event.is_set()
            ):
                cancel = WorkerRequest(
                    _request_id(),
                    "cancel",
                    {"requestId": request.request_id},
                )
                with suppress(BrokenPipeError, ConnectionResetError):
                    process.stdin.write(_frame(cancel))
                    await process.stdin.drain()
                await self._stop(process, initial_grace=WORKER_CANCEL_GRACE_SECONDS)
                raise WorkerCancelledError
            if timeout_task in done:
                await self._stop(process, initial_grace=0)
                stderr = await self._collect_stderr(stderr_task)
                raise WorkerExecutionError(
                    f"worker request timed out{_stage_suffix(stderr, 'worker-process-timeout')}"
                )
            if exit_task in done and not read_task.done():
                # A worker can write and flush its response immediately before
                # exiting.  ``Process.wait`` may complete before the stdout
                # transport delivers that line, so give the already-exited
                # process a bounded opportunity to finish the read before
                # declaring that it produced no response.
                try:
                    await asyncio.wait_for(
                        read_task,
                        timeout=WORKER_TERMINATE_GRACE_SECONDS,
                    )
                except TimeoutError as error:
                    stderr = await self._collect_stderr(stderr_task)
                    raise WorkerExecutionError(
                        f"worker exited before a response with code {process.returncode}"
                        f"{_stage_suffix(stderr, 'worker-process-exit-before-response')}"
                    ) from error
                except ValueError as error:
                    raise WorkerProtocolError(
                        "worker response exceeds the framing limit"
                    ) from error
            try:
                line = await read_task
            except ValueError as error:
                raise WorkerProtocolError("worker response exceeds the framing limit") from error
            if not line:
                await self._stop(process, initial_grace=0)
                stderr = await self._collect_stderr(stderr_task)
                return_code = process.returncode
                code_suffix = (
                    f" with code {return_code}"
                    if isinstance(return_code, int) and not isinstance(return_code, bool)
                    else ""
                )
                raise WorkerExecutionError(
                    f"worker returned no response{code_suffix}"
                    f"{_stage_suffix(stderr, 'worker-process-no-response')}"
                )
            if len(line) > MAX_WORKER_OUTPUT_BYTES or not line.endswith(b"\n"):
                raise WorkerProtocolError("worker response exceeds the framing limit")
            try:
                decoded = line.decode("utf-8")
                raw_response = json.loads(decoded)
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise WorkerProtocolError("worker response is not one UTF-8 JSON line") from error
            response = WorkerResponse.from_dict(raw_response)
            if response.request_id != request.request_id:
                raise WorkerProtocolError("worker response requestId does not match request")
            try:
                if os.name == "nt" and process.pid in self._windows_job_handles:
                    parent_exited = await asyncio.to_thread(
                        _wait_for_windows_process_exit,
                        process,
                        WORKER_TERMINATE_GRACE_SECONDS,
                    )
                    if not parent_exited:
                        raise TimeoutError
                    # asyncio's Windows subprocess transport does not finish
                    # ``wait()`` while a descendant still inherits a pipe.
                    # The one-run protocol is complete once the parent has
                    # emitted its response and exited, so release the owned
                    # Job now to close descendant-held pipe handles before
                    # awaiting transport EOF.
                    await self._stop(process, initial_grace=0)
                await asyncio.wait_for(process.wait(), timeout=WORKER_TERMINATE_GRACE_SECONDS)
            except TimeoutError as error:
                await self._stop(process, initial_grace=0)
                raise WorkerExecutionError(
                    "worker did not exit after its response at stage worker-process-termination"
                ) from error
            try:
                trailing = await asyncio.wait_for(
                    process.stdout.read(1), timeout=WORKER_TERMINATE_GRACE_SECONDS
                )
            except TimeoutError:
                # A native child can retain the inherited stdout handle after
                # the one-run parent has emitted its response. The owned Job
                # has already been released above; do not turn an otherwise
                # valid response into an unbounded EOF wait.
                trailing = b""
            if trailing:
                raise WorkerProtocolError("worker emitted more than one response line")
            stderr = await self._collect_stderr(stderr_task)
            if not response.ok:
                assert response.error is not None
                raise WorkerExecutionError(
                    f"{response.error.code}: {response.error.message}"
                    f"{_stage_suffix(stderr, 'worker-process-response-error')}"
                )
            if process.returncode != 0:
                raise WorkerExecutionError(
                    f"worker exited with code {process.returncode}"
                    f"{_stage_suffix(stderr, 'worker-process-exit-nonzero')}"
                )
            return response
        finally:
            for task_name in ("read_task", "exit_task", "cancel_task", "timeout_task"):
                task = locals().get(task_name)
                if isinstance(task, asyncio.Task) and not task.done():
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
            if process.returncode is None or process.pid in self._windows_job_handles:
                await self._stop(process, initial_grace=0)
            stderr_drain = locals().get("stderr_task")
            if isinstance(stderr_drain, asyncio.Task) and not stderr_drain.done():
                stderr_drain.cancel()
                with suppress(asyncio.CancelledError):
                    await stderr_drain
            async with self._lock:
                self._active.discard(process)

    async def shutdown(self) -> None:
        async with self._lock:
            processes = list(self._active)
        await asyncio.gather(
            *(self._stop(process, initial_grace=0) for process in processes),
            return_exceptions=True,
        )

    async def _stop(self, process: asyncio.subprocess.Process, *, initial_grace: float) -> None:
        if initial_grace > 0:
            try:
                await asyncio.wait_for(process.wait(), timeout=initial_grace)
            except TimeoutError:
                pass
        windows_job_handle = self._windows_job_handles.pop(process.pid, None)
        if windows_job_handle is not None:
            await asyncio.to_thread(_terminate_windows_job, windows_job_handle)
            with suppress(TimeoutError):
                await asyncio.wait_for(process.wait(), timeout=WORKER_TERMINATE_GRACE_SECONDS)
            return
        if process.returncode is not None:
            return
        with suppress(ProcessLookupError):
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=WORKER_TERMINATE_GRACE_SECONDS)
            return
        except TimeoutError:
            pass
        with suppress(ProcessLookupError):
            process.kill()
        with suppress(TimeoutError):
            await asyncio.wait_for(process.wait(), timeout=WORKER_TERMINATE_GRACE_SECONDS)

    @staticmethod
    async def _drain_stderr(stream: asyncio.StreamReader) -> str:
        captured = bytearray()
        while chunk := await stream.read(16 * 1024):
            captured.extend(chunk)
            if len(captured) > MAX_WORKER_STDERR_BYTES:
                del captured[:-MAX_WORKER_STDERR_BYTES]
        return captured.decode("utf-8", errors="replace").strip()

    @staticmethod
    async def _collect_stderr(task: asyncio.Task[str]) -> str:
        try:
            return await asyncio.wait_for(task, timeout=WORKER_TERMINATE_GRACE_SECONDS)
        except TimeoutError:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
            return ""


def _create_windows_kill_on_close_job(process: asyncio.subprocess.Process) -> int:
    import ctypes
    from ctypes import wintypes

    class BasicLimitInformation(ctypes.Structure):
        _fields_ = [
            ("per_process_user_time_limit", ctypes.c_longlong),
            ("per_job_user_time_limit", ctypes.c_longlong),
            ("limit_flags", wintypes.DWORD),
            ("minimum_working_set_size", ctypes.c_size_t),
            ("maximum_working_set_size", ctypes.c_size_t),
            ("active_process_limit", wintypes.DWORD),
            ("affinity", ctypes.c_size_t),
            ("priority_class", wintypes.DWORD),
            ("scheduling_class", wintypes.DWORD),
        ]

    class IoCounters(ctypes.Structure):
        _fields_ = [
            ("read_operation_count", ctypes.c_ulonglong),
            ("write_operation_count", ctypes.c_ulonglong),
            ("other_operation_count", ctypes.c_ulonglong),
            ("read_transfer_count", ctypes.c_ulonglong),
            ("write_transfer_count", ctypes.c_ulonglong),
            ("other_transfer_count", ctypes.c_ulonglong),
        ]

    class ExtendedLimitInformation(ctypes.Structure):
        _fields_ = [
            ("basic_limit_information", BasicLimitInformation),
            ("io_info", IoCounters),
            ("process_memory_limit", ctypes.c_size_t),
            ("job_memory_limit", ctypes.c_size_t),
            ("peak_process_memory_used", ctypes.c_size_t),
            ("peak_job_memory_used", ctypes.c_size_t),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    kernel32.SetInformationJobObject.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        wintypes.DWORD,
    ]
    kernel32.SetInformationJobObject.restype = wintypes.BOOL
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = wintypes.BOOL

    native_handle = _native_windows_process_handle(process)
    job = kernel32.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        information = ExtendedLimitInformation()
        information.basic_limit_information.limit_flags = 0x00002000
        if not kernel32.SetInformationJobObject(
            job,
            9,
            ctypes.byref(information),
            ctypes.sizeof(information),
        ):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel32.AssignProcessToJobObject(job, ctypes.c_void_p(native_handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(job)
    except BaseException:
        kernel32.CloseHandle(job)
        raise


def _native_windows_process_handle(process: asyncio.subprocess.Process) -> int:
    transport = getattr(process, "_transport", None)
    get_extra_info = getattr(transport, "get_extra_info", None)
    native_process = get_extra_info("subprocess") if callable(get_extra_info) else None
    native_handle = getattr(native_process, "_handle", None)
    if not isinstance(native_handle, int):
        raise RuntimeError("Windows worker process handle is unavailable")
    return native_handle


def _wait_for_windows_process_exit(
    process: asyncio.subprocess.Process,
    timeout_seconds: float,
) -> bool:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    timeout_ms = min(max(round(timeout_seconds * 1000), 0), 0xFFFFFFFE)
    result = int(
        kernel32.WaitForSingleObject(
            ctypes.c_void_p(_native_windows_process_handle(process)),
            timeout_ms,
        )
    )
    if result == 0:
        return True
    if result == 0x00000102:
        return False
    if result == 0xFFFFFFFF:
        raise ctypes.WinError(ctypes.get_last_error())
    raise RuntimeError("Windows worker process wait returned an unexpected result")


def _terminate_windows_job(handle: int) -> None:
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.TerminateJobObject.argtypes = [ctypes.c_void_p, wintypes.UINT]
    kernel32.TerminateJobObject.restype = wintypes.BOOL
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, wintypes.DWORD]
    kernel32.WaitForSingleObject.restype = wintypes.DWORD
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = wintypes.BOOL
    job = ctypes.c_void_p(handle)
    try:
        if not kernel32.TerminateJobObject(job, 1):
            raise ctypes.WinError(ctypes.get_last_error())
        wait_result = int(kernel32.WaitForSingleObject(job, 15_000))
        if wait_result == 0x00000102:
            raise TimeoutError("worker Windows job did not terminate within 15 seconds")
        if wait_result == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel32.CloseHandle(job)


def _stage_suffix(stderr: str, fallback_stage: str | None = None) -> str:
    """Return a bounded, allowlisted worker-stage sequence, if present."""

    stages = WORKER_STAGE_PATTERN.findall(stderr)
    if stages:
        if len(stages) > MAX_WORKER_DIAGNOSTIC_STAGES:
            head_count = MAX_WORKER_DIAGNOSTIC_STAGES // 2
            stages = [
                *stages[:head_count],
                "worker-stage-sequence-truncated",
                *stages[-(MAX_WORKER_DIAGNOSTIC_STAGES - head_count - 1) :],
            ]
        if len(stages) == 1:
            return f" at stage {stages[0]}"
        return f" at stages {'>'.join(stages)}"
    for line in stderr.splitlines():
        if WORKER_BOOTLOADER_PATTERN.fullmatch(line):
            # Bootloader failures are useful for diagnosis, but paths and
            # arbitrary stderr are not part of the runtime error contract.
            detail = re.sub(r"[A-Za-z]:[\\/][^\r\n]*", "<path>", line.strip())
            if fallback_stage is not None:
                return f" at stage {fallback_stage}-bootloader"
            return f" ({detail[:180]})"
    return f" at stage {fallback_stage}" if fallback_stage is not None else ""


__all__ = [
    "DEFAULT_PROBE_TIMEOUT_SECONDS",
    "DEFAULT_RUN_TIMEOUT_SECONDS",
    "WorkerCancelledError",
    "WorkerExecutionError",
    "WorkerProcess",
]
