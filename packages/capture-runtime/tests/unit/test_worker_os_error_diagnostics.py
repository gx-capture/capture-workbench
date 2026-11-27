"""A worker's OSError reaches the runtime's diagnostics by type and number only."""

from __future__ import annotations

import io
import json
import os
import struct
import sys
from typing import Any

import pytest

from capture_runtime.speech.infrastructure.progressive_audio import ProgressiveSessionEvent
from capture_runtime.speech.infrastructure.speech_session import (
    SessionFrameType,
    encode_control,
)
from capture_runtime.worker_process import WorkerFailureDiagnostics, _worker_diagnostics
from capture_runtime.worker_stage_policy import (
    WorkerOsError,
    parse_worker_error_marker,
    worker_error_marker,
)
from capture_runtime.workers.server import report_worker_error
from capture_runtime.workers.speech_session_server import serve_session

_PRIVATE = r"C:\Users\secret-user\models\aligner\model.safetensors"


class _WindowsError(OSError):
    """An OSError carrying a Windows error code, on any platform."""

    winerror = 1455


def _paging_file_error() -> OSError:
    """What a failed commit raises on Windows, built on any platform."""

    error = OSError(12, "The paging file is too small", _PRIVATE)
    error.winerror = 1455  # type: ignore[misc]
    return error


class _LibraryError(FileNotFoundError):
    """An OSError subclass of a dependency, with a name of its own."""


def test_an_os_error_with_a_windows_error_reports_type_and_that_number(
    capsys: pytest.CaptureFixture[str],
) -> None:
    error = _WindowsError(12, "The paging file is too small", _PRIVATE)

    report_worker_error(error)

    assert capsys.readouterr().err == "capture-worker-error:OSError:1455\n"


@pytest.mark.skipif(os.name != "nt", reason="Python sets winerror only on Windows")
def test_a_windows_os_error_reports_its_windows_error_not_its_errno() -> None:
    error = OSError(None, "The paging file is too small", _PRIVATE, 1455)

    assert error.winerror == 1455
    assert error.errno != 1455
    assert worker_error_marker(error) == "capture-worker-error:OSError:1455"


def test_an_os_error_with_only_errno_reports_type_and_errno(
    capsys: pytest.CaptureFixture[str],
) -> None:
    report_worker_error(FileNotFoundError(2, "No such file or directory", _PRIVATE))

    assert capsys.readouterr().err == "capture-worker-error:FileNotFoundError:2\n"


def test_an_os_error_without_a_number_reports_its_type_only() -> None:
    assert worker_error_marker(OSError(_PRIVATE)) == "capture-worker-error:OSError"


def test_a_dependencys_os_error_is_reported_as_its_nearest_built_in_type() -> None:
    error = _LibraryError(2, "missing", _PRIVATE)

    assert worker_error_marker(error) == "capture-worker-error:FileNotFoundError:2"


@pytest.mark.parametrize(
    "error", [RuntimeError(_PRIVATE), MemoryError(), ValueError(_PRIVATE), KeyError(_PRIVATE)]
)
def test_another_exception_reports_nothing(
    capsys: pytest.CaptureFixture[str], error: Exception
) -> None:
    report_worker_error(error)

    assert worker_error_marker(error) is None
    assert capsys.readouterr().err == ""


def test_a_report_that_cannot_be_written_is_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sys, "stderr", None)

    report_worker_error(_WindowsError(12, "The paging file is too small", _PRIVATE))


class _FailingBackend:
    def start(self, metadata: dict[str, Any]) -> None:
        raise _paging_file_error()

    def input(self, window: object) -> list[ProgressiveSessionEvent]:
        return []

    def finish(self) -> list[ProgressiveSessionEvent]:
        return []

    def cancel(self) -> None:
        pass


def test_a_session_worker_reports_the_os_error_and_keeps_its_failure_frame(
    capsys: pytest.CaptureFixture[str],
) -> None:
    start = encode_control(
        SessionFrameType.START,
        {
            "protocolVersion": "3",
            "sessionId": "session-1",
            "sampleRate": 16_000,
            "channels": 1,
            "windowMs": 120_000,
            "overlapMs": 30_000,
            "source": {
                "sha256": "a" * 64,
                "fileName": "sample.wav",
                "mediaType": "audio/wav",
                "bytes": 1_000,
            },
        },
    )
    output = io.BytesIO()

    serve_session(
        _FailingBackend(),
        stdin=io.BytesIO(start),
        stdout=output,
        failure_context=lambda: "speech-transcription-call-complete",
    )

    frame = output.getvalue()
    frame_type, size = struct.unpack(">BI", frame[:5])
    assert frame_type == ord(SessionFrameType.ERROR.value)
    assert json.loads(frame[5 : 5 + size]) == {
        "code": "session_failed",
        "message": "Speech recognition session failed at OSError after stage "
        "speech-transcription-call-complete.",
        "retryable": True,
    }
    assert capsys.readouterr().err == "capture-worker-error:OSError:1455\n"


