"""The runtime diagnostic file contains only bounded, validated events."""

import logging
import re
from collections.abc import Callable
from contextlib import nullcontext
from logging.handlers import RotatingFileHandler
from pathlib import Path
from types import SimpleNamespace
from typing import cast

import pytest
import uvicorn

from capture_runtime.__main__ import run_server
from capture_runtime.config import RuntimeSettings
from capture_runtime.contracts import CaptureSourceKind, CaptureStatus
from capture_runtime.diagnostic_log import (
    configure_diagnostic_log,
    record_cancelled_capture_wait_expired,
    record_capture_ended,
    record_worker_failure,
)
from capture_runtime.worker_process import WorkerFailureDiagnostics


def _worker_failure(
    cause: BaseException | None = None,
    *,
    worker_error_type: str | None = None,
    os_error_number: int | None = None,
) -> None:
    record_worker_failure(
        requirement="speech-recognition",
        code="speech_recognition_worker_failed",
        diagnostics=WorkerFailureDiagnostics(
            stage_sequence=("speech-model-load-cpu-failed-unknown",),
            failure_class="exit-nonzero",
            exit_code=7,
            worker_error_type=worker_error_type,
            os_error_number=os_error_number,
        ),
        cause=cause,
        elapsed_ms=310,
    )


@pytest.mark.usefixtures("isolated_server_logging")
@pytest.mark.parametrize("server_raises", [False, True])
def test_server_records_diagnostics_and_closes_log(
    settings_factory: Callable[..., RuntimeSettings],
    monkeypatch: pytest.MonkeyPatch,
    server_raises: bool,
) -> None:
    settings = settings_factory()
    logger = logging.getLogger("capture_runtime.diagnostics")
    handlers: list[logging.Handler] = []

    def run(server: uvicorn.Server) -> None:
        # uvicorn.run exits with a startup failure unless the server started.
        server.started = True
        _worker_failure()
        handlers.extend(logger.handlers)
        if server_raises:
            raise RuntimeError("server run failed")

    monkeypatch.setattr(uvicorn.Server, "run", run)
    with pytest.raises(RuntimeError, match="server run failed") if server_raises else nullcontext():
        run_server(settings)

    log = settings.app_data_dir / "logs" / "runtime-diagnostics.log"
    start_line, worker_line = log.read_text(encoding="utf-8").splitlines()
    assert " runtime-start version=" in start_line
    assert worker_line.split(" ", 1)[1] == (
        "worker-failure requirement=speech-recognition code=speech_recognition_worker_failed "
        "class=exit-nonzero exit=7 cause=none stages=speech-model-load-cpu-failed-unknown "
        "elapsedMs=310 workerErrorType=none osErrorNumber=none"
    )
    (handler,) = handlers
    assert isinstance(handler, RotatingFileHandler)
    assert handler.stream is None
    assert handler not in logger.handlers


def test_worker_failure_is_one_allowlisted_line(tmp_path: Path) -> None:
    handler = configure_diagnostic_log(tmp_path)
    assert handler is not None
    try:
        _worker_failure(RuntimeError(r"C:\Users\example\private.wav Bearer fixture-secret-token"))
    finally:
        handler.close()
    text = Path(handler.baseFilename).read_text(encoding="utf-8")
    worker_lines = [line for line in text.splitlines() if " worker-failure " in line]
    assert len(worker_lines) == 1
    timestamp, event, *fields = worker_lines[0].split()
    assert event == "worker-failure"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00", timestamp)
    assert fields == [
        "requirement=speech-recognition",
        "code=speech_recognition_worker_failed",
        "class=exit-nonzero",
        "exit=7",
        "cause=RuntimeError",
        "stages=speech-model-load-cpu-failed-unknown",
        "elapsedMs=310",
        "workerErrorType=none",
        "osErrorNumber=none",
    ]
    for private in (r"C:\Users\example", "private.wav", "Bearer", "fixture-secret-token"):
        assert private not in text


