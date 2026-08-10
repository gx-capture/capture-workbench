from __future__ import annotations

import asyncio
import ctypes
import os
import subprocess
import time
from pathlib import Path

import pytest

from capture_runtime.worker_client import InstalledEngine, WorkerClient
from capture_runtime.worker_contracts import WorkerProtocolError, WorkerResponse
from capture_runtime.worker_process import (
    WorkerCancelledError,
    WorkerExecutionError,
    WorkerProcess,
    _stage_suffix,
    _subprocess_path,
)

WORKER = Path(__file__).parent / "fixtures" / "deterministic_worker.py"
SERVER_WORKER = Path(__file__).parent / "fixtures" / "server_worker.py"


class RecordingWorkerProcess:
    def __init__(self) -> None:
        self.payloads: list[dict[str, object]] = []

    async def request(
        self,
        _executable: Path,
        _operation: str,
        payload: dict[str, object],
        *,
        timeout_seconds: float,
    ) -> WorkerResponse:
        del timeout_seconds
        self.payloads.append(payload)
        return WorkerResponse(
            request_id="probe",
            ok=True,
            result={
                "ready": True,
                "codeReady": True,
                "assetsReady": True,
                "detail": "ready",
                "device": None,
            },
            error=None,
        )


class FreshWhisperRetryProcess:
    def __init__(
        self,
        failure: str = "worker_failed at stage whisper-model-load-cpu-failed-runtimeerror",
    ) -> None:
        self.failure = failure
        self.options: list[dict[str, object]] = []
        self.timeouts: list[float] = []

    async def request(
        self,
        _executable: Path,
        _operation: str,
        payload: dict[str, object],
        *,
        cancel_event: asyncio.Event | None = None,
        timeout_seconds: float,
    ) -> WorkerResponse:
        del cancel_event
        options = payload["options"]
        assert isinstance(options, dict)
        self.options.append(options)
        self.timeouts.append(timeout_seconds)
        if len(self.options) == 1:
            raise WorkerExecutionError(self.failure)
        return WorkerResponse(
            request_id="run",
            ok=True,
            result={
                "segments": [
                    {
                        "order": 0,
                        "text": "words",
                        "page": None,
                        "startMs": 0,
                        "endMs": 1000,
                    }
                ],
                "provenance": {
                    "engine": "whisper-primary",
                    "model": "small",
                    "digest": f"sha256:{'1' * 64}",
                    "device": "cpu",
                },
                "warnings": [],
            },
            error=None,
        )


def test_worker_client_restarts_whisper_worker_for_cpu_fallback(
    tmp_path: Path,
) -> None:
    process = FreshWhisperRetryProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    async def run() -> None:
        result = await client.run(
            InstalledEngine(
                requirement_id="whisper-primary",
                artifact_version="engine-1",
                executable=tmp_path / "whisper.exe",
                model_dir=model_dir,
            ),
            source_path=source,
            media_type="audio/mpeg",
            options={"maxDurationMs": 60_000, "preferGpu": True},
            cancel_event=asyncio.Event(),
        )
        assert result.device == "cpu"
        assert result.model == "small"

    asyncio.run(run())
    assert process.options == [
        {"maxDurationMs": 60_000, "preferGpu": True},
        {"maxDurationMs": 60_000, "preferGpu": False},
    ]


def test_worker_client_does_not_retry_whisper_when_gpu_is_already_disabled(
    tmp_path: Path,
) -> None:
    process = FreshWhisperRetryProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    async def run() -> None:
        with pytest.raises(WorkerExecutionError):
            await client.run(
                InstalledEngine(
                    requirement_id="whisper-primary",
                    artifact_version="engine-1",
                    executable=tmp_path / "whisper.exe",
                    model_dir=model_dir,
                ),
                source_path=source,
                media_type="audio/mpeg",
                options={"maxDurationMs": 60_000, "preferGpu": False},
                cancel_event=asyncio.Event(),
            )

    asyncio.run(run())
    assert process.options == [{"maxDurationMs": 60_000, "preferGpu": False}]


def test_worker_client_does_not_retry_after_cpu_model_load_started(
    tmp_path: Path,
) -> None:
    process = FreshWhisperRetryProcess(
        "worker request timed out at stages whisper-model-load-cpu-start>"
        "whisper-model-load-cpu-complete>whisper-transcription-call-start"
    )
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")

    async def run() -> None:
        with pytest.raises(WorkerExecutionError):
            await client.run(
                InstalledEngine(
                    requirement_id="whisper-primary",
                    artifact_version="engine-1",
                    executable=tmp_path / "whisper.exe",
                    model_dir=model_dir,
                ),
                source_path=source,
                media_type="audio/mpeg",
                options={"maxDurationMs": 60_000, "preferGpu": True},
                cancel_event=asyncio.Event(),
            )

    asyncio.run(run())
    assert process.options == [{"maxDurationMs": 60_000, "preferGpu": True}]


