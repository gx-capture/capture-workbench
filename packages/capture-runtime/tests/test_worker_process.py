from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from capture_runtime.worker_client import InstalledEngine, WorkerClient
from capture_runtime.worker_contracts import WorkerProtocolError, WorkerResponse
from capture_runtime.worker_process import (
    WorkerCancelledError,
    WorkerExecutionError,
    WorkerProcess,
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
                timeout_seconds=0.1,
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
        assert str(raised.value) == "worker_failed: Worker operation failed."
        assert "SECRET_STDERR" not in str(raised.value)
        assert "private-source.pdf" not in str(raised.value)
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
