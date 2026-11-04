"""OCR worker run: compute preflight, the run result, and when a worker stays warm.

DirectML keeps the GPU buffers of every run in a worker's sessions: after a
12 MP photo a warm worker held 7.8 GB of an 8 GB GPU and its next page read
as empty. Only runs whose pages are at most this large use a warm worker; a
larger one gets fresh sessions and the GPU memory a warm worker would hold.
The process itself stays in the worker kernel.
"""

from __future__ import annotations

import asyncio
import hashlib
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any, Protocol

from capture_runtime._worker_payloads import (
    SHA256_PROVENANCE,
    WorkerResultError,
    WorkerSegment,
)
from capture_runtime._worker_payloads import (
    bounded_string as _string,
)
from capture_runtime._worker_payloads import (
    parse_engine_timings as _parse_engine_timings,
)
from capture_runtime._worker_payloads import (
    parse_suggested_units as _parse_suggested_units,
)
from capture_runtime._worker_payloads import (
    parse_words as _parse_words,
)
from capture_runtime.contracts import OcrComputePreflightV2
from capture_runtime.ocr.infrastructure.ocr_execution_proof import OcrExecutionDeviceProofV1
from capture_runtime.ocr.infrastructure.ocr_preflight import OcrComputeSelection, OcrExecutionPlan
from capture_runtime.ocr.infrastructure.ocr_worker_result import (
    OcrWorkerFailure,
    OcrWorkerRunResult,
    _assert_ocr_progress_matches_final,
    _canonical_manifest_page,
    _consecutive_progress_prefix,
    _largest_manifest_page_pixels,
    _OcrProgressConsistencyError,
    _parse_ocr_pages,
    _parse_ocr_provenance,
    _safe_parse_ocr_progress,
    parse_ocr_progress,
)
from capture_runtime.worker_client import InstalledEngine
from capture_runtime.worker_contracts import WorkerProtocolError
from capture_runtime.worker_process import (
    DEFAULT_PROBE_TIMEOUT_SECONDS,
    DEFAULT_RUN_TIMEOUT_SECONDS,
    WorkerExecutionError,
    WorkerProcess,
    WorkerTimeoutError,
)

OCR_WARM_MAX_PAGE_PIXELS = 2048 * 2048


class _ProcessClient(Protocol):
    process: WorkerProcess
    ocr_idle_seconds: float


def parse_ocr_compute_preflight(payload: dict[str, Any]) -> OcrComputePreflightV2:
    """Validate the typed compute decision returned by the OCR worker."""

    try:
        return OcrComputePreflightV2.model_validate(payload)
    except Exception:
        # The worker owns one retained plan and projects readiness from that
        # same result.  Keep this legacy public readiness seam usable while
        # rejecting any malformed plan through the strict private parser.
        try:
            return OcrComputeSelection.from_dict(payload).readiness
        except Exception as error:
            raise WorkerResultError("OCR compute preflight result is invalid") from error


def parse_ocr_compute_selection(payload: dict[str, Any]) -> OcrComputeSelection:
    """Validate the private worker-owned plan and its public projection."""

    try:
        return OcrComputeSelection.from_dict(payload)
    except Exception as error:
        raise WorkerResultError("OCR compute selection result is invalid") from error


def parse_run_result(payload: dict[str, Any]) -> OcrWorkerRunResult[OcrExecutionDeviceProofV1]:
    fields = set(payload)
    if not {"segments", "provenance", "warnings"}.issubset(fields) or not fields.issubset(
        {"segments", "provenance", "warnings", "pages", "executionProof", "suggestedUnits"}
    ):
        raise WorkerResultError("worker run result has unexpected fields")
    raw_segments = payload["segments"]
    if not isinstance(raw_segments, list) or len(raw_segments) > 100_000:
        raise WorkerResultError("worker segments must be a bounded list")
    segments: list[WorkerSegment] = []
    for expected_order, raw_segment in enumerate(raw_segments):
        if not isinstance(raw_segment, dict) or set(raw_segment) - {"words"} != {
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
                words=_parse_words(raw_segment.get("words"), time_locator=time_locator),
            )
        )
    provenance = payload["provenance"]
    if not isinstance(provenance, dict):
        raise WorkerResultError("worker provenance is invalid")
    ocr_provenance = (
        _parse_ocr_provenance(provenance)
        if provenance.get("engine") == "windowsml-ocr"
        or provenance.get("status") in ("resolved", "unavailable")
        else None
    )
    if ocr_provenance is None:
        if set(provenance) - {"elapsedMs", "stageMs"} != {"engine", "model", "digest", "device"}:
            raise WorkerResultError("worker provenance has unexpected fields")
        engine = provenance.get("engine")
        model = provenance.get("model")
        digest = provenance.get("digest")
        device = provenance.get("device")
        elapsed_ms, stage_ms = _parse_engine_timings(provenance)
    else:
        elapsed_ms, stage_ms = None, None
        if not ocr_provenance.is_resolved:
            raise WorkerResultError("worker OCR result requires resolved provenance")
        engine = ocr_provenance.engine
        model = ocr_provenance.model
        digest = ocr_provenance.model_digest
        device = ocr_provenance.device
    if not isinstance(digest, str) or SHA256_PROVENANCE.fullmatch(digest) is None:
        raise WorkerResultError("worker provenance digest is invalid")
    warnings = payload["warnings"]
    if not isinstance(warnings, list) or len(warnings) > 100:
        raise WorkerResultError("worker warnings must be a bounded list")
    parsed_warnings = tuple(_string(item, "worker warning") for item in warnings)
    pages = _parse_ocr_pages(payload.get("pages"))
    execution_proof_value = payload.get("executionProof")
    execution_proof = None
    if execution_proof_value is not None:
        try:
            execution_proof = OcrExecutionDeviceProofV1.from_dict(execution_proof_value)
        except (TypeError, ValueError) as error:
            raise WorkerResultError("worker OCR execution proof is invalid") from error
    return OcrWorkerRunResult(
        segments=tuple(segments),
        engine=_string(engine, "worker engine"),
        model=_string(model, "worker model"),
        digest=digest,
        device=_string(device, "worker device"),
        warnings=parsed_warnings,
        pages=pages,
        ocr_provenance=ocr_provenance,
        execution_proof=execution_proof,
        suggested_units=_parse_suggested_units(payload.get("suggestedUnits")),
        elapsed_ms=elapsed_ms,
        stage_ms=stage_ms,
    )