def test_invalid_values_are_replaced(tmp_path: Path) -> None:
    handler = configure_diagnostic_log(tmp_path)
    assert handler is not None
    private = "https://example.invalid/private.wav"
    try:
        # Diagnostics validate their own values; the log does not rely on that.
        unvalidated = SimpleNamespace(
            failure_class=private,
            exit_code=private,
            stage_sequence=("unknown-private-stage", private),
            worker_error_type=private,
            os_error_number=2**32,
        )
        record_worker_failure(
            requirement=private,
            code=private,
            diagnostics=cast(WorkerFailureDiagnostics, unvalidated),
            cause=type(private, (Exception,), {})(),
            elapsed_ms=True,
        )
        record_capture_ended(
            kind=cast(CaptureSourceKind, private),
            outcome=CaptureStatus.EXTRACTING,
            code="x" * 65,
            stage=private,
            elapsed_ms=cast(int, private),
        )
        record_cancelled_capture_wait_expired(timeout_ms=cast(int, private), pending_count=2**63)
        record_cancelled_capture_wait_expired(timeout_ms=-1, pending_count=0)
    finally:
        handler.close()
    text = Path(handler.baseFilename).read_text(encoding="utf-8")
    assert private not in text
    assert "unknown-private-stage" not in text
    assert (
        "worker-failure requirement=other code=other class=other exit=other "
        "cause=other stages=other>other elapsedMs=other "
        "workerErrorType=other osErrorNumber=other"
    ) in text
    assert "capture-ended kind=other outcome=other code=other stage=other elapsedMs=other" in text
    assert text.count("cancelled-capture-wait-expired timeoutMs=other pendingCount=other") == 2


def test_worker_os_error_is_logged_by_type_and_number(tmp_path: Path) -> None:
    handler = configure_diagnostic_log(tmp_path)
    assert handler is not None
    try:
        _worker_failure(
            RuntimeError(r"C:\Users\example\model.safetensors"),
            worker_error_type="OSError",
            os_error_number=1455,
        )
    finally:
        handler.close()
    text = Path(handler.baseFilename).read_text(encoding="utf-8")
    (line,) = [line for line in text.splitlines() if " worker-failure " in line]
    assert line.endswith(
        " cause=RuntimeError stages=speech-model-load-cpu-failed-unknown elapsedMs=310"
        " workerErrorType=OSError osErrorNumber=1455"
    )
    assert "example" not in text
    assert "safetensors" not in text


def test_rotation_caps_file_count_and_size(tmp_path: Path) -> None:
    max_bytes = 250
    backups = 2
    handler = configure_diagnostic_log(tmp_path, max_bytes=max_bytes, backup_count=backups)
    assert handler is not None
    try:
        for _ in range(20):
            _worker_failure()
    finally:
        handler.close()
    files = list((tmp_path / "logs").iterdir())
    assert len(files) == backups + 1
    for file in files:
        data = file.read_bytes()
        assert data
        assert len(data) <= max_bytes + max(map(len, data.splitlines(keepends=True)))


def test_configuration_is_idempotent(tmp_path: Path) -> None:
    handler = configure_diagnostic_log(tmp_path)
    assert handler is not None
    try:
        assert configure_diagnostic_log(tmp_path) is handler
        assert logging.getLogger("capture_runtime.diagnostics").handlers == [handler]
        _worker_failure()
    finally:
        handler.close()
    log = Path(handler.baseFilename).read_text(encoding="utf-8")
    assert log.count(" runtime-start ") == 1
    assert " cause=none " in log


def test_write_error_is_silent(tmp_path: Path, capsys) -> None:
    handler = configure_diagnostic_log(tmp_path)
    assert handler is not None
    try:

        def fail_to_rollover() -> None:
            raise OSError("private path")

        handler.doRollover = fail_to_rollover  # type: ignore[method-assign]
        handler.maxBytes = 1
        _worker_failure()
    finally:
        handler.close()
    assert capsys.readouterr().err == ""
