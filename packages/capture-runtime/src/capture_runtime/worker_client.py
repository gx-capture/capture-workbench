"""Validated client for installed OCR and Whisper worker executables."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from time import monotonic
from typing import Any

from capture_runtime.worker_process import (
    DEFAULT_PROBE_TIMEOUT_SECONDS,
    DEFAULT_RUN_TIMEOUT_SECONDS,
    WorkerExecutionError,
    WorkerProcess,
)

SHA256_PROVENANCE = re.compile(r"^sha256:[a-f0-9]{64}$")
WHISPER_CPU_MODEL_LOAD_FAILURE = re.compile(
    r"(?:at stage |>)whisper-model-load-cpu-failed-[a-z0-9-]+$"
)


class WorkerResultError(ValueError):
    """Raised when a worker result does not match the internal contract."""


@dataclass(frozen=True, slots=True)
class InstalledEngine:
    requirement_id: str
    artifact_version: str
    executable: Path
    model_dir: Path


@dataclass(frozen=True, slots=True)
class WorkerProbeResult:
    ready: bool
    code_ready: bool
    assets_ready: bool
    detail: str
    device: str | None


@dataclass(frozen=True, slots=True)
class WorkerSegment:
    order: int
    text: str
    page: int | None = None
    start_ms: int | None = None
    end_ms: int | None = None


@dataclass(frozen=True, slots=True)
class WorkerRunResult:
    segments: tuple[WorkerSegment, ...]
    engine: str
    model: str
    digest: str
    device: str
    warnings: tuple[str, ...]


def _string(value: object, label: str, *, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WorkerResultError(f"{label} must be a non-empty bounded string")
    return value


def parse_probe_result(payload: dict[str, Any]) -> WorkerProbeResult:
    if set(payload) != {"ready", "codeReady", "assetsReady", "detail", "device"}:
        raise WorkerResultError("worker probe result has unexpected fields")
    if not all(isinstance(payload[name], bool) for name in ("ready", "codeReady", "assetsReady")):
        raise WorkerResultError("worker probe readiness fields must be boolean")
    device = payload["device"]
    if device is not None and not isinstance(device, str):
        raise WorkerResultError("worker probe device must be a string or null")
    return WorkerProbeResult(
        ready=payload["ready"],
        code_ready=payload["codeReady"],
        assets_ready=payload["assetsReady"],
        detail=_string(payload["detail"], "worker probe detail"),
        device=device,
    )


def parse_run_result(payload: dict[str, Any]) -> WorkerRunResult:
    if set(payload) != {"segments", "provenance", "warnings"}:
        raise WorkerResultError("worker run result has unexpected fields")
    raw_segments = payload["segments"]
    if not isinstance(raw_segments, list) or len(raw_segments) > 100_000:
        raise WorkerResultError("worker segments must be a bounded list")
    segments: list[WorkerSegment] = []
    for expected_order, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict) or set(raw_segment) != {
            "order",
            "text",
            "page",
            "startMs",
            "endMs",
        }:
            raise WorkerResultError("worker segment has unexpected fields")
        if raw_segment["order"] != expected_order:
            raise WorkerResultError("worker segment order must be contiguous")
        page = raw_segment["page"]
        start_ms = raw_segment["startMs"]
        end_ms = raw_segment["endMs"]
        page_locator = isinstance(page, int) and not isinstance(page, bool) and page >= 1
        time_locator = (
            isinstance(start_ms, int)
            and not isinstance(start_ms, bool)
            and isinstance(end_ms, int)
            and not isinstance(end_ms, bool)
            and 0 <= start_ms <= end_ms
        )
        if page_locator == time_locator:
            raise WorkerResultError("worker segment must have exactly one valid locator")
        segments.append(
            WorkerSegment(
                order=expected_order,
                text=_string(raw_segment["text"], "worker segment text", maximum=2_000_000),
                page=page if page_locator else None,
                start_ms=start_ms if time_locator else None,
                end_ms=end_ms if time_locator else None,
            )
        )
    provenance = payload["provenance"]
    if not isinstance(provenance, dict) or set(provenance) != {
        "engine",
        "model",
        "digest",
        "device",
    }:
        raise WorkerResultError("worker provenance has unexpected fields")
    digest = provenance["digest"]
    if not isinstance(digest, str) or SHA256_PROVENANCE.fullmatch(digest) is None:
        raise WorkerResultError("worker provenance digest is invalid")
    warnings = payload["warnings"]
    if not isinstance(warnings, list) or len(warnings) > 100:
        raise WorkerResultError("worker warnings must be a bounded list")
    parsed_warnings = tuple(_string(item, "worker warning") for item in warnings)
    return WorkerRunResult(
        segments=tuple(segments),
        engine=_string(provenance["engine"], "worker engine"),
        model=_string(provenance["model"], "worker model"),
        digest=digest,
        device=_string(provenance["device"], "worker device"),
        warnings=parsed_warnings,
    )


class WorkerClient:
    def __init__(self, process: WorkerProcess | None = None) -> None:
        self.process = process or WorkerProcess()

    async def probe(
        self,
        engine: InstalledEngine,
        *,
        include_model: bool,
        options: dict[str, object] | None = None,
        timeout_seconds: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    ) -> WorkerProbeResult:
        payload: dict[str, object] = {
            "requirementId": engine.requirement_id,
            "artifactVersion": engine.artifact_version,
            "modelPath": str(engine.model_dir) if include_model else None,
        }
        if options is not None:
            payload["options"] = options
        response = await self.process.request(
            engine.executable,
            "probe",
            payload,
            timeout_seconds=timeout_seconds,
        )
        assert response.result is not None
        return parse_probe_result(response.result)

    async def run(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
    ) -> WorkerRunResult:
        if not source_path.is_file() or not source_path.is_absolute():
            raise ValueError("worker source path must be an existing absolute file")
        started_at = monotonic()
        payload: dict[str, object] = {
            "requirementId": engine.requirement_id,
            "artifactVersion": engine.artifact_version,
            "modelPath": str(engine.model_dir),
            "sourcePath": str(source_path),
            "mediaType": media_type,
            "options": options,
        }
        try:
            response = await self.process.request(
                engine.executable,
                "run",
                payload,
                cancel_event=cancel_event,
                timeout_seconds=timeout_seconds,
            )
        except WorkerExecutionError as error:
            # A failed CUDA constructor can poison the native ctranslate2
            # process before its in-process CPU fallback is attempted. Start
            # a clean worker for that narrow Whisper boundary instead of
            # retrying inside the contaminated process. The stage is already
            # allowlisted and contains no source path or backend detail.
            if (
                engine.requirement_id != "whisper-primary"
                or options.get("preferGpu") is not True
                or cancel_event.is_set()
                or WHISPER_CPU_MODEL_LOAD_FAILURE.search(str(error)) is None
            ):
                raise
            remaining_seconds = timeout_seconds - max(0.0, monotonic() - started_at)
            if remaining_seconds <= 0:
                raise
            cpu_options = {**options, "preferGpu": False}
            response = await self.process.request(
                engine.executable,
                "run",
                {**payload, "options": cpu_options},
                cancel_event=cancel_event,
                timeout_seconds=remaining_seconds,
            )
        assert response.result is not None
        return parse_run_result(response.result)

    async def shutdown(self) -> None:
        await self.process.shutdown()


__all__ = [
    "InstalledEngine",
    "WorkerClient",
    "WorkerProbeResult",
    "WorkerResultError",
    "WorkerRunResult",
    "WorkerSegment",
    "parse_probe_result",
    "parse_run_result",
]
