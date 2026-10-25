"""Separately packaged TEA-ASR worker."""

# Imports are deliberately staged below so the packaged worker can report the
# exact failing import boundary before loading heavyweight model dependencies.
# ruff: noqa: E402, I001

from __future__ import annotations

import importlib
import importlib.util
import os
import sys
from pathlib import Path
from threading import Event
from typing import TYPE_CHECKING, Any

from capture_runtime.worker_stage_policy import (
    sanitize_worker_stage,
    speech_import_os_failure_stage,
    speech_import_stage,
)

if TYPE_CHECKING:
    from capture_runtime.worker_contracts import WorkerRequest as WorkerRequestModel

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

STAGE_PREFIX = "capture-worker-stage:"
_WORKER_STAGES: list[str] = []


def _report_stage(stage: str) -> None:
    safe_stage = sanitize_worker_stage(stage)
    if safe_stage is None:
        return
    _WORKER_STAGES.append(safe_stage)
    del _WORKER_STAGES[:-16]
    sys.stderr.write(f"{STAGE_PREFIX}{safe_stage}\n")
    sys.stderr.flush()


def _last_worker_stage() -> str:
    return _WORKER_STAGES[-1] if _WORKER_STAGES else ""


def _report_import_os_failure(module: str, error: OSError) -> None:
    _report_stage(speech_import_os_failure_stage(module, error))


_report_stage("worker-entry-start")


def _import_capture_runtime() -> tuple[Any, Any, Any, Any]:
    _report_stage("python-import-engine-adapters-start")
    try:
        from capture_runtime.speech_recognition import TeaAsrAdapter
    except ModuleNotFoundError:
        _report_stage("python-import-engine-adapters-module-missing")
        raise
    except ImportError:
        _report_stage("python-import-engine-adapters-dependency-failed")
        raise
    except OSError as error:
        _report_import_os_failure("engine-adapters", error)
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
        _report_import_os_failure("worker-contracts", error)
        raise
    except BaseException:
        _report_stage("python-import-worker-contracts-failed")
        raise
    _report_stage("python-import-worker-contracts-complete")

    _report_stage("python-import-worker-server-start")
    try:
        from capture_runtime.workers.server import permille_reporter, serve
    except ModuleNotFoundError:
        _report_stage("python-import-worker-server-module-missing")
        raise
    except ImportError:
        _report_stage("python-import-worker-server-dependency-failed")
        raise
    except OSError as error:
        _report_import_os_failure("worker-server", error)
        raise
    except BaseException:
        _report_stage("python-import-worker-server-failed")
        raise
    _report_stage("python-import-worker-server-complete")
    return TeaAsrAdapter, WorkerRequest, serve, permille_reporter


TeaAsrAdapter, WorkerRequest, serve, permille_reporter = _import_capture_runtime()
_report_stage("python-import-capture-runtime-complete")

MAX_SOURCE_BYTES = 50 * 1024 * 1024


def _import_speech_runtime() -> None:
    for module in ("torch", "transformers", "librosa", "numpy", "av"):
        _report_stage(speech_import_stage(module, "start"))
        importlib.import_module(module)
        _report_stage(speech_import_stage(module, "complete"))


def _payload(request: WorkerRequestModel, expected: set[str]) -> dict[str, Any]:
    if set(request.payload) != expected:
        raise ValueError("Speech recognition worker payload fields are invalid")
    return request.payload


