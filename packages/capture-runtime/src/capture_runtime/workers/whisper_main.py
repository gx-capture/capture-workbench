"""Separately packaged faster-whisper worker."""

# Imports are deliberately staged below so the packaged worker can report the
# exact failing import boundary before loading heavyweight model dependencies.
# ruff: noqa: E402, I001

from __future__ import annotations

import importlib
import importlib.util
import os
import re
import sys
from pathlib import Path
from threading import Event
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from capture_runtime.worker_contracts import WorkerRequest as WorkerRequestModel

STAGE_PREFIX = "capture-worker-stage:"
_WORKER_STAGES: list[str] = []


def _report_stage(stage: str) -> None:
    normalized = re.sub(r"[^a-z0-9]+", "-", stage.casefold()).strip("-")[:120]
    if not normalized:
        normalized = "worker-stage-invalid"
    _WORKER_STAGES.append(normalized)
    del _WORKER_STAGES[:-16]
    sys.stderr.write(f"{STAGE_PREFIX}{normalized}\n")
    sys.stderr.flush()


def _last_worker_stage() -> str:
    return _WORKER_STAGES[-1] if _WORKER_STAGES else ""


def _report_import_os_failure(stage: str, error: OSError) -> None:
    winerror = getattr(error, "winerror", None)
    if isinstance(winerror, int) and 0 <= winerror <= 65_535:
        _report_stage(f"{stage}-winerror-{winerror}")
    else:
        _report_stage(stage)


_report_stage("worker-entry-start")


def _import_capture_runtime() -> tuple[Any, Any, Any]:
    _report_stage("python-import-engine-adapters-start")
    try:
        from capture_runtime.engine_adapters import FasterWhisperAdapter
    except ModuleNotFoundError:
        _report_stage("python-import-engine-adapters-module-missing")
        raise
    except ImportError:
        _report_stage("python-import-engine-adapters-dependency-failed")
        raise
    except OSError as error:
        _report_import_os_failure("python-import-engine-adapters-os-failed", error)
        raise
    except BaseException:
        _report_stage("python-import-engine-adapters-failed")
        raise
    _report_stage("python-import-engine-adapters-complete")

    _report_stage("python-import-worker-contracts-start")
    try:
        from capture_runtime.worker_contracts import WorkerRequest
    except ModuleNotFoundError:
        _report_stage("python-import-worker-contracts-module-missing")
        raise
    except ImportError:
        _report_stage("python-import-worker-contracts-dependency-failed")
        raise
    except OSError as error:
        _report_import_os_failure("python-import-worker-contracts-os-failed", error)
        raise
    except BaseException:
        _report_stage("python-import-worker-contracts-failed")
        raise
    _report_stage("python-import-worker-contracts-complete")

    _report_stage("python-import-worker-server-start")
    try:
        from capture_runtime.workers.server import serve
    except ModuleNotFoundError:
        _report_stage("python-import-worker-server-module-missing")
        raise
    except ImportError:
        _report_stage("python-import-worker-server-dependency-failed")
        raise
    except OSError as error:
        _report_import_os_failure("python-import-worker-server-os-failed", error)
        raise
    except BaseException:
        _report_stage("python-import-worker-server-failed")
        raise
    _report_stage("python-import-worker-server-complete")
    return FasterWhisperAdapter, WorkerRequest, serve


FasterWhisperAdapter, WorkerRequest, serve = _import_capture_runtime()
_report_stage("python-import-capture-runtime-complete")

MAX_SOURCE_BYTES = 50 * 1024 * 1024


def _import_whisper_runtime() -> None:
    for module, stage in (
        ("ctranslate2", "python-import-ctranslate"),
        ("av", "python-import-av"),
        ("faster_whisper", "python-import-faster-whisper"),
    ):
        _report_stage(f"{stage}-start")
        importlib.import_module(module)
        _report_stage(f"{stage}-complete")


def _payload(request: WorkerRequestModel, expected: set[str]) -> dict[str, Any]:
    if set(request.payload) != expected:
        raise ValueError("Whisper worker payload fields are invalid")
    return request.payload


def _probe(request: WorkerRequestModel) -> dict[str, Any]:
    base_fields = {"requirementId", "artifactVersion", "modelPath"}
    payload_fields = frozenset(request.payload)
    if payload_fields not in {frozenset(base_fields), frozenset(base_fields | {"options"})}:
        raise ValueError("Whisper worker payload fields are invalid")
    payload = request.payload
    if payload["requirementId"] != "whisper-primary":
        raise ValueError("Whisper requirementId is invalid")
    options = payload.get("options", {})
    if not isinstance(options, dict) or set(options) - {"preferGpu"}:
        raise ValueError("Whisper probe options are invalid")
    prefer_gpu = options.get("preferGpu", True)
    if not isinstance(prefer_gpu, bool):
        raise ValueError("Whisper probe preferGpu is invalid")
    model_value = payload["modelPath"]
    if model_value is None:
        import importlib.util

        ready = all(
            importlib.util.find_spec(item) is not None
            for item in ("faster_whisper", "ctranslate2", "av")
        )
        return {
            "ready": ready,
            "codeReady": ready,
            "assetsReady": False,
            "detail": (
                "Whisper worker code is ready."
                if ready
                else "Whisper worker dependencies are unavailable."
            ),
            "device": None,
        }
    if not isinstance(model_value, str):
        raise ValueError("Whisper modelPath is invalid")
    model_path = Path(model_value)
    if not model_path.is_absolute() or not model_path.is_dir():
        raise ValueError("Whisper modelPath must be an existing absolute directory")
    adapter = FasterWhisperAdapter(
        model_path,
        primary_model="primary",
        fallback_model="fallback",
        primary_provenance_model="large-v3-turbo",
        fallback_provenance_model="small",
        prefer_gpu=prefer_gpu,
        max_duration_ms=8 * 60 * 60 * 1000,
        stage_reporter=_report_stage,
    )
    probe = adapter.probe()
    device = "cuda" if prefer_gpu and adapter._cuda_devices() > 0 else "cpu"
    return {
        "ready": probe.ready,
        "codeReady": probe.code_ready,
        "assetsReady": probe.assets_ready,
        "detail": probe.detail,
        "device": device,
    }


