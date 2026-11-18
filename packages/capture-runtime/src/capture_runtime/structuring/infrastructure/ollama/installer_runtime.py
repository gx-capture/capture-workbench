"""Command execution primitives for runtime installation."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
from collections.abc import Callable, Collection, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from capture_runtime.contracts import RuntimeRequirementV2
from capture_runtime.install_progress import DownloadProgress


def _atomic_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


@dataclass(frozen=True, slots=True)
class CommandResult:
    return_code: int
    output: str


class CommandRunner(Protocol):
    async def run(
        self,
        arguments: list[str],
        *,
        environment: Mapping[str, str] | None,
        cwd: Path | None,
        cancel_event: asyncio.Event,
        timeout_seconds: float,
    ) -> CommandResult: ...


class AsyncSubprocessCommandRunner:
    async def run(
        self,
        arguments: list[str],
        *,
        environment: Mapping[str, str] | None,
        cwd: Path | None,
        cancel_event: asyncio.Event,
        timeout_seconds: float,
    ) -> CommandResult:
        creation_flags = 0
        if os.name == "nt":
            creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        process = await asyncio.create_subprocess_exec(
            *arguments,
            cwd=cwd,
            env=None if environment is None else dict(environment),
            stdin=subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            creationflags=creation_flags,
        )
        communicate = asyncio.create_task(process.communicate())
        cancellation = asyncio.create_task(cancel_event.wait())
        try:
            done, _ = await asyncio.wait(
                {communicate, cancellation},
                timeout=timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancellation in done and cancel_event.is_set():
                await self._stop_process(process)
                communicate.cancel()
                raise asyncio.CancelledError
            if communicate not in done:
                await self._stop_process(process)
                communicate.cancel()
                raise TimeoutError(f"command timed out after {timeout_seconds:g}s")
            output, _ = communicate.result()
            return CommandResult(
                return_code=process.returncode or 0,
                output=output.decode("utf-8", errors="replace")[-4000:],
            )
        finally:
            cancellation.cancel()

    @staticmethod
    async def _stop_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        if os.name == "nt":
            await asyncio.to_thread(
                subprocess.run,
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
            process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=10)
        except TimeoutError:
            process.kill()
            await process.wait()


class RuntimeInstaller(Protocol):
    def requirements(
        self,
        enabled_requirement_ids: Collection[str] | None = None,
    ) -> list[RuntimeRequirementV2]: ...

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        report_download: DownloadProgress | None = None,
    ) -> None: ...

    async def install_model_option(
        self,
        option_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None: ...

    def is_uninstallable(self, requirement_id: str) -> bool:
        """Whether the requirement is an engine install unit this installer can remove."""
        ...

    async def uninstall(self, requirement_id: str) -> None:
        """Remove an installed engine unit; a unit that is not installed is a no-op."""
        ...
