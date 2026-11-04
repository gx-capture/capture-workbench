"""Speech-recognition worker run results.

The worker kernel carries the process. This module checks a speech run's
segments, words, and provenance. OCR pages and the execution proof stay in
Document OCR; a speech payload does not carry them.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol

from capture_runtime._worker_payloads import (
    SHA256_PROVENANCE,
    WorkerResultError,
    WorkerRunResult,
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
from capture_runtime._worker_payloads import (
    permille_handler as _permille_handler,
)
from capture_runtime.contracts import OcrProvenanceV3
from capture_runtime.worker_client import InstalledEngine
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS, WorkerProcess


class _ProcessClient(Protocol):
    process: WorkerProcess


def _parse_ocr_provenance(value: object) -> OcrProvenanceV3:
    if not isinstance(value, dict):
        raise WorkerResultError("worker OCR provenance has unexpected fields")
    status = value.get("status")
    expected_fields = (
        {
            "status",
            "engine",
            "model",
            "modelDigest",
            "device",
            "profileId",
            "profileSpecSha256",
        }
        if status == "resolved"
        else {"status", "profileId", "profileSpecSha256", "reason"}
        if status == "unavailable"
        else None
    )
    if expected_fields is None or set(value) != expected_fields:
        raise WorkerResultError("worker OCR provenance has unexpected fields")
    try:
        return OcrProvenanceV3.model_validate(value)
    except Exception as error:
        raise WorkerResultError("worker OCR provenance is invalid") from error


def parse_run_result(payload: dict[str, Any]) -> WorkerRunResult:
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
    # Speech workers omit pages. A present value still has to fail the same
    # first checks; building the page objects would import Document OCR.
    pages_value = payload.get("pages")
    if pages_value is not None:
        if not isinstance(pages_value, list) or len(pages_value) > 500:
            raise WorkerResultError("worker OCR pages must be a bounded list")
        raise WorkerResultError("worker OCR page has unexpected fields")
    if payload.get("executionProof") is not None:
        raise WorkerResultError("worker OCR execution proof is invalid")
    return WorkerRunResult(
        segments=tuple(segments),
        engine=_string(engine, "worker engine"),
        model=_string(model, "worker model"),
        digest=digest,
        device=_string(device, "worker device"),
        warnings=parsed_warnings,
        ocr_provenance=ocr_provenance,
        suggested_units=_parse_suggested_units(payload.get("suggestedUnits")),
        elapsed_ms=elapsed_ms,
        stage_ms=stage_ms,
    )


class SpeechWorkerMethods:
    async def run(
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
    ) -> WorkerRunResult:
        del ocr_progress, vertical_reader_dir
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
        progress_handler = _permille_handler(on_permille)
        # The speech worker owns its single classified CUDA-to-CPU retry.
        # Repeating a failed CPU constructor here would exceed that bound.
        response = await self.process.request(
            engine.executable,
            "run",
            payload,
            cancel_event=cancel_event,
            **({"progress_handler": progress_handler} if progress_handler is not None else {}),
            timeout_seconds=timeout_seconds,
        )
        assert response.result is not None
        return parse_run_result(response.result)
