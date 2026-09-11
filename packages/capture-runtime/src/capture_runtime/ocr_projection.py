"""Canonical OCR page projection owned by the runtime extraction module.

The worker and synchronous adapter are deliberately small adapters.  This
module owns the stable page ordering, raster/box invariants, confidence
semantics, and typed failure conversion that consumers bind to.
"""

from __future__ import annotations

import math
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path
from typing import Literal, Protocol

from capture_runtime.constants import API_VERSION, RUNTIME_VERSION
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureFailureV2,
    CaptureOcrProjectionV3,
    CaptureSource,
    OcrBoxV3,
    OcrPageProjectionV3,
    OcrPageStatus,
    OcrPointV3,
    OcrProjectionStatus,
    OcrProvenanceUnavailableReason,
    OcrProvenanceV3,
    OcrRasterV3,
)
from capture_runtime.ocr_profile import load_profile_spec


def _default_profile_identity() -> tuple[str, str]:
    """Read the checked-in Paddle profile identity for pre-worker failures.

    Worker runs replace this identity with the model-directory identity before
    emitting a header.  The checked-in profile keeps an early failure readable
    without inventing a host-specific OCR configuration.
    """

    try:
        profile = load_profile_spec()
        return profile.profile_id, profile.profile_spec_sha256
    except Exception as error:
        raise OcrProjectionError("canonical OCR profile identity is unavailable") from error


class OcrProjectionError(ValueError):
    """Raised when an adapter result cannot satisfy the canonical projection."""


@dataclass(frozen=True, slots=True)
class OcrPageManifest:
    """The bounded, source-owned raster identity for one OCR page."""

    page: int
    raster_width: int
    raster_height: int
    raster_scale: float

    def __post_init__(self) -> None:
        if isinstance(self.page, bool) or self.page < 1:
            raise OcrProjectionError("OCR manifest pages must be one-based")
        if (
            isinstance(self.raster_width, bool)
            or isinstance(self.raster_height, bool)
            or self.raster_width <= 0
            or self.raster_height <= 0
        ):
            raise OcrProjectionError("OCR manifest raster dimensions must be positive")
        if (
            isinstance(self.raster_scale, bool)
            or not isinstance(self.raster_scale, int | float)
            or not math.isfinite(float(self.raster_scale))
            or not 0 < float(self.raster_scale) <= 8
        ):
            raise OcrProjectionError("OCR manifest raster scale must be positive")


@dataclass(frozen=True, slots=True)
class OcrBoxInput:
    """One normalized OCR region before it crosses the wire contract."""

    polygon: tuple[tuple[float, float], ...]
    text: str
    confidence: float | None = None


@dataclass(frozen=True, slots=True)
class OcrPageInput:
    """Normalized output from one engine page adapter."""

    page: int
    text: str
    raster_width: int
    raster_height: int
    raster_scale: float
    boxes: tuple[OcrBoxInput | tuple[int, int, int, int], ...] = ()
    region_confidences: tuple[float, ...] = ()
    confidence: float | None = None
    status: OcrPageStatus | None = None
    provenance: OcrProvenanceV3 | None = None
    failure: CaptureFailureV2 | None = None


@dataclass(frozen=True, slots=True)
class OcrEngineRun:
    """The small result port shared by synchronous and remote OCR adapters."""

    pages: tuple[OcrPageInput, ...]
    provenance: OcrProvenanceV3 | CaptureEngine
    warnings: tuple[str, ...] = ()


class OcrEnginePort(Protocol):
    """Internal engine seam; transport and Paddle configuration stay behind it."""

    def recognize(self, manifest: tuple[OcrPageManifest, ...]) -> OcrEngineRun: ...


@dataclass(frozen=True, slots=True)
class _OcrRequest:
    """Metadata-only request owned by the canonical OCR execution seam."""

    capture_id: str
    source: CaptureSource
    page_scope: tuple[int, ...] | None
    manifest: tuple[OcrPageManifest, ...]
    created_at: datetime
    warnings: tuple[str, ...]
    is_cancelled: Callable[[], bool]
    progress: Callable[[dict[str, object]], None] | None = None


@dataclass(frozen=True, slots=True)
class _OcrEngineRequest:
    """Bounded callbacks an adapter uses for one-page observations."""

    manifest: tuple[OcrPageManifest, ...]
    is_cancelled: Callable[[], bool]
    observe: Callable[[OcrPageManifest, object, OcrProvenanceV3], OcrPageInput]
    fail_page: Callable[[OcrPageManifest], None]


class _OcrEnginePort(Protocol):
    def recognize(self, request: _OcrEngineRequest) -> OcrEngineRun: ...


class _LegacyOcrEngineAdapter:
    """Keep the existing synchronous engine port compatible during convergence."""

    def __init__(self, engine: OcrEnginePort) -> None:
        self._engine = engine

    def recognize(self, request: _OcrEngineRequest) -> OcrEngineRun:
        return self._engine.recognize(request.manifest)


class OcrEngineFailure(RuntimeError):
    """A sanitized engine-terminal signal with any already trusted page results."""

    def __init__(
        self,
        *,
        kind: Literal["timeout", "protocol", "worker", "unavailable"],
        completed_pages: Iterable[OcrPageInput] = (),
        provenance: OcrProvenanceV3 | CaptureEngine | None = None,
    ) -> None:
        self.kind = kind
        self.completed_pages = tuple(completed_pages)
        self.provenance = provenance
        super().__init__(kind)


