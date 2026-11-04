"""Installed engine identity plus the probe and shutdown calls every engine shares."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from capture_runtime._worker_payloads import WorkerProbeResult, parse_probe_result
from capture_runtime.worker_process import DEFAULT_PROBE_TIMEOUT_SECONDS, WorkerProcess


@dataclass(frozen=True, slots=True)
class InstalledEngine:
    requirement_id: str
    artifact_version: str
    executable: Path
    model_dir: Path
    # Populated by EngineInstallationManager from the verified catalog
    # descriptor. Test-only protocol callers may omit it.
    worker_sha256: str | None = None


class WorkerClient:
    def __init__(
        self,
        process: WorkerProcess | None = None,
        *,
        ocr_idle_seconds: float = 0.0,
    ) -> None:
        self.process = process or WorkerProcess()
        # An OCR worker keeps its DirectML sessions this long for the next run;
        # 0 starts a worker for each run.
        self.ocr_idle_seconds = ocr_idle_seconds

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

    async def shutdown(self) -> None:
        await self.process.shutdown()
