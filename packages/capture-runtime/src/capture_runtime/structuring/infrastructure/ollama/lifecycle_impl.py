"""Owned Ollama process lifecycle implementation."""

from __future__ import annotations

import asyncio
import codecs
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO, Protocol

from capture_runtime._windows_job import create_kill_on_close_job, terminate_and_close_job
from capture_runtime.clock import Clock
from capture_runtime.config import OllamaRuntimeConfig
from capture_runtime.structuring.infrastructure.model_catalog import ActiveModelSelectionStore
from capture_runtime.structuring.infrastructure.ollama.device_policy import (
    OllamaDevicePolicy,
    resolve_device_policy,
)
from capture_runtime.structuring.infrastructure.ollama.listener_owner import (
    ListenerOwner,
    SystemListenerOwner,
    choose_loopback_port,
)
from capture_runtime.structuring.infrastructure.ollama.server_log import OllamaLogParser

_LOG = logging.getLogger(__name__)
_LOG_READ_BYTES = 16 * 1024
_LOG_POLL_SECONDS = 0.02


def _drain_log(path: Path, offset: int, parser: OllamaLogParser, stop: threading.Event) -> None:
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    while not stop.is_set():
        try:
            with path.open("rb") as stream:
                stream.seek(offset)
                chunk = stream.read(_LOG_READ_BYTES)
        except OSError:
            chunk = b""
        if chunk:
            offset += len(chunk)
            parser.feed(decoder.decode(chunk))
        else:
            stop.wait(_LOG_POLL_SECONDS)


class OllamaOwnershipError(RuntimeError):
    pass


class RuntimeUnavailableError(RuntimeError):
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

    def process_creation_time(self, pid: int) -> int | None:
        """Raw OS creation-time integer, or None when it cannot be read."""
        ...

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

    def process_creation_time(self, pid: int) -> int | None:
        if pid <= 0:
            return None
        if os.name == "nt":
            return _windows_process_creation_time(pid)
        return _posix_process_creation_time(pid)

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


def _raw_creation_time(value: object) -> int | None:
    # JSON booleans are ints in Python. Only a real integer is a creation time.
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _recorded_process_creation_time(payload: object) -> int | None:
    if not isinstance(payload, dict):
        return None
    return _raw_creation_time(payload.get("processCreationTime"))


def _windows_process_creation_time(pid: int) -> int | None:
    """Raw FILETIME from GetProcessTimes, or None when the process cannot be queried."""

    import ctypes

    class Filetime(ctypes.Structure):
        _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetProcessTimes.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(Filetime),
        ctypes.POINTER(Filetime),
        ctypes.POINTER(Filetime),
        ctypes.POINTER(Filetime),
    ]
    kernel32.GetProcessTimes.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    # PROCESS_QUERY_LIMITED_INFORMATION. FILETIME is a 64-bit count of
    # 100-nanosecond intervals; keep that integer so comparison stays exact.
    process_query_limited_information = 0x1000
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return None
    try:
        created = Filetime()
        exited = Filetime()
        kernel = Filetime()
        user = Filetime()
        if not kernel32.GetProcessTimes(
            handle,
            ctypes.byref(created),
            ctypes.byref(exited),
            ctypes.byref(kernel),
            ctypes.byref(user),
        ):
            return None
        return (int(created.dwHighDateTime) << 32) | int(created.dwLowDateTime)
    finally:
        kernel32.CloseHandle(handle)


def _posix_process_creation_time(pid: int) -> int | None:
    try:
        stat = Path(f"/proc/{pid}/stat").read_bytes()
    except OSError:
        return None
    return _parse_proc_stat_start_time(stat)


def _parse_proc_stat_start_time(stat: bytes) -> int | None:
    # Field 22 is starttime. The comm field is wrapped in parentheses and may
    # itself contain spaces and parentheses, so count tokens after the last one.
    end = stat.rfind(b")")
    if end < 0:
        return None
    fields = stat[end + 1 :].split()
    if len(fields) < 20:
        return None
    try:
        value = int(fields[19])
    except ValueError:
        return None
    if value < 0:
        return None
    return value


def _create_windows_kill_on_close_job(process: subprocess.Popen[bytes]) -> int:
    return create_kill_on_close_job(int(process._handle))  # type: ignore[attr-defined]