class OcrExtractionFailure(RuntimeError):
    """A sanitized OCR failure carrying its complete readable projection."""

    def __init__(
        self,
        *,
        failure: CaptureFailureV2,
        projection: CaptureOcrProjectionV3,
    ) -> None:
        self.failure = failure
        self.projection = projection
        super().__init__(failure.message)


@dataclass(frozen=True, slots=True)
class OcrTerminalOutcome:
    """One OCR terminal failure and its page-complete projection."""

    failure: CaptureFailureV2
    projection: CaptureOcrProjectionV3


def _coerce_polygon(
    value: object,
    *,
    rectangle_is_size: bool = False,
) -> tuple[tuple[float, float], ...]:
    """Keep predictor point order while accepting a legacy xyxy rectangle."""

    if isinstance(value, OcrBoxInput):
        value = value.polygon
    if not isinstance(value, list | tuple):
        raise OcrProjectionError("OCR polygon is invalid")
    if len(value) == 4 and all(not isinstance(item, list | tuple) for item in value):
        try:
            left, top, third, fourth = (float(item) for item in value)
        except (TypeError, ValueError) as error:
            raise OcrProjectionError("OCR polygon is invalid") from error
        right = left + third if rectangle_is_size else third
        bottom = top + fourth if rectangle_is_size else fourth
        if right <= left or bottom <= top:
            raise OcrProjectionError("OCR polygon is invalid")
        points: tuple[tuple[float, float], ...] = (
            (left, top),
            (right, top),
            (right, bottom),
            (left, bottom),
        )
    else:
        parsed_points: list[tuple[float, float]] = []
        for raw_point in value:
            if not isinstance(raw_point, list | tuple) or len(raw_point) != 2:
                raise OcrProjectionError("OCR polygon is invalid")
            try:
                x, y = (float(item) for item in raw_point)
            except (TypeError, ValueError) as error:
                raise OcrProjectionError("OCR polygon is invalid") from error
            parsed_points.append((x, y))
        if len(parsed_points) < 4:
            raise OcrProjectionError("OCR polygon requires at least four points")
        points = tuple(parsed_points)
    if any(
        not math.isfinite(coordinate) or coordinate < 0 for point in points for coordinate in point
    ):
        raise OcrProjectionError("OCR polygon coordinates must be finite and non-negative")
    return tuple(points)