def test_worker_client_cpu_retry_shares_original_timeout_budget(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = FreshWhisperRetryProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()
    source = tmp_path / "audio.mp3"
    source.write_bytes(b"audio")
    clock = iter((100.0, 106.0))
    monkeypatch.setattr("capture_runtime.worker_client.monotonic", lambda: next(clock))

    async def run() -> None:
        result = await client.run(
            InstalledEngine(
                requirement_id="whisper-primary",
                artifact_version="engine-1",
                executable=tmp_path / "whisper.exe",
                model_dir=model_dir,
            ),
            source_path=source,
            media_type="audio/mpeg",
            options={"maxDurationMs": 60_000, "preferGpu": True},
            cancel_event=asyncio.Event(),
            timeout_seconds=10,
        )
        assert result.device == "cpu"

    asyncio.run(run())
    assert process.timeouts == [10, 4]


def test_worker_client_carries_ocr_probe_options_without_changing_whisper(
    tmp_path: Path,
) -> None:
    process = RecordingWorkerProcess()
    client = WorkerClient(process=process)  # type: ignore[arg-type]
    model_dir = tmp_path / "model"
    model_dir.mkdir()

    async def probe() -> None:
        await client.probe(
            InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="engine-1",
                executable=tmp_path / "ocr.exe",
                model_dir=model_dir,
            ),
            include_model=True,
            options={"deviceId": 7},
        )
        await client.probe(
            InstalledEngine(
                requirement_id="whisper-primary",
                artifact_version="engine-1",
                executable=tmp_path / "whisper.exe",
                model_dir=model_dir,
            ),
            include_model=True,
        )

    asyncio.run(probe())
    assert process.payloads[0]["options"] == {"deviceId": 7}
    assert "options" not in process.payloads[1]


def test_worker_subprocess_path_removes_windows_extended_prefix_on_windows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("capture_runtime.worker_process.os.name", "nt")

    assert _subprocess_path(Path(r"\\?\C:\capture\worker.exe")) == r"C:\capture\worker.exe"
    assert (
        _subprocess_path(Path(r"\\?\UNC\server\share\worker.exe")) == r"\\server\share\worker.exe"
    )


def test_deterministic_worker_success_and_secret_isolation() -> None:
    owner = WorkerProcess(
        base_environment={
            "PATH": "C:\\Windows\\System32",
            "CAPTURE_API_TOKEN": "secret-value",
            "CAPTURE_TEST_SECRET": "secret-value",
        }
    )

    async def run() -> None:
        response = await owner.request(
            WORKER,
            "probe",
            {"mode": "security"},
            timeout_seconds=5,
        )
        assert response.result == {
            "apiTokenInEnvironment": False,
            "secretInEnvironment": False,
            "secretInArgv": False,
            "secretInStdin": False,
        }
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_drains_large_stderr_without_pipe_deadlock() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        response = await owner.request(
            WORKER,
            "probe",
            {"mode": "stderr-flood"},
            timeout_seconds=5,
        )
        assert response.result == {"value": "ok"}
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_timeout_reports_only_allowlisted_last_stage() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(
            WorkerExecutionError,
            match=r"^worker request timed out at stage model-load-cuda-start$",
        ):
            await owner.request(
                WORKER,
                "run",
                {"mode": "staged-timeout"},
                timeout_seconds=0.5,
            )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_no_response_reports_safe_exit_code_and_stage_only(tmp_path: Path) -> None:
    worker = tmp_path / "no_response_worker.py"
    worker.write_text(
        """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.write("C:\\\\Users\\\\secret-user\\\\private-source.pdf SECRET_STDERR\\n")
sys.stderr.write("capture-worker-stage:worker-boot\\n")
sys.stderr.flush()
os._exit(7)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "probe", {}, timeout_seconds=5)
        assert str(raised.value) == "worker returned no response with code 7 at stage worker-boot"
        assert "SECRET_STDERR" not in str(raised.value)
        assert "private-source.pdf" not in str(raised.value)
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_stage_diagnostics_accept_windows_crlf(tmp_path: Path) -> None:
    worker = tmp_path / "crlf_worker.py"
    worker.write_text(
        """
import os
import sys

sys.stdin.buffer.readline()
sys.stderr.buffer.write(b"capture-worker-stage:worker-crlf\\r\\n")
sys.stderr.buffer.flush()
os._exit(7)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError, match=r"at stage worker-crlf$"):
            await owner.request(worker, "probe", {}, timeout_seconds=5)

    asyncio.run(run())