def _run(request: WorkerRequestModel, cancellation: Event) -> dict[str, Any]:
    payload = _payload(
        request,
        {
            "requirementId",
            "artifactVersion",
            "modelPath",
            "sourcePath",
            "mediaType",
            "options",
        },
    )
    if payload["requirementId"] != "whisper-primary":
        raise ValueError("Whisper requirementId is invalid")
    source_value = payload["sourcePath"]
    model_value = payload["modelPath"]
    options = payload["options"]
    if not isinstance(source_value, str) or not isinstance(model_value, str):
        raise ValueError("Whisper source/model path is invalid")
    source = Path(source_value)
    model_path = Path(model_value)
    if (
        not source.is_absolute()
        or not source.is_file()
        or source.stat().st_size > MAX_SOURCE_BYTES
        or not model_path.is_absolute()
        or not model_path.is_dir()
        or not isinstance(options, dict)
    ):
        raise ValueError("Whisper run paths/options are invalid")
    max_duration_ms = options.get("maxDurationMs")
    prefer_gpu = options.get("preferGpu")
    allow_cpu_fallback = options.get("allowCpuFallback", True)
    if (
        set(options) - {"maxDurationMs", "preferGpu", "allowCpuFallback"}
        or not isinstance(max_duration_ms, int)
        or isinstance(max_duration_ms, bool)
        or max_duration_ms <= 0
        or not isinstance(prefer_gpu, bool)
        or not isinstance(allow_cpu_fallback, bool)
    ):
        raise ValueError("Whisper run options are invalid")
    adapter = FasterWhisperAdapter(
        model_path,
        primary_model="primary",
        fallback_model="fallback",
        primary_provenance_model="large-v3-turbo",
        fallback_provenance_model="small",
        prefer_gpu=prefer_gpu,
        max_duration_ms=max_duration_ms,
        allow_cpu_fallback=allow_cpu_fallback,
        stage_reporter=_report_stage,
    )
    _import_whisper_runtime()
    result = adapter.transcribe(source, should_cancel=cancellation.is_set)
    return {
        "segments": [
            {
                "order": index,
                "text": item.text,
                "page": None,
                "startMs": item.start_ms,
                "endMs": item.end_ms,
            }
            for index, item in enumerate(result.segments)
        ],
        "provenance": {
            "engine": "whisper-primary",
            "model": result.model,
            "digest": result.digest,
            "device": result.device,
        },
        "warnings": [result.warning] if result.warning else [],
    }


def handle(request: WorkerRequestModel, cancellation: Event) -> dict[str, Any]:
    if request.operation == "probe":
        return _probe(request)
    if request.operation == "run":
        return _run(request, cancellation)
    raise ValueError("unsupported Whisper operation")


def prepare(request: WorkerRequestModel) -> None:
    if request.operation == "run":
        _import_whisper_runtime()


def _session() -> None:
    from capture_runtime.clock import SystemClock
    from capture_runtime.contracts import CaptureSource
    from capture_runtime.progressive_audio import ProgressiveAudioSession
    from capture_runtime.progressive_whisper import (
        DirectWindowDecoder,
        FasterWhisperWindowTranscriber,
        ProgressiveWhisperWorkerBackend,
    )
    from capture_runtime.workers.session_server import serve_session

    model_path = Path(os.environ.get("CAPTURE_SESSION_MODEL_PATH", ""))
    temp_dir = Path(os.environ.get("CAPTURE_SESSION_TEMP_DIR", ""))
    if not model_path.is_absolute() or not model_path.is_dir() or not temp_dir.is_absolute():
        raise ValueError("Whisper session paths are invalid")
    source = CaptureSource(
        sha256=os.environ["CAPTURE_SESSION_SOURCE_SHA256"],
        file_name=os.environ["CAPTURE_SESSION_FILE_NAME"],
        media_type=os.environ["CAPTURE_SESSION_MEDIA_TYPE"],
        bytes=int(os.environ["CAPTURE_SESSION_SOURCE_BYTES"]),
    )
    adapter = FasterWhisperAdapter(
        model_path,
        primary_model="primary",
        fallback_model="fallback",
        primary_provenance_model="large-v3-turbo",
        fallback_provenance_model="small",
        prefer_gpu=os.environ.get("CAPTURE_SESSION_PREFER_GPU", "1") == "1",
        allow_cpu_fallback=os.environ.get("CAPTURE_SESSION_ALLOW_CPU_FALLBACK", "1") == "1",
        max_duration_ms=8 * 60 * 60 * 1000,
        stage_reporter=_report_stage,
    )
    _import_whisper_runtime()
    decoder = DirectWindowDecoder()
    session = ProgressiveAudioSession(
        source,
        capture_id=os.environ["CAPTURE_SESSION_ID"],
        decoder=decoder,
        transcriber=FasterWhisperWindowTranscriber(adapter, temp_dir=temp_dir),
        clock=SystemClock(),
    )
    serve_session(
        ProgressiveWhisperWorkerBackend(session),
        failure_context=_last_worker_stage,
    )


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "session":
        _session()
    else:
        serve(handle, prepare=prepare)
