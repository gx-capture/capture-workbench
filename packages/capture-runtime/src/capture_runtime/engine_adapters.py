"""Standalone WindowsML OCR and faster-whisper engine adapters.

The adapters deliberately own their dependency and model probes. They never import a host
application package, never download during extraction, and report the exact missing runtime
asset instead of substituting deterministic content.
"""

from __future__ import annotations

import ctypes
import hashlib
import importlib.util
import json
import math
import re
import shutil
import stat
import sys
import tempfile
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from io import BytesIO
from numbers import Real
from pathlib import Path
from threading import Lock
from types import ModuleType
from typing import Any, NoReturn, Protocol
from uuid import uuid4

from capture_runtime.contracts import OcrProvenanceV3
from capture_runtime.ocr_execution_proof import (
    OcrExecutionDeviceProofV1,
    OcrExecutionProofContextV1,
    OcrPipelineConstructionProofV1,
)
from capture_runtime.ocr_preflight import (
    OcrExecutionPlan,
    OcrSelectionDeviceProofV1,
    _NativeOcrAdapterMapLease,
)
from capture_runtime.ocr_profile import (
    EngineRuntimeUnavailableError,
    OcrProfileSpec,
    load_profile_spec,
    validate_model_artifacts,
)
from capture_runtime.worker_stage_policy import (
    ocr_probe_providers_stage,
    ocr_probe_readiness_stage,
    ocr_provider_evidence_stage,
    ocr_stage_failure,
    sanitize_worker_stage,
    whisper_model_load_stage,
    whisper_output_stage,
    whisper_stage,
)

# Compatibility name retained for callers that imported the former identity
# record; the canonical profile module now owns its implementation.
OcrProfileIdentity = OcrProfileSpec

WINDOWSML_MODEL_NAME = "pp-ocrv6-medium-windowsml"
WINDOWSML_REQUIRED_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocrv6_dict.txt",
    "pipeline.json",
)
WHISPER_REQUIRED_FILES = (
    "config.json",
    "model.bin",
    "tokenizer.json",
)
LOAD_LIBRARY_SEARCH_SYSTEM32 = 0x00000800


def _windows_cuda_device_count() -> int | None:
    if sys.platform != "win32":
        return None
    try:
        driver = ctypes.WinDLL("nvcuda.dll", winmode=LOAD_LIBRARY_SEARCH_SYSTEM32)
        driver.cuInit.argtypes = [ctypes.c_uint]
        driver.cuInit.restype = ctypes.c_int
        if driver.cuInit(0) != 0:
            return 0
        count = ctypes.c_int()
        driver.cuDeviceGetCount.argtypes = [ctypes.POINTER(ctypes.c_int)]
        driver.cuDeviceGetCount.restype = ctypes.c_int
        if driver.cuDeviceGetCount(ctypes.byref(count)) != 0:
            return 0
        return max(0, count.value)
    except (AttributeError, OSError):
        return 0


class _WhisperModelLoadError(RuntimeError):
    """Marks a CPU model-constructor failure for a bounded compatibility retry."""


@dataclass(frozen=True, slots=True)
class EngineProbe:
    ready: bool
    code_ready: bool
    assets_ready: bool
    detail: str
    code_detail: str | None = None
    assets_detail: str | None = None


@dataclass(frozen=True, slots=True)
class OcrTextResult:
    text: str
    device: str
    model: str
    digest: str
    warning: str | None = None
    regions: tuple[OcrRegion, ...] = ()
    raster_width: int | None = None
    raster_height: int | None = None
    raster_scale: float = 1
    region_confidences: tuple[float, ...] = ()
    profile_id: str | None = None
    profile_spec_sha256: str | None = None
    provenance: OcrProvenanceV3 | None = None
    # Private and ephemeral.  It is intentionally not projected into any
    # public OCR contract or persisted capture model.
    execution_proof: OcrExecutionDeviceProofV1 | None = None


@dataclass(frozen=True, slots=True)
class OcrRegion:
    text: str
    confidence: float | None = None
    polygon: tuple[tuple[float, float], ...] = ()

    @property
    def box(self) -> tuple[int, int, int, int] | None:
        """Return a compatibility bounding rectangle without replacing polygon."""

        if not self.polygon:
            return None
        left = math.floor(min(point[0] for point in self.polygon))
        top = math.floor(min(point[1] for point in self.polygon))
        right = math.ceil(max(point[0] for point in self.polygon))
        bottom = math.ceil(max(point[1] for point in self.polygon))
        return left, top, max(1, right - left), max(1, bottom - top)


@dataclass(frozen=True, slots=True)
class PaddleNormalizedResult:
    """One atomically normalized Paddle result sequence."""

    text: str
    regions: tuple[OcrRegion, ...]