def test_worker_stage_diagnostics_preserve_bounded_sequence_without_stderr() -> None:
    stderr = "\n".join(
        [
            "C:\\Users\\secret-user\\private-source.mp3 SECRET_STDERR",
            "capture-worker-stage:whisper-assets-probe-start",
            "capture-worker-stage:device-probe-complete",
            "capture-worker-stage:model-load-cuda-failed-runtimeerror",
            "capture-worker-stage:gpu-fallback",
            "capture-worker-stage:model-load-cpu-failed-runtimeerror",
        ]
    )

    detail = _stage_suffix(stderr)

    assert detail == (
        " at stages whisper-assets-probe-start>device-probe-complete>"
        "model-load-cuda-failed-runtimeerror>gpu-fallback>"
        "model-load-cpu-failed-runtimeerror"
    )
    assert "private-source.mp3" not in detail
    assert "SECRET_STDERR" not in detail


def test_worker_failure_response_wins_exit_and_hides_stderr(tmp_path: Path) -> None:
    worker = tmp_path / "failure_worker.py"
    worker.write_text(
        """
import json
import os
import sys

request = json.loads(sys.stdin.buffer.readline())
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": False,
    "result": None,
    "error": {
        "code": "worker_failed",
        "message": "Worker operation failed.",
        "retryable": True,
    },
}
sys.stderr.buffer.write(b"C:\\\\Users\\\\secret-user\\\\private-source.pdf SECRET_STDERR\\n")
sys.stderr.buffer.flush()
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert str(raised.value) == (
            "worker_failed: Worker operation failed. at stage worker-process-response-error"
        )
        assert "SECRET_STDERR" not in str(raised.value)
        assert "private-source.pdf" not in str(raised.value)
        assert owner.active_process_count == 0

    asyncio.run(run())


@pytest.mark.skipif(os.name != "nt", reason="Windows worker-tree release boundary")
def test_worker_response_releases_descendant_after_parent_exits(tmp_path: Path) -> None:
    worker = tmp_path / "failure_worker_with_child.py"
    pid_file = tmp_path / "child.pid"
    worker.write_text(
        """
import json
import os
import subprocess
import sys
import time

request = json.loads(sys.stdin.buffer.readline())
child = subprocess.Popen(
    [sys.executable, "-c", "import time; time.sleep(60)"],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.DEVNULL,
    stderr=subprocess.DEVNULL,
)
with open(request["payload"]["pidFile"], "w", encoding="ascii") as handle:
    handle.write(str(child.pid))
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": True,
    "result": {"value": "ok"},
    "error": None,
}
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(0)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        response = await owner.request(
            worker,
            "run",
            {"pidFile": str(pid_file)},
            timeout_seconds=5,
        )
        assert response.result == {"value": "ok"}

    asyncio.run(run())
    deadline = time.monotonic() + 5
    child_pid: int | None = None
    while time.monotonic() < deadline:
        if pid_file.is_file():
            raw_pid = pid_file.read_text(encoding="ascii").strip()
            if raw_pid:
                child_pid = int(raw_pid)
                break
        time.sleep(0.01)
    assert child_pid is not None
    try:
        assert not _windows_pid_is_live(child_pid)
    finally:
        if _windows_pid_is_live(child_pid):
            subprocess.run(
                ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                check=False,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )


