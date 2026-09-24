"""Owned worker subprocess lifecycle with bounded JSON-lines framing."""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import subprocess
import sys
from collections.abc import Callable, Mapping
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from capture_runtime.config import sanitized_child_environment
from capture_runtime.worker_contracts import (
    MAX_WORKER_INPUT_BYTES,
    MAX_WORKER_OUTPUT_BYTES,
    WorkerProgress,
    WorkerProtocolError,
    WorkerRequest,
    WorkerResponse,
)
from capture_runtime.worker_stage_policy import (
    MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH,
    MAX_WORKER_DIAGNOSTIC_STAGES,
    WORKER_STAGE_PATTERN,
    bound_worker_stage_sequence,
)
from capture_runtime.worker_stage_policy import (
    sanitize_worker_stage as _sanitize_worker_stage,
)
from capture_runtime.worker_stage_policy import (
    sanitize_worker_stage_sequence as _sanitize_stage_sequence,
)

DEFAULT_PROBE_TIMEOUT_SECONDS = 30.0
DEFAULT_RUN_TIMEOUT_SECONDS = 15 * 60.0
WORKER_CANCEL_GRACE_SECONDS = 2.0
WORKER_TERMINATE_GRACE_SECONDS = 3.0
MAX_WORKER_STDERR_BYTES = 64 * 1024
WORKER_ERROR_STAGE_PATTERN = re.compile(
    r"(?:^| at stage | at stages )([a-z0-9]+(?:-[a-z0-9]+)*(?:>[a-z0-9]+(?:-[a-z0-9]+)*)*)$"
)
WORKER_BOOTLOADER_PATTERN = re.compile(
    r"(?im)^\s*(?:\[PYI-[^\r\n]{0,80}|fatal error[^\r\n]{0,160})$"
)
WorkerFailureClass = Literal[
    "entry-point-missing",
    "timeout",
    "exit-before-response",
    "no-response",
    "termination",
    "response-error",
    "exit-nonzero",
    "protocol",
    "worker",
    "unavailable",
]
_WORKER_FAILURE_CLASSES = frozenset(
    {
        "entry-point-missing",
        "timeout",
        "exit-before-response",
        "no-response",
        "termination",
        "response-error",
        "exit-nonzero",
        "protocol",
        "worker",
        "unavailable",
    }
)


@dataclass(frozen=True, slots=True)
class WorkerFailureDiagnostics:
    """Sanitized, bounded diagnostics from one owned worker execution."""

    stage_sequence: tuple[str, ...]
    failure_class: WorkerFailureClass
    exit_code: int | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.stage_sequence, tuple):
            raise ValueError("worker diagnostic stages must be a tuple")
        stages = _sanitize_stage_sequence(self.stage_sequence, reject_unknown=True)
        stages = _bounded_stage_sequence(stages)
        if self.failure_class not in _WORKER_FAILURE_CLASSES:
            raise ValueError("worker failure class is not allowlisted")
        if self.exit_code is not None and (
            isinstance(self.exit_code, bool)
            or not isinstance(self.exit_code, int)
            or not -255 <= self.exit_code <= 255
        ):
            raise ValueError("worker exit code is invalid")
        object.__setattr__(self, "stage_sequence", stages)


class WorkerExecutionError(RuntimeError):
    """Raised when a checksum-pinned worker cannot produce a valid result."""

    def __init__(
        self,
        message: str,
        *,
        diagnostics: WorkerFailureDiagnostics | None = None,
    ) -> None:
        if diagnostics is not None and not isinstance(diagnostics, WorkerFailureDiagnostics):
            raise ValueError("worker diagnostics are invalid")
        self.diagnostics = diagnostics or _diagnostics_from_error_message(message)
        super().__init__(message)


