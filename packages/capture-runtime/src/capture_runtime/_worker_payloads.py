"""Pure decoders for worker wire payloads: JSON frames in, typed results out."""

from __future__ import annotations

import math
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any, cast

from capture_runtime.constants import VERTICAL_READER_REQUIREMENT_ID
from capture_runtime.contracts import (
    CaptureFailureV2,
    OcrComputePreflightV2,
    OcrProvenanceV3,
)
from capture_runtime.ocr_execution_proof import OcrExecutionDeviceProofV1
from capture_runtime.ocr_preflight import OcrComputeSelection
from capture_runtime.ocr_projection import OcrBoxInput
from capture_runtime.speaker_turns import SPEAKER_LABEL, SpeakerTurn

SHA256_PROVENANCE = re.compile(r"^sha256:[a-f0-9]{64}$")
SUGGESTABLE_UNITS = frozenset({VERTICAL_READER_REQUIREMENT_ID})


class WorkerResultError(ValueError):
    """Raised when a worker result does not match the internal contract."""


class _OcrProgressConsistencyError(WorkerResultError):
    """Raised when a terminal OCR result disagrees with validated progress."""

    def __init__(self, message: str, *, progress: WorkerOcrProgress) -> None:
        super().__init__(message)
        self.progress = progress


@dataclass(frozen=True, slots=True)
class WorkerProbeResult:
    ready: bool
    code_ready: bool
    assets_ready: bool
    detail: str
    device: str | None


@dataclass(frozen=True, slots=True)
class WorkerWord:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class WorkerSegment:
    order: int
    text: str
    page: int | None = None
    start_ms: int | None = None
    end_ms: int | None = None
    words: tuple[WorkerWord, ...] = ()


@dataclass(frozen=True, slots=True)
class WorkerDiarizationResult:
    turns: tuple[SpeakerTurn, ...]
    exclusive_turns: tuple[SpeakerTurn, ...]
    duration_ms: int
    engine: str
    model: str
    digest: str
    device: str
    warnings: tuple[str, ...]
    elapsed_ms: int | None = None
    stage_ms: dict[str, int] | None = None


@dataclass(frozen=True, slots=True)
class WorkerOcrPage:
    page: int
    status: str
    text: str
    boxes: tuple[OcrBoxInput | tuple[int, int, int, int], ...]
    confidence: float | None
    raster_width: int
    raster_height: int
    raster_scale: float
    region_confidences: tuple[float, ...] = ()
    failure: CaptureFailureV2 | None = None


@dataclass(frozen=True, slots=True)
class WorkerOcrProgress:
    """Validated OCR manifest and the pages emitted before a terminal frame."""

    page_count: int
    page_manifest: tuple[WorkerOcrPage, ...]
    provenance: OcrProvenanceV3 | None = None
    pages: tuple[WorkerOcrPage, ...] = ()


@dataclass(frozen=True, slots=True)
class WorkerRunResult:
    segments: tuple[WorkerSegment, ...]
    engine: str
    model: str
    digest: str
    device: str
    warnings: tuple[str, ...]
    pages: tuple[WorkerOcrPage, ...] = ()
    ocr_progress: WorkerOcrProgress | None = None
    ocr_provenance: OcrProvenanceV3 | None = None
    # Internal worker-only receipt; this is not part of any HTTP/SSE contract.
    execution_proof: OcrExecutionDeviceProofV1 | None = None
    # Optional units that are not installed and would have read part of the source.
    suggested_units: tuple[str, ...] = ()
    elapsed_ms: int | None = None
    stage_ms: dict[str, int] | None = None


def _string(value: object, label: str, *, maximum: int = 500) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum:
        raise WorkerResultError(f"{label} must be a non-empty bounded string")
    return value


def _parse_ocr_confidence(
    value: object,
    label: str,
    *,
    allow_none: bool = True,
) -> float | None:
    if value is None:
        if allow_none:
            return None
        raise WorkerResultError(f"{label} is invalid")
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise WorkerResultError(f"{label} is invalid")
    try:
        normalized = float(value)
    except (OverflowError, ValueError) as error:
        raise WorkerResultError(f"{label} is invalid") from error
    if not math.isfinite(normalized) or not 0 <= normalized <= 1:
        raise WorkerResultError(f"{label} is invalid")
    return normalized


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


