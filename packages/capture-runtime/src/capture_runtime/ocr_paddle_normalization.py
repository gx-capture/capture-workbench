"""Strict normalization of Paddle/PaddleX OCR results into OCR regions.

A Paddle result that violates the runtime's OCR result contract fails with
``PaddleResultNormalizationError`` instead of being coerced. Composite regions
are split along the alignment records the predictor observed.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from numbers import Real
from typing import Any, NoReturn

from capture_runtime.ocr_alignment import AlignmentContractError, AlignmentRecord
from capture_runtime.ocr_composite_regions import CompositeSplit, plan_composite_splits
from capture_runtime.ocr_page_result import OcrRegion
from capture_runtime.ocr_region_lineage import RegionSource, validate_region_sources
from capture_runtime.worker_probe import EngineRuntimeUnavailableError


@dataclass(frozen=True, slots=True)
class PaddleNormalizedResult:
    """One atomically normalized Paddle result sequence."""

    text: str
    regions: tuple[OcrRegion, ...]
    # Original result/region ordinals, retained even when an empty crop is omitted.
    source_slots: tuple[tuple[int, int], ...]


class PaddleResultNormalizationError(EngineRuntimeUnavailableError):
    """A Paddle result violated the runtime's strict OCR result contract."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Paddle OCR result normalization failed: {reason}")


def compose_aligned_regions(
    normalized: PaddleNormalizedResult,
    records: tuple[AlignmentRecord, ...] | None,
    raster_width: int | None,
    raster_height: int | None,
) -> tuple[tuple[OcrRegion, ...], tuple[RegionSource, ...], tuple[CompositeSplit, ...]]:
    alignments: dict[int, AlignmentRecord] = {}
    if records is not None:
        if len({record.record_id for record in records}) != len(records):
            raise AlignmentContractError("OCR alignment record identity is duplicated.")
        by_tuple: dict[tuple[Any, ...], list[AlignmentRecord]] = {}
        for record in records:
            if (record.raster_width, record.raster_height) != (raster_width, raster_height):
                raise AlignmentContractError("OCR alignment raster differs from predictor input.")
            key: tuple[Any, ...] = (
                record.page_index,
                record.text.strip(),
                record.polygon,
                record.confidence,
            )
            by_tuple.setdefault(key, []).append(record)
        required: dict[tuple[Any, ...], int] = {}
        for region, slot in zip(normalized.regions, normalized.source_slots, strict=True):
            key = (slot[0], region.text, region.polygon, region.confidence)
            required[key] = required.get(key, 0) + 1
        if any(len(by_tuple.get(key, [])) < count for key, count in required.items()):
            raise AlignmentContractError("OCR alignment cannot cover every normalized source once.")
        for index, (region, slot) in enumerate(
            zip(normalized.regions, normalized.source_slots, strict=True)
        ):
            matches = by_tuple.get((slot[0], region.text, region.polygon, region.confidence), [])
            if not matches:
                raise AlignmentContractError(
                    "OCR alignment does not match a normalized source tuple."
                )
            # Ambiguous identical observations or trimmed raw text have no unique
            # supported text-span alignment. Preserve these parents, without guessing.
            if len(matches) == 1 and matches[0].text == region.text:
                alignments[index] = matches[0]
    splits = plan_composite_splits(normalized.regions, alignments)
    by_parent = {split.source_index: split for split in splits}
    regions: list[OcrRegion] = []
    sources: list[RegionSource] = []
    for index, (parent, slot) in enumerate(
        zip(normalized.regions, normalized.source_slots, strict=True)
    ):
        split = by_parent.get(index)
        if split is None:
            regions.append(parent)
            sources.append(RegionSource(slot, (0, len(parent.text)), len(parent.text)))
        else:
            for child in split.children:
                regions.append(OcrRegion(child.text, child.confidence, child.polygon))
                sources.append(RegionSource(slot, child.text_span, len(parent.text)))
    validate_region_sources(normalized.regions, normalized.source_slots, regions, sources)
    return tuple(regions), tuple(sources), splits


_PADDLE_MISSING = object()


def _paddle_fail(reason: str) -> NoReturn:
    raise PaddleResultNormalizationError(reason)


def _paddle_sequence(value: Any, field: str) -> list[Any]:
    """Read one Paddle array without coercing malformed values."""

    if value is None:
        _paddle_fail(f"{field} must be an array")
    try:
        tolist = getattr(value, "tolist", None)
    except Exception as error:
        raise PaddleResultNormalizationError(f"{field} array access failed") from error
    if callable(tolist):
        try:
            value = tolist()
        except Exception as error:
            raise PaddleResultNormalizationError(f"{field} array conversion failed") from error
    if not isinstance(value, list | tuple):
        _paddle_fail(f"{field} must be an array")
    return list(value)


def _paddle_optional_sequence(data: dict[str, Any], field: str) -> list[Any] | None:
    value = data.get(field, _PADDLE_MISSING)
    if value is _PADDLE_MISSING:
        return None
    return _paddle_sequence(value, field)


def _paddle_payload(result: Any) -> dict[str, Any]:
    payload: Any
    if isinstance(result, dict) and "res" in result:
        payload = result
    else:
        try:
            payload = getattr(result, "json", None)
        except Exception as error:
            raise PaddleResultNormalizationError("result payload access failed") from error
        if not isinstance(payload, dict):
            try:
                to_dict = getattr(result, "to_dict", None)
            except Exception as error:
                raise PaddleResultNormalizationError("result dictionary access failed") from error
            if callable(to_dict):
                try:
                    payload = to_dict()
                except Exception as error:
                    raise PaddleResultNormalizationError(
                        "result dictionary conversion failed"
                    ) from error
            elif isinstance(result, dict):
                payload = result
    if not isinstance(payload, dict):
        _paddle_fail("result payload must be an object")
    data = payload.get("res", _PADDLE_MISSING)
    if not isinstance(data, dict):
        _paddle_fail("result res payload must be an object")
    return data


