"""Validated client for installed OCR and Whisper worker executables."""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal

from capture_runtime._worker_payloads import (
    SHA256_PROVENANCE,
    WorkerDiarizationResult,
    WorkerOcrPage,
    WorkerOcrProgress,
    WorkerProbeResult,
    WorkerResultError,
    WorkerRunResult,
    WorkerSegment,
    WorkerWord,
    _assert_ocr_progress_matches_final,
    _canonical_manifest_page,
    _consecutive_progress_prefix,
    _largest_manifest_page_pixels,
    _OcrProgressConsistencyError,
    _permille_handler,
    _safe_parse_ocr_progress,
    parse_diarization_result,
    parse_ocr_compute_preflight,
    parse_ocr_compute_selection,
    parse_ocr_progress,
    parse_probe_result,
    parse_run_result,
)
from capture_runtime.contracts import OcrComputePreflightV2, OcrProvenanceV3
from capture_runtime.ocr_preflight import OcrComputeSelection, OcrExecutionPlan
from capture_runtime.worker_contracts import WorkerProtocolError
from capture_runtime.worker_process import (
    DEFAULT_PROBE_TIMEOUT_SECONDS,
    DEFAULT_RUN_TIMEOUT_SECONDS,
    WorkerExecutionError,
    WorkerFailureDiagnostics,
    WorkerProcess,
    WorkerTimeoutError,
)

# DirectML keeps the GPU buffers of every run in a worker's sessions: after a
# 12 MP photo a warm worker held 7.8 GB of an 8 GB GPU and its next page read
# as empty. Only runs whose pages are at most this large use a warm worker; a
# larger one gets fresh sessions and the GPU memory a warm worker would hold.
OCR_WARM_MAX_PAGE_PIXELS = 2048 * 2048


@dataclass(frozen=True, slots=True)
class InstalledEngine:
    requirement_id: str
    artifact_version: str
    executable: Path
    model_dir: Path
    # Populated by EngineInstallationManager from the verified catalog
    # descriptor. Test-only protocol callers may omit it.
    worker_sha256: str | None = None


