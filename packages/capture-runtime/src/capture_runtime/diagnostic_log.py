"""Bounded, allowlisted diagnostics for the runtime process."""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime, timedelta
from logging.handlers import RotatingFileHandler
from pathlib import Path
from threading import Lock
from typing import get_args, override

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.contracts import CaptureRequirementId, CaptureSourceKind, CaptureStatus
from capture_runtime.worker_process import WorkerFailureClass
from capture_runtime.worker_stage_policy import MAX_WORKER_DIAGNOSTIC_STAGES, sanitize_worker_stage

_LOGGER = logging.getLogger("capture_runtime.diagnostics")
_LOGGER.setLevel(logging.INFO)
_LOGGER.propagate = False
_CONFIGURATION_LOCK = Lock()
_REQUIREMENTS = frozenset(get_args(CaptureRequirementId))
_FAILURE_CLASSES = frozenset(get_args(WorkerFailureClass))
_KINDS = frozenset(kind.value for kind in CaptureSourceKind)
_OUTCOMES = frozenset({"completed", "failed", "cancelled"})
_CODE = re.compile(r"[a-z0-9_]{1,64}")
_STAGE = re.compile(r"[a-z0-9-]{1,64}")
_EXCEPTION_TYPE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
_VERSION = re.compile(r"[0-9]{1,9}(?:\.[0-9]{1,9}){2}")
_MILLISECOND = timedelta(milliseconds=1)


class _DiagnosticHandler(RotatingFileHandler):
    @override
    def handleError(self, record: logging.LogRecord) -> None:
        # Logging's default traceback can disclose the log's filesystem path.
        pass

    @override
    def close(self) -> None:
        with _CONFIGURATION_LOCK:
            _LOGGER.removeHandler(self)
            super().close()


def configure_diagnostic_log(
    app_data_dir: Path, *, max_bytes: int = 1024 * 1024, backup_count: int = 3
) -> RotatingFileHandler | None:
    with _CONFIGURATION_LOCK:
        for existing in _LOGGER.handlers:
            if isinstance(existing, _DiagnosticHandler):
                return existing

        directory = app_data_dir / "logs"
        try:
            directory.mkdir(parents=True, exist_ok=True)
            handler = _DiagnosticHandler(
                directory / "runtime-diagnostics.log",
                maxBytes=max_bytes,
                backupCount=backup_count,
                encoding="utf-8",
                delay=True,
            )
        except OSError:
            return None
        _LOGGER.addHandler(handler)
        _record_runtime_start()
        return handler


def _record_runtime_start() -> None:
    _write("runtime-start", version=_matching(RUNTIME_VERSION, _VERSION))


def record_worker_failure(
    *,
    requirement: str,
    code: str,
    failure_class: WorkerFailureClass,
    exit_code: int | None,
    cause: BaseException | None,
    stages: tuple[str, ...],
    elapsed_ms: int,
) -> None:
    _write(
        "worker-failure",
        requirement=_allowed(requirement, _REQUIREMENTS),
        code=_matching(code, _CODE),
        **{
            "class": _allowed(failure_class, _FAILURE_CLASSES),
            "exit": "none" if exit_code is None else _integer(exit_code),
            "cause": "none" if cause is None else _matching(type(cause).__name__, _EXCEPTION_TYPE),
            "stages": _worker_stages(stages),
            "elapsedMs": _integer(elapsed_ms),
        },
    )


def record_capture_ended(
    *,
    kind: CaptureSourceKind,
    outcome: CaptureStatus,
    code: str | None,
    stage: str | None,
    elapsed_ms: int,
) -> None:
    _write(
        "capture-ended",
        kind=_allowed(kind, _KINDS),
        outcome=_allowed(outcome, _OUTCOMES),
        code="none" if code is None else _matching(code, _CODE),
        stage="none" if stage is None else _matching(stage, _STAGE),
        elapsedMs=_integer(elapsed_ms),
    )


def record_cancelled_capture_wait_expired(*, timeout_ms: int, pending_count: int) -> None:
    _write(
        "cancelled-capture-wait-expired",
        timeoutMs=_integer(timeout_ms, minimum=0),
        pendingCount=_integer(pending_count, minimum=1),
    )


def capture_elapsed_ms(created_at: datetime, ended_at: datetime) -> int:
    return max(0, (ended_at - created_at) // _MILLISECOND)


def _allowed(value: object, allowed: frozenset[str]) -> str:
    return value if isinstance(value, str) and value in allowed else "other"


def _matching(value: object, pattern: re.Pattern[str]) -> str:
    return value if isinstance(value, str) and pattern.fullmatch(value) else "other"


def _integer(value: object, *, minimum: int = -(2**63)) -> str:
    return str(value) if type(value) is int and minimum <= value < 2**63 else "other"


def _worker_stages(stages: object) -> str:
    if not isinstance(stages, tuple):
        return "other"
    return (
        ">".join(
            sanitize_worker_stage(stage) or "other"
            for stage in stages[-MAX_WORKER_DIAGNOSTIC_STAGES:]
        )
        or "none"
    )


def _write(event: str, **fields: str) -> None:
    if _LOGGER.handlers:
        timestamp = datetime.now(UTC).isoformat(timespec="milliseconds")
        values = " ".join(f"{key}={value}" for key, value in fields.items())
        _LOGGER.info("%s %s %s", timestamp, event, values)