class PaddleResultNormalizationError(EngineRuntimeUnavailableError):
    """A Paddle result violated the runtime's strict OCR result contract."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"Paddle OCR result normalization failed: {reason}")


@dataclass(frozen=True, slots=True)
class OcrExecutionEvidence:
    """Provider assignment observed from an ONNX Runtime execution profile.

    The configured provider list is only a request.  DML provenance is
    resolved from this evidence after the first prediction, so a session that
    silently assigned every node to CPU cannot be labelled as DML.
    """

    dml_node_count: int
    cpu_node_count: int
    source: str = "ort-profile"
    session_device_proofs: tuple[OcrSessionDeviceProof, ...] = ()

    def __post_init__(self) -> None:
        for name in ("dml_node_count", "cpu_node_count"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if not self.source.strip():
            raise ValueError("execution evidence source must be non-empty")
        if self.session_device_proofs:
            if tuple(item.session_index for item in self.session_device_proofs) != tuple(
                range(len(self.session_device_proofs))
            ):
                raise ValueError("execution evidence session order is invalid")
            if (
                sum(item.dml_node_count for item in self.session_device_proofs)
                != self.dml_node_count
            ):
                raise ValueError("execution evidence DML count does not match sessions")
            if (
                sum(item.cpu_node_count for item in self.session_device_proofs)
                != self.cpu_node_count
            ):
                raise ValueError("execution evidence CPU count does not match sessions")


@dataclass(frozen=True, slots=True)
class OcrSessionDeviceProof:
    """Provider/node evidence tied to one returned ORT session.

    ``dml_device_id`` is the optional provider-options readback.  A value of
    ``None`` means that ORT did not expose that readback; the configured
    adapter identity remains bound by the retained execution plan and native
    map construction proof.
    """

    session_index: int
    providers: tuple[str, ...]
    dml_device_id: int | None
    fallback_disabled: bool
    dml_node_count: int
    evidence_source: str
    cpu_node_count: int = 0

    def __post_init__(self) -> None:
        if (
            isinstance(self.session_index, bool)
            or not isinstance(self.session_index, int)
            or self.session_index < 0
        ):
            raise ValueError("session index must be a non-negative integer")
        if not isinstance(self.providers, tuple) or self.providers != (
            "DmlExecutionProvider",
            "CPUExecutionProvider",
        ):
            raise ValueError("session provider order is invalid")
        if self.dml_device_id is not None and (
            isinstance(self.dml_device_id, bool)
            or not isinstance(self.dml_device_id, int)
            or self.dml_device_id < 0
        ):
            raise ValueError("session DML device id is invalid")
        if not isinstance(self.fallback_disabled, bool) or not self.fallback_disabled:
            raise ValueError("session fallback must be disabled")
        if (
            isinstance(self.dml_node_count, bool)
            or not isinstance(self.dml_node_count, int)
            or self.dml_node_count < 1
        ):
            raise ValueError("session DML node count must be positive")
        if (
            isinstance(self.cpu_node_count, bool)
            or not isinstance(self.cpu_node_count, int)
            or self.cpu_node_count < 0
        ):
            raise ValueError("session CPU node count must be non-negative")
        if not isinstance(self.evidence_source, str) or not self.evidence_source.strip():
            raise ValueError("session evidence source must be non-empty")


@dataclass(frozen=True, slots=True)
class OcrExecutionEvidenceFailure:
    """Sanitized failure collected while closing one ORT profile session."""

    code: str
    session_index: int | None = None


class OcrExecutionEvidenceError(EngineRuntimeUnavailableError):
    """Aggregate fail-closed result for ORT evidence or profile cleanup."""

    def __init__(
        self,
        failures: Iterable[OcrExecutionEvidenceFailure],
        *,
        cleanup_verified: bool,
    ) -> None:
        self.failures = tuple(failures)
        self.cleanup_failures = self.failures
        self.cleanup_verified = cleanup_verified
        self.profile_paths_absent = cleanup_verified
        message_labels = [
            "profile does not belong" if failure.code == "profile_path_foreign" else failure.code
            for failure in self.failures
        ]
        labels = ",".join(
            label
            + (f"@session-{failure.session_index + 1}" if failure.session_index is not None else "")
            for label, failure in zip(message_labels, self.failures, strict=True)
        )
        cleanup = "verified" if cleanup_verified else "unverified"
        super().__init__(
            "DML execution evidence failed; "
            f"failures={labels or 'unknown'}; profile cleanup={cleanup}."
        )


class OcrInferenceCleanupError(EngineRuntimeUnavailableError):
    """A primary OCR failure whose owned-profile cleanup also failed.

    The public message contains only stable failure codes.  The original
    inference exception remains the Python cause, while cleanup evidence is
    available as typed fields for the owning adapter and tests.
    """

    def __init__(
        self,
        *,
        primary_code: str,
        cleanup_error: OcrExecutionEvidenceError,
    ) -> None:
        self.primary_code = primary_code
        self.cleanup_failures = cleanup_error.failures
        self.cleanup_verified = cleanup_error.cleanup_verified
        self.profile_paths_absent = cleanup_error.profile_paths_absent
        cleanup_codes = ",".join(dict.fromkeys(item.code for item in self.cleanup_failures))
        super().__init__(
            f"{primary_code}; OCR profile cleanup failed "
            f"(codes={cleanup_codes or 'unknown'}; "
            f"residue={'absent' if self.cleanup_verified else 'present-or-unknown'})."
        )


class OcrExecutionEvidenceAdapter(Protocol):
    """Internal seam for provider preparation and post-prediction execution proof."""

    def prepare(self, pipeline: Any, *, expected_device_id: int | None = None) -> None: ...

    def finalize(self, pipeline: Any) -> OcrExecutionEvidence: ...

    def abort(self, pipeline: Any | None = None) -> None: ...


def _load_ocr_profile_identity(model_dir: Path) -> OcrProfileSpec:
    profile = load_profile_spec(model_dir / "pipeline.json")
    validate_model_artifacts(model_dir, profile)
    return profile


load_ocr_profile_identity = _load_ocr_profile_identity


@dataclass(frozen=True, slots=True)
class WhisperTextSegment:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class WhisperTranscriptionResult:
    segments: tuple[WhisperTextSegment, ...]
    duration_ms: int
    device: str
    model: str
    digest: str
    warning: str | None = None


class OcrAdapter(Protocol):
    def probe(self) -> EngineProbe: ...

    def extract_png(self, image_png: bytes) -> OcrTextResult: ...


class WhisperAdapter(Protocol):
    def probe(self) -> EngineProbe: ...

    def transcribe(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool = False,
    ) -> WhisperTranscriptionResult: ...


def _directory_digest(root: Path, relative_files: Iterable[str] | None = None) -> str:
    digest = hashlib.sha256()
    paths = (
        [root / relative for relative in relative_files]
        if relative_files is not None
        else sorted(path for path in root.rglob("*") if path.is_file())
    )
    for path in paths:
        if not path.is_file():
            raise FileNotFoundError(path)
        digest.update(path.relative_to(root).as_posix().encode("utf-8"))
        digest.update(b"\0")
        with path.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


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


def _paddle_results_sequence(results: Any) -> list[Any]:
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
    for result in _paddle_results_sequence(results):
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
            text = raw_text.strip()
            if not text:
                _paddle_fail("rec_texts values must be non-empty")
            polygon = _paddle_polygon(polygon_values[index])
            _validate_paddle_polygon(polygon, raster_width, raster_height)
            regions.append(
                OcrRegion(
                    text=text,
                    confidence=normalized_scores[index],
                    polygon=polygon,
                )
            )
    return PaddleNormalizedResult(
        text="\n".join(region.text for region in regions),
        regions=tuple(regions),
    )


def _paddle_texts(results: Any) -> list[str]:
    normalized = normalize_paddle_results(results, raster_width=None, raster_height=None)
    return [region.text for region in normalized.regions]


def _paddle_regions(
    results: Any,
    *,
    raster_width: int | None,
    raster_height: int | None,
) -> list[OcrRegion]:
    """Compatibility wrapper around the canonical Paddle normalizer."""

    return list(
        normalize_paddle_results(
            results,
            raster_width=raster_width,
            raster_height=raster_height,
        ).regions
    )


def _bound_box(
    box: tuple[int, int, int, int] | None,
    raster_width: int | None,
    raster_height: int | None,
) -> tuple[int, int, int, int] | None:
    if box is None or raster_width is None or raster_height is None:
        return box
    x, y, width, height = box
    x = min(max(0, x), max(0, raster_width - 1))
    y = min(max(0, y), max(0, raster_height - 1))
    right = min(raster_width, max(x + 1, x + width))
    bottom = min(raster_height, max(y + 1, y + height))
    return x, y, max(1, right - x), max(1, bottom - y)


def _png_dimensions(image_png: bytes) -> tuple[int, int] | tuple[None, None]:
    try:
        from PIL import Image

        with Image.open(BytesIO(image_png)) as image:
            width, height = image.size
            if width > 0 and height > 0:
                return width, height
    except Exception:
        pass
    return None, None


def _paddle_onnx_sessions(pipeline: Any) -> tuple[Any, ...]:
    """Find the ONNX sessions owned by the Paddle OCR pipeline.

    PaddleOCR's public wrapper intentionally does not expose provider
    assignment.  Its PaddleX pipeline does, however, retain one runner for
    each OCR model.  Keeping this traversal here gives the runtime one
    narrowly-scoped internal adapter instead of spreading PaddleX knowledge
    into the worker and projection modules.
    """

    roots = [pipeline]
    visited_roots: set[int] = set()
    sessions: list[Any] = []
    visited_sessions: set[int] = set()
    while roots:
        root = roots.pop()
        if root is None or id(root) in visited_roots:
            continue
        visited_roots.add(id(root))
        nested = getattr(root, "paddlex_pipeline", None)
        if nested is not None:
            roots.append(nested)
        for child_name in ("doc_preprocessor_pipeline",):
            child = getattr(root, child_name, None)
            if child is not None:
                roots.append(child)
        for model_name in (
            "text_det_model",
            "text_rec_model",
            "textline_orientation_model",
        ):
            model = getattr(root, model_name, None)
            runner = getattr(model, "runner", None)
            session = getattr(runner, "session", None)
            if session is not None and id(session) not in visited_sessions:
                visited_sessions.add(id(session))
                sessions.append(session)
    return tuple(sessions)


_ALLOWED_ORT_NODE_PROVIDERS = frozenset(
    {
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    }
)


class _UnknownExecutionProviderError(EngineRuntimeUnavailableError):
    """A provider name outside the canonical ORT execution policy."""

    def __init__(self) -> None:
        super().__init__("OCR execution evidence has an unknown provider.")


def _provider_node_counts(provider: object) -> tuple[int, int]:
    """Return one node count for an exact, allowlisted provider name."""

    if type(provider) is not str or provider not in _ALLOWED_ORT_NODE_PROVIDERS:
        raise _UnknownExecutionProviderError()
    if provider == "DmlExecutionProvider":
        return 1, 0
    return 0, 1


def _profile_node_counts(value: object) -> tuple[int, int]:
    if not isinstance(value, list):
        raise EngineRuntimeUnavailableError("OCR execution profile has an invalid shape.")
    dml_nodes = 0
    cpu_nodes = 0
    for event in value:
        if not isinstance(event, dict):
            raise EngineRuntimeUnavailableError("OCR execution profile has an invalid event.")
        if event.get("cat") != "Node":
            continue
        args = event.get("args")
        if not isinstance(args, dict):
            raise EngineRuntimeUnavailableError("OCR execution profile has an invalid node event.")
        provider = args.get("provider")
        dml_count, cpu_count = _provider_node_counts(provider)
        dml_nodes += dml_count
        cpu_nodes += cpu_count
    return dml_nodes, cpu_nodes


class _PaddleOcrExecutionEvidenceAdapter:
    """Disable ORT fallback and prove provider assignment after prediction.

    PaddleX does not expose a stable graph-assignment API in every supported
    ONNX Runtime build. The graph API is preferred when available on every
    OCR session and its recording option is enabled; otherwise the session
    profile is read only after prediction. Preparation intentionally never
    returns resolved evidence because provider configuration is not execution
    proof.
    """

    def __init__(
        self,
        profile_file_prefix: Path,
        *,
        stage_reporter: Callable[[str], None] | None = None,
    ) -> None:
        self._profile_file_prefix = profile_file_prefix
        self._stage_reporter = stage_reporter
        self._sessions: tuple[Any, ...] = ()
        self._cleanup_sessions: tuple[Any, ...] = ()
        self._profile_aliases: set[Path] = set()
        self._lifecycle = "idle"
        self._expected_device_id: int | None = None
        self._session_device_ids: tuple[int | None, ...] = ()
        self._session_proofs: tuple[OcrSessionDeviceProof, ...] = ()

    def _report_stage(self, stage: str) -> None:
        if self._stage_reporter is not None:
            self._stage_reporter(stage)

    def prepare(self, pipeline: Any, *, expected_device_id: int | None = None) -> None:
        sessions = _paddle_onnx_sessions(pipeline)
        self._sessions = sessions
        self._cleanup_sessions = ()
        self._expected_device_id = expected_device_id
        self._session_device_ids = ()
        self._session_proofs = ()
        self._lifecycle = "prepared"
        if not sessions:
            raise EngineRuntimeUnavailableError(
                "DML execution evidence is unavailable: PaddleOCR created no ONNX sessions."
            )
        session_device_ids: list[int | None] = []
        for session in sessions:
            get_providers = getattr(session, "get_providers", None)
            if not callable(get_providers):
                raise EngineRuntimeUnavailableError(
                    "DML provider identity is unavailable: ONNX Runtime session "
                    "does not expose get_providers()."
                )
            try:
                providers = tuple(get_providers())
            except Exception as error:
                raise EngineRuntimeUnavailableError(
                    "DML provider identity could not be read from ONNX Runtime."
                ) from error
            expected = ("DmlExecutionProvider", "CPUExecutionProvider")
            if providers != expected:
                raise EngineRuntimeUnavailableError(
                    "DML provider identity mismatch: expected one DML-first session "
                    f"with providers {list(expected)!r}, observed {list(providers)!r}."
                )
            if expected_device_id is not None:
                get_options = getattr(session, "get_provider_options", None)
                if not callable(get_options):
                    self._report_stage("ocr-dml-device-id-unobservable")
                    session_device_ids.append(None)
                else:
                    try:
                        options = get_options()
                    except Exception:
                        # Some supported ORT builds expose the method but do
                        # not expose provider options.  Execution proof still
                        # comes from the post-predict profile, never this
                        # optional readback.
                        self._report_stage("ocr-dml-device-id-unobservable")
                        session_device_ids.append(None)
                    else:
                        if not isinstance(options, Mapping):
                            raise EngineRuntimeUnavailableError(
                                "DML provider options have an invalid shape."
                            )
                        if "DmlExecutionProvider" not in options:
                            self._report_stage("ocr-dml-device-id-unobservable")
                            session_device_ids.append(None)
                        else:
                            dml_options = options["DmlExecutionProvider"]
                            if not isinstance(dml_options, Mapping):
                                raise EngineRuntimeUnavailableError(
                                    "DML provider options have an invalid shape."
                                )
                            if "device_id" not in dml_options:
                                self._report_stage("ocr-dml-device-id-unobservable")
                                session_device_ids.append(None)
                            else:
                                reported = dml_options["device_id"]
                                if isinstance(reported, bool):
                                    self._report_stage("ocr-dml-device-id-mismatch")
                                    raise EngineRuntimeUnavailableError(
                                        "DML session device_id is invalid"
                                    )
                                if isinstance(reported, int):
                                    canonical_id = reported
                                elif isinstance(reported, str) and re.fullmatch(
                                    r"(?:0|[1-9][0-9]*)", reported
                                ):
                                    canonical_id = int(reported)
                                else:
                                    self._report_stage("ocr-dml-device-id-mismatch")
                                    raise EngineRuntimeUnavailableError(
                                        "DML session device_id is invalid"
                                    )
                                if canonical_id != expected_device_id:
                                    self._report_stage("ocr-dml-device-id-mismatch")
                                    raise EngineRuntimeUnavailableError(
                                        "DML session device_id does not match the retained OCR plan"
                                    )
                                session_device_ids.append(canonical_id)
            else:
                session_device_ids.append(None)
            disable_fallback = getattr(session, "disable_fallback", None)
            if not callable(disable_fallback):
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence is unavailable: ONNX Runtime fallback "
                    "cannot be disabled."
                )
            self._cleanup_sessions += (session,)
            # Register ownership before invoking the mutating ORT call.  A
            # provider can throw after partially enabling profiling; retaining
            # it here lets abort() close and prove that session as well.
            try:
                disabled = disable_fallback()
            except Exception as error:
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence could not disable ONNX Runtime fallback."
                ) from error
            if disabled is False:
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence could not disable ONNX Runtime fallback."
                )
        self._session_device_ids = tuple(session_device_ids)
        return None

    def finalize(self, pipeline: Any) -> OcrExecutionEvidence:
        """Read provider evidence after the pipeline has run inference."""

        sessions = self._sessions or _paddle_onnx_sessions(pipeline)
        if not sessions:
            raise EngineRuntimeUnavailableError(
                "DML execution evidence is unavailable: PaddleOCR created no ONNX sessions."
            )
        if all(
            callable(getattr(session, "get_provider_graph_assignment_info", None))
            for session in sessions
        ):
            assignments: list[Any] = []
            session_proofs: list[OcrSessionDeviceProof] = []
            graph_evidence_unavailable = False
            assignment_error: _UnknownExecutionProviderError | None = None
            try:
                for session_index, session in enumerate(sessions):
                    get_assignments = session.get_provider_graph_assignment_info
                    try:
                        session_assignments = get_assignments()
                    except Exception as error:
                        if _is_ort_graph_assignment_unavailable(error):
                            # PaddleX 3.7 cannot set ORT's internal graph
                            # assignment recording option through its public
                            # engine_config.  In that supported case, use the
                            # already-configured execution profile.  This is
                            # deliberately a selection fallback only: the
                            # profile parser remains the same fail-closed
                            # evidence path and no profile is trusted before
                            # prediction has completed.
                            graph_evidence_unavailable = True
                            evidence = self._profile_evidence(sessions)
                            self._mark_finalized()
                            return evidence
                        raise EngineRuntimeUnavailableError(
                            "DML execution evidence could not be read from ONNX Runtime."
                        ) from error
                    if not isinstance(session_assignments, list):
                        raise EngineRuntimeUnavailableError(
                            "DML execution evidence has an invalid ONNX Runtime graph assignment."
                        )
                    assignments.extend(session_assignments)
                    try:
                        session_evidence = _assignment_evidence(session_assignments)
                    except _UnknownExecutionProviderError as error:
                        assignment_error = error
                        continue
                    if self._expected_device_id is not None:
                        if session_evidence.dml_node_count < 1:
                            raise EngineRuntimeUnavailableError(
                                "DML execution evidence contained zero assigned DML nodes."
                            )
                        session_proofs.append(
                            OcrSessionDeviceProof(
                                session_index=session_index,
                                providers=(
                                    "DmlExecutionProvider",
                                    "CPUExecutionProvider",
                                ),
                                dml_device_id=(
                                    self._session_device_ids[session_index]
                                    if session_index < len(self._session_device_ids)
                                    else None
                                ),
                                fallback_disabled=True,
                                dml_node_count=session_evidence.dml_node_count,
                                evidence_source=session_evidence.source,
                                cpu_node_count=session_evidence.cpu_node_count,
                            )
                        )
                try:
                    evidence = _assignment_evidence(assignments)
                except _UnknownExecutionProviderError as error:
                    assignment_error = error
            finally:
                if not graph_evidence_unavailable:
                    try:
                        self._cleanup_profiles(sessions)
                    except OcrExecutionEvidenceError as cleanup_error:
                        if assignment_error is None:
                            raise
                        raise OcrExecutionEvidenceError(
                            [
                                OcrExecutionEvidenceFailure("graph_unknown_provider"),
                                *cleanup_error.failures,
                            ],
                            cleanup_verified=cleanup_error.cleanup_verified,
                        ) from assignment_error
            if assignment_error is not None:
                self._mark_finalized()
                raise OcrExecutionEvidenceError(
                    [OcrExecutionEvidenceFailure("graph_unknown_provider")],
                    cleanup_verified=True,
                ) from assignment_error
            self._mark_finalized()
            if session_proofs:
                evidence = OcrExecutionEvidence(
                    dml_node_count=evidence.dml_node_count,
                    cpu_node_count=evidence.cpu_node_count,
                    source=evidence.source,
                    session_device_proofs=tuple(session_proofs),
                )
            return evidence

        evidence = self._profile_evidence(sessions)
        self._mark_finalized()
        return evidence

    def abort(self, pipeline: Any | None = None) -> None:
        """Close all prepared sessions and prove owned profiles are absent.

        Aborting intentionally does not parse profile contents: inference did
        not complete, so no provider evidence is accepted.  It still ends all
        known sessions, discovers stale files for this prefix, deletes each
        owned file, and requires a successful absence probe.  A failure leaves
        the session set retained so the caller can retry idempotently.
        """

        if self._lifecycle in {"aborted", "finalized"} and not self._sessions:
            return None
        sessions = self._cleanup_sessions
        if not sessions and pipeline is not None:
            try:
                sessions = _paddle_onnx_sessions(pipeline)
            except Exception as error:
                raise OcrExecutionEvidenceError(
                    [OcrExecutionEvidenceFailure("profile_session_discovery_failed")],
                    cleanup_verified=False,
                ) from error
        self._cleanup_profiles(sessions, read_profiles=False)
        self._sessions = ()
        self._cleanup_sessions = ()
        self._lifecycle = "aborted"
        return None

    def _mark_finalized(self) -> None:
        self._sessions = ()
        self._cleanup_sessions = ()
        self._lifecycle = "finalized"
        self._session_proofs = ()

    def _cleanup_profiles(
        self,
        sessions: tuple[Any, ...],
        *,
        read_profiles: bool = True,
    ) -> None:
        """Close every ORT profile and prove that this adapter left no residue."""

        session_paths, failures = self._end_profiles(sessions)
        profile_paths, path_failures, path_sessions = self._unique_profile_paths(session_paths)
        failures.extend(path_failures)
        alias_keys = self._append_profile_aliases(profile_paths)
        discovered_paths, discovery_failures = self._discover_owned_profiles()
        failures.extend(discovery_failures)
        for profile_path in discovered_paths:
            key = self._profile_key(profile_path)
            if key is not None and key not in {self._profile_key(path) for path in profile_paths}:
                profile_paths.append(profile_path)
                if key in alias_keys:
                    continue
        if read_profiles:
            for profile_path in profile_paths:
                profile_key = self._profile_key(profile_path)
                if profile_key in alias_keys:
                    continue
                self._read_profile(
                    profile_path,
                    failures,
                    path_sessions.get(profile_key) if profile_key is not None else None,
                )
        self._delete_profiles(profile_paths, failures)
        cleanup_verified = self._prove_profiles_absent(failures)
        if failures:
            raise OcrExecutionEvidenceError(
                failures,
                cleanup_verified=cleanup_verified,
            )
        self._profile_aliases.clear()

    def _profile_evidence(self, sessions: tuple[Any, ...]) -> OcrExecutionEvidence:
        """Read and clean all sessions, collecting failures before failing closed."""

        session_paths, failures = self._end_profiles(sessions)
        profile_paths, path_failures, path_sessions = self._unique_profile_paths(session_paths)
        failures.extend(path_failures)
        alias_keys = self._append_profile_aliases(profile_paths)
        discovered_paths, discovery_failures = self._discover_owned_profiles()
        failures.extend(discovery_failures)
        known_keys = {
            key for key in (self._profile_key(path) for path in profile_paths) if key is not None
        }
        for profile_path in discovered_paths:
            key = self._profile_key(profile_path)
            if key is not None and key not in known_keys:
                profile_paths.append(profile_path)
                known_keys.add(key)

        dml_nodes = 0
        cpu_nodes = 0
        session_counts: dict[int, tuple[int, int]] = {}
        for profile_path in profile_paths:
            profile_key = self._profile_key(profile_path)
            if profile_key in alias_keys:
                continue
            session_index = path_sessions.get(profile_key) if profile_key is not None else None
            profile_counts = self._read_profile(profile_path, failures, session_index)
            if profile_counts is not None:
                session_dml_nodes, session_cpu_nodes = profile_counts
                dml_nodes += session_dml_nodes
                cpu_nodes += session_cpu_nodes
                if session_index is not None:
                    session_counts[session_index] = (session_dml_nodes, session_cpu_nodes)

        self._delete_profiles(profile_paths, failures)
        cleanup_verified = self._prove_profiles_absent(failures)
        if failures:
            raise OcrExecutionEvidenceError(
                failures,
                cleanup_verified=cleanup_verified,
            )
        self._profile_aliases.clear()
        if self._expected_device_id is not None:
            if set(session_counts) != set(range(len(sessions))) or any(
                counts[0] < 1 for counts in session_counts.values()
            ):
                raise EngineRuntimeUnavailableError(
                    "DML execution evidence is not associated with every OCR session."
                )
            session_proofs = tuple(
                OcrSessionDeviceProof(
                    session_index=index,
                    providers=("DmlExecutionProvider", "CPUExecutionProvider"),
                    dml_device_id=(
                        self._session_device_ids[index]
                        if index < len(self._session_device_ids)
                        else None
                    ),
                    fallback_disabled=True,
                    dml_node_count=session_counts[index][0],
                    evidence_source="ort-profile",
                    cpu_node_count=session_counts[index][1],
                )
                for index in range(len(sessions))
            )
        else:
            session_proofs = ()
        return OcrExecutionEvidence(
            dml_node_count=dml_nodes,
            cpu_node_count=cpu_nodes,
            session_device_proofs=session_proofs,
        )

    def _end_profiles(
        self,
        sessions: tuple[Any, ...],
    ) -> tuple[list[tuple[int, Path | None]], list[OcrExecutionEvidenceFailure]]:
        """Call ``end_profiling`` for every session, even after one raises."""

        paths: list[tuple[int, Path | None]] = []
        failures: list[OcrExecutionEvidenceFailure] = []
        relocated_sources: set[str] = set()
        source_fingerprints: dict[str, tuple[int, int, str | None]] = {}
        for session_index, session in enumerate(sessions):
            try:
                end_profiling = getattr(session, "end_profiling", None)
            except Exception:
                failures.append(
                    OcrExecutionEvidenceFailure("profile_end_unavailable", session_index)
                )
                paths.append((session_index, None))
                continue
            if not callable(end_profiling):
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_end_unavailable",
                        session_index,
                    )
                )
                paths.append((session_index, None))
                continue
            try:
                profile_path_value = end_profiling()
            except Exception:
                failures.append(OcrExecutionEvidenceFailure("profile_end_failed", session_index))
                paths.append((session_index, None))
                continue
            if not isinstance(profile_path_value, str) or not profile_path_value:
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_invalid",
                        session_index,
                    )
                )
                paths.append((session_index, None))
                continue
            profile_path = Path(profile_path_value)
            if not self._owns_profile(profile_path):
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_foreign",
                        session_index,
                    )
                )
                paths.append((session_index, None))
                continue
            profile_key = self._profile_key(profile_path)
            if profile_key is not None and self._is_ort_timestamp_profile(profile_path):
                relocated_path, relocation_failure = self._relocate_ort_profile(
                    profile_path,
                    session_index,
                    source_key=profile_key,
                    relocated_sources=relocated_sources,
                    source_fingerprints=source_fingerprints,
                )
                if relocation_failure is not None:
                    failures.append(OcrExecutionEvidenceFailure(relocation_failure, session_index))
                if relocated_path is None:
                    paths.append((session_index, None))
                    continue
                profile_path = relocated_path
            paths.append((session_index, profile_path))
        return paths, failures

    def _is_ort_timestamp_profile(self, profile_path: Path) -> bool:
        """Recognize ORT's second-resolution profile filename, not arbitrary paths.

        PaddleX passes one profile prefix to every OCR session.  ORT appends a
        timestamp to that prefix, so two sessions ending within one second can
        return the same path.  Restricting this normalization to ORT's known
        filename shape preserves the generic duplicate-path fail-closed rule.
        """

        prefix = self._profile_file_prefix.name + "_"
        if not profile_path.name.casefold().startswith(prefix.casefold()):
            return False
        suffix = profile_path.name[len(prefix) :]
        if not suffix.casefold().endswith(".json"):
            return False
        timestamp = suffix[:-5]
        return (
            re.fullmatch(
                r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:_\d+)?",
                timestamp,
            )
            is not None
        )

    def _relocate_ort_profile(
        self,
        profile_path: Path,
        session_index: int,
        *,
        source_key: str,
        relocated_sources: set[str],
        source_fingerprints: dict[str, tuple[int, int, str | None]],
    ) -> tuple[Path | None, str | None]:
        """Give each timestamped ORT profile a unique owned path before the next session ends."""

        profile_state = self._wait_for_profile(profile_path)
        if profile_state is False:
            # A prior session may have returned this same timestamped path and
            # already moved it.  A missing second file is therefore a duplicate
            # result, not an empty successful profile.
            if source_key in relocated_sources:
                return None, "profile_path_duplicate"
            return profile_path, "profile_path_relocate_failed"
        if profile_state is None:
            return profile_path, "profile_path_relocate_failed"
        current_fingerprint = self._profile_fingerprint(profile_path)
        previous_fingerprint = source_fingerprints.get(source_key)
        if previous_fingerprint is not None:
            if current_fingerprint is None or current_fingerprint == previous_fingerprint:
                return None, "profile_path_duplicate"

        destination = self._profile_file_prefix.parent / (
            f"{self._profile_file_prefix.name}_session-{session_index + 1}.json"
        )
        try:
            destination.lstat()
        except FileNotFoundError:
            pass
        except (OSError, RuntimeError, ValueError):
            return profile_path, "profile_path_relocate_failed"
        else:
            return profile_path, "profile_path_relocate_failed"
        deadline = time.monotonic() + 1.0
        renamed = False
        while True:
            try:
                profile_path.rename(destination)
                renamed = True
                break
            except FileNotFoundError:
                if source_key in relocated_sources:
                    return None, "profile_path_duplicate"
                return profile_path, "profile_path_relocate_failed"
            except (OSError, RuntimeError, ValueError):
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.01)
        if renamed:
            relocated_sources.add(source_key)
            return destination, None

        # Windows may keep ORT's profile handle open after it returns the
        # path.  A same-volume copy preserves the first session's bytes while
        # the original path remains an alias to delete after all sessions end.
        try:
            destination.lstat()
        except FileNotFoundError:
            pass
        except (OSError, RuntimeError, ValueError):
            return profile_path, "profile_path_relocate_failed"
        else:
            return profile_path, "profile_path_relocate_failed"
        try:
            shutil.copyfile(profile_path, destination)
        except (OSError, RuntimeError, ValueError):
            return profile_path, "profile_path_relocate_failed"
        fingerprint = self._profile_fingerprint(destination)
        if fingerprint is None:
            return profile_path, "profile_path_relocate_failed"
        self._profile_aliases.add(profile_path)
        source_fingerprints[source_key] = fingerprint
        relocated_sources.add(source_key)
        return destination, None

    def _append_profile_aliases(self, profile_paths: list[Path]) -> set[str]:
        """Include copied source paths for deletion without counting them twice."""

        alias_keys: set[str] = set()
        known_keys = {
            key for key in (self._profile_key(path) for path in profile_paths) if key is not None
        }
        for alias in self._profile_aliases:
            if not self._owns_profile(alias):
                continue
            key = self._profile_key(alias)
            if key is None:
                continue
            alias_keys.add(key)
            if key not in known_keys:
                profile_paths.append(alias)
                known_keys.add(key)
        return alias_keys

    @staticmethod
    def _profile_fingerprint(profile_path: Path) -> tuple[int, int, str | None] | None:
        try:
            profile_stat = profile_path.stat()
        except (OSError, RuntimeError, ValueError):
            return None
        digest: str | None
        try:
            digest = hashlib.sha256(profile_path.read_bytes()).hexdigest()
        except (OSError, RuntimeError, ValueError):
            digest = None
        return profile_stat.st_size, profile_stat.st_mtime_ns, digest

    @staticmethod
    def _wait_for_profile(profile_path: Path) -> bool | None:
        """Allow ORT's end-profiling writer to publish its returned path."""

        deadline = time.monotonic() + 1.0
        while True:
            try:
                profile_path.lstat()
                return True
            except FileNotFoundError:
                if time.monotonic() >= deadline:
                    return False
                time.sleep(0.01)
            except (OSError, RuntimeError, ValueError):
                return None

    def _unique_profile_paths(
        self,
        session_paths: list[tuple[int, Path | None]],
    ) -> tuple[
        list[Path],
        list[OcrExecutionEvidenceFailure],
        dict[str, int],
    ]:
        profile_paths: list[Path] = []
        failures: list[OcrExecutionEvidenceFailure] = []
        path_sessions: dict[str, int] = {}
        for session_index, profile_path in session_paths:
            if profile_path is None:
                continue
            key = self._profile_key(profile_path)
            if key is None:
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_unresolvable",
                        session_index,
                    )
                )
                continue
            if key in path_sessions:
                failures.append(
                    OcrExecutionEvidenceFailure(
                        "profile_path_duplicate",
                        session_index,
                    )
                )
                continue
            path_sessions[key] = session_index
            profile_paths.append(profile_path)
        return profile_paths, failures, path_sessions

    def _discover_owned_profiles(
        self,
    ) -> tuple[list[Path], list[OcrExecutionEvidenceFailure]]:
        """Find profiles left behind by a session whose end call failed."""

        try:
            candidates = tuple(self._profile_file_prefix.parent.iterdir())
        except FileNotFoundError:
            return [], []
        except OSError:
            return [], [OcrExecutionEvidenceFailure("profile_discovery_failed")]
        except Exception:
            return [], [OcrExecutionEvidenceFailure("profile_discovery_failed")]
        profile_prefix = (self._profile_file_prefix.name + "_").casefold()
        return [
            path
            for path in candidates
            if path.name.casefold().startswith(profile_prefix) and self._owns_profile(path)
        ], []

    def _read_profile(
        self,
        profile_path: Path,
        failures: list[OcrExecutionEvidenceFailure],
        session_index: int | None,
    ) -> tuple[int, int] | None:
        try:
            profile_stat = profile_path.lstat()
        except FileNotFoundError:
            failures.append(OcrExecutionEvidenceFailure("profile_missing", session_index))
            return None
        except OSError:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown", session_index))
            return None
        except Exception:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown", session_index))
            return None
        if stat.S_ISLNK(profile_stat.st_mode) or not stat.S_ISREG(profile_stat.st_mode):
            failures.append(OcrExecutionEvidenceFailure("profile_invalid", session_index))
            return None
        try:
            profile_text = profile_path.read_text(encoding="utf-8")
        except Exception:
            failures.append(OcrExecutionEvidenceFailure("profile_read_failed", session_index))
            return None
        try:
            profile = json.loads(profile_text)
            return _profile_node_counts(profile)
        except _UnknownExecutionProviderError:
            failures.append(OcrExecutionEvidenceFailure("profile_unknown_provider", session_index))
            return None
        except (json.JSONDecodeError, EngineRuntimeUnavailableError, TypeError, ValueError):
            failures.append(OcrExecutionEvidenceFailure("profile_invalid", session_index))
            return None

    def _delete_profiles(
        self,
        profile_paths: list[Path],
        failures: list[OcrExecutionEvidenceFailure],
    ) -> None:
        """Attempt deletion for every path; an earlier deletion error is not terminal."""

        for profile_path in profile_paths:
            try:
                profile_path.unlink()
            except FileNotFoundError:
                pass
            except Exception:
                failures.append(OcrExecutionEvidenceFailure("profile_delete_failed"))

    def _prove_profiles_absent(
        self,
        failures: list[OcrExecutionEvidenceFailure],
    ) -> bool:
        """Prove every owned profile prefix is absent; unknown stat is failure."""

        try:
            candidates = tuple(self._profile_file_prefix.parent.iterdir())
        except FileNotFoundError:
            return True
        except OSError:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
            return False
        except Exception:
            failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
            return False
        residue = False
        profile_prefix = (self._profile_file_prefix.name + "_").casefold()
        for path in candidates:
            if not path.name.casefold().startswith(profile_prefix):
                continue
            if not self._owns_profile(path):
                continue
            try:
                path.lstat()
            except FileNotFoundError:
                continue
            except OSError:
                failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
                residue = True
            except Exception:
                failures.append(OcrExecutionEvidenceFailure("profile_presence_unknown"))
                residue = True
            else:
                failures.append(OcrExecutionEvidenceFailure("profile_residue"))
                residue = True
        return not residue

    def _profile_key(self, profile_path: Path) -> str | None:
        try:
            return str(profile_path.resolve(strict=False)).casefold()
        except (OSError, RuntimeError, ValueError):
            return None

    def _owns_profile(self, profile_path: Path) -> bool:
        try:
            return (
                profile_path.name.casefold().startswith(
                    (self._profile_file_prefix.name + "_").casefold()
                )
                and profile_path.parent.resolve() == self._profile_file_prefix.parent.resolve()
            )
        except (OSError, RuntimeError, ValueError):
            return False


