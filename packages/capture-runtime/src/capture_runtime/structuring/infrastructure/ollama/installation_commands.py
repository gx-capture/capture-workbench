"""Command execution primitives for runtime installation."""

from __future__ import annotations

import asyncio
import os
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


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