def paddle_results_sequence(results: Any) -> list[Any]:
    if results is None:
        _paddle_fail("prediction result must be an array or result object")
    if isinstance(results, list | tuple):
        return list(results)
    return [results]


def _paddle_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        _paddle_fail(f"{field} must be numeric")
    try:
        number = float(value)
    except (OverflowError, TypeError, ValueError) as error:
        raise PaddleResultNormalizationError(f"{field} must be numeric") from error
    if not math.isfinite(number):
        _paddle_fail(f"{field} must be finite")
    return number


def _paddle_score(value: Any) -> float:
    score = _paddle_number(value, "rec_scores value")
    if not 0 <= score <= 1:
        _paddle_fail("rec_scores value must be between zero and one")
    return score


def _paddle_polygon(value: Any) -> tuple[tuple[float, float], ...]:
    try:
        tolist = getattr(value, "tolist", None)
    except Exception as error:
        raise PaddleResultNormalizationError("polygon array access failed") from error
    if callable(tolist):
        try:
            value = tolist()
        except Exception as error:
            raise PaddleResultNormalizationError("polygon array conversion failed") from error
    if not isinstance(value, list | tuple):
        _paddle_fail("polygon must be an array")
    if len(value) == 4 and all(not isinstance(item, list | tuple) for item in value):
        left, top, right, bottom = (_paddle_number(item, "polygon coordinate") for item in value)
        if right <= left or bottom <= top:
            _paddle_fail("rectangle polygon must have positive dimensions")
        points: tuple[tuple[float, float], ...] = (
            (left, top),
            (right, top),
            (right, bottom),
            (left, bottom),
        )
    else:
        if not 4 <= len(value) <= 256:
            _paddle_fail("polygon must contain between four and 256 points")
        parsed_points: list[tuple[float, float]] = []
        for point in value:
            if not isinstance(point, list | tuple) or len(point) != 2:
                _paddle_fail("polygon point must contain two coordinates")
            parsed_points.append(
                (
                    _paddle_number(point[0], "polygon coordinate"),
                    _paddle_number(point[1], "polygon coordinate"),
                )
            )
        points = tuple(parsed_points)
    if any(coordinate < 0 for point in points for coordinate in point):
        _paddle_fail("polygon coordinates must be non-negative")
    return points


def _validate_paddle_polygon(
    polygon: tuple[tuple[float, float], ...],
    raster_width: int | None,
    raster_height: int | None,
) -> None:
    if (
        raster_width is not None
        and raster_height is not None
        and any(x > raster_width or y > raster_height for x, y in polygon)
    ):
        _paddle_fail("polygon is outside predictor input raster")


def normalize_paddle_results(
    results: Any,
    *,
    raster_width: int | None,
    raster_height: int | None,
) -> PaddleNormalizedResult:
    """Strictly normalize one Paddle/PaddleX prediction result sequence."""

    regions: list[OcrRegion] = []
    source_slots: list[tuple[int, int]] = []
    for result_index, result in enumerate(paddle_results_sequence(results)):
        data = _paddle_payload(result)
        texts = _paddle_optional_sequence(data, "rec_texts")
        if texts is None:
            _paddle_fail("rec_texts is required")
        scores = _paddle_optional_sequence(data, "rec_scores")
        polygon_fields = {
            field: _paddle_optional_sequence(data, field)
            for field in ("rec_polys", "dt_polys", "rec_boxes")
        }

        if not texts:
            if scores not in (None, []):
                _paddle_fail("empty rec_texts must have empty rec_scores")
            if any(values not in (None, []) for values in polygon_fields.values()):
                _paddle_fail("empty rec_texts must have empty polygons")
            continue

        if scores is None or len(scores) != len(texts):
            _paddle_fail("rec_texts and rec_scores must have equal cardinality")

        polygon_values: list[Any] | None = None
        for field in ("rec_polys", "dt_polys", "rec_boxes"):
            candidate = polygon_fields[field]
            if candidate:
                polygon_values = candidate
                break
        if polygon_values is None:
            _paddle_fail("non-empty rec_texts requires a polygon array")
        if len(polygon_values) != len(texts):
            _paddle_fail("rec_texts and polygon array must have equal cardinality")

        normalized_scores = tuple(_paddle_score(value) for value in scores)
        for index, raw_text in enumerate(texts):
            if not isinstance(raw_text, str):
                _paddle_fail("rec_texts values must be strings")
            polygon = _paddle_polygon(polygon_values[index])
            _validate_paddle_polygon(polygon, raster_width, raster_height)
            text = raw_text.strip()
            # Paddle can retain an unrecognized crop with empty text and score zero.
            # Validate its metadata before omitting it from the recognized regions.
            if not text:
                continue
            regions.append(
                OcrRegion(
                    text=text,
                    confidence=normalized_scores[index],
                    polygon=polygon,
                )
            )
            source_slots.append((result_index, index))
    return PaddleNormalizedResult(
        text="\n".join(region.text for region in regions),
        regions=tuple(regions),
        source_slots=tuple(source_slots),
    )


__all__ = [
    "PaddleNormalizedResult",
    "PaddleResultNormalizationError",
    "compose_aligned_regions",
    "normalize_paddle_results",
    "paddle_results_sequence",
]
