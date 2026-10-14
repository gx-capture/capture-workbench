"""Separately packaged pyannote speaker diarization worker."""

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

from capture_runtime.worker_stage_policy import sanitize_worker_stage

if TYPE_CHECKING:
    from capture_runtime.worker_contracts import WorkerRequest as WorkerRequestModel

STAGE_PREFIX = "capture-worker-stage:"
MAX_SOURCE_BYTES = 50 * 1024 * 1024
MAX_SPEAKERS = 32


def _report_stage(stage: str) -> None:
    safe_stage = sanitize_worker_stage(stage)
    if safe_stage is None:
        return
    sys.stderr.write(f"{STAGE_PREFIX}{safe_stage}\n")
    sys.stderr.flush()


_report_stage("worker-entry-start")
_report_stage("python-import-capture-runtime-start")
try:
    from capture_runtime.speaker_diarization import (
        DIARIZATION_REQUIREMENT_ID,
        PyannoteDiarizationAdapter,
    )
    from capture_runtime.workers.server import permille_reporter, serve
except BaseException:
    _report_stage("python-import-capture-runtime-failed")
    raise
_report_stage("python-import-capture-runtime-complete")


def _prepare_environment() -> None:
    # The model is a local directory; the worker must never reach a model hub
    # or send pyannote usage metrics.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["PYANNOTE_METRICS_ENABLED"] = "0"
    # The runtime starts workers without USERNAME, and PyTorch asks for the
    # user name while it is imported; on Windows that lookup then fails.
    os.environ.setdefault("USERNAME", "capture-runtime")


def _import_diarization_runtime() -> None:
    _prepare_environment()
    _report_stage("python-import-av-start")
    importlib.import_module("av")
    _report_stage("python-import-av-complete")
    _report_stage("python-import-torch-start")
    importlib.import_module("torch")
    _report_stage("python-import-torch-complete")
    _report_stage("python-import-pyannote-start")
    importlib.import_module("pyannote.audio")
    _report_stage("python-import-pyannote-complete")


def _model_dir(payload: dict[str, Any]) -> Path:
    if payload["requirementId"] != DIARIZATION_REQUIREMENT_ID:
        raise ValueError("Diarization requirementId is invalid")
    value = payload["modelPath"]
    if not isinstance(value, str):
        raise ValueError("Diarization modelPath is invalid")
    model_dir = Path(value)
    if not model_dir.is_absolute() or not model_dir.is_dir():
        raise ValueError("Diarization modelPath must be an existing absolute directory")
    return model_dir


def _probe(request: WorkerRequestModel) -> dict[str, Any]:
    payload = request.payload
    base_fields = {"requirementId", "artifactVersion", "modelPath"}
    if set(payload) not in (base_fields, base_fields | {"options"}):
        raise ValueError("Diarization worker payload fields are invalid")
    options = payload.get("options", {})
    if not isinstance(options, dict) or set(options) - {"preferGpu"}:
        raise ValueError("Diarization probe options are invalid")
    prefer_gpu = options.get("preferGpu", True)
    if not isinstance(prefer_gpu, bool):
        raise ValueError("Diarization probe preferGpu is invalid")
    if payload["modelPath"] is None:
        # The installer checks the unpacked worker before any model exists.
        if payload["requirementId"] != DIARIZATION_REQUIREMENT_ID:
            raise ValueError("Diarization requirementId is invalid")
        ready = all(
            importlib.util.find_spec(name) is not None for name in ("torch", "pyannote", "av")
        )
        return {
            "ready": ready,
            "codeReady": ready,
            "assetsReady": False,
            "detail": (
                "Diarization worker code is ready."
                if ready
                else "Diarization worker dependencies are unavailable."
            ),
            "device": None,
        }
    adapter = PyannoteDiarizationAdapter(
        _model_dir(payload),
        prefer_gpu=prefer_gpu,
        max_duration_ms=1,
        stage_reporter=_report_stage,
    )
    probe = adapter.probe()
    device = None
    if probe.code_ready:
        device = "cuda" if prefer_gpu and adapter.cuda_available() else "cpu"
    return {
        "ready": probe.ready,
        "codeReady": probe.code_ready,
        "assetsReady": probe.assets_ready,
        "detail": probe.detail,
        "device": device,
    }


def _run(request: WorkerRequestModel, cancellation: Event, progress: Any = None) -> dict[str, Any]:
    payload = request.payload
    if set(payload) != {
        "requirementId",
        "artifactVersion",
        "modelPath",
        "sourcePath",
        "mediaType",
        "options",
    }:
        raise ValueError("Diarization worker payload fields are invalid")
    model_dir = _model_dir(payload)
    source_value = payload["sourcePath"]
    options = payload["options"]
    if not isinstance(source_value, str) or not isinstance(options, dict):
        raise ValueError("Diarization run paths/options are invalid")
    source = Path(source_value)
    if not source.is_absolute() or not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("Diarization run paths/options are invalid")
    max_duration_ms = options.get("maxDurationMs")
    prefer_gpu = options.get("preferGpu")
    allow_cpu_fallback = options.get("allowCpuFallback", True)
    num_speakers = options.get("numSpeakers")
    if (
        set(options) - {"maxDurationMs", "preferGpu", "allowCpuFallback", "numSpeakers"}
        or not isinstance(max_duration_ms, int)
        or isinstance(max_duration_ms, bool)
        or max_duration_ms <= 0
        or not isinstance(prefer_gpu, bool)
        or not isinstance(allow_cpu_fallback, bool)
        or (
            num_speakers is not None
            and (
                not isinstance(num_speakers, int)
                or isinstance(num_speakers, bool)
                or not 1 <= num_speakers <= MAX_SPEAKERS
            )
        )
    ):
        raise ValueError("Diarization run options are invalid")
    adapter = PyannoteDiarizationAdapter(
        model_dir,
        prefer_gpu=prefer_gpu,
        max_duration_ms=max_duration_ms,
        allow_cpu_fallback=allow_cpu_fallback,
        num_speakers=num_speakers,
        stage_reporter=_report_stage,
        progress_reporter=None if progress is None else permille_reporter(progress),
    )
    result = adapter.diarize(source, should_cancel=cancellation.is_set)

    def turns(items: Any) -> list[dict[str, Any]]:
        return [
            {"startMs": item.start_ms, "endMs": item.end_ms, "speaker": item.speaker}
            for item in items
        ]

    return {
        "turns": turns(result.turns),
        "exclusiveTurns": turns(result.exclusive_turns),
        "durationMs": result.duration_ms,
        "provenance": {
            "engine": DIARIZATION_REQUIREMENT_ID,
            "model": result.model,
            "digest": result.digest,
            "device": result.device,
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
    raise ValueError("unsupported diarization operation")


def prepare(request: WorkerRequestModel) -> None:
    if request.operation == "run":
        _import_diarization_runtime()


if __name__ == "__main__":
    serve(handle, prepare=prepare)