class OcrPipeline:
    """Deep OCR pipeline seam for source manifests and engine adapters.

    Callers provide only the source identity, a preflight manifest, and an
    engine port.  This module owns ordering, metadata trust, box/confidence
    normalization, empty-page semantics, and sanitized terminal failures.
    ``OcrEnginePort`` is deliberately transport-neutral so the synchronous
    rasterizer, remote worker adapter, and in-memory test adapter exercise the
    same policy.
    """

    def __init__(
        self,
        *,
        contract_sha256: str | None = None,
        default_provenance: OcrProvenanceV3 | None = None,
    ) -> None:
        self._builder = _OcrProjectionBuilder(
            contract_sha256=contract_sha256,
            default_provenance=default_provenance,
        )

    @property
    def contract_sha256(self) -> str:
        return self._builder.contract_sha256

    @property
    def default_provenance(self) -> OcrProvenanceV3:
        return self._builder.default_provenance

    def extract(
        self,
        *,
        capture_id: str,
        source: CaptureSource,
        manifest: Sequence[OcrPageManifest],
        engine: OcrEnginePort,
        created_at: datetime,
        warnings: Sequence[str] = (),
    ) -> CaptureOcrProjectionV3:
        request = _OcrRequest(
            capture_id=capture_id,
            source=source,
            page_scope=None,
            manifest=self._validate_manifest(manifest),
            created_at=created_at,
            warnings=tuple(warnings),
            is_cancelled=lambda: False,
        )
        outcome = self._execute(request, _LegacyOcrEngineAdapter(engine))
        if isinstance(outcome, OcrTerminalOutcome):
            raise OcrExtractionFailure(failure=outcome.failure, projection=outcome.projection)
        return outcome

    def _execute(
        self,
        request: _OcrRequest,
        engine: _OcrEnginePort,
    ) -> CaptureOcrProjectionV3 | OcrTerminalOutcome:
        expected_manifest = self._validate_manifest(request.manifest)
        expected_pages = tuple(self._manifest_input(item) for item in expected_manifest)
        observed_pages: list[OcrPageInput] = []
        observed_provenance: OcrProvenanceV3 | None = None
        header_emitted = False
        failed_pages: set[int] = set()

        def observe(
            expected: OcrPageManifest,
            observation: object,
            provenance: OcrProvenanceV3,
        ) -> OcrPageInput:
            nonlocal observed_provenance, header_emitted
            if expected.page != len(observed_pages) + 1:
                raise OcrProjectionError("OCR page results must be complete and ordered")
            if not provenance.is_resolved or provenance.engine != "windowsml-ocr":
                raise OcrProjectionError("OCR engine provenance is incompatible")
            if observed_provenance is None:
                observed_provenance = provenance
            elif observed_provenance != provenance:
                raise OcrProjectionError("OCR worker returned changing provenance across pages")
            normalized = self._normalize_observation(
                expected,
                observation,
                raster_scale_override=expected.raster_scale,
                provenance_override=provenance,
            )
            observed_pages.append(normalized)
            if request.progress is not None and not header_emitted:
                request.progress(
                    {
                        "type": "ocr-header",
                        "pageCount": len(expected_manifest),
                        "pages": self._serialize_manifest(expected_manifest),
                        "provenance": provenance.model_dump(mode="json", by_alias=True),
                    }
                )
                header_emitted = True
            if request.progress is not None:
                request.progress({"type": "ocr-page", "page": self._serialize_page(normalized)})
            return normalized

        def fail_page(expected: OcrPageManifest) -> None:
            if request.progress is None or not header_emitted or expected.page in failed_pages:
                return
            failed_pages.add(expected.page)
            failure = CaptureFailureV2(
                code="ocr_page_failed",
                message="OCR page processing failed.",
                stage="extraction",
                retryable=True,
            )
            request.progress(
                {
                    "type": "ocr-page",
                    "page": self._serialize_page(self._failed_page(expected, failure)),
                }
            )

        engine_request = _OcrEngineRequest(
            manifest=expected_manifest,
            is_cancelled=request.is_cancelled,
            observe=observe,
            fail_page=fail_page,
        )
        try:
            run = engine.recognize(engine_request)
        except InterruptedError:
            raise
        except OcrEngineFailure as error:
            return self._builder.worker_failure(
                capture_id=request.capture_id,
                source=request.source,
                expected_pages=expected_pages,
                kind=error.kind,
                completed_pages=error.completed_pages,
                provenance=error.provenance,
                created_at=request.created_at,
                warnings=request.warnings,
            )
        except Exception:
            return self._builder.worker_failure(
                capture_id=request.capture_id,
                source=request.source,
                expected_pages=expected_pages,
                kind="protocol",
                completed_pages=observed_pages,
                provenance=observed_provenance,
                created_at=request.created_at,
                warnings=request.warnings,
            )

        try:
            if not isinstance(run, OcrEngineRun):
                raise OcrProjectionError("OCR engine returned an invalid run")
            provenance = self._builder.coerce_provenance(run.provenance)
            if not provenance.is_resolved or provenance.engine != "windowsml-ocr":
                raise OcrProjectionError("OCR engine provenance is incompatible")
            pages = tuple(
                replace(page, provenance=page.provenance or provenance) for page in run.pages
            )
            if observed_pages and pages != tuple(observed_pages):
                raise OcrProjectionError("OCR engine observations do not match its terminal run")
            self._validate_run(expected_manifest, pages)
            projection = self._builder.build(
                capture_id=request.capture_id,
                source=request.source,
                pages=pages,
                provenance=provenance,
                warnings=(*request.warnings, *run.warnings),
                created_at=request.created_at,
            )
        except Exception:
            completed_pages = (
                tuple(run.pages) if isinstance(run, OcrEngineRun) else tuple(observed_pages)
            )
            failed_provenance: OcrProvenanceV3 | None = None
            if isinstance(run, OcrEngineRun):
                try:
                    failed_provenance = self._builder.coerce_provenance(run.provenance)
                except (OcrProjectionError, ValueError):
                    # An invalid model identity is a protocol failure, not a
                    # reason to leak a sentinel or mask the readable terminal
                    # projection with a second coercion exception.
                    failed_provenance = observed_provenance
            else:
                failed_provenance = observed_provenance
            return self._builder.worker_failure(
                capture_id=request.capture_id,
                source=request.source,
                expected_pages=expected_pages,
                kind="protocol",
                completed_pages=completed_pages,
                provenance=failed_provenance,
                created_at=request.created_at,
                warnings=request.warnings,
            )
        if projection.failure is not None:
            return OcrTerminalOutcome(failure=projection.failure, projection=projection)
        return projection

    def _normalize_observation(
        self,
        expected: OcrPageManifest,
        observation: object,
        *,
        use_manifest_raster: bool = False,
        raster_scale_override: float | None = None,
        provenance_override: OcrProvenanceV3 | None = None,
    ) -> OcrPageInput:
        """Normalize either a local engine result or a validated worker page."""

        if isinstance(observation, OcrPageInput):
            candidate = observation
        else:
            text = getattr(observation, "text", None)
            if not isinstance(text, str):
                raise OcrProjectionError("OCR engine page text is invalid")
            raw_regions = getattr(observation, "regions", None)
            raw_boxes = getattr(observation, "boxes", None)
            confidences: list[float] = []
            boxes: list[OcrBoxInput] = []
            if raw_regions is not None:
                for region in raw_regions:
                    region_text = getattr(region, "text", text)
                    if not isinstance(region_text, str):
                        raise OcrProjectionError("OCR region text is invalid")
                    region_polygon = getattr(region, "polygon", None)
                    if not region_polygon:
                        region_polygon = getattr(region, "box", None)
                    value = getattr(region, "confidence", None)
                    normalized_confidence = self._confidence_or_none(value)
                    if normalized_confidence is not None:
                        confidences.append(normalized_confidence)
                    if region_polygon:
                        boxes.append(
                            OcrBoxInput(
                                polygon=_coerce_polygon(region_polygon),
                                text=region_text.strip(),
                                confidence=normalized_confidence,
                            )
                        )
            elif raw_boxes is not None:
                raw_region_confidences = getattr(observation, "region_confidences", ())
                for index, value in enumerate(raw_boxes):
                    normalized_value = value
                    region_text = text
                    region_confidence = (
                        raw_region_confidences[index]
                        if index < len(raw_region_confidences)
                        else None
                    )
                    if isinstance(value, OcrBoxInput):
                        normalized_value = value.polygon
                        region_text = value.text
                        region_confidence = value.confidence
                    boxes.append(
                        OcrBoxInput(
                            polygon=_coerce_polygon(normalized_value, rectangle_is_size=True),
                            text=region_text.strip(),
                            confidence=self._confidence_or_none(region_confidence),
                        )
                    )
            boxes_tuple = tuple(boxes)
            # The adapter aggregate is intentionally ignored.  The canonical
            # projection computes confidence from the normalized region scores
            # in one place so every transport has identical semantics.
            adapter_confidence = getattr(observation, "confidence", None)
            if adapter_confidence is not None:
                self._confidence_or_none(adapter_confidence)
            region_confidences = tuple(confidences)
            raw_region_confidences = getattr(observation, "region_confidences", None)
            if raw_region_confidences is not None and not raw_regions:
                normalized_confidences: list[float] = []
                for value in raw_region_confidences:
                    normalized = self._confidence_or_none(value)
                    if normalized is not None:
                        normalized_confidences.append(normalized)
                region_confidences = tuple(normalized_confidences)
            status = getattr(observation, "status", None)
            if status is not None:
                try:
                    status = OcrPageStatus(status)
                except ValueError as error:
                    raise OcrProjectionError("OCR engine page status is invalid") from error
            failure = getattr(observation, "failure", None)
            observation_provenance = getattr(observation, "provenance", None)
            if not isinstance(observation_provenance, OcrProvenanceV3):
                if any(hasattr(observation, name) for name in ("model", "digest", "device")):
                    observation_provenance = self._builder.observation_provenance(observation)
                elif provenance_override is not None:
                    observation_provenance = provenance_override
                else:
                    observation_provenance = None
            candidate = OcrPageInput(
                page=getattr(observation, "page", expected.page),
                text=text.strip(),
                raster_width=expected.raster_width
                if use_manifest_raster
                else getattr(observation, "raster_width", expected.raster_width)
                or expected.raster_width,
                raster_height=expected.raster_height
                if use_manifest_raster
                else getattr(observation, "raster_height", expected.raster_height)
                or expected.raster_height,
                raster_scale=raster_scale_override
                if raster_scale_override is not None
                else expected.raster_scale
                if use_manifest_raster
                else getattr(observation, "raster_scale", expected.raster_scale)
                or expected.raster_scale,
                boxes=boxes_tuple,
                region_confidences=region_confidences,
                confidence=None,
                status=status,
                provenance=observation_provenance,
                failure=failure,
            )
        if candidate.text != candidate.text.strip():
            candidate = replace(candidate, text=candidate.text.strip())
        if (
            candidate.page != expected.page
            or candidate.raster_width != expected.raster_width
            or candidate.raster_height != expected.raster_height
            or candidate.raster_scale != expected.raster_scale
        ):
            raise OcrProjectionError("OCR page metadata does not match the manifest")
        self._builder._page(
            candidate,
            candidate.provenance or provenance_override or self.default_provenance,
        )
        return candidate

    def normalize_observation(
        self,
        expected: OcrPageManifest,
        observation: object,
        *,
        use_manifest_raster: bool = False,
        raster_scale_override: float | None = None,
        provenance_override: OcrProvenanceV3 | None = None,
    ) -> OcrPageInput:
        """Normalize one adapter page through the canonical OCR seam."""

        return self._normalize_observation(
            expected,
            observation,
            use_manifest_raster=use_manifest_raster,
            raster_scale_override=raster_scale_override,
            provenance_override=provenance_override,
        )

    def observation_provenance(self, observation: object) -> OcrProvenanceV3:
        return self._builder.observation_provenance(observation)

    def serialize_page(self, item: OcrPageInput) -> dict[str, object]:
        return self._serialize_page(item)

    def serialize_manifest(self, manifest: Sequence[OcrPageManifest]) -> list[dict[str, object]]:
        return self._serialize_manifest(manifest)

    def _serialize_pages(
        self,
        pages: Sequence[OcrPageInput],
    ) -> list[dict[str, object]]:
        """Serialize normalized pages using the private worker wire contract."""

        return [self._serialize_page(page) for page in pages]

    def _segments(self, projection: CaptureOcrProjectionV3) -> list[dict[str, object]]:
        """Derive the worker segment envelope from canonical page projections."""

        return [
            {
                "order": order,
                "text": page.text,
                "page": page.page,
                "startMs": None,
                "endMs": None,
            }
            for order, page in enumerate(page for page in projection.pages if page.text.strip())
        ]

    def failed_page(
        self,
        expected: OcrPageManifest,
        failure: CaptureFailureV2,
    ) -> OcrPageInput:
        return self._failed_page(expected, failure)

    def failure(
        self,
        *,
        capture_id: str,
        source: CaptureSource,
        manifest: Sequence[OcrPageManifest],
        kind: Literal["timeout", "protocol", "worker", "unavailable"],
        completed_pages: Iterable[OcrPageInput] = (),
        provenance: OcrProvenanceV3 | CaptureEngine | None = None,
        created_at: datetime,
        warnings: Sequence[str] = (),
    ) -> OcrExtractionFailure:
        expected_manifest = self._validate_manifest(manifest)
        return self._terminal_failure(
            capture_id=capture_id,
            source=source,
            expected_pages=tuple(self._manifest_input(item) for item in expected_manifest),
            kind=kind,
            completed_pages=completed_pages,
            provenance=provenance,
            created_at=created_at,
            warnings=warnings,
        )

    @staticmethod
    def _serialize_page(item: OcrPageInput) -> dict[str, object]:
        """Serialize a normalized page for the internal worker wire adapter."""

        boxes = _OcrProjectionBuilder._box_inputs(item)
        return {
            "page": item.page,
            "status": (
                item.status.value
                if item.status is not None
                else OcrPageStatus.FAILED.value
                if item.failure is not None
                else OcrPageStatus.RECOGNIZED.value
                if item.text.strip()
                else OcrPageStatus.EMPTY.value
            ),
            "text": item.text.strip(),
            "boxes": [
                {
                    "polygon": [{"x": x, "y": y} for x, y in box.polygon],
                    "text": box.text,
                    "confidence": box.confidence,
                }
                for box in boxes
            ],
            "confidence": item.confidence,
            "regionConfidences": list(item.region_confidences),
            "raster": {
                "width": item.raster_width,
                "height": item.raster_height,
                "scale": item.raster_scale,
                "coordinateSystem": "pixel",
            },
            "failure": None if item.failure is None else item.failure.model_dump(mode="json"),
        }

    @staticmethod
    def _serialize_manifest(manifest: Sequence[OcrPageManifest]) -> list[dict[str, object]]:
        return [
            {
                "page": item.page,
                "raster": {
                    "width": item.raster_width,
                    "height": item.raster_height,
                    "scale": item.raster_scale,
                    "coordinateSystem": "pixel",
                },
            }
            for item in manifest
        ]

    @staticmethod
    def _failed_page(
        expected: OcrPageManifest,
        failure: CaptureFailureV2,
    ) -> OcrPageInput:
        return OcrPageInput(
            page=expected.page,
            text="",
            raster_width=expected.raster_width,
            raster_height=expected.raster_height,
            raster_scale=expected.raster_scale,
            status=OcrPageStatus.FAILED,
            failure=failure,
        )

    @staticmethod
    def _validate_manifest(
        manifest: Sequence[OcrPageManifest],
    ) -> tuple[OcrPageManifest, ...]:
        values = tuple(manifest)
        if not values or [item.page for item in values] != list(range(1, len(values) + 1)):
            raise OcrProjectionError("OCR manifest must be complete and ordered")
        return values

    @staticmethod
    def _manifest_input(item: OcrPageManifest) -> OcrPageInput:
        return OcrPageInput(
            page=item.page,
            text="",
            raster_width=item.raster_width,
            raster_height=item.raster_height,
            raster_scale=item.raster_scale,
        )

    @staticmethod
    def _validate_run(
        manifest: Sequence[OcrPageManifest],
        pages: Sequence[OcrPageInput],
    ) -> None:
        if len(pages) != len(manifest):
            raise OcrProjectionError("OCR engine did not complete the page manifest")
        for expected, actual in zip(manifest, pages, strict=True):
            if (
                actual.page != expected.page
                or actual.raster_width != expected.raster_width
                or actual.raster_height != expected.raster_height
                or actual.raster_scale != expected.raster_scale
            ):
                raise OcrProjectionError("OCR engine page metadata does not match the manifest")

    @classmethod
    def _confidence_or_none(cls, value: object) -> float | None:
        if value is None:
            return None
        if not (
            isinstance(value, int | float)
            and not isinstance(value, bool)
            and math.isfinite(float(value))
            and 0 <= float(value) <= 1
        ):
            raise OcrProjectionError("OCR engine confidence is invalid")
        return float(value)

    def _terminal_failure(
        self,
        *,
        capture_id: str,
        source: CaptureSource,
        expected_pages: Sequence[OcrPageInput],
        kind: Literal["timeout", "protocol", "worker", "unavailable"],
        completed_pages: Iterable[OcrPageInput] = (),
        provenance: OcrProvenanceV3 | CaptureEngine | None = None,
        created_at: datetime,
        warnings: Sequence[str],
    ) -> OcrExtractionFailure:
        outcome = self._builder.worker_failure(
            capture_id=capture_id,
            source=source,
            kind=kind,
            expected_pages=expected_pages,
            completed_pages=completed_pages,
            provenance=provenance,
            created_at=created_at,
            warnings=warnings,
        )
        return OcrExtractionFailure(failure=outcome.failure, projection=outcome.projection)

    def build(
        self,
        *,
        capture_id: str,
        source: CaptureSource | None,
        pages: Iterable[OcrPageInput],
        provenance: OcrProvenanceV3 | CaptureEngine | None,
        warnings: Sequence[str] = (),
        created_at: datetime,
        failure: CaptureFailureV2 | None = None,
    ) -> CaptureOcrProjectionV3:
        return self._builder.build(
            capture_id=capture_id,
            source=source,
            pages=pages,
            provenance=provenance,
            warnings=warnings,
            created_at=created_at,
            failure=failure,
        )

    def failed(
        self,
        *,
        capture_id: str,
        source: CaptureSource | None,
        failure: CaptureFailureV2,
        created_at: datetime,
        pages: Iterable[OcrPageInput] = (),
        provenance: OcrProvenanceV3 | CaptureEngine | None = None,
        warnings: Sequence[str] = (),
    ) -> CaptureOcrProjectionV3:
        return self._builder.failed(
            capture_id=capture_id,
            source=source,
            failure=failure,
            created_at=created_at,
            pages=pages,
            provenance=provenance,
            warnings=warnings,
        )


