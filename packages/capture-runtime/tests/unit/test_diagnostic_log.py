"""The runtime diagnostic file contains only bounded, validated events."""

import logging
import re
from pathlib import Path
from typing import cast

from capture_runtime.contracts import CaptureSourceKind, CaptureStatus
from capture_runtime.diagnostic_log import (
    configure_diagnostic_log,
    record_capture_ended,
    record_worker_failure,
)
from capture_runtime.worker_process import WorkerFailureClass


def _worker_failure() -> None:
    record_worker_failure(
        requirement="speech-recognition",
        code="speech_recognition_worker_failed",
        failure_class="exit-nonzero",
        exit_code=7,
        cause=RuntimeError(r"C:\Users\example\private.wav Bearer fixture-secret-token"),
        stages=("speech-model-load-cpu-failed-unknown",),
        elapsed_ms=310,
    )


def test_worker_failure_is_one_allowlisted_line(tmp_path: Path) -> None:
    handler = configure_diagnostic_log(tmp_path)
    assert handler is not None
    try:
        _worker_failure()
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
    ]
    for private in (r"C:\Users\example", "private.wav", "Bearer", "fixture-secret-token"):
        assert private not in text


def test_invalid_values_are_replaced(tmp_path: Path) -> None:
    handler = configure_diagnostic_log(tmp_path)
    assert handler is not None
    private = "https://example.invalid/private.wav"
    try:
        record_worker_failure(
            requirement=private,
            code=private,
            failure_class=cast(WorkerFailureClass, private),
            exit_code=cast(int, private),
            cause=type(private, (Exception,), {})(),
            stages=("unknown-private-stage", private),
            elapsed_ms=True,
        )
        record_capture_ended(
            kind=cast(CaptureSourceKind, private),
            outcome=CaptureStatus.EXTRACTING,
            code="x" * 65,
            stage=private,
            elapsed_ms=cast(int, private),
        )
    finally:
        handler.close()
    text = Path(handler.baseFilename).read_text(encoding="utf-8")
    assert private not in text
    assert "unknown-private-stage" not in text
    assert (
        "worker-failure requirement=other code=other class=other exit=other "
        "cause=other stages=other>other elapsedMs=other"
    ) in text
    assert "capture-ended kind=other outcome=other code=other stage=other elapsedMs=other" in text


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
    finally:
        handler.close()
    assert Path(handler.baseFilename).read_text(encoding="utf-8").count(" runtime-start ") == 1


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