class OcrWorkerFailure(WorkerExecutionError):
    """Sanitized OCR worker failure with any validated progress preserved."""

    _MESSAGES = {
        "timeout": "OCR worker timed out before completing all pages.",
        "protocol": "OCR worker returned an invalid response.",
        "worker": "OCR worker failed before completing all pages.",
        "unavailable": "OCR runtime was unavailable before completing all pages.",
    }

    def __init__(
        self,
        *,
        kind: Literal["timeout", "protocol", "worker", "unavailable"],
        progress: WorkerOcrProgress | None,
        provenance: OcrProvenanceV3 | None = None,
        diagnostics: WorkerFailureDiagnostics | None = None,
        worker_sha256: str | None = None,
    ) -> None:
        self.kind = kind
        self.progress = progress
        self.provenance = provenance or (progress.provenance if progress is not None else None)
        self._diagnostics = diagnostics or WorkerFailureDiagnostics(
            stage_sequence=(),
            failure_class=kind,
        )
        self._worker_sha256 = (
            worker_sha256
            if isinstance(worker_sha256, str)
            and SHA256_PROVENANCE.fullmatch(f"sha256:{worker_sha256}")
            else None
        )
        super().__init__(self._MESSAGES[kind], diagnostics=self._diagnostics)
        # OCR callers only receive the sanitized public failure projection;
        # diagnostics remain an in-process handoff to the private evidence seam.
        del self.diagnostics


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

    async def ocr_compute_preflight(
        self,
        engine: InstalledEngine,
        *,
        contract_sha256: str,
        timeout_seconds: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    ) -> OcrComputePreflightV2:
        """Run one model-free compute probe in the installed OCR worker."""

        payload: dict[str, object] = {
            "requirementId": engine.requirement_id,
            "artifactVersion": engine.artifact_version,
            "modelPath": None,
            "contractSha256": contract_sha256,
            "options": {},
        }
        if engine.worker_sha256 is not None:
            payload["expectedWorkerSha256"] = engine.worker_sha256
        response = await self.process.request(
            engine.executable,
            "preflight",
            payload,
            timeout_seconds=timeout_seconds,
        )
        assert response.result is not None
        return parse_ocr_compute_preflight(response.result)

    async def ocr_compute_selection(
        self,
        engine: InstalledEngine,
        *,
        contract_sha256: str,
        timeout_seconds: float = DEFAULT_PROBE_TIMEOUT_SECONDS,
    ) -> OcrComputeSelection:
        """Run one worker-owned selection and retain its private plan."""

        payload: dict[str, object] = {
            "requirementId": engine.requirement_id,
            "artifactVersion": engine.artifact_version,
            "modelPath": None,
            "contractSha256": contract_sha256,
            "options": {},
        }
        if engine.worker_sha256 is not None:
            payload["expectedWorkerSha256"] = engine.worker_sha256
        response = await self.process.request(
            engine.executable,
            "preflight",
            payload,
            timeout_seconds=timeout_seconds,
        )
        assert response.result is not None
        return parse_ocr_compute_selection(response.result)

    async def run(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
        ocr_progress: Callable[[int, int], None] | None = None,
        on_permille: Callable[[int], None] | None = None,
        vertical_reader_dir: Path | None = None,
    ) -> WorkerRunResult:
        if not source_path.is_file() or not source_path.is_absolute():
            raise ValueError("worker source path must be an existing absolute file")
        payload: dict[str, object] = {
            "requirementId": engine.requirement_id,
            "artifactVersion": engine.artifact_version,
            "modelPath": str(engine.model_dir),
            "sourcePath": str(source_path),
            "mediaType": media_type,
            "options": options,
        }
        is_ocr = engine.requirement_id == "windowsml-ocr"
        if is_ocr and vertical_reader_dir is not None:
            payload["verticalReaderPath"] = str(vertical_reader_dir)
        progress_frames: list[dict[str, object]] = []

        def collect_ocr_progress(frame: dict[str, object]) -> None:
            candidate = [*progress_frames, frame]
            # Validate before committing the frame so a malformed terminal
            # progress frame cannot erase already trusted completed pages.
            progress = parse_ocr_progress(candidate)
            progress_frames.append(frame)
            if ocr_progress is None or progress is None or not progress.pages:
                return
            if cancel_event.is_set():
                return
            # Only consecutive, successful pages matching the requested raster
            # manifest count as movement. Do not publish text or terminal success.
            requested_manifest = options.get("pageManifest")
            if requested_manifest is not None and candidate[0]["pages"] != requested_manifest:
                return
            if any(
                page.status not in {"recognized", "empty"}
                or _canonical_manifest_page(page) != _canonical_manifest_page(expected)
                for page, expected in zip(progress.pages, progress.page_manifest, strict=False)
            ):
                return
            ocr_progress(len(progress.pages), progress.page_count)

        progress_handler = collect_ocr_progress if is_ocr else _permille_handler(on_permille)
        # Acceptance runs bind an execution proof to each run's own sessions.
        largest_page = _largest_manifest_page_pixels(options.get("pageManifest"))
        keep_warm = (
            is_ocr
            and self.ocr_idle_seconds > 0
            and "runtimeSha256" not in options
            and largest_page is not None
            and largest_page <= OCR_WARM_MAX_PAGE_PIXELS
        )
        release_warm = getattr(self.process, "release_warm", None)
        if is_ocr and not keep_warm and release_warm is not None:
            await release_warm()
        try:
            if keep_warm:
                response = await self.process.request_warm(
                    engine.executable,
                    "run",
                    payload,
                    idle_seconds=self.ocr_idle_seconds,
                    cancel_event=cancel_event,
                    progress_handler=progress_handler,
                    timeout_seconds=timeout_seconds,
                )
            else:
                response = await self.process.request(
                    engine.executable,
                    "run",
                    payload,
                    cancel_event=cancel_event,
                    **(
                        {"progress_handler": progress_handler}
                        if progress_handler is not None
                        else {}
                    ),
                    timeout_seconds=timeout_seconds,
                )
        except WorkerTimeoutError as error:
            if is_ocr:
                raise OcrWorkerFailure(
                    kind="timeout",
                    progress=_safe_parse_ocr_progress(progress_frames),
                    diagnostics=error.diagnostics,
                    worker_sha256=engine.worker_sha256,
                ) from error
            raise
        except WorkerProtocolError as error:
            if is_ocr:
                progress = _safe_parse_ocr_progress(progress_frames)
                # A protocol-level terminal response may be unparseable; only
                # consecutive pages independently validated before it are safe.
                raise OcrWorkerFailure(
                    kind="protocol",
                    progress=(None if progress is None else _consecutive_progress_prefix(progress)),
                    worker_sha256=engine.worker_sha256,
                ) from error
            raise
        except WorkerResultError as error:
            if is_ocr:
                raise OcrWorkerFailure(
                    kind="protocol",
                    progress=_safe_parse_ocr_progress(progress_frames),
                    worker_sha256=engine.worker_sha256,
                ) from error
            raise
        except WorkerExecutionError as error:
            if is_ocr:
                if isinstance(error, OcrWorkerFailure):
                    raise
                raise OcrWorkerFailure(
                    kind="worker",
                    progress=_safe_parse_ocr_progress(progress_frames),
                    diagnostics=error.diagnostics,
                    worker_sha256=engine.worker_sha256,
                ) from error
            # The speech worker owns its single classified CUDA-to-CPU retry.
            # Repeating a failed CPU constructor here would exceed that bound.
            raise
        assert response.result is not None
        try:
            result = parse_run_result(response.result)
        except WorkerResultError as error:
            if is_ocr:
                progress = _safe_parse_ocr_progress(progress_frames)
                # A malformed terminal frame cannot be paired with any page;
                # retain the consecutive validated progress prefix and its
                # resolved header/provenance for the failed 1..N projection.
                raise OcrWorkerFailure(
                    kind="protocol",
                    progress=(None if progress is None else _consecutive_progress_prefix(progress)),
                    worker_sha256=engine.worker_sha256,
                ) from error
            raise
        if not is_ocr and result.execution_proof is not None:
            raise WorkerResultError("non-OCR worker returned a private OCR execution proof")
        if is_ocr and result.execution_proof is not None:
            try:
                plan_value = options.get("computePlan")
                plan = OcrExecutionPlan.from_dict(plan_value)
                result.execution_proof.validate_against(plan)
                source_digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
                if result.execution_proof.source_sha256 != source_digest:
                    raise ValueError("worker OCR execution proof source identity drifted")
            except (OSError, TypeError, ValueError) as error:
                if is_ocr:
                    raise OcrWorkerFailure(
                        kind="protocol",
                        progress=_safe_parse_ocr_progress(progress_frames),
                        worker_sha256=engine.worker_sha256,
                    ) from error
                raise WorkerResultError(
                    "worker OCR execution proof is not bound to this run"
                ) from error
        try:
            if is_ocr:
                progress = _safe_parse_ocr_progress(progress_frames)
                if progress is not None:
                    _assert_ocr_progress_matches_final(progress, result)
                if not result.segments and (
                    not result.pages or not all(page.status == "empty" for page in result.pages)
                ):
                    raise OcrWorkerFailure(
                        kind="protocol" if result.pages else "worker",
                        progress=progress,
                        worker_sha256=engine.worker_sha256,
                    )
                if any(page.status == "failed" for page in result.pages):
                    raise OcrWorkerFailure(
                        kind="worker",
                        progress=progress,
                        provenance=result.ocr_provenance,
                        worker_sha256=engine.worker_sha256,
                    )
            return replace(result, ocr_progress=progress) if is_ocr else result
        except _OcrProgressConsistencyError as error:
            raise OcrWorkerFailure(
                kind="protocol",
                progress=error.progress,
                worker_sha256=engine.worker_sha256,
            ) from error
        except OcrWorkerFailure:
            raise
        except WorkerResultError as error:
            if is_ocr:
                raise OcrWorkerFailure(
                    kind="protocol",
                    progress=_safe_parse_ocr_progress(progress_frames),
                    worker_sha256=engine.worker_sha256,
                ) from error
            raise

    async def diarize(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
        on_permille: Callable[[int], None] | None = None,
    ) -> WorkerDiarizationResult:
        if not source_path.is_file() or not source_path.is_absolute():
            raise ValueError("worker source path must be an existing absolute file")
        response = await self.process.request(
            engine.executable,
            "run",
            {
                "requirementId": engine.requirement_id,
                "artifactVersion": engine.artifact_version,
                "modelPath": str(engine.model_dir),
                "sourcePath": str(source_path),
                "mediaType": media_type,
                "options": options,
            },
            cancel_event=cancel_event,
            progress_handler=_permille_handler(on_permille),
            timeout_seconds=timeout_seconds,
        )
        assert response.result is not None
        return parse_diarization_result(response.result)

    async def shutdown(self) -> None:
        await self.process.shutdown()


__all__ = [
    "InstalledEngine",
    "WorkerClient",
    "WorkerDiarizationResult",
    "WorkerProbeResult",
    "WorkerResultError",
    "WorkerRunResult",
    "WorkerSegment",
    "WorkerWord",
    "WorkerOcrPage",
    "WorkerOcrProgress",
    "OcrWorkerFailure",
    "parse_diarization_result",
    "parse_ocr_compute_preflight",
    "parse_ocr_compute_selection",
    "parse_ocr_progress",
    "parse_probe_result",
    "parse_run_result",
]
