"""Owned Ollama process lifecycle implementation."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Protocol

from capture_runtime.clock import Clock
from capture_runtime.config import OllamaRuntimeConfig
from capture_runtime.model_catalog import ActiveModelSelectionStore


class OllamaOwnershipError(RuntimeError):
    pass


class RuntimeUnavailableError(RuntimeError):
    pass


class ManualActionRequiredError(RuntimeError):
    pass


@dataclass(slots=True)
class OwnedProcess:
    process: subprocess.Popen[bytes]
    output: BinaryIO
    windows_job_handle: int | None = None

    @property
    def pid(self) -> int:
        return self.process.pid

    def poll(self) -> int | None:
        return self.process.poll()


class ProcessController(Protocol):
    def is_pid_running(self, pid: int) -> bool: ...

    def spawn(
        self,
        executable: str,
        arguments: list[str],
        *,
        environment: Mapping[str, str],
        cwd: Path,
        output_path: Path,
    ) -> OwnedProcess: ...

    def stop_tree(self, process: OwnedProcess) -> None: ...


class SubprocessController:
    def is_pid_running(self, pid: int) -> bool:
        if pid <= 0:
            return False
        if os.name == "nt":
            return _windows_pid_is_running(pid)
        try:
            os.kill(pid, 0)
        except OSError:
            return False
        return True

    def spawn(
        self,
        executable: str,
        arguments: list[str],
        *,
        environment: Mapping[str, str],
        cwd: Path,
        output_path: Path,
    ) -> OwnedProcess:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output = output_path.open("ab")
        creation_flags = 0
        if os.name == "nt":
            creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        try:
            process = subprocess.Popen(
                [executable, *arguments],
                cwd=cwd,
                env=dict(environment),
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.STDOUT,
                shell=False,
                creationflags=creation_flags,
            )
        except Exception:
            output.close()
            raise
        windows_job_handle = None
        if os.name == "nt":
            try:
                windows_job_handle = _create_windows_kill_on_close_job(process)
            except Exception:
                self.stop_tree(OwnedProcess(process=process, output=output))
                raise
        return OwnedProcess(
            process=process,
            output=output,
            windows_job_handle=windows_job_handle,
        )

    def stop_tree(self, process: OwnedProcess) -> None:
        try:
            if os.name == "nt":
                if process.windows_job_handle is not None:
                    job_handle = process.windows_job_handle
                    process.windows_job_handle = None
                    _terminate_windows_job(job_handle)
                else:
                    subprocess.run(
                        ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                        stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.DEVNULL,
                        shell=False,
                        check=False,
                        timeout=15,
                        creationflags=subprocess.CREATE_NO_WINDOW,
                    )
                # ``taskkill`` reporting success only confirms that Windows
                # accepted the tree termination. Wait for the owned process
                # handle to become signaled before returning so the next
                # native engine cannot race Ollama's model/GPU teardown.
                try:
                    process.process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.process.kill()
                    process.process.wait(timeout=5)
            else:
                process.process.terminate()
                try:
                    process.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.process.kill()
                    process.process.wait(timeout=5)
        finally:
            process.output.close()


def _windows_pid_is_running(pid: int) -> bool:
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    synchronize = 0x00100000
    wait_timeout = 0x00000102
    access_denied = 5
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return ctypes.get_last_error() == access_denied
    try:
        wait_result = int(kernel32.WaitForSingleObject(handle, 0))
        return wait_result == wait_timeout
    finally:
        kernel32.CloseHandle(handle)


def _create_windows_kill_on_close_job(process: subprocess.Popen[bytes]) -> int:
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
        process_handle = ctypes.c_void_p(int(process._handle))  # type: ignore[attr-defined]
        if not kernel32.AssignProcessToJobObject(job, process_handle):
            raise ctypes.WinError(ctypes.get_last_error())
        return int(job)
    except BaseException:
        kernel32.CloseHandle(job)
        raise


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
            raise TimeoutError("owned Windows job did not terminate within 15 seconds")
        if wait_result == 0xFFFFFFFF:
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        kernel32.CloseHandle(job)


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


class IsolatedOllamaLifecycle:
    """Own exactly one Capture-specific Ollama server process and no foreign PID."""

    def __init__(
        self,
        config: OllamaRuntimeConfig,
        *,
        process_controller: ProcessController | None = None,
        executable_resolver: Callable[[], str | None] | None = None,
        clock: Clock,
    ) -> None:
        self.config = config
        self._controller = process_controller or SubprocessController()
        self._resolve_executable = executable_resolver or (lambda: shutil.which("ollama"))
        self._clock = clock
        self._owned: OwnedProcess | None = None
        self._lock = threading.RLock()

    def executable(self) -> str | None:
        return self._resolve_executable()

    def owns_running_process(self) -> bool:
        """Return whether this lifecycle still owns a live Ollama process."""

        with self._lock:
            return self._owned is not None and self._owned.poll() is None

    def active_model_selection(self) -> dict[str, object] | None:
        return ActiveModelSelectionStore(self.config.app_data_dir).load()

    def start(self) -> int:
        with self._lock:
            if self._owned is not None and self._owned.poll() is None:
                return self._owned.pid
            self._reject_unowned_live_pid()
            executable = self.executable()
            if executable is None:
                raise RuntimeUnavailableError("Ollama executable is not installed")
            self.config.app_data_dir.mkdir(parents=True, exist_ok=True)
            self.config.models_dir.mkdir(parents=True, exist_ok=True)
            owned = self._controller.spawn(
                executable,
                ["serve"],
                environment=self.config.process_environment(),
                cwd=self.config.app_data_dir,
                output_path=self.config.app_data_dir / "ollama.log",
            )
            self._owned = owned
            _atomic_json(
                self.config.pid_file,
                {
                    "pid": owned.pid,
                    "profileId": self.config.profile_id,
                    "startedAt": self._clock.now().isoformat(),
                },
            )
            return owned.pid

    def stop(self) -> None:
        with self._lock:
            owned = self._owned
            if owned is None:
                return
            self._owned = None
            self._controller.stop_tree(owned)
            self._remove_pid_file_if_owned(owned.pid)

    def _reject_unowned_live_pid(self) -> None:
        if not self.config.pid_file.exists():
            return
        try:
            payload = json.loads(self.config.pid_file.read_text(encoding="utf-8"))
            pid = int(payload["pid"])
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            self.config.pid_file.unlink(missing_ok=True)
            return
        if self._controller.is_pid_running(pid):
            raise OllamaOwnershipError(
                "Capture Ollama PID file points to a live process not owned by this runtime"
            )
        self.config.pid_file.unlink(missing_ok=True)

    def _remove_pid_file_if_owned(self, pid: int) -> None:
        try:
            payload = json.loads(self.config.pid_file.read_text(encoding="utf-8"))
            if int(payload.get("pid", -1)) == pid:
                self.config.pid_file.unlink(missing_ok=True)
        except (OSError, ValueError, TypeError, json.JSONDecodeError):
            return