def _parse_suggested_units(value: object) -> tuple[str, ...]:
    """Optional units the worker says would have improved this result."""

    if value is None:
        return ()
    if (
        not isinstance(value, list)
        or not value
        or len(set(value)) != len(value)
        or any(item not in SUGGESTABLE_UNITS for item in value)
    ):
        raise WorkerResultError("worker suggested units are invalid")
    return tuple(value)


def _milliseconds(value: object) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise WorkerResultError("worker time must be a non-negative integer")
    return value


def _parse_engine_timings(provenance: dict[str, Any]) -> tuple[int | None, dict[str, int] | None]:
    elapsed = provenance.get("elapsedMs")
    stages = provenance.get("stageMs")
    if stages is not None and (
        not isinstance(stages, dict)
        or any(not isinstance(name, str) or not name.strip() for name in stages)
    ):
        raise WorkerResultError("worker stage times must use non-empty names")
    return (
        None if elapsed is None else _milliseconds(elapsed),
        None if stages is None else {name: _milliseconds(value) for name, value in stages.items()},
    )


def _parse_words(value: object, *, time_locator: bool) -> tuple[WorkerWord, ...]:
    if value is None:
        return ()
    if not time_locator or not isinstance(value, list) or len(value) > 100_000:
        raise WorkerResultError("worker segment words are invalid")
    words: list[WorkerWord] = []
    for raw_word in value:
        if not isinstance(raw_word, dict) or set(raw_word) != {"startMs", "endMs", "text"}:
            raise WorkerResultError("worker segment word has unexpected fields")
        start_ms = _milliseconds(raw_word["startMs"])
        end_ms = _milliseconds(raw_word["endMs"])
        text = raw_word["text"]
        if end_ms < start_ms or not isinstance(text, str) or not text or len(text) > 500:
            raise WorkerResultError("worker segment word is invalid")
        words.append(WorkerWord(start_ms, end_ms, text))
    return tuple(words)


def _parse_turns(value: object, duration_ms: int) -> tuple[SpeakerTurn, ...]:
    if not isinstance(value, list) or len(value) > 100_000:
        raise WorkerResultError("diarization turns must be a bounded list")
    turns: list[SpeakerTurn] = []
    for raw_turn in value:
        if not isinstance(raw_turn, dict) or set(raw_turn) != {"startMs", "endMs", "speaker"}:
            raise WorkerResultError("diarization turn has unexpected fields")
        start_ms = _milliseconds(raw_turn["startMs"])
        end_ms = _milliseconds(raw_turn["endMs"])
        speaker = raw_turn["speaker"]
        if (
            not start_ms < end_ms <= duration_ms
            or not isinstance(speaker, str)
            or SPEAKER_LABEL.fullmatch(speaker) is None
        ):
            raise WorkerResultError("diarization turn is invalid")
        turns.append(SpeakerTurn(start_ms, end_ms, speaker))
    return tuple(turns)


def parse_diarization_result(payload: dict[str, Any]) -> WorkerDiarizationResult:
    """Validate a speaker diarization worker result before the runtime uses it."""

    if set(payload) != {"turns", "exclusiveTurns", "durationMs", "provenance", "warnings"}:
        raise WorkerResultError("diarization result has unexpected fields")
    duration_ms = _milliseconds(payload["durationMs"])
    exclusive_turns = _parse_turns(payload["exclusiveTurns"], duration_ms)
    if any(
        right.start_ms < left.end_ms
        for left, right in zip(exclusive_turns, exclusive_turns[1:], strict=False)
    ):
        raise WorkerResultError("exclusive diarization turns must not overlap")
    provenance = payload["provenance"]
    if not isinstance(provenance, dict) or set(provenance) - {"elapsedMs", "stageMs"} != {
        "engine",
        "model",
        "digest",
        "device",
    }:
        raise WorkerResultError("worker provenance has unexpected fields")
    elapsed_ms, stage_ms = _parse_engine_timings(provenance)
    digest = provenance["digest"]
    if not isinstance(digest, str) or SHA256_PROVENANCE.fullmatch(digest) is None:
        raise WorkerResultError("worker provenance digest is invalid")
    if provenance["engine"] != "speaker-diarization" or provenance["device"] not in {
        "cpu",
        "cuda",
    }:
        raise WorkerResultError("diarization provenance is invalid")
    warnings = payload["warnings"]
    if not isinstance(warnings, list) or len(warnings) > 100:
        raise WorkerResultError("worker warnings must be a bounded list")
    return WorkerDiarizationResult(
        turns=_parse_turns(payload["turns"], duration_ms),
        exclusive_turns=exclusive_turns,
        duration_ms=duration_ms,
        engine=provenance["engine"],
        model=_string(provenance["model"], "worker provenance model"),
        digest=digest,
        device=provenance["device"],
        warnings=tuple(_string(item, "worker warning") for item in warnings),
        elapsed_ms=elapsed_ms,
        stage_ms=stage_ms,
    )