def _probe(request: WorkerRequestModel) -> dict[str, Any]:
    base_fields = {"requirementId", "artifactVersion", "modelPath"}
    payload_fields = frozenset(request.payload)
    if payload_fields not in {frozenset(base_fields), frozenset(base_fields | {"options"})}:
        raise ValueError("Speech recognition worker payload fields are invalid")
    payload = request.payload
    if payload["requirementId"] != "speech-recognition":
        raise ValueError("Speech recognition requirementId is invalid")
    options = payload.get("options", {})
    if not isinstance(options, dict) or set(options) - {"preferGpu"}:
        raise ValueError("Speech recognition probe options are invalid")
    prefer_gpu = options.get("preferGpu", True)
    if not isinstance(prefer_gpu, bool):
        raise ValueError("Speech recognition probe preferGpu is invalid")
    model_value = payload["modelPath"]
    if model_value is None:
        import importlib.util

        ready = all(
            importlib.util.find_spec(item) is not None
            for item in ("torch", "transformers", "librosa", "numpy", "av")
        )
        return {
            "ready": ready,
            "codeReady": ready,
            "assetsReady": False,
            "detail": (
                "Speech recognition worker code is ready."
                if ready
                else "Speech recognition worker dependencies are unavailable."
            ),
            "device": None,
        }
    if not isinstance(model_value, str):
        raise ValueError("Speech recognition modelPath is invalid")
    model_path = Path(model_value)
    if not model_path.is_absolute() or not model_path.is_dir():
        raise ValueError("Speech recognition modelPath must be an existing absolute directory")
    adapter = TeaAsrAdapter(
        model_path,
        primary_model="primary",
        fallback_model="fallback",
        primary_provenance_model="tea-asr-1.1",
        fallback_provenance_model="tea-asr-1.1-mini",
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


def _run(request: WorkerRequestModel, cancellation: Event, progress: Any = None) -> dict[str, Any]:
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
    if payload["requirementId"] != "speech-recognition":
        raise ValueError("Speech recognition requirementId is invalid")
    source_value = payload["sourcePath"]
    model_value = payload["modelPath"]
    options = payload["options"]
    if not isinstance(source_value, str) or not isinstance(model_value, str):
        raise ValueError("Speech recognition source/model path is invalid")
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
        raise ValueError("Speech recognition run paths/options are invalid")
    max_duration_ms = options.get("maxDurationMs")
    prefer_gpu = options.get("preferGpu")
    allow_cpu_fallback = options.get("allowCpuFallback", True)
    word_timestamps = options.get("wordTimestamps", False)
    if (
        set(options) - {"maxDurationMs", "preferGpu", "allowCpuFallback", "wordTimestamps"}
        or not isinstance(max_duration_ms, int)
        or isinstance(max_duration_ms, bool)
        or max_duration_ms <= 0
        or not isinstance(prefer_gpu, bool)
        or not isinstance(allow_cpu_fallback, bool)
        or not isinstance(word_timestamps, bool)
    ):
        raise ValueError("Speech recognition run options are invalid")
    adapter = TeaAsrAdapter(
        model_path,
        primary_model="primary",
        fallback_model="fallback",
        primary_provenance_model="tea-asr-1.1",
        fallback_provenance_model="tea-asr-1.1-mini",
        prefer_gpu=prefer_gpu,
        max_duration_ms=max_duration_ms,
        allow_cpu_fallback=allow_cpu_fallback,
        word_timestamps=word_timestamps,
        stage_reporter=_report_stage,
        progress_reporter=None if progress is None else permille_reporter(progress),
    )
    _import_speech_runtime()
    result = adapter.transcribe(source, should_cancel=cancellation.is_set)

    def words(item: Any) -> dict[str, Any]:
        if not word_timestamps:
            return {}
        return {
            "words": [
                {"startMs": word.start_ms, "endMs": word.end_ms, "text": word.text}
                for word in item.words
            ]
        }

    return {
        "segments": [
            {
                "order": index,
                "text": item.text,
                "page": None,
                "startMs": item.start_ms,
                "endMs": item.end_ms,
                **words(item),
            }
            for index, item in enumerate(result.segments)
        ],
        "provenance": {
            "engine": "speech-recognition",
            "model": result.model,
            "digest": result.digest,
            "device": result.device,
            "elapsedMs": result.elapsed_ms,
            "stageMs": result.stage_ms,
        },
        "warnings": [result.warning] if result.warning else [],
    }


def handle(
    request: WorkerRequestModel,
    cancellation: Event,
    progress: Any,
) -> dict[str, Any]:
    if request.operation == "probe":
        return _probe(request)
    if request.operation == "run":
        return _run(request, cancellation, progress)
    raise ValueError("unsupported Speech recognition operation")


def prepare(request: WorkerRequestModel) -> None:
    if request.operation == "run":
        _import_speech_runtime()


def _session() -> None:
    from capture_runtime.clock import SystemClock
    from capture_runtime.contracts import CaptureSource
    from capture_runtime.progressive_audio import ProgressiveAudioSession
    from capture_runtime.progressive_whisper import (
        DirectWindowDecoder,
        SpeechRecognitionWindowTranscriber,
        ProgressiveWhisperWorkerBackend,
    )
    from capture_runtime.workers.session_server import serve_session

    model_path = Path(os.environ.get("CAPTURE_SESSION_MODEL_PATH", ""))
    temp_dir = Path(os.environ.get("CAPTURE_SESSION_TEMP_DIR", ""))
    if not model_path.is_absolute() or not model_path.is_dir() or not temp_dir.is_absolute():
        raise ValueError("Speech recognition session paths are invalid")
    # One adapter for the worker's life: a warm worker serves several captures
    # with its models loaded.
    adapter = TeaAsrAdapter(
        model_path,
        primary_model="primary",
        fallback_model="fallback",
        primary_provenance_model="tea-asr-1.1",
        fallback_provenance_model="tea-asr-1.1-mini",
        prefer_gpu=os.environ.get("CAPTURE_SESSION_PREFER_GPU", "1") == "1",
        allow_cpu_fallback=os.environ.get("CAPTURE_SESSION_ALLOW_CPU_FALLBACK", "1") == "1",
        max_duration_ms=8 * 60 * 60 * 1000,
        stage_reporter=_report_stage,
    )
    _import_speech_runtime()

    def new_session(metadata: dict[str, Any]) -> ProgressiveAudioSession:
        source = metadata["source"]
        return ProgressiveAudioSession(
            CaptureSource(
                sha256=source["sha256"],
                file_name=source["fileName"],
                media_type=source["mediaType"],
                bytes=source["bytes"],
            ),
            capture_id=metadata["sessionId"],
            decoder=DirectWindowDecoder(),
            transcriber=SpeechRecognitionWindowTranscriber(adapter, temp_dir=temp_dir),
            clock=SystemClock(),
        )

    serve_session(
        ProgressiveWhisperWorkerBackend(new_session),
        failure_context=_last_worker_stage,
    )


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "session":
        _session()
    else:
        serve(handle, prepare=prepare)