class _OcrProjectionBuilder:
    """Internal projection implementation behind :class:`OcrPipeline`."""

    def __init__(
        self,
        *,
        contract_sha256: str | None = None,
        default_provenance: OcrProvenanceV3 | None = None,
    ) -> None:
        self.contract_sha256 = contract_sha256 or self._packaged_contract_sha256()
        self.default_provenance = default_provenance or self._fallback_provenance()

    @staticmethod
    def _packaged_contract_sha256() -> str:
        try:
            value = (
                (Path(__file__).resolve().parent / "assets" / "contract-set.sha256")
                .read_text(encoding="ascii")
                .strip()
            )
            if len(value) == 64 and all(char in "0123456789abcdef" for char in value):
                return value
        except OSError:
            pass
        return "0" * 64

    @staticmethod
    def _fallback_provenance(
        reason: OcrProvenanceUnavailableReason = OcrProvenanceUnavailableReason.MODEL_UNAVAILABLE,
    ) -> OcrProvenanceV3:
        profile_id, profile_spec_sha256 = _default_profile_identity()
        return OcrProvenanceV3(
            status="unavailable",
            profile_id=profile_id,
            profile_spec_sha256=profile_spec_sha256,
            reason=reason,
        )

    def coerce_provenance(self, value: OcrProvenanceV3 | CaptureEngine | None) -> OcrProvenanceV3:
        if isinstance(value, OcrProvenanceV3):
            return value
        if isinstance(value, CaptureEngine):
            if not value.device:
                raise OcrProjectionError("OCR engine device identity is unavailable")
            return OcrProvenanceV3(
                status="resolved",
                engine="windowsml-ocr",
                model=value.model,
                model_digest=value.digest,
                device=value.device,
                profile_id=self.default_provenance.profile_id,
                profile_spec_sha256=self.default_provenance.profile_spec_sha256,
            )
        return self.default_provenance

    def observation_provenance(self, observation: object) -> OcrProvenanceV3:
        model = getattr(observation, "model", None)
        digest = getattr(observation, "digest", None)
        device = getattr(observation, "device", None)
        if not isinstance(model, str) or not model.strip():
            raise OcrProjectionError("OCR observation model identity is unavailable")
        if not isinstance(digest, str) or not digest.strip():
            raise OcrProjectionError("OCR observation model digest is unavailable")
        if not digest.startswith("sha256:") and len(digest) == 64:
            digest = "sha256:" + digest
        if not isinstance(device, str) or not device.strip():
            raise OcrProjectionError("OCR observation device identity is unavailable")
        try:
            profile_id = (
                getattr(observation, "profile_id", None) or self.default_provenance.profile_id
            )
            profile_spec_sha256 = (
                getattr(observation, "profile_spec_sha256", None)
                or self.default_provenance.profile_spec_sha256
            )
            return OcrProvenanceV3(
                status="resolved",
                engine="windowsml-ocr",
                model=model,
                model_digest=digest,
                device=device,
                profile_id=profile_id,
                profile_spec_sha256=profile_spec_sha256,
            )
        except Exception as error:
            raise OcrProjectionError("OCR observation provenance is invalid") from error

    def build(
        self,
        *,
        capture_id: str,
        source: CaptureSource | None,
        pages: Iterable[OcrPageInput],
        provenance: OcrProvenanceV3 | CaptureEngine | None,
        warnings: Sequence[str] = (),
        created_at: datetime,
        failure: CaptureFailureV2 | None = None,
    ) -> CaptureOcrProjectionV3:
        canonical_provenance = self.coerce_provenance(provenance)
        normalized_pages = [
            replace(item, provenance=item.provenance or canonical_provenance) for item in pages
        ]
        if any(item.provenance != canonical_provenance for item in normalized_pages):
            raise OcrProjectionError("page OCR provenance must match document provenance")
        if [page.page for page in normalized_pages] != list(range(1, len(normalized_pages) + 1)):
            raise OcrProjectionError("OCR page results must be complete and ordered")
        projection_pages = [self._page(item, canonical_provenance) for item in normalized_pages]
        page_failure = next(
            (item.failure for item in projection_pages if item.failure is not None), None
        )
        effective_failure = failure or page_failure
        if (
            effective_failure is None
            and projection_pages
            and all(page.status is OcrPageStatus.EMPTY for page in projection_pages)
        ):
            effective_failure = self.no_text_failure()
        status = (
            OcrProjectionStatus.FAILED
            if effective_failure is not None
            else OcrProjectionStatus.COMPLETED
        )
        if status is OcrProjectionStatus.COMPLETED and source is None:
            raise OcrProjectionError("completed OCR projection requires source and provenance")
        return CaptureOcrProjectionV3(
            api_version=API_VERSION,
            schema_version="3",
            capture_id=capture_id,
            status=status,
            source=source,
            pages=projection_pages,
            page_count=len(projection_pages),
            runtime_version=RUNTIME_VERSION,
            contract_sha256=self.contract_sha256,
            provenance=canonical_provenance,
            warnings=[value[:500] for value in dict.fromkeys(item for item in warnings if item)],
            failure=effective_failure,
            created_at=created_at,
        )

    @staticmethod
    def no_text_failure() -> CaptureFailureV2:
        return CaptureFailureV2(
            code="ocr_no_text",
            message="OCR produced no text.",
            stage="extraction",
            retryable=False,
        )

    def require_success(self, projection: CaptureOcrProjectionV3) -> CaptureOcrProjectionV3:
        if projection.failure is not None:
            raise OcrExtractionFailure(
                failure=projection.failure,
                projection=projection,
            )
        return projection

    def worker_failure(
        self,
        *,
        capture_id: str,
        source: CaptureSource,
        kind: str,
        expected_pages: Sequence[OcrPageInput],
        completed_pages: Iterable[OcrPageInput] = (),
        provenance: OcrProvenanceV3 | CaptureEngine | None = None,
        created_at: datetime,
        warnings: Sequence[str] = (),
    ) -> OcrTerminalOutcome:
        if kind == "timeout":
            failure = CaptureFailureV2(
                code="ocr_worker_timeout",
                message="OCR worker timed out before completing all pages.",
                stage="extraction",
                retryable=True,
            )
        elif kind == "protocol":
            failure = CaptureFailureV2(
                code="ocr_worker_protocol",
                message="OCR worker returned an invalid response.",
                stage="extraction",
                retryable=False,
            )
        elif kind == "worker":
            failure = CaptureFailureV2(
                code="ocr_worker_failed",
                message="OCR worker failed before completing all pages.",
                stage="extraction",
                retryable=True,
            )
        elif kind == "unavailable":
            failure = CaptureFailureV2(
                code="ocr_runtime_unavailable",
                message="OCR runtime was unavailable before completing all pages.",
                stage="extraction",
                retryable=True,
            )
        else:
            raise OcrProjectionError("OCR worker failure kind is invalid")

        # An unavailable runtime cannot establish a resolved model/device
        # identity.  Keep the manifest-derived page projection, but never
        # expose a trusted progress prefix under unavailable provenance.
        completed_candidates = () if kind == "unavailable" else tuple(completed_pages)
        candidate_provenances = tuple(
            page.provenance
            for page in completed_candidates
            if page.provenance is not None and page.provenance.is_resolved
        )
        if (
            provenance is None
            and candidate_provenances
            and all(candidate == candidate_provenances[0] for candidate in candidate_provenances)
        ):
            canonical_provenance = candidate_provenances[0]
        elif provenance is None or kind == "unavailable":
            canonical_provenance = self._fallback_provenance(
                {
                    "timeout": OcrProvenanceUnavailableReason.WORKER_TIMEOUT,
                    "protocol": OcrProvenanceUnavailableReason.PROTOCOL_FAILURE,
                    "worker": OcrProvenanceUnavailableReason.WORKER_CRASHED,
                    "unavailable": OcrProvenanceUnavailableReason.MODEL_UNAVAILABLE,
                }[kind]
            )
        else:
            canonical_provenance = self.coerce_provenance(provenance)
        completed = tuple(
            replace(page, provenance=page.provenance or canonical_provenance)
            for page in completed_candidates
        )
        trusted_empty = (
            len(completed) == len(expected_pages)
            and all(
                page.status in {None, OcrPageStatus.EMPTY} and not page.text.strip()
                for page in completed
            )
            and self._trusted_completed_pages(expected_pages, completed, canonical_provenance)
        )
        if kind == "worker" and trusted_empty:
            failure = self.no_text_failure()
        projection = self.failed_from_completed_pages(
            capture_id=capture_id,
            source=source,
            expected_pages=expected_pages,
            completed_pages=completed,
            failure=failure,
            provenance=canonical_provenance,
            created_at=created_at,
            warnings=warnings,
        )
        return OcrTerminalOutcome(failure=failure, projection=projection)

    def failed_from_completed_pages(
        self,
        *,
        capture_id: str,
        source: CaptureSource,
        expected_pages: Sequence[OcrPageInput],
        completed_pages: Iterable[OcrPageInput],
        failure: CaptureFailureV2,
        provenance: OcrProvenanceV3 | CaptureEngine | None = None,
        created_at: datetime,
        warnings: Sequence[str] = (),
    ) -> CaptureOcrProjectionV3:
        expected = tuple(expected_pages)
        canonical_provenance = self.coerce_provenance(provenance)
        trusted = self._trusted_completed_pages(
            expected, tuple(completed_pages), canonical_provenance
        )
        page_inputs = [
            trusted_page
            if trusted_page is not None
            else OcrPageInput(
                page=expected_page.page,
                text="",
                raster_width=expected_page.raster_width,
                raster_height=expected_page.raster_height,
                raster_scale=expected_page.raster_scale,
                status=OcrPageStatus.FAILED,
                provenance=canonical_provenance,
                failure=failure,
            )
            for expected_page, trusted_page in zip(expected, trusted, strict=True)
        ]
        return self.failed(
            capture_id=capture_id,
            source=source,
            failure=failure,
            created_at=created_at,
            pages=page_inputs,
            provenance=canonical_provenance,
            warnings=warnings,
        )

    def _trusted_completed_pages(
        self,
        expected_pages: Sequence[OcrPageInput],
        completed_pages: Sequence[OcrPageInput],
        provenance: OcrProvenanceV3,
    ) -> tuple[OcrPageInput | None, ...]:
        expected = tuple(expected_pages)
        by_page: dict[int, OcrPageInput] = {}
        expected_by_page = {page.page: page for page in expected}
        for candidate in completed_pages:
            expected_page = expected_by_page.get(candidate.page)
            if expected_page is None:
                continue
            if (
                candidate.raster_width != expected_page.raster_width
                or candidate.raster_height != expected_page.raster_height
                or candidate.raster_scale != expected_page.raster_scale
            ):
                continue
            if candidate.page in by_page:
                continue
            try:
                candidate = replace(candidate, provenance=candidate.provenance or provenance)
                self._page(candidate, provenance)
            except Exception:
                continue
            by_page[candidate.page] = candidate
        return tuple(by_page.get(page.page) for page in expected)

    def failed(
        self,
        *,
        capture_id: str,
        source: CaptureSource | None,
        failure: CaptureFailureV2,
        created_at: datetime,
        pages: Iterable[OcrPageInput] = (),
        provenance: OcrProvenanceV3 | CaptureEngine | None = None,
        warnings: Sequence[str] = (),
    ) -> CaptureOcrProjectionV3:
        return self.build(
            capture_id=capture_id,
            source=source,
            pages=pages,
            provenance=provenance,
            created_at=created_at,
            failure=failure,
            warnings=warnings,
        )

    @staticmethod
    def _box_inputs(item: OcrPageInput) -> tuple[OcrBoxInput, ...]:
        boxes: list[OcrBoxInput] = []
        for index, value in enumerate(item.boxes):
            if isinstance(value, OcrBoxInput):
                polygon = _coerce_polygon(value.polygon)
                text = value.text.strip()
                confidence = value.confidence
            else:
                polygon = _coerce_polygon(value, rectangle_is_size=True)
                text = item.text.strip()
                confidence = (
                    item.region_confidences[index] if index < len(item.region_confidences) else None
                )
            if not text:
                raise OcrProjectionError("OCR box text is invalid")
            if confidence is not None:
                if (
                    isinstance(confidence, bool)
                    or not isinstance(confidence, int | float)
                    or not math.isfinite(float(confidence))
                    or not 0 <= float(confidence) <= 1
                ):
                    raise OcrProjectionError("OCR box confidence is invalid")
                confidence = float(confidence)
            if any(x > item.raster_width or y > item.raster_height for x, y in polygon):
                raise OcrProjectionError("OCR polygon must stay inside the raw raster bounds")
            boxes.append(OcrBoxInput(polygon=polygon, text=text, confidence=confidence))
        return tuple(boxes)

    @classmethod
    def _page(cls, item: OcrPageInput, provenance: OcrProvenanceV3 | None) -> OcrPageProjectionV3:
        if item.page < 1:
            raise OcrProjectionError("OCR page must be one-based")
        if item.raster_width <= 0 or item.raster_height <= 0:
            raise OcrProjectionError("OCR raster dimensions must be positive")
        if item.raster_scale <= 0:
            raise OcrProjectionError("OCR raster scale must be positive")
        text = item.text.strip()
        status = item.status
        if status is None:
            status = (
                OcrPageStatus.FAILED
                if item.failure is not None
                else OcrPageStatus.RECOGNIZED
                if text
                else OcrPageStatus.EMPTY
            )
        box_inputs = cls._box_inputs(item)
        boxes = tuple(
            OcrBoxV3(
                polygon=[OcrPointV3(x=x, y=y) for x, y in box.polygon],
                text=box.text,
                confidence=box.confidence,
            )
            for box in box_inputs
        )
        for value in item.region_confidences:
            if (
                isinstance(value, bool)
                or not isinstance(value, int | float)
                or not math.isfinite(float(value))
                or not 0 <= float(value) <= 1
            ):
                raise OcrProjectionError("OCR region confidence is invalid")
        region_confidences = item.region_confidences or tuple(
            box.confidence for box in box_inputs if box.confidence is not None
        )
        # Confidence is a projection rule, never adapter metadata: recognized
        # numeric scores use a four-place arithmetic mean, recognized text
        # without legal numeric scores uses 0.0, and empty/failed is null.
        confidence = (
            round(sum(region_confidences) / len(region_confidences), 4)
            if status is OcrPageStatus.RECOGNIZED and region_confidences
            else 0.0
            if status is OcrPageStatus.RECOGNIZED
            else None
        )
        effective_provenance = provenance or item.provenance
        if effective_provenance is None:
            raise OcrProjectionError("OCR page provenance is required")
        return OcrPageProjectionV3(
            page=item.page,
            status=status,
            raster=OcrRasterV3(
                width=item.raster_width,
                height=item.raster_height,
                scale=item.raster_scale,
                coordinate_system="pixel",
            ),
            text=text,
            boxes=list(boxes),
            confidence=confidence,
            provenance=effective_provenance,
            failure=item.failure,
        )


__all__ = [
    "OcrEngineFailure",
    "OcrEnginePort",
    "OcrEngineRun",
    "OcrExtractionFailure",
    "OcrBoxInput",
    "OcrPageInput",
    "OcrPageManifest",
    "OcrPipeline",
    "OcrProjectionError",
    "OcrTerminalOutcome",
]