class OcrWorkerMethods:
    async def ocr_compute_preflight(
        self: _ProcessClient,
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
        self: _ProcessClient,
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

    async def run_ocr(
        self: _ProcessClient,
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
    ) -> OcrWorkerRunResult[OcrExecutionDeviceProofV1]:
        del on_permille
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
        if vertical_reader_dir is not None:
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

        progress_handler = collect_ocr_progress
        # Acceptance runs bind an execution proof to each run's own sessions.
        largest_page = _largest_manifest_page_pixels(options.get("pageManifest"))
        keep_warm = (
            self.ocr_idle_seconds > 0
            and "runtimeSha256" not in options
            and largest_page is not None
            and largest_page <= OCR_WARM_MAX_PAGE_PIXELS
        )
        release_warm = getattr(self.process, "release_warm", None)
        if not keep_warm and release_warm is not None:
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
                    progress_handler=progress_handler,
                    timeout_seconds=timeout_seconds,
                )
        except WorkerTimeoutError as error:
            raise OcrWorkerFailure(
                kind="timeout",
                progress=_safe_parse_ocr_progress(progress_frames),
                diagnostics=error.diagnostics,
                worker_sha256=engine.worker_sha256,
            ) from error
        except WorkerProtocolError as error:
            progress = _safe_parse_ocr_progress(progress_frames)
            # A protocol-level terminal response may be unparseable; only
            # consecutive pages independently validated before it are safe.
            raise OcrWorkerFailure(
                kind="protocol",
                progress=(None if progress is None else _consecutive_progress_prefix(progress)),
                worker_sha256=engine.worker_sha256,
            ) from error
        except WorkerResultError as error:
            raise OcrWorkerFailure(
                kind="protocol",
                progress=_safe_parse_ocr_progress(progress_frames),
                worker_sha256=engine.worker_sha256,
            ) from error
        except WorkerExecutionError as error:
            if isinstance(error, OcrWorkerFailure):
                raise
            raise OcrWorkerFailure(
                kind="worker",
                progress=_safe_parse_ocr_progress(progress_frames),
                diagnostics=error.diagnostics,
                worker_sha256=engine.worker_sha256,
            ) from error
        assert response.result is not None
        try:
            result = parse_run_result(response.result)
        except WorkerResultError as error:
            progress = _safe_parse_ocr_progress(progress_frames)
            # A malformed terminal frame cannot be paired with any page;
            # retain the consecutive validated progress prefix and its
            # resolved header/provenance for the failed 1..N projection.
            raise OcrWorkerFailure(
                kind="protocol",
                progress=(None if progress is None else _consecutive_progress_prefix(progress)),
                worker_sha256=engine.worker_sha256,
            ) from error
        if result.execution_proof is not None:
            try:
                plan_value = options.get("computePlan")
                plan = OcrExecutionPlan.from_dict(plan_value)
                result.execution_proof.validate_against(plan)
                source_digest = hashlib.sha256(source_path.read_bytes()).hexdigest()
                if result.execution_proof.source_sha256 != source_digest:
                    raise ValueError("worker OCR execution proof source identity drifted")
            except (OSError, TypeError, ValueError) as error:
                raise OcrWorkerFailure(
                    kind="protocol",
                    progress=_safe_parse_ocr_progress(progress_frames),
                    worker_sha256=engine.worker_sha256,
                ) from error
        try:
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
            return replace(result, ocr_progress=progress)
        except _OcrProgressConsistencyError as error:
            raise OcrWorkerFailure(
                kind="protocol",
                progress=error.progress,
                worker_sha256=engine.worker_sha256,
            ) from error
        except OcrWorkerFailure:
            raise
        except WorkerResultError as error:
            raise OcrWorkerFailure(
                kind="protocol",
                progress=_safe_parse_ocr_progress(progress_frames),
                worker_sha256=engine.worker_sha256,
            ) from error