@pytest.mark.parametrize(
    ("stderr", "expected"),
    [
        ("capture-worker-error:OSError:1455\n", WorkerOsError("OSError", 1455)),
        ("capture-worker-error:PermissionError:5\r\n", WorkerOsError("PermissionError", 5)),
        ("capture-worker-error:OSError", WorkerOsError("OSError", None)),
        ("capture-worker-error:OSError:4294967295\n", WorkerOsError("OSError", 0xFFFF_FFFF)),
        # The last marker is the error that ended the run.
        (
            "capture-worker-error:FileNotFoundError:2\ncapture-worker-error:OSError:1455\n",
            WorkerOsError("OSError", 1455),
        ),
        # An older worker writes no marker.
        ("capture-worker-stage:speech-transcription-call-complete\n", WorkerOsError(None, None)),
        ("", WorkerOsError(None, None)),
    ],
)
def test_the_runtime_reads_a_valid_marker(stderr: str, expected: WorkerOsError) -> None:
    assert parse_worker_error_marker(stderr) == expected


@pytest.mark.parametrize(
    ("marker", "expected"),
    [
        (f"SafetensorError:{_PRIVATE}", WorkerOsError(None, None)),
        ("C_Users_secret_user:1455", WorkerOsError(None, 1455)),
        ("oserror:1455", WorkerOsError(None, 1455)),
        ("OSError:4294967296", WorkerOsError("OSError", None)),
        ("OSError:99999999999999999999", WorkerOsError("OSError", None)),
        ("OSError:-1", WorkerOsError("OSError", None)),
        ("OSError:0x5AF", WorkerOsError("OSError", None)),
        ("OSError:1455 paging file", WorkerOsError("OSError", None)),
        (f"OSError:1455:{_PRIVATE}", WorkerOsError("OSError", None)),
        ("OSError:١٤٥٥", WorkerOsError("OSError", None)),
        ("x" * 4096, WorkerOsError(None, None)),
    ],
)
def test_the_runtime_drops_each_value_that_does_not_validate(
    marker: str, expected: WorkerOsError
) -> None:
    assert parse_worker_error_marker(f"capture-worker-error:{marker}\n") == expected


def test_worker_diagnostics_carry_the_marker_and_no_other_stderr_text() -> None:
    stderr = "\n".join(
        [
            f"OSError: [WinError 1455] The paging file is too small: '{_PRIVATE}'",
            "capture-worker-stage:speech-transcription-call-complete",
            "capture-worker-error:OSError:1455",
        ]
    )

    diagnostics = _worker_diagnostics(
        stderr,
        failure_class="response-error",
        fallback_stage="worker-process-response-error",
        exit_code=1,
    )

    assert diagnostics == WorkerFailureDiagnostics(
        stage_sequence=("speech-transcription-call-complete",),
        failure_class="response-error",
        exit_code=1,
        worker_error_type="OSError",
        os_error_number=1455,
    )


def test_worker_diagnostics_without_a_marker_have_no_os_error() -> None:
    diagnostics = _worker_diagnostics(
        "capture-worker-stage:speech-transcription-call-complete\n",
        failure_class="response-error",
        exit_code=1,
    )

    assert (diagnostics.worker_error_type, diagnostics.os_error_number) == (None, None)


@pytest.mark.parametrize(
    ("worker_error_type", "os_error_number"),
    [(_PRIVATE, -1), ("RuntimeError", 2**32), (["OSError"], True), (None, "1455")],
)
def test_diagnostics_drop_invalid_os_error_values_instead_of_failing(
    worker_error_type: Any, os_error_number: Any
) -> None:
    diagnostics = WorkerFailureDiagnostics(
        stage_sequence=(),
        failure_class="worker",
        worker_error_type=worker_error_type,
        os_error_number=os_error_number,
    )

    assert (diagnostics.worker_error_type, diagnostics.os_error_number) == (None, None)