def _assignment_evidence(assignments: list[Any]) -> OcrExecutionEvidence:
    dml_nodes = 0
    cpu_nodes = 0
    for assignment in assignments:
        provider = getattr(assignment, "ep_name", None)
        get_nodes = getattr(assignment, "get_nodes", None)
        if not callable(get_nodes):
            raise EngineRuntimeUnavailableError(
                "DML execution evidence has an invalid ONNX Runtime graph assignment."
            )
        try:
            nodes = get_nodes()
        except Exception as error:
            raise EngineRuntimeUnavailableError(
                "DML execution evidence could not read ONNX Runtime graph nodes."
            ) from error
        if not isinstance(nodes, list):
            raise EngineRuntimeUnavailableError(
                "DML execution evidence has an invalid ONNX Runtime graph node list."
            )
        dml_count, cpu_count = _provider_node_counts(provider)
        dml_nodes += len(nodes) * dml_count
        cpu_nodes += len(nodes) * cpu_count
    return OcrExecutionEvidence(
        dml_node_count=dml_nodes,
        cpu_node_count=cpu_nodes,
        source="ort-graph-assignment",
    )


def _is_ort_graph_assignment_unavailable(error: Exception) -> bool:
    """Recognize ORT's public signal that graph assignment recording is off.

    ``InferenceSession.get_provider_graph_assignment_info`` is present in
    recent ORT builds, but it raises until the internal session option
    ``session.record_ep_graph_assignment_info`` has been enabled.  PaddleX's
    supported runner cannot set that option through ``engine_config``.  Keep
    this compatibility check narrowly keyed to ORT's documented option name;
    unrelated graph API errors must remain fail-closed.
    """

    return "session.record_ep_graph_assignment_info" in str(error)


