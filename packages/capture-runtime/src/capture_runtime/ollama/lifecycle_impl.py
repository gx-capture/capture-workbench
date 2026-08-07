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
        return OwnedProcess(process=process, output=output)

    def stop_tree(self, process: OwnedProcess) -> None:
        try:
            if process.poll() is not None:
                return
            if os.name == "nt":
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
            else:
                process.process.terminate()
                try:
                    process.process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.process.kill()
                    process.process.wait(timeout=5)
        finally:
            process.output.close()


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