def _terminate_windows_job(handle: int) -> None:
    terminate_and_close_job(
        handle, timeout_message="owned Windows job did not terminate within 15 seconds"
    )


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
        listener_owner: ListenerOwner | None = None,
        port_selector: Callable[[], int] = choose_loopback_port,
        listener_timeout_seconds: float = 10,
    ) -> None:
        self._listener_owner = listener_owner or SystemListenerOwner()
        self._port_selector = port_selector
        self._listener_timeout = listener_timeout_seconds
        self._host_url: str | None = None
        self.config = config
        self._controller = process_controller or SubprocessController()
        self._resolve_executable = executable_resolver or (lambda: shutil.which("ollama"))
        self._clock = clock
        self._owned: OwnedProcess | None = None
        self._lock = threading.RLock()
        self._lease_lock = asyncio.Lock()
        self._shutdown = threading.Event()
        self._log_stop: threading.Event | None = None
        self._log_thread: threading.Thread | None = None
        self.log_parser: OllamaLogParser | None = None
        self.device_policy: OllamaDevicePolicy | None = None

    def begin_shutdown(self) -> None:
        self._shutdown.set()

    def _check_start_allowed(self, cancel_event: asyncio.Event | None) -> None:
        if cancel_event is not None and cancel_event.is_set():
            raise asyncio.CancelledError
        if self._shutdown.is_set():
            raise RuntimeUnavailableError("isolated Ollama is shutting down")

    async def restart_for_device(
        self, policy: OllamaDevicePolicy, cancel_event: asyncio.Event
    ) -> None:
        """Reap under the document lease before attempting a corrected launch."""
        self._check_start_allowed(cancel_event)

        def replace_process() -> None:
            self.stop()
            self._check_start_allowed(cancel_event)
            self.start(policy=policy, cancel_event=cancel_event)

        replacement = asyncio.create_task(asyncio.to_thread(replace_process))
        try:
            await asyncio.shield(replacement)
        except asyncio.CancelledError:
            cancel_event.set()
            await asyncio.gather(replacement, return_exceptions=True)
            raise
        except OSError as exc:
            raise RuntimeUnavailableError("isolated Ollama could not restart") from exc

    @asynccontextmanager
    async def lease(self, cancel_event: asyncio.Event) -> AsyncIterator[None]:
        """Reserve process ownership through the caller's final cleanup."""

        acquire = asyncio.create_task(self._lease_lock.acquire())
        cancellation = asyncio.create_task(cancel_event.wait())
        try:
            await asyncio.wait((acquire, cancellation), return_when=asyncio.FIRST_COMPLETED)
            if cancel_event.is_set():
                raise asyncio.CancelledError
            await acquire
            yield
        finally:
            acquire.cancel()
            cancellation.cancel()
            # Both tasks may finish on the same loop turn. Return the lock
            # even when cancellation won before the caller entered the lease.
            if acquire.done() and not acquire.cancelled() and acquire.exception() is None:
                self._lease_lock.release()
            await asyncio.gather(acquire, cancellation, return_exceptions=True)

    def executable(self) -> str | None:
        return self._resolve_executable()

    def owns_running_process(self) -> bool:
        """Return whether this lifecycle still owns a live Ollama process."""

        with self._lock:
            return (
                self._owned is not None
                and self._owned.poll() is None
                and self._host_url is not None
                and self._listener_owner.listener_pid(int(self._host_url.rsplit(":", 1)[1]))
                == self._owned.pid
                and self._owned.poll() is None
            )

    @property
    def host_url(self) -> str:
        # Under the lock: start() holds it until the listener is verified, so a
        # reader never sees the URL of a lease that is still being checked.
        with self._lock:
            if not self.owns_running_process() or self._host_url is None:
                raise RuntimeUnavailableError("isolated Ollama listener ownership is not verified")
            return self._host_url

    def process_environment(self) -> dict[str, str]:
        return self.config.process_environment(self.host_url.removeprefix("http://"))

    def active_model_selection(self) -> dict[str, object] | None:
        return ActiveModelSelectionStore(self.config.app_data_dir).load()

    def start(
        self,
        *,
        policy: OllamaDevicePolicy | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> int:
        with self._lock:
            self._check_start_allowed(cancel_event)
            if self.owns_running_process():
                assert self._owned is not None
                return self._owned.pid
            self.stop()
            self._reject_unowned_live_pid()
            executable = self.executable()
            if executable is None:
                raise RuntimeUnavailableError("Ollama executable is not installed")
            self.config.app_data_dir.mkdir(parents=True, exist_ok=True)
            self.config.models_dir.mkdir(parents=True, exist_ok=True)
            # Every ordinary launch resolves the policy again, so a CUDA lookup
            # that failed (a GPU still waking) is retried at the next launch. A
            # corrective restart passes its corrected policy, which is kept.
            device_policy = policy or resolve_device_policy()
            output_path = self.config.app_data_dir / "ollama.log"
            for attempt in range(5):
                try:
                    self._check_start_allowed(cancel_event)
                    if (
                        attempt
                        and policy is None
                        and device_policy.target == "cuda"
                        and device_policy.cuda_uuid is None
                    ):
                        device_policy = resolve_device_policy()
                    try:
                        output_offset = output_path.stat().st_size
                    except FileNotFoundError:
                        output_offset = 0
                    port = self._port_selector()
                    self._host_url = f"http://127.0.0.1:{port}"
                    pin_reason = device_policy.cuda_pin_reason or (
                        "UUID unavailable"
                        if device_policy.target == "cuda"
                        else "target is not cuda"
                    )
                    _LOG.info(
                        "Starting owned Ollama: target=%s cuda_uuid_pin=%s reason=%s",
                        device_policy.target,
                        device_policy.cuda_uuid is not None,
                        "applied" if device_policy.cuda_uuid else pin_reason,
                    )
                    owned = self._controller.spawn(
                        executable,
                        ["serve"],
                        environment=device_policy.serve_environment(
                            self.config.process_environment(f"127.0.0.1:{port}")
                        ),
                        cwd=self.config.app_data_dir,
                        output_path=output_path,
                    )
                    self._owned = owned
                    self.device_policy = device_policy
                    self.log_parser = OllamaLogParser()
                    self._log_stop = threading.Event()
                    self._log_thread = threading.Thread(
                        target=_drain_log,
                        args=(output_path, output_offset, self.log_parser, self._log_stop),
                        daemon=True,
                    )
                    self._log_thread.start()
                    deadline = time.monotonic() + self._listener_timeout
                    while owned.poll() is None:
                        self._check_start_allowed(cancel_event)
                        owner = self._listener_owner.listener_pid(port)
                        # shell=False launches the server directly: other PIDs fail closed.
                        if owner == owned.pid:
                            break
                        if owner is not None or time.monotonic() >= deadline:
                            break
                        time.sleep(0.05)
                    self._check_start_allowed(cancel_event)
                    if self.owns_running_process():
                        break
                except OSError:
                    pass
                except BaseException:
                    # Anything else must not leave a started child behind.
                    self.stop()
                    raise
                self.stop()
            else:
                raise RuntimeUnavailableError(
                    "isolated Ollama listener could not be verified after 5 attempts"
                )
            try:
                payload: dict[str, object] = {
                    "pid": owned.pid,
                    "profileId": self.config.profile_id,
                    "startedAt": self._clock.now().isoformat(),
                }
                creation_time = _raw_creation_time(
                    self._controller.process_creation_time(owned.pid)
                )
                if creation_time is not None:
                    payload["processCreationTime"] = creation_time
                _atomic_json(self.config.pid_file, payload)
            except BaseException:
                self.stop()
                raise
            return owned.pid

    def stop(self) -> None:
        with self._lock:
            owned = self._owned
            self._host_url = None
            if owned is None:
                return
            if self._log_stop is not None and self._log_thread is not None:
                self._log_stop.set()
                self._log_thread.join()
                self._log_stop = None
                self._log_thread = None
            self.log_parser = None
            self.device_policy = None
            try:
                self._controller.stop_tree(owned)
            except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
                raise RuntimeUnavailableError("isolated Ollama could not be reaped") from exc
            self._owned = None
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
        if not self._controller.is_pid_running(pid):
            self.config.pid_file.unlink(missing_ok=True)
            return
        # Refuse unless both creation times are raw integers and they differ.
        # A missing or unreadable time keeps today's refusal of a live PID.
        recorded = _recorded_process_creation_time(payload)
        live = (
            _raw_creation_time(self._controller.process_creation_time(pid))
            if recorded is not None
            else None
        )
        if recorded is None or live is None or live == recorded:
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