def _default_paddle_pipeline(**kwargs: Any) -> Any:
    """Create PaddleOCR without mutating ONNX Runtime's process-global module.

    PaddleX 3.7 constructs ``InferenceSession`` internally and does not expose
    ORT's constructor fallback kwarg through ``engine_config``.  The factory
    therefore leaves the vendor modules untouched; the evidence adapter
    validates every returned session's provider identity before inference and
    fails closed if ORT returned a CPU-only retry session.
    """

    _install_offline_aistudio_stubs()
    _install_offline_huggingface_stubs()
    from paddleocr import PaddleOCR

    return PaddleOCR(**kwargs)


def _native_selected_adapter_map(
    plan: OcrExecutionPlan,
    lease: _NativeOcrAdapterMapLease,
) -> tuple[str, str]:
    """Resolve the retained plan against the map owned by one DXGI lease."""

    if plan.mode.value != "gpu-dml" or plan.dml_device_id is None:
        raise EngineRuntimeUnavailableError("retained OCR plan is not a GPU plan")
    map_digest, joined = lease.adapter_map()
    selected = next((item for item in joined if item.index == plan.dml_device_id), None)
    if selected is None or selected.luid is None:
        raise EngineRuntimeUnavailableError("retained OCR adapter ordinal is unavailable")
    return map_digest, selected.luid


