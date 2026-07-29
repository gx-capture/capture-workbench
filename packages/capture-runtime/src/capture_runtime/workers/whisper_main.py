"""Separately packaged faster-whisper worker."""

from __future__ import annotations

from pathlib import Path
from threading import Event
from typing import Any

from capture_runtime.engine_adapters import FasterWhisperAdapter
from capture_runtime.worker_contracts import WorkerRequest
from capture_runtime.workers.server import serve

MAX_SOURCE_BYTES = 50 * 1024 * 1024


def _payload(request: WorkerRequest, expected: set[str]) -> dict[str, Any]:
    if set(request.payload) != expected:
        raise ValueError("Whisper worker payload fields are invalid")
    return request.payload


def _probe(request: WorkerRequest) -> dict[str, Any]:
    payload = _payload(request, {"requirementId", "artifactVersion", "modelPath"})
    if payload["requirementId"] != "whisper-primary":
        raise ValueError("Whisper requirementId is invalid")
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
        prefer_gpu=True,
        max_duration_ms=8 * 60 * 60 * 1000,
    )
    probe = adapter.probe()
    device = "cuda" if adapter._cuda_devices() > 0 else "cpu"
    return {
        "ready": probe.ready,
        "codeReady": probe.code_ready,
        "assetsReady": probe.assets_ready,
        "detail": probe.detail,
        "device": device,
    }


def _run(request: WorkerRequest, cancellation: Event) -> dict[str, Any]:
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
    if (
        not isinstance(max_duration_ms, int)
        or isinstance(max_duration_ms, bool)
        or max_duration_ms <= 0
        or not isinstance(prefer_gpu, bool)
    ):
        raise ValueError("Whisper run options are invalid")
    adapter = FasterWhisperAdapter(
        model_path,
        primary_model="primary",
        fallback_model="fallback",
        prefer_gpu=prefer_gpu,
        max_duration_ms=max_duration_ms,
    )
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


def handle(request: WorkerRequest, cancellation: Event) -> dict[str, Any]:
    if request.operation == "probe":
        return _probe(request)
    if request.operation == "run":
        return _run(request, cancellation)
    raise ValueError("unsupported Whisper operation")


if __name__ == "__main__":
    serve(handle)
