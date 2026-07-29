"""Owned worker subprocess lifecycle with bounded JSON-lines framing."""

from __future__ import annotations

import asyncio
import json
import os
import secrets
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


class WorkerProcess:
    """Launch and clean up only subprocesses created by this owner."""

    def __init__(
        self,
        *,
        base_environment: Mapping[str, str] | None = None,
    ) -> None:
        self._base_environment = sanitized_child_environment(base_environment)
        self._active: set[asyncio.subprocess.Process] = set()
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
            raise WorkerExecutionError("installed worker entry point is missing")
        if timeout_seconds <= 0:
            raise ValueError("worker timeout must be positive")
        request = WorkerRequest(_request_id(), operation, payload)  # type: ignore[arg-type]
        command = (
            [sys.executable, str(executable)]
            if executable.suffix.casefold() in {".py", ".pyw"}
            else [str(executable)]
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=dict(self._base_environment),
            cwd=str(executable.parent),
            limit=MAX_WORKER_OUTPUT_BYTES + 2,
            creationflags=(
                getattr(__import__("subprocess"), "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            ),
        )
        async with self._lock:
            self._active.add(process)
        try:
            assert process.stdin is not None
            assert process.stdout is not None
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
                raise WorkerExecutionError("worker request timed out")
            if exit_task in done and not read_task.done():
                stderr = await self._read_stderr(process)
                raise WorkerExecutionError(
                    f"worker exited before a response with code {process.returncode}"
                    + (f": {stderr}" if stderr else "")
                )
            try:
                line = await read_task
            except ValueError as error:
                raise WorkerProtocolError("worker response exceeds the framing limit") from error
            if not line:
                stderr = await self._read_stderr(process)
                raise WorkerExecutionError(
                    "worker returned no response" + (f": {stderr}" if stderr else "")
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
                await asyncio.wait_for(process.wait(), timeout=WORKER_TERMINATE_GRACE_SECONDS)
            except TimeoutError as error:
                await self._stop(process, initial_grace=0)
                raise WorkerExecutionError("worker did not exit after its response") from error
            if process.returncode != 0:
                stderr = await self._read_stderr(process)
                raise WorkerExecutionError(
                    f"worker exited with code {process.returncode}"
                    + (f": {stderr}" if stderr else "")
                )
            trailing = await process.stdout.read(1)
            if trailing:
                raise WorkerProtocolError("worker emitted more than one response line")
            if not response.ok:
                assert response.error is not None
                raise WorkerExecutionError(f"{response.error.code}: {response.error.message}")
            return response
        finally:
            for task_name in ("read_task", "exit_task", "cancel_task", "timeout_task"):
                task = locals().get(task_name)
                if isinstance(task, asyncio.Task) and not task.done():
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
            if process.returncode is None:
                await self._stop(process, initial_grace=0)
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
        if process.returncode is not None:
            return
        if initial_grace > 0:
            try:
                await asyncio.wait_for(process.wait(), timeout=initial_grace)
                return
            except TimeoutError:
                pass
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
    async def _read_stderr(process: asyncio.subprocess.Process) -> str:
        if process.stderr is None:
            return ""
        try:
            data = await asyncio.wait_for(
                process.stderr.read(MAX_WORKER_STDERR_BYTES + 1), timeout=0.25
            )
        except TimeoutError:
            return ""
        if len(data) > MAX_WORKER_STDERR_BYTES:
            data = data[:MAX_WORKER_STDERR_BYTES]
        return data.decode("utf-8", errors="replace").strip()


__all__ = [
    "DEFAULT_PROBE_TIMEOUT_SECONDS",
    "DEFAULT_RUN_TIMEOUT_SECONDS",
    "WorkerCancelledError",
    "WorkerExecutionError",
    "WorkerProcess",
]