class WindowsMLOcrAdapter:
    """PaddleOCR 3.7 DML-first session with no separate CPU-only retry."""

    def __init__(
        self,
        model_dir: Path,
        *,
        execution_plan: OcrExecutionPlan | None = None,
        pipeline_factory: Callable[..., Any] | None = None,
        provider_resolver: Callable[[], list[str]] | None = None,
        provider_evidence_adapter: OcrExecutionEvidenceAdapter | None = None,
        stage_reporter: Callable[[str], None] | None = None,
        adapter_map_resolver: Callable[[], tuple[str, str] | tuple[str, str, bool]] | None = None,
        adapter_map_lease_factory: Callable[[], _NativeOcrAdapterMapLease] | None = None,
        selection_proof: Any | None = None,
        execution_proof_context: OcrExecutionProofContextV1 | None = None,
        source_sha256: str | None = None,
        requested_page_scope: tuple[int, ...] | None = None,
        runtime_sha256: str | None = None,
    ) -> None:
        self.model_dir = model_dir
        if adapter_map_resolver is not None and adapter_map_lease_factory is not None:
            raise ValueError("OCR adapter map resolver and lease factory are mutually exclusive")
        self.execution_plan = execution_plan
        self.device_id = None if execution_plan is None else execution_plan.dml_device_id
        self._pipeline_factory = pipeline_factory
        self._provider_resolver = provider_resolver
        self._adapter_map_resolver = adapter_map_resolver
        self._adapter_map_lease_factory = adapter_map_lease_factory or (
            (lambda: _NativeOcrAdapterMapLease())
            if execution_plan is not None
            and execution_plan.mode.value == "gpu-dml"
            and sys.platform == "win32"
            and adapter_map_resolver is None
            else None
        )
        self._stage_reporter = stage_reporter
        self._profile_file_prefix = (
            Path(tempfile.gettempdir()) / f"capture-runtime-ocr-{uuid4().hex}"
        )
        self._provider_evidence_adapter = provider_evidence_adapter or (
            _PaddleOcrExecutionEvidenceAdapter(
                self._profile_file_prefix,
                stage_reporter=stage_reporter,
            )
        )
        self._profile = _load_ocr_profile_identity(model_dir)
        if execution_proof_context is None and runtime_sha256 is not None:
            if execution_plan is None or execution_plan.worker_sha256 is None:
                raise ValueError("OCR execution proof requires a retained worker identity")
            if source_sha256 is None:
                raise ValueError("OCR execution proof requires a source identity")
            model_digest = _directory_digest(model_dir, WINDOWSML_REQUIRED_MODEL_FILES)
            execution_proof_context = OcrExecutionProofContextV1(
                source_sha256=source_sha256,
                requested_page_scope=requested_page_scope,
                runtime_sha256=runtime_sha256,
                worker_sha256=execution_plan.worker_sha256,
                model_sha256=model_digest.removeprefix("sha256:"),
                profile_id=self._profile.profile_id,
                profile_spec_sha256=self._profile.profile_spec_sha256,
                contract_set_sha256=execution_plan.contract_set_sha256,
            )
        self._pipeline: Any | None = None
        self._device = "windowsml-dml"
        self._warning: str | None = None
        self._model_digest: str | None = None
        self._execution_evidence: OcrExecutionEvidence | None = None
        self._execution_evidence_finalized = False
        self._execution_proof: OcrExecutionDeviceProofV1 | None = None
        self._construction_proof: OcrPipelineConstructionProofV1 | None = None
        self._selection_proof = selection_proof
        self._execution_proof_context = execution_proof_context
        self._map_current_before = False
        self._map_current_after = False
        self._last_map_current = False
        self._cleanup_pending = False
        self._lock = Lock()

    def provenance(self) -> OcrProvenanceV3:
        """Return identity only after the selected provider is evidenced.

        A DML provider list is configuration, not execution evidence.  The
        evidence adapter is finalized by :meth:`extract_png` after prediction;
        this method must not create a pipeline or imply that a prediction ran.
        """

        providers = self._providers()
        if "DmlExecutionProvider" in providers:
            if (
                not self._execution_evidence_finalized
                or self._execution_evidence is None
                or self._execution_evidence.dml_node_count < 1
            ):
                raise EngineRuntimeUnavailableError(
                    "DML provenance is available only after OCR prediction and "
                    "execution evidence finalization."
                )
            device = "windowsml-dml"
        else:
            device = "cpu"
        if self._model_digest is None:
            self._model_digest = _directory_digest(self.model_dir, WINDOWSML_REQUIRED_MODEL_FILES)
        return OcrProvenanceV3(
            status="resolved",
            engine="windowsml-ocr",
            model=self._profile.model,
            model_digest=self._model_digest,
            device=device,
            profile_id=self._profile.profile_id,
            profile_spec_sha256=self._profile.profile_spec_sha256,
        )

    def _report_stage(self, stage: str) -> None:
        safe_stage = sanitize_worker_stage(stage)
        if safe_stage is not None and self._stage_reporter is not None:
            self._stage_reporter(safe_stage)

    def probe(self) -> EngineProbe:
        self._report_stage("ocr-probe-modules-start")
        missing_modules = [
            module
            for module in ("onnxruntime", "paddleocr")
            if importlib.util.find_spec(module) is None
            and not (self._pipeline_factory is not None and self._provider_resolver is not None)
        ]
        self._report_stage(ocr_probe_readiness_stage("modules", len(missing_modules)))
        missing_files = [
            relative
            for relative in WINDOWSML_REQUIRED_MODEL_FILES
            if not (self.model_dir / relative).is_file()
        ]
        self._report_stage(ocr_probe_readiness_stage("assets", len(missing_files)))
        code_ready = not missing_modules
        assets_ready = not missing_files
        code_detail = (
            "Missing WindowsML OCR dependencies: " + ", ".join(missing_modules)
            if missing_modules
            else None
        )
        assets_detail = (
            "Missing WindowsML OCR model assets: " + ", ".join(missing_files)
            if missing_files
            else None
        )
        if missing_modules:
            detail = code_detail or "WindowsML OCR dependencies are unavailable."
        elif missing_files:
            detail = assets_detail or "WindowsML OCR model assets are unavailable."
        else:
            try:
                providers = self._providers()
            except Exception as error:
                self._report_stage("ocr-probe-providers-error")
                return EngineProbe(False, True, True, f"Provider probe failed: {error}")
            self._report_stage(
                ocr_probe_providers_stage(
                    len(providers),
                    cpu="CPUExecutionProvider" in providers,
                    dml="DmlExecutionProvider" in providers,
                )
            )
            if "CPUExecutionProvider" not in providers:
                return EngineProbe(
                    False,
                    True,
                    True,
                    "CPUExecutionProvider is required for deterministic fallback.",
                )
            detail = (
                "WindowsML DML-first session with CPU execution-provider support is ready."
                if "DmlExecutionProvider" in providers
                else "DmlExecutionProvider is unavailable; CPU OCR fallback is ready."
            )
        return EngineProbe(
            code_ready and assets_ready,
            code_ready,
            assets_ready,
            detail,
            code_detail=code_detail,
            assets_detail=assets_detail,
        )

    def extract_png(self, image_png: bytes) -> OcrTextResult:
        with self._lock:
            self._retry_pending_cleanup()
            return self._extract_png_locked(image_png)

    def _retry_pending_cleanup(self) -> None:
        if not self._cleanup_pending:
            return
        cleanup_error = self._abort_provider_evidence(None)
        if cleanup_error is not None:
            raise OcrInferenceCleanupError(
                primary_code="ocr_profile_cleanup_retry_failed",
                cleanup_error=cleanup_error,
            )

    def _abort_provider_evidence(self, pipeline: Any | None) -> OcrExecutionEvidenceError | None:
        abort = getattr(self._provider_evidence_adapter, "abort", None)
        if not callable(abort):
            self._cleanup_pending = False
            self._reset_after_abort()
            return None
        try:
            abort(pipeline)
        except OcrExecutionEvidenceError as error:
            self._cleanup_pending = True
            return error
        except Exception:
            self._cleanup_pending = True
            return OcrExecutionEvidenceError(
                [OcrExecutionEvidenceFailure("profile_cleanup_failed")],
                cleanup_verified=False,
            )
        self._cleanup_pending = False
        self._reset_after_abort()
        return None

    def _reset_after_abort(self) -> None:
        self._pipeline = None
        self._execution_evidence = None
        self._execution_evidence_finalized = False
        self._execution_proof = None

    def execution_proof(self) -> OcrExecutionDeviceProofV1 | None:
        """Return the validated private receipt, if this run requested one."""

        return self._execution_proof

    def _finalize_execution_proof(self) -> None:
        """Bind finalized ORT evidence to the retained plan and run identities."""

        if self._execution_proof_context is None:
            return
        plan = self.execution_plan
        evidence = self._execution_evidence
        construction = self._construction_proof
        if plan is None or evidence is None or construction is None:
            raise EngineRuntimeUnavailableError(
                "OCR execution proof is missing retained plan construction evidence."
            )
        if plan.mode.value != "gpu-dml" or plan.identity is None:
            raise EngineRuntimeUnavailableError("OCR execution proof requires a retained GPU plan")
        selection_proof = self._selection_proof
        if selection_proof is None:
            selection_proof = OcrSelectionDeviceProofV1(
                identity=plan.identity,
                high_performance_rank=plan.high_performance_rank,
                dml_device_id=plan.dml_device_id,
                adapter_map_sha256=plan.adapter_map_sha256,
                plan_sha256=plan.plan_sha256,
            )
        if not isinstance(selection_proof, OcrSelectionDeviceProofV1):
            raise EngineRuntimeUnavailableError("OCR execution selection proof is invalid")
        context = self._execution_proof_context
        if (
            context.profile_id != self._profile.profile_id
            or context.profile_spec_sha256 != self._profile.profile_spec_sha256
            or context.model_sha256 != (self._model_digest or "").removeprefix("sha256:")
        ):
            raise EngineRuntimeUnavailableError(
                "OCR execution proof model/profile identity drifted"
            )
        try:
            proof = OcrExecutionDeviceProofV1.build(
                plan=plan,
                selection_proof=selection_proof,
                construction=construction,
                evidence=evidence,
                context=context,
            )
            proof.validate_against(plan)
            proof.validate_context(context)
        except (TypeError, ValueError) as error:
            raise EngineRuntimeUnavailableError(
                "OCR execution proof failed closed after DML evidence"
            ) from error
        self._execution_proof = proof

    def _extract_png_locked(self, image_png: bytes) -> OcrTextResult:
        self._report_stage("ocr-probe-start")
        probe = self.probe()
        if not probe.ready:
            raise EngineRuntimeUnavailableError(probe.detail)
        self._report_stage("ocr-probe-complete")
        failure_stage = "pipeline-create"
        pipeline: Any | None = None
        try:
            self._report_stage("ocr-pipeline-create-start")
            pipeline = self._get_pipeline()
            self._report_stage("ocr-pipeline-create-complete")
            failure_stage = "predict"
            self._report_stage("ocr-predict-start")
            results = self._predict(pipeline, image_png)
            self._report_stage("ocr-predict-complete")
            if self._device != "cpu" and not self._execution_evidence_finalized:
                failure_stage = "provider-evidence"
                self._report_stage("ocr-provider-evidence-start")
                finalize = getattr(self._provider_evidence_adapter, "finalize", None)
                if not callable(finalize):
                    raise EngineRuntimeUnavailableError(
                        "DML execution evidence finalization is unavailable."
                    )
                evidence = finalize(pipeline)
                if evidence.dml_node_count < 1:
                    raise EngineRuntimeUnavailableError(
                        "DML execution evidence contained zero assigned DML nodes."
                    )
                self._execution_evidence = evidence
                self._execution_evidence_finalized = True
                if self._model_digest is None:
                    self._model_digest = _directory_digest(
                        self.model_dir, WINDOWSML_REQUIRED_MODEL_FILES
                    )
                self._finalize_execution_proof()
                self._report_stage(
                    ocr_provider_evidence_stage(
                        self._execution_evidence.dml_node_count,
                        self._execution_evidence.cpu_node_count,
                    )
                )
        except Exception as error:
            self._report_stage(ocr_stage_failure(failure_stage, error))
            if self._device == "cpu":
                raise
            cleanup_error = self._abort_provider_evidence(pipeline)
            primary_code = {
                "pipeline-create": "ocr_pipeline_init_failed",
                "predict": "ocr_prediction_failed",
                "provider-evidence": "ocr_execution_evidence_failed",
            }.get(failure_stage, "ocr_inference_failed")
            if cleanup_error is not None:
                raise OcrInferenceCleanupError(
                    primary_code=primary_code,
                    cleanup_error=cleanup_error,
                ) from error
            if isinstance(error, OcrExecutionEvidenceError):
                raise
            raise EngineRuntimeUnavailableError(
                "WindowsML DirectML OCR execution failed while a GPU provider was available; "
                "a separate CPU-only pipeline retry is disabled: "
                f"{type(error).__name__}: {error}"
            ) from error
        try:
            if self._model_digest is None:
                self._model_digest = _directory_digest(
                    self.model_dir, WINDOWSML_REQUIRED_MODEL_FILES
                )
            raster_width, raster_height = _png_dimensions(image_png)
            normalized = normalize_paddle_results(
                results,
                raster_width=raster_width,
                raster_height=raster_height,
            )
            return OcrTextResult(
                text=normalized.text,
                device=self._device,
                model=self._profile.model,
                digest=self._model_digest,
                warning=self._warning,
                regions=normalized.regions,
                raster_width=raster_width,
                raster_height=raster_height,
                region_confidences=tuple(
                    region.confidence
                    for region in normalized.regions
                    if region.confidence is not None
                ),
                profile_id=self._profile.profile_id,
                profile_spec_sha256=self._profile.profile_spec_sha256,
                execution_proof=self._execution_proof,
                provenance=OcrProvenanceV3(
                    status="resolved",
                    engine="windowsml-ocr",
                    model=self._profile.model,
                    model_digest=self._model_digest,
                    device=self._device,
                    profile_id=self._profile.profile_id,
                    profile_spec_sha256=self._profile.profile_spec_sha256,
                ),
            )
        except PaddleResultNormalizationError as error:
            cleanup_error = self._abort_provider_evidence(pipeline)
            if cleanup_error is not None:
                raise OcrInferenceCleanupError(
                    primary_code="ocr_normalization_failed",
                    cleanup_error=cleanup_error,
                ) from error
            raise
        except Exception as error:
            cleanup_error = self._abort_provider_evidence(pipeline)
            if cleanup_error is not None:
                raise OcrInferenceCleanupError(
                    primary_code="ocr_provenance_failed",
                    cleanup_error=cleanup_error,
                ) from error
            raise

    def _providers(self) -> list[str]:
        if self._provider_resolver is not None:
            return list(self._provider_resolver())
        import onnxruntime as ort

        return list(ort.get_available_providers())

    def _validate_plan_map(self, previous: tuple[str, str] | None = None) -> tuple[str, str] | None:
        """Validate the retained ordinary ordinal/LUID map around construction."""

        plan = self.execution_plan
        resolver = self._adapter_map_resolver
        if plan is None or plan.mode.value != "gpu-dml" or resolver is None:
            return previous
        try:
            value = resolver()
            if not isinstance(value, tuple) or len(value) not in (2, 3):
                raise ValueError("adapter map resolver returned an invalid value")
            digest, luid = value[:2]
            current = len(value) == 3 and value[2] is True
            if len(value) == 3 and value[2] is not True:
                raise ValueError("DXGI adapter factory is not current")
            if not isinstance(digest, str) or not isinstance(luid, str):
                raise ValueError("adapter map resolver returned an invalid value")
        except Exception as error:
            raise EngineRuntimeUnavailableError(
                "retained OCR GPU plan could not validate the adapter map"
            ) from error
        expected_luid = plan.identity.luid if plan.identity is not None else None
        if digest != plan.adapter_map_sha256 or luid != expected_luid:
            raise EngineRuntimeUnavailableError("retained OCR GPU adapter identity drifted")
        if previous is not None and previous != (digest, luid):
            raise EngineRuntimeUnavailableError(
                "retained OCR GPU adapter map changed during construction"
            )
        self._last_map_current = current
        return digest, luid

    def _validate_native_plan_map(
        self,
        lease: _NativeOcrAdapterMapLease,
        previous: tuple[str, str] | None = None,
    ) -> tuple[str, str]:
        """Validate map identity and factory freshness on one native lease."""

        plan = self.execution_plan
        if plan is None or plan.mode.value != "gpu-dml":
            return previous or ("", "")
        try:
            if not lease.is_current():
                raise RuntimeError("DXGI adapter factory is not current")
            value = _native_selected_adapter_map(plan, lease)
        except Exception as error:
            raise EngineRuntimeUnavailableError(
                "retained OCR GPU plan could not validate the native adapter map"
            ) from error
        expected_luid = plan.identity.luid if plan.identity is not None else None
        if value[0] != plan.adapter_map_sha256 or value[1] != expected_luid:
            raise EngineRuntimeUnavailableError("retained OCR GPU adapter identity drifted")
        if previous is not None and previous != value:
            raise EngineRuntimeUnavailableError(
                "retained OCR GPU adapter map changed during construction"
            )
        self._last_map_current = True
        return value

    def _get_pipeline(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline
        if self.execution_plan is None:
            raise EngineRuntimeUnavailableError(
                "OCR pipeline construction requires a retained compute plan"
            )
        providers = self._providers()
        use_dml = self._device != "cpu" and "DmlExecutionProvider" in providers
        if (
            self.execution_plan is not None
            and self.execution_plan.mode.value == "gpu-dml"
            and not use_dml
        ):
            raise EngineRuntimeUnavailableError(
                "retained OCR GPU plan cannot be satisfied by the worker provider set"
            )
        if self.execution_plan is not None and self.execution_plan.mode.value == "cpu-fallback":
            use_dml = False
        if not use_dml:
            self._device = "cpu"
            if self._warning is None and "DmlExecutionProvider" not in providers:
                self._warning = "DmlExecutionProvider is unavailable; CPU OCR fallback was used."
        if use_dml and self.device_id is None:
            raise EngineRuntimeUnavailableError("OCR execution plan has no device id")
        kwargs = self._profile.paddle_kwargs(
            model_dir=self.model_dir,
            device_id=self.device_id,
            use_dml=use_dml,
            profile_file_prefix=(str(self._profile_file_prefix) if use_dml else None),
        )
        self._profile.verify_paddle_kwargs(
            kwargs,
            model_dir=self.model_dir,
            device_id=self.device_id,
            use_dml=use_dml,
            profile_file_prefix=(str(self._profile_file_prefix) if use_dml else None),
        )
        factory = self._pipeline_factory
        if factory is None:
            factory = _default_paddle_pipeline
        lease = None
        try:
            if self._adapter_map_lease_factory is not None:
                try:
                    lease = self._adapter_map_lease_factory()
                except Exception as error:
                    raise EngineRuntimeUnavailableError(
                        "retained OCR GPU plan could not create a native adapter map lease"
                    ) from error
            if use_dml:
                self._report_stage("ocr-native-map-before")
            before_map: tuple[str, str] | None = (
                self._validate_native_plan_map(lease)
                if lease is not None
                else self._validate_plan_map()
            )
            self._map_current_before = self._last_map_current
            if use_dml:
                self._report_stage("ocr-paddle-factory")
            pipeline = factory(**kwargs)
            after_map: tuple[str, str] | None
            if use_dml:
                self._report_stage("ocr-native-map-after")
            if lease is not None:
                after_map = self._validate_native_plan_map(lease, before_map)
            else:
                after_map = self._validate_plan_map(before_map)
            self._map_current_after = self._last_map_current
            if (
                self._execution_proof_context is not None
                and before_map is not None
                and after_map is not None
                and self._map_current_before
                and self._map_current_after
            ):
                self._construction_proof = OcrPipelineConstructionProofV1(
                    pre_adapter_luid=before_map[1],
                    post_adapter_luid=after_map[1],
                    pre_adapter_map_sha256=before_map[0],
                    post_adapter_map_sha256=after_map[0],
                    pre_factory_current=self._map_current_before,
                    post_factory_current=self._map_current_after,
                )
            if use_dml:
                # Preparation only disables ORT's implicit fallback.  It cannot
                # establish which provider actually executed a node; that proof is
                # finalized after _predict returns.
                self._report_stage("ocr-execution-evidence-prepare")
                prepare = self._provider_evidence_adapter.prepare
                try:
                    prepare(pipeline, expected_device_id=self.execution_plan.dml_device_id)
                except TypeError as error:
                    # A custom adapter cannot validate a retained plan, so it
                    # is not accepted on the plan path.
                    raise EngineRuntimeUnavailableError(
                        "OCR evidence adapter cannot validate the retained device plan"
                    ) from error
            self._pipeline = pipeline
            return pipeline
        finally:
            if lease is not None:
                lease.close()

    @staticmethod
    def _predict(pipeline: Any, image_png: bytes) -> Any:
        with tempfile.NamedTemporaryFile(
            prefix="capture-workbench-windowsml-", suffix=".png", delete=False
        ) as temporary:
            temporary.write(image_png)
            path = Path(temporary.name)
        try:
            return pipeline.predict(str(path))
        finally:
            path.unlink(missing_ok=True)


def _install_offline_aistudio_stubs() -> None:
    existing = sys.modules.get("aistudio_sdk")
    if getattr(existing, "_capture_workbench_offline_stub", False):
        return
    package = ModuleType("aistudio_sdk")
    package.__path__ = []
    package._capture_workbench_offline_stub = True  # type: ignore[attr-defined]
    errors = ModuleType("aistudio_sdk.errors")
    downloads = ModuleType("aistudio_sdk.snapshot_download")

    class NotExistError(Exception):
        pass

    def snapshot_download(*_args: object, **_kwargs: object) -> None:
        raise EngineRuntimeUnavailableError(
            "Capture WindowsML OCR only uses checksum-verified local model assets."
        )

    errors.NotExistError = NotExistError  # type: ignore[attr-defined]
    downloads.snapshot_download = snapshot_download  # type: ignore[attr-defined]
    package.errors = errors  # type: ignore[attr-defined]
    package.snapshot_download = downloads  # type: ignore[attr-defined]
    sys.modules["aistudio_sdk"] = package
    sys.modules["aistudio_sdk.errors"] = errors
    sys.modules["aistudio_sdk.snapshot_download"] = downloads


def _install_offline_huggingface_stubs() -> None:
    existing = sys.modules.get("huggingface_hub")
    if getattr(existing, "_capture_workbench_offline_stub", False):
        return
    package = ModuleType("huggingface_hub")
    package.__path__ = []
    package._capture_workbench_offline_stub = True  # type: ignore[attr-defined]
    logging = ModuleType("huggingface_hub.logging")
    utils = ModuleType("huggingface_hub.utils")

    class HfHubHTTPError(Exception):
        pass

    class RepositoryNotFoundError(HfHubHTTPError):
        pass

    class EntryNotFoundError(HfHubHTTPError):
        pass

    class RevisionNotFoundError(HfHubHTTPError):
        pass

    def set_verbosity_error() -> None:
        return None

    def snapshot_download(*_args: object, **_kwargs: object) -> None:
        raise EngineRuntimeUnavailableError(
            "Capture WindowsML OCR only uses checksum-verified local model assets."
        )

    logging.set_verbosity_error = set_verbosity_error  # type: ignore[attr-defined]
    utils.HfHubHTTPError = HfHubHTTPError  # type: ignore[attr-defined]
    utils.RepositoryNotFoundError = RepositoryNotFoundError  # type: ignore[attr-defined]
    utils.EntryNotFoundError = EntryNotFoundError  # type: ignore[attr-defined]
    utils.RevisionNotFoundError = RevisionNotFoundError  # type: ignore[attr-defined]
    package.logging = logging  # type: ignore[attr-defined]
    package.snapshot_download = snapshot_download  # type: ignore[attr-defined]
    package.utils = utils  # type: ignore[attr-defined]
    sys.modules["huggingface_hub"] = package
    sys.modules["huggingface_hub.logging"] = logging
    sys.modules["huggingface_hub.utils"] = utils


class FasterWhisperAdapter:
    """Local-only faster-whisper adapter with explicit, bounded CPU fallback."""

    def __init__(
        self,
        models_dir: Path,
        *,
        primary_model: str,
        fallback_model: str,
        primary_provenance_model: str | None = None,
        fallback_provenance_model: str | None = None,
        prefer_gpu: bool,
        max_duration_ms: int,
        allow_cpu_fallback: bool = True,
        model_factory: Callable[..., Any] | None = None,
        cuda_count: Callable[[], int] | None = None,
        stage_reporter: Callable[[str], None] | None = None,
    ) -> None:
        self.models_dir = models_dir
        self.primary_model = primary_model
        self.fallback_model = fallback_model
        # Model directory names are intentionally independent from the
        # lock-visible model identities.  Workers keep the stable
        # ``primary``/``fallback`` layout while reporting the actual
        # upstream model names in provenance.
        self.primary_provenance_model = primary_provenance_model or primary_model
        self.fallback_provenance_model = fallback_provenance_model or fallback_model
        self.prefer_gpu = prefer_gpu
        self.allow_cpu_fallback = allow_cpu_fallback
        self.max_duration_ms = max_duration_ms
        self._model_factory = model_factory
        self._cuda_count = cuda_count
        self._stage_reporter = stage_reporter
        self._runtime_cache: dict[tuple[str, str, str], Any] = {}
        self._digest_cache: dict[str, str] = {}

    def _report_stage(self, stage: str) -> None:
        safe_stage = sanitize_worker_stage(stage)
        if safe_stage is not None and self._stage_reporter is not None:
            self._stage_reporter(safe_stage)

    def model_path(self, model: str) -> Path:
        return self.models_dir / model

    def probe(self) -> EngineProbe:
        code_ready = (
            self._model_factory is not None
            or importlib.util.find_spec("faster_whisper") is not None
        )
        missing: list[str] = []
        for model in {self.primary_model, self.fallback_model}:
            model_root = self.model_path(model)
            for relative in WHISPER_REQUIRED_FILES:
                if not (model_root / relative).is_file():
                    missing.append(f"{model}/{relative}")
            if not any(model_root.glob("vocabulary.*")):
                missing.append(f"{model}/vocabulary.*")
        assets_ready = not missing
        code_detail = None if code_ready else "Missing faster-whisper runtime dependency."
        assets_detail = (
            None if assets_ready else "Missing local Whisper model assets: " + ", ".join(missing)
        )
        if not code_ready:
            detail = code_detail or "Whisper runtime dependency is unavailable."
        elif missing:
            detail = assets_detail or "Whisper model assets are unavailable."
        else:
            detail = "Primary and CPU fallback Whisper models are locally ready."
        return EngineProbe(
            code_ready and assets_ready,
            code_ready,
            assets_ready,
            detail,
            code_detail=code_detail,
            assets_detail=assets_detail,
        )

    def transcribe(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        allow_empty_output: bool = False,
    ) -> WhisperTranscriptionResult:
        self._report_stage(whisper_stage("assets-probe-start"))
        probe = self.probe()
        if not probe.ready:
            raise EngineRuntimeUnavailableError(probe.detail)
        self._report_stage(whisper_stage("assets-probe-complete"))
        if should_cancel():
            raise InterruptedError("Whisper transcription was cancelled.")
        self._report_stage(whisper_stage("device-probe-start"))
        cuda_devices = self._cuda_devices()
        use_gpu = self.prefer_gpu and cuda_devices > 0
        self._report_stage(whisper_stage("device-probe-complete"))
        if self.prefer_gpu and not self.allow_cpu_fallback and cuda_devices <= 0:
            raise EngineRuntimeUnavailableError("Whisper CUDA device is unavailable.")
        if use_gpu:
            try:
                return self._run(
                    source_path,
                    model=self.primary_model,
                    provenance_model=self.primary_provenance_model,
                    device="cuda",
                    compute_type="float16",
                    should_cancel=should_cancel,
                    allow_empty_output=allow_empty_output,
                )
            except InterruptedError:
                raise
            except Exception as error:
                if not self.allow_cpu_fallback:
                    raise
                self._runtime_cache.pop((self.primary_model, "cuda", "float16"), None)
                # A CUDA-capable driver is not proof that the bundled
                # ctranslate2 build can initialize a CUDA model.  Keep the
                # desktop product usable on machines that advertise CUDA but
                # fail during model construction or the first transcription;
                # the CPU model is the supported fallback for Whisper.  The
                # warning is deliberately type-only so a model path or raw
                # backend diagnostic cannot cross the worker boundary.
                self._report_stage(whisper_stage("gpu-fallback"))
                return self._run_cpu(
                    source_path,
                    should_cancel=should_cancel,
                    warning=f"Whisper GPU fallback: {type(error).__name__}",
                    allow_empty_output=allow_empty_output,
                )
        return self._run_cpu(
            source_path,
            should_cancel=should_cancel,
            allow_empty_output=allow_empty_output,
        )

    def _run_cpu(
        self,
        source_path: Path,
        *,
        should_cancel: Callable[[], bool],
        warning: str | None = None,
        allow_empty_output: bool = False,
    ) -> WhisperTranscriptionResult:
        try:
            return self._run(
                source_path,
                model=self.fallback_model,
                provenance_model=self.fallback_provenance_model,
                device="cpu",
                # Use mixed int8 weights/float32 activations as the CPU
                # default. It is supported by the bundled CTranslate2
                # build while avoiding the pure-int8 constructor path that
                # can fail on otherwise supported Windows CPUs.
                compute_type="int8_float32",
                should_cancel=should_cancel,
                warning=warning,
                allow_empty_output=allow_empty_output,
            )
        except _WhisperModelLoadError:
            self._report_stage(whisper_stage("model-load-cpu-fallback-float32"))
            return self._run(
                source_path,
                model=self.fallback_model,
                provenance_model=self.fallback_provenance_model,
                device="cpu",
                compute_type="float32",
                should_cancel=should_cancel,
                warning=warning or "Whisper CPU int8_float32 compatibility fallback: RuntimeError",
                allow_empty_output=allow_empty_output,
            )

    def _cuda_devices(self) -> int:
        if self._cuda_count is not None:
            return self._cuda_count()
        windows_count = _windows_cuda_device_count()
        if windows_count is not None:
            return windows_count
        try:
            import ctranslate2

            return int(ctranslate2.get_cuda_device_count())
        except Exception:
            return 0

    def _run(
        self,
        source_path: Path,
        *,
        model: str,
        provenance_model: str,
        device: str,
        compute_type: str,
        should_cancel: Callable[[], bool],
        warning: str | None = None,
        allow_empty_output: bool = False,
    ) -> WhisperTranscriptionResult:
        factory = self._model_factory
        if factory is None:
            from faster_whisper import WhisperModel

            factory = WhisperModel
        model_root = self.model_path(model)
        cache_key = (model, device, compute_type)
        runtime = self._runtime_cache.get(cache_key)
        if runtime is None:
            self._report_stage(whisper_model_load_stage(device, "start"))
            try:
                runtime = factory(str(model_root), device=device, compute_type=compute_type)
            except Exception as error:
                self._report_stage(whisper_model_load_stage(device, "failed", error))
                if device == "cpu" and isinstance(error, RuntimeError):
                    raise _WhisperModelLoadError from error
                raise
            self._runtime_cache[cache_key] = runtime
            self._report_stage(whisper_model_load_stage(device, "complete"))
        else:
            self._report_stage(whisper_model_load_stage(device, "reused"))
        self._report_stage(whisper_stage("transcription-call-start"))
        raw_segments, info = runtime.transcribe(
            str(source_path), beam_size=5, vad_filter=True, word_timestamps=False
        )
        self._report_stage(whisper_stage("transcription-call-complete"))
        self._report_stage(whisper_stage("transcription-iteration-start"))
        duration_ms = max(0, round(float(info.duration) * 1000))
        if duration_ms > self.max_duration_ms:
            raise ValueError("Audio duration exceeds the configured limit.")
        segments: list[WhisperTextSegment] = []
        for raw in raw_segments:
            if should_cancel():
                raise InterruptedError("Whisper transcription was cancelled.")
            text = str(raw.text).strip()
            start_ms = max(0, round(float(raw.start) * 1000))
            end_ms = min(duration_ms, max(0, round(float(raw.end) * 1000)))
            if text and start_ms < end_ms:
                segments.append(WhisperTextSegment(start_ms, end_ms, text))
        if should_cancel():
            raise InterruptedError("Whisper transcription was cancelled.")
        if not segments and not allow_empty_output:
            self._report_stage(whisper_stage("output-empty"))
            raise ValueError("Whisper produced no non-empty segments.")
        self._report_stage(whisper_output_stage(bool(segments)))
        digest = self._digest_cache.get(model)
        if digest is None:
            digest = _directory_digest(model_root)
            self._digest_cache[model] = digest
        return WhisperTranscriptionResult(
            segments=tuple(segments),
            duration_ms=duration_ms,
            device=device,
            model=provenance_model,
            digest=digest,
            warning=warning,
        )


__all__ = [
    "EngineProbe",
    "EngineRuntimeUnavailableError",
    "FasterWhisperAdapter",
    "OcrAdapter",
    "OcrExecutionEvidence",
    "OcrExecutionEvidenceAdapter",
    "OcrExecutionEvidenceError",
    "OcrExecutionEvidenceFailure",
    "OcrExecutionDeviceProofV1",
    "OcrExecutionProofContextV1",
    "OcrPipelineConstructionProofV1",
    "OcrSessionDeviceProof",
    "OcrInferenceCleanupError",
    "OcrProfileIdentity",
    "OcrTextResult",
    "PaddleNormalizedResult",
    "PaddleResultNormalizationError",
    "WhisperAdapter",
    "WhisperTextSegment",
    "WhisperTranscriptionResult",
    "WindowsMLOcrAdapter",
    "load_ocr_profile_identity",
    "normalize_paddle_results",
]