class WorkerTimeoutError(WorkerExecutionError):
    """Raised when a worker exceeds its caller-owned execution budget."""


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
        progress_handler: Callable[[dict[str, object]], None] | None = None,
        timeout_seconds: float,
    ) -> WorkerResponse:
        if not executable.is_file():
            raise WorkerExecutionError(
                "installed worker entry point is missing at stage worker-process-entry-missing",
                diagnostics=WorkerFailureDiagnostics(
                    stage_sequence=("worker-process-entry-missing",),
                    failure_class="entry-point-missing",
                ),
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
            response: WorkerResponse | None = None
            while response is None:
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
                    raise WorkerTimeoutError(
                        "worker request timed out"
                        f"{_stage_suffix(stderr, 'worker-process-timeout')}",
                        diagnostics=_worker_diagnostics(
                            stderr,
                            failure_class="timeout",
                            fallback_stage="worker-process-timeout",
                        ),
                    )
                if exit_task in done and not read_task.done():
                    # A worker can write and flush its response immediately before
                    # exiting. Process.wait may complete before stdout delivers
                    # that line, so give the exited process a bounded opportunity.
                    try:
                        await asyncio.wait_for(
                            read_task,
                            timeout=WORKER_TERMINATE_GRACE_SECONDS,
                        )
                    except TimeoutError as error:
                        stderr = await self._collect_stderr(stderr_task)
                        raise WorkerExecutionError(
                            f"worker exited before a response with code {process.returncode}"
                            f"{_stage_suffix(stderr, 'worker-process-exit-before-response')}",
                            diagnostics=_worker_diagnostics(
                                stderr,
                                failure_class="exit-before-response",
                                fallback_stage="worker-process-exit-before-response",
                                exit_code=process.returncode,
                            ),
                        ) from error
                    except ValueError as error:
                        raise WorkerProtocolError(
                            "worker response exceeds the framing limit"
                        ) from error
                try:
                    line = await read_task
                except ValueError as error:
                    raise WorkerProtocolError(
                        "worker response exceeds the framing limit"
                    ) from error
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
                        f"{_stage_suffix(stderr, 'worker-process-no-response')}",
                        diagnostics=_worker_diagnostics(
                            stderr,
                            failure_class="no-response",
                            fallback_stage="worker-process-no-response",
                            exit_code=return_code,
                        ),
                    )
                if len(line) > MAX_WORKER_OUTPUT_BYTES or not line.endswith(b"\n"):
                    raise WorkerProtocolError("worker response exceeds the framing limit")
                try:
                    decoded = line.decode("utf-8")
                    raw_response = json.loads(decoded)
                except (UnicodeDecodeError, json.JSONDecodeError) as error:
                    raise WorkerProtocolError(
                        "worker response is not one UTF-8 JSON line"
                    ) from error
                if isinstance(raw_response, dict) and raw_response.get("kind") == "progress":
                    progress = WorkerProgress.from_dict(raw_response)
                    if progress.request_id != request.request_id:
                        raise WorkerProtocolError(
                            "worker progress requestId does not match request"
                        )
                    if progress_handler is not None:
                        progress_handler(progress.payload)
                    read_task = asyncio.create_task(process.stdout.readline())
                    waiters = {read_task, exit_task, timeout_task}
                    if cancel_task is not None:
                        waiters.add(cancel_task)
                    continue
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
                    "worker did not exit after its response at stage worker-process-termination",
                    diagnostics=WorkerFailureDiagnostics(
                        stage_sequence=("worker-process-termination",),
                        failure_class="termination",
                    ),
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
                    f"{_stage_suffix(stderr, 'worker-process-response-error')}",
                    diagnostics=_worker_diagnostics(
                        stderr,
                        failure_class="response-error",
                        fallback_stage="worker-process-response-error",
                        exit_code=process.returncode,
                    ),
                )
            if process.returncode != 0:
                raise WorkerExecutionError(
                    f"worker exited with code {process.returncode}"
                    f"{_stage_suffix(stderr, 'worker-process-exit-nonzero')}",
                    diagnostics=_worker_diagnostics(
                        stderr,
                        failure_class="exit-nonzero",
                        fallback_stage="worker-process-exit-nonzero",
                        exit_code=process.returncode,
                    ),
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


def _bounded_stage_sequence(stages: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    return bound_worker_stage_sequence(stages)


def _diagnostic_stage_sequence(stderr: str, fallback_stage: str | None = None) -> tuple[str, ...]:
    stages = _bounded_stage_sequence(
        _sanitize_stage_sequence(
            WORKER_STAGE_PATTERN.findall(stderr),
            reject_unknown=False,
        )
    )
    if stages:
        return stages
    for line in stderr.splitlines():
        if WORKER_BOOTLOADER_PATTERN.fullmatch(line):
            bootloader_stage = _sanitize_worker_stage(
                f"{fallback_stage}-bootloader" if fallback_stage is not None else None
            )
            return (bootloader_stage,) if bootloader_stage is not None else ()
    safe_fallback = _sanitize_worker_stage(fallback_stage)
    return (safe_fallback,) if safe_fallback is not None else ()


def _worker_diagnostics(
    stderr: str,
    *,
    failure_class: WorkerFailureClass,
    fallback_stage: str | None = None,
    exit_code: int | None = None,
) -> WorkerFailureDiagnostics:
    return WorkerFailureDiagnostics(
        stage_sequence=_diagnostic_stage_sequence(stderr, fallback_stage),
        failure_class=failure_class,
        exit_code=exit_code,
    )


def _diagnostics_from_error_message(message: str) -> WorkerFailureDiagnostics:
    """Keep legacy manually-created errors structured without retaining detail."""

    match = WORKER_ERROR_STAGE_PATTERN.search(message)
    if match is None:
        stages: tuple[str, ...] = ()
    else:
        stages = _sanitize_stage_sequence(
            match.group(1).split(">"),
            reject_unknown=False,
        )
    return WorkerFailureDiagnostics(stage_sequence=stages, failure_class="worker")


def _stage_suffix(stderr: str, fallback_stage: str | None = None) -> str:
    """Return a bounded, allowlisted worker-stage sequence, if present."""

    stages = _diagnostic_stage_sequence(stderr, fallback_stage)
    if stages:
        if len(stages) == 1:
            return f" at stage {stages[0]}"
        return f" at stages {'>'.join(stages)}"
    for line in stderr.splitlines():
        if WORKER_BOOTLOADER_PATTERN.fullmatch(line):
            # Bootloader failures are useful for diagnosis, but paths and
            # arbitrary stderr are not part of the runtime error contract.
            detail = re.sub(r"[A-Za-z]:[\\/][^\r\n]*", "<path>", line.strip())
            return f" ({detail[:180]})"
    safe_fallback = _sanitize_worker_stage(fallback_stage)
    return f" at stage {safe_fallback}" if safe_fallback is not None else ""


__all__ = [
    "DEFAULT_PROBE_TIMEOUT_SECONDS",
    "DEFAULT_RUN_TIMEOUT_SECONDS",
    "MAX_WORKER_DIAGNOSTIC_STAGES",
    "MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH",
    "WorkerCancelledError",
    "WorkerExecutionError",
    "WorkerFailureClass",
    "WorkerFailureDiagnostics",
    "WorkerTimeoutError",
    "WorkerProcess",
]