@pytest.mark.skipif(os.name != "nt", reason="Windows worker-tree pipe boundary")
def test_worker_response_does_not_wait_for_inherited_descendant_pipes(
    tmp_path: Path,
) -> None:
    worker = tmp_path / "response_worker_with_inherited_pipes.py"
    pid_file = tmp_path / "inherited-child.pid"
    worker.write_text(
        """
import json
import os
import subprocess
import sys
import time

request = json.loads(sys.stdin.buffer.readline())
child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
with open(request["payload"]["pidFile"], "w", encoding="ascii") as handle:
    handle.write(str(child.pid))
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": True,
    "result": {"value": "ok"},
    "error": None,
}
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(0)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        response = await asyncio.wait_for(
            owner.request(
                worker,
                "run",
                {"pidFile": str(pid_file)},
                timeout_seconds=5,
            ),
            timeout=5,
        )
        assert response.result == {"value": "ok"}

    try:
        asyncio.run(run())
    finally:
        if pid_file.is_file():
            child_pid = int(pid_file.read_text(encoding="ascii").strip())
            if _windows_pid_is_live(child_pid):
                subprocess.run(
                    ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    shell=False,
                    check=False,
                    timeout=15,
                    creationflags=subprocess.CREATE_NO_WINDOW,
                )


def _windows_pid_is_live(pid: int) -> bool:
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    handle = kernel32.OpenProcess(0x00100000, False, pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0x00000102
    finally:
        kernel32.CloseHandle(handle)


def test_worker_failure_retains_last_stage_after_large_stderr(tmp_path: Path) -> None:
    worker = tmp_path / "large_stderr_failure_worker.py"
    worker.write_text(
        """
import json
import os
import sys

request = json.loads(sys.stdin.buffer.readline())
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": False,
    "result": None,
    "error": {
        "code": "worker_failed",
        "message": "Worker operation failed.",
        "retryable": True,
    },
}
sys.stderr.buffer.write(b"bounded diagnostic\\n" * 8192)
sys.stderr.buffer.write(b"capture-worker-stage:ocr-output-empty\\n")
sys.stderr.buffer.flush()
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert (
            str(raised.value) == "worker_failed: Worker operation failed. at stage ocr-output-empty"
        )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_response_failure_has_safe_fallback_stage(tmp_path: Path) -> None:
    worker = tmp_path / "response_failure_worker.py"
    worker.write_text(
        """
import json
import os
import sys

request = json.loads(sys.stdin.buffer.readline())
response = {
    "protocolVersion": "1",
    "requestId": request["requestId"],
    "ok": False,
    "result": None,
    "error": {"code": "worker_failed", "message": "Worker operation failed.", "retryable": True},
}
sys.stdout.buffer.write((json.dumps(response, separators=(",", ":")) + "\\n").encode())
sys.stdout.buffer.flush()
os._exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert str(raised.value) == (
            "worker_failed: Worker operation failed. at stage worker-process-response-error"
        )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_bootloader_failure_preserves_fallback_stage(tmp_path: Path) -> None:
    worker = tmp_path / "bootloader_failure_worker.py"
    worker.write_text(
        """
import sys

sys.stdin.buffer.readline()
sys.stderr.write("[PYI-123:ERROR] worker terminated before a response\\n")
sys.stderr.flush()
sys.exit(1)
""".lstrip(),
        encoding="utf-8",
    )
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(WorkerExecutionError) as raised:
            await owner.request(worker, "run", {}, timeout_seconds=5)
        assert str(raised.value) == (
            "worker returned no response with code 1 at stage worker-process-no-response-bootloader"
        )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_server_runs_native_handler_on_main_thread() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        response = await owner.request(
            SERVER_WORKER,
            "run",
            {},
            timeout_seconds=5,
        )
        assert response.result == {
            "mainThread": True,
            "operation": "run",
            "preparedOnMainThread": True,
        }
        assert owner.active_process_count == 0

    asyncio.run(run())


@pytest.mark.parametrize(
    ("mode", "error_type"),
    [
        ("malformed", WorkerProtocolError),
        ("oversized", WorkerProtocolError),
        ("multiple", WorkerProtocolError),
        ("protocol-mismatch", WorkerProtocolError),
        ("timeout", WorkerExecutionError),
    ],
)
def test_worker_malformed_protocol_and_timeout_leave_no_residue(
    mode: str, error_type: type[BaseException]
) -> None:
    owner = WorkerProcess()

    async def run() -> None:
        with pytest.raises(error_type):
            await owner.request(
                WORKER,
                "probe",
                {"mode": mode},
                timeout_seconds=0.1 if mode == "timeout" else 5,
            )
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_cancellation_is_bounded_and_leaves_no_residue() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        cancellation = asyncio.Event()
        task = asyncio.create_task(
            owner.request(
                WORKER,
                "run",
                {"mode": "cancel"},
                cancel_event=cancellation,
                timeout_seconds=5,
            )
        )
        await asyncio.sleep(0.05)
        cancellation.set()
        with pytest.raises(WorkerCancelledError):
            await task
        assert owner.active_process_count == 0

    asyncio.run(run())


def test_worker_shutdown_stops_all_owned_processes() -> None:
    owner = WorkerProcess()

    async def run() -> None:
        task = asyncio.create_task(
            owner.request(
                WORKER,
                "probe",
                {"mode": "timeout"},
                timeout_seconds=60,
            )
        )
        for _ in range(100):
            if owner.active_process_count == 1:
                break
            await asyncio.sleep(0.01)
        assert owner.active_process_count == 1
        await owner.shutdown()
        with pytest.raises(WorkerExecutionError):
            await task
        assert owner.active_process_count == 0

    asyncio.run(run())