def _permille_handler(
    progress: Callable[[int], None] | None,
) -> Callable[[dict[str, object]], None] | None:
    """Pass on well-formed 0-1000 progress frames; a malformed one is ignored."""

    if progress is None:
        return None

    def handle(frame: dict[str, object]) -> None:
        value = frame.get("permille")
        if (
            set(frame) == {"permille"}
            and isinstance(value, int)
            and not isinstance(value, bool)
            and 0 <= value <= 1000
        ):
            progress(value)

    return handle


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
    pages = _parse_ocr_pages(payload.get("pages"))
    execution_proof_value = payload.get("executionProof")
    execution_proof = None
    if execution_proof_value is not None:
        try:
            execution_proof = OcrExecutionDeviceProofV1.from_dict(execution_proof_value)
        except (TypeError, ValueError) as error:
            raise WorkerResultError("worker OCR execution proof is invalid") from error
    return WorkerRunResult(
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


def _parse_ocr_page(value: object, *, expected_page: int) -> WorkerOcrPage:
    raw_page = value
    if not isinstance(raw_page, dict) or set(raw_page) != {
        "page",
        "status",
        "text",
        "boxes",
        "regionConfidences",
        "confidence",
        "raster",
        "failure",
    }:
        raise WorkerResultError("worker OCR page has unexpected fields")
    if raw_page["page"] != expected_page:
        raise WorkerResultError("worker OCR page order must be ascending")
    status = raw_page["status"]
    if status not in {"recognized", "empty", "failed"}:
        raise WorkerResultError("worker OCR page status is invalid")
    text = raw_page["text"]
    if not isinstance(text, str) or len(text) > 8_000_000:
        raise WorkerResultError("worker OCR page text is invalid")
    raw_region_confidences = raw_page["regionConfidences"]
    if not isinstance(raw_region_confidences, list) or len(raw_region_confidences) > 100_000:
        raise WorkerResultError("worker OCR region confidences are invalid")
    region_confidences: list[float] = []
    for value in raw_region_confidences:
        parsed = _parse_ocr_confidence(value, "worker OCR region confidence", allow_none=False)
        if parsed is None:
            raise WorkerResultError("worker OCR region confidence is invalid")
        region_confidences.append(parsed)
    confidence = _parse_ocr_confidence(raw_page["confidence"], "worker OCR confidence")
    raw_raster = raw_page["raster"]
    if not isinstance(raw_raster, dict) or set(raw_raster) != {
        "width",
        "height",
        "scale",
        "coordinateSystem",
    }:
        raise WorkerResultError("worker OCR raster is invalid")
    width = raw_raster["width"]
    height = raw_raster["height"]
    scale = raw_raster["scale"]
    coordinate_system = raw_raster["coordinateSystem"]
    if (
        not isinstance(width, int)
        or isinstance(width, bool)
        or width <= 0
        or not isinstance(height, int)
        or isinstance(height, bool)
        or height <= 0
        or isinstance(scale, bool)
        or not isinstance(scale, int | float)
        or not 0 < float(scale) <= 8
        or coordinate_system != "pixel"
    ):
        raise WorkerResultError("worker OCR raster dimensions are invalid")
    raw_boxes = raw_page["boxes"]
    if not isinstance(raw_boxes, list) or len(raw_boxes) > 100_000:
        raise WorkerResultError("worker OCR page boxes are invalid")
    boxes: list[OcrBoxInput] = []
    box_confidences: list[float | None] = []
    for index, raw_box in enumerate(raw_boxes):
        box_confidence = region_confidences[index] if index < len(region_confidences) else None
        if isinstance(raw_box, list):
            if (
                len(raw_box) != 4
                or not all(isinstance(item, int) and not isinstance(item, bool) for item in raw_box)
                or raw_box[0] < 0
                or raw_box[1] < 0
                or raw_box[2] <= 0
                or raw_box[3] <= 0
                or raw_box[0] + raw_box[2] > width
                or raw_box[1] + raw_box[3] > height
            ):
                raise WorkerResultError("worker OCR box is invalid")
            x, y, box_width, box_height = raw_box
            boxes.append(
                OcrBoxInput(
                    polygon=(
                        (float(x), float(y)),
                        (float(x + box_width), float(y)),
                        (float(x + box_width), float(y + box_height)),
                        (float(x), float(y + box_height)),
                    ),
                    text=text.strip(),
                    confidence=box_confidence,
                )
            )
            box_confidences.append(box_confidence)
            continue
        if not isinstance(raw_box, dict) or set(raw_box) != {"polygon", "text", "confidence"}:
            raise WorkerResultError("worker OCR box is invalid")
        box_text = raw_box["text"]
        if not isinstance(box_text, str) or not box_text.strip() or len(box_text) > 8_000_000:
            raise WorkerResultError("worker OCR box text is invalid")
        raw_box_confidence = _parse_ocr_confidence(
            raw_box["confidence"], "worker OCR box confidence"
        )
        raw_polygon = raw_box["polygon"]
        if not isinstance(raw_polygon, list) or not 4 <= len(raw_polygon) <= 256:
            raise WorkerResultError("worker OCR polygon is invalid")
        polygon: list[tuple[float, float]] = []
        for raw_point in raw_polygon:
            if not isinstance(raw_point, dict) or set(raw_point) != {"x", "y"}:
                raise WorkerResultError("worker OCR polygon point is invalid")
            x = raw_point["x"]
            y = raw_point["y"]
            if (
                isinstance(x, bool)
                or not isinstance(x, int | float)
                or not math.isfinite(float(x))
                or float(x) < 0
                or float(x) > width
                or isinstance(y, bool)
                or not isinstance(y, int | float)
                or not math.isfinite(float(y))
                or float(y) < 0
                or float(y) > height
            ):
                raise WorkerResultError("worker OCR polygon point is invalid")
            polygon.append((float(x), float(y)))
        boxes.append(
            OcrBoxInput(
                polygon=tuple(polygon),
                text=box_text.strip(),
                confidence=raw_box_confidence,
            )
        )
        box_confidences.append(raw_box_confidence)
    # The worker wire has two legal, non-overlapping confidence modes.  A
    # scored page carries one region score for every box and repeats that
    # score inside the box; a no-score page carries no region scores and every
    # box has ``confidence: null``.  Never fill a missing index from the other
    # source or retain a partially mapped recognized page.
    if region_confidences:
        if len(region_confidences) != len(boxes):
            raise WorkerResultError(
                "worker OCR page boxes and region confidences cardinality is invalid"
            )
        for index, (box_confidence, region_confidence) in enumerate(
            zip(box_confidences, region_confidences, strict=True)
        ):
            if box_confidence is None or box_confidence != region_confidence:
                raise WorkerResultError(
                    f"worker OCR box confidence does not match region confidence at index {index}"
                )
    elif any(value is not None for value in box_confidences):
        raise WorkerResultError(
            "worker OCR page box confidence requires a matching region confidence"
        )
    failure = raw_page["failure"]
    parsed_failure = None
    if failure is not None:
        if not isinstance(failure, dict):
            raise WorkerResultError("worker OCR page failure is invalid")
        try:
            parsed_failure = CaptureFailureV2.model_validate(failure)
        except Exception as error:
            raise WorkerResultError("worker OCR page failure is invalid") from error
    if status == "recognized" and (not text.strip() or parsed_failure is not None):
        raise WorkerResultError("recognized worker OCR pages require text")
    if status == "empty" and (
        text.strip() or boxes or region_confidences or confidence is not None or parsed_failure
    ):
        raise WorkerResultError("empty worker OCR pages must have an empty payload")
    if status == "failed" and (
        text.strip()
        or boxes
        or region_confidences
        or confidence is not None
        or parsed_failure is None
    ):
        raise WorkerResultError("failed worker OCR pages require a typed failure")
    return WorkerOcrPage(
        page=expected_page,
        status=status,
        text=text,
        boxes=tuple(boxes),
        region_confidences=tuple(region_confidences),
        confidence=confidence,
        raster_width=width,
        raster_height=height,
        raster_scale=float(scale),
        failure=parsed_failure,
    )


def _next_page_number(raw_page: object, previous_page: int) -> int:
    """The page number a worker page may carry: any source page after the last.

    Pages carry source page numbers, so a selection such as ``[3, 7]`` arrives
    as pages 3 and 7. A number that does not ascend is rejected by the parser.
    """

    page = raw_page.get("page") if isinstance(raw_page, dict) else None
    if type(page) is int and page > previous_page:
        return page
    return previous_page + 1


def _parse_ocr_pages(value: object) -> tuple[WorkerOcrPage, ...]:
    if value is None:
        return ()
    if not isinstance(value, list) or len(value) > 500:
        raise WorkerResultError("worker OCR pages must be a bounded list")
    pages: list[WorkerOcrPage] = []
    previous_page = 0
    for raw_page in value:
        page = _parse_ocr_page(raw_page, expected_page=_next_page_number(raw_page, previous_page))
        pages.append(page)
        previous_page = page.page
    return tuple(pages)


def parse_ocr_progress(payloads: list[dict[str, object]]) -> WorkerOcrProgress | None:
    """Validate the header/page progress stream, dropping no trusted details."""

    if not payloads:
        return None
    header = payloads[0]
    if (
        set(header) != {"type", "pageCount", "pages", "provenance"}
        or header.get("type") != "ocr-header"
    ):
        raise WorkerResultError("OCR progress header is invalid")
    provenance = _parse_ocr_provenance(header.get("provenance"))
    if not provenance.is_resolved:
        raise WorkerResultError("OCR progress header requires resolved provenance")
    page_count = header.get("pageCount")
    raw_manifest = header.get("pages")
    if (
        not isinstance(page_count, int)
        or isinstance(page_count, bool)
        or not 1 <= page_count <= 500
        or not isinstance(raw_manifest, list)
        or len(raw_manifest) != page_count
    ):
        raise WorkerResultError("OCR progress page manifest is invalid")
    manifest: list[WorkerOcrPage] = []
    previous_page = 0
    for raw_item in raw_manifest:
        if not isinstance(raw_item, dict) or set(raw_item) != {"page", "raster"}:
            raise WorkerResultError("OCR progress page manifest entry is invalid")
        raw_page = raw_item["page"]
        raw_raster = raw_item["raster"]
        if (
            type(raw_page) is not int
            or raw_page <= previous_page
            or not isinstance(raw_raster, dict)
            or set(raw_raster) != {"width", "height", "scale", "coordinateSystem"}
        ):
            raise WorkerResultError("OCR progress page manifest entry is invalid")
        expected_page = previous_page = raw_page
        page_payload = {
            "page": expected_page,
            "status": "empty",
            "text": "",
            "boxes": [],
            "regionConfidences": [],
            "confidence": None,
            "raster": raw_raster,
            "failure": None,
        }
        manifest.append(_parse_ocr_page(page_payload, expected_page=expected_page))
    manifest_pages = {item.page for item in manifest}
    pages: list[WorkerOcrPage] = []
    seen: set[int] = set()
    for payload in payloads[1:]:
        if set(payload) != {"type", "page"} or payload.get("type") != "ocr-page":
            raise WorkerResultError("OCR progress page frame is invalid")
        raw_page = payload["page"]
        if not isinstance(raw_page, dict):
            raise WorkerResultError("OCR progress page frame is invalid")
        page = raw_page.get("page")
        if type(page) is not int or page not in manifest_pages:
            raise WorkerResultError("OCR progress page number is invalid")
        if page in seen:
            raise WorkerResultError("OCR progress contains a duplicate page")
        seen.add(page)
        pages.append(_parse_ocr_page(raw_page, expected_page=page))
    return WorkerOcrProgress(
        page_count=page_count,
        page_manifest=tuple(manifest),
        provenance=provenance,
        pages=tuple(pages),
    )


def _safe_parse_ocr_progress(
    payloads: list[dict[str, object]],
) -> WorkerOcrProgress | None:
    if not payloads:
        return None
    try:
        return parse_ocr_progress(payloads)
    except WorkerResultError:
        return None


def _canonical_number(value: int | float) -> float:
    normalized = float(value)
    return 0.0 if normalized == 0 else normalized


def _canonical_provenance(provenance: OcrProvenanceV3) -> dict[str, object]:
    return cast(dict[str, object], provenance.model_dump(mode="json", by_alias=True))


def _canonical_failure(failure: CaptureFailureV2 | None) -> dict[str, object] | None:
    return None if failure is None else failure.model_dump(mode="json", by_alias=True)


def _canonical_box(
    box: OcrBoxInput | tuple[int, int, int, int],
) -> tuple[tuple[tuple[float, float], ...], str, float | None]:
    if isinstance(box, OcrBoxInput):
        polygon = box.polygon
        text = box.text
        confidence = box.confidence
    else:
        x, y, width, height = box
        polygon = (
            (x, y),
            (x + width, y),
            (x + width, y + height),
            (x, y + height),
        )
        text = ""
        confidence = None
    return (
        tuple((_canonical_number(x), _canonical_number(y)) for x, y in polygon),
        text,
        None if confidence is None else _canonical_number(confidence),
    )


def _canonical_page(page: WorkerOcrPage) -> tuple[object, ...]:
    return (
        page.page,
        page.status,
        page.text,
        tuple(_canonical_box(box) for box in page.boxes),
        tuple(_canonical_number(value) for value in page.region_confidences),
        None if page.confidence is None else _canonical_number(page.confidence),
        page.raster_width,
        page.raster_height,
        _canonical_number(page.raster_scale),
        _canonical_failure(page.failure),
    )


def _largest_manifest_page_pixels(manifest: object) -> int | None:
    """The largest page raster a run's manifest asks for, or None when it is malformed."""

    if not isinstance(manifest, list) or not manifest:
        return None
    largest = 0
    for page in manifest:
        raster = page.get("raster") if isinstance(page, dict) else None
        width = raster.get("width") if isinstance(raster, dict) else None
        height = raster.get("height") if isinstance(raster, dict) else None
        if not isinstance(width, int) or not isinstance(height, int):
            return None
        largest = max(largest, width * height)
    return largest


def _canonical_manifest_page(page: WorkerOcrPage) -> tuple[object, ...]:
    return (
        page.page,
        page.raster_width,
        page.raster_height,
        _canonical_number(page.raster_scale),
    )


def _progress_prefix(
    progress: WorkerOcrProgress,
    count: int,
) -> WorkerOcrProgress:
    return replace(progress, pages=progress.pages[:count])


def _consecutive_progress_prefix(progress: WorkerOcrProgress) -> WorkerOcrProgress:
    count = 0
    for expected, page in zip(progress.page_manifest, progress.pages, strict=False):
        if page.page != expected.page:
            break
        count += 1
    return _progress_prefix(progress, count)


def _assert_ocr_progress_matches_final(
    progress: WorkerOcrProgress,
    result: WorkerRunResult,
) -> None:
    """Require one semantic OCR result across progress and terminal frames.

    A mismatch taints the first disagreeing page and everything after it. Only
    pages that have matched in both channels remain eligible for a readable
    failed projection; the worker can never publish either side of a conflict
    as a successful page.
    """

    progress_provenance = progress.provenance
    result_provenance = result.ocr_provenance
    if progress_provenance is None or result_provenance is None:
        raise _OcrProgressConsistencyError(
            "OCR worker progress and final provenance differ",
            progress=_progress_prefix(progress, 0),
        )
    if _canonical_provenance(progress_provenance) != _canonical_provenance(result_provenance):
        raise _OcrProgressConsistencyError(
            "OCR worker progress and final provenance differ",
            progress=_progress_prefix(progress, 0),
        )

    comparable_pages = min(progress.page_count, len(progress.pages), len(result.pages))
    for index in range(comparable_pages):
        expected_page = progress.page_manifest[index].page
        progress_page = progress.pages[index]
        final_page = result.pages[index]
        if progress_page.page != expected_page or final_page.page != expected_page:
            raise _OcrProgressConsistencyError(
                "OCR worker progress and final page order differ",
                progress=_progress_prefix(progress, index),
            )
        manifest_page = progress.page_manifest[index]
        if _canonical_manifest_page(manifest_page) != _canonical_manifest_page(final_page):
            raise _OcrProgressConsistencyError(
                "OCR worker progress manifest and final raster differ",
                progress=_progress_prefix(progress, index),
            )
        if _canonical_page(progress_page) != _canonical_page(final_page):
            raise _OcrProgressConsistencyError(
                "OCR worker progress and final page content differ",
                progress=_progress_prefix(progress, index),
            )

    if len(progress.pages) != progress.page_count or len(result.pages) != progress.page_count:
        raise _OcrProgressConsistencyError(
            "OCR worker progress and final page counts differ",
            progress=_progress_prefix(progress, comparable_pages),
        )
