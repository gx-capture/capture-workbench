"""Separately packaged WindowsML OCR worker."""

# Imports are deliberately staged below so the packaged worker can report the
# exact failing import boundary before loading heavyweight model dependencies.
# ruff: noqa: E402, I001

from __future__ import annotations

import hashlib
import importlib
import re
import sys
import warnings
from collections.abc import Callable, Iterable, Iterator
from datetime import UTC, datetime
from io import BytesIO
from pathlib import Path
from threading import Event
from typing import Any

from capture_runtime.worker_stage_policy import (
    ocr_import_failure_stage,
    ocr_import_stage,
    sanitize_worker_stage,
)

STAGE_PREFIX = "capture-worker-stage:"


def _report_stage(stage: str) -> None:
    safe_stage = sanitize_worker_stage(stage)
    if safe_stage is None:
        return
    sys.stderr.write(f"{STAGE_PREFIX}{safe_stage}\n")
    sys.stderr.flush()


_report_stage("worker-entry-start")

_report_stage("python-import-pdfium-start")
import pypdfium2 as pdfium  # type: ignore[import-untyped]

_report_stage("python-import-pdfium-complete")

_report_stage("python-import-pillow-start")
from PIL import Image, ImageOps, UnidentifiedImageError

_report_stage("python-import-pillow-complete")

_report_stage("python-import-capture-runtime-start")
from capture_runtime.engine_adapters import (
    WindowsMLOcrAdapter,
    _install_offline_aistudio_stubs,
    _install_offline_huggingface_stubs,
)
from capture_runtime.contracts import CaptureSource
from capture_runtime.image_normalization import bounded_scaled_dimensions
from capture_runtime.ocr_preflight import (
    NativeOcrGpuCapabilityProbe,
    OcrComputePlan,
    OcrExecutionPlan,
)
from capture_runtime.ocr_projection import (
    OcrEngineRun,
    OcrEngineRequest,
    OcrPageInput,
    OcrPageManifest,
    OcrPipeline,
    OcrRequest,
    OcrTerminalOutcome,
)
from capture_runtime.worker_contracts import WorkerRequest
from capture_runtime.workers.server import serve

_report_stage("python-import-capture-runtime-complete")

MAX_SOURCE_BYTES = 50 * 1024 * 1024
_OCR_PIPELINE = OcrPipeline()


class _WorkerOcrEngineAdapter:
    """Keep PDFium/Paddle mechanics behind the shared pipeline request seam."""

    def __init__(
        self,
        adapter: WindowsMLOcrAdapter,
        images: Iterable[tuple[int, bytes]],
    ) -> None:
        self._adapter = adapter
        self._images = images
        self.execution_proof = None
        self.last_error: Exception | None = None
        self.last_pages: tuple[OcrPageInput, ...] = ()

    def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
        pages: list[OcrPageInput] = []
        warnings: list[str] = []
        provenance = None
        images = iter(self._images)
        while True:
            if request.is_cancelled():
                raise InterruptedError
            try:
                page, image = next(images)
            except StopIteration:
                break
            if request.is_cancelled():
                raise InterruptedError
            if page > len(request.manifest):
                mismatch = ValueError("OCR worker returned a page outside the manifest")
                self.last_error = mismatch
                raise mismatch
            expected = request.manifest[page - 1]
            try:
                result = self._adapter.extract_png(image)
                if request.is_cancelled():
                    raise InterruptedError
                current_provenance = getattr(result, "provenance", None)
                if current_provenance is None:
                    provenance_method = getattr(self._adapter, "provenance", None)
                    if not callable(provenance_method):
                        raise ValueError("OCR worker result is missing resolved provenance")
                    current_provenance = provenance_method()
                proof_reader = getattr(self._adapter, "execution_proof", None)
                current_execution_proof = proof_reader() if callable(proof_reader) else None
                if current_execution_proof is not None:
                    if (
                        self.execution_proof is not None
                        and current_execution_proof != self.execution_proof
                    ):
                        raise ValueError("OCR worker returned changing execution proof")
                    self.execution_proof = current_execution_proof
                if request.is_cancelled():
                    raise InterruptedError
                pages.append(request.observe(expected, result, current_provenance))
                if provenance is None:
                    provenance = current_provenance
            except Exception as error:
                self.last_error = error
                if not isinstance(error, InterruptedError):
                    request.fail_page(expected)
                raise
            warning = getattr(result, "warning", None)
            if warning:
                warnings.append(warning)
        if len(pages) != len(request.manifest):
            mismatch = ValueError("OCR worker did not complete the page manifest")
            self.last_error = mismatch
            raise mismatch
        if not pages:
            mismatch = ValueError("OCR produced no results")
            self.last_error = mismatch
            raise mismatch
        if provenance is None:
            mismatch = ValueError("OCR worker result requires resolved provenance")
            self.last_error = mismatch
            raise mismatch
        if request.is_cancelled():
            raise InterruptedError
        self.last_pages = tuple(pages)
        return OcrEngineRun(
            pages=tuple(pages),
            provenance=provenance,
            warnings=tuple(dict.fromkeys(warnings)),
        )


def _import_ocr_runtime() -> None:
    _install_offline_aistudio_stubs()
    _install_offline_huggingface_stubs()
    for module in ("onnxruntime", "paddleocr"):
        _report_stage(ocr_import_stage(module, "start"))
        try:
            importlib.import_module(module)
        except Exception as error:
            _report_stage(ocr_import_failure_stage(module, error))
            raise
        _report_stage(ocr_import_stage(module, "complete"))


def _payload(request: WorkerRequest, expected: set[str]) -> dict[str, Any]:
    if set(request.payload) != expected:
        raise ValueError("OCR worker payload fields are invalid")
    return request.payload


def _model_path(value: object, *, required: bool) -> Path | None:
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise ValueError("OCR modelPath is invalid")
    path = Path(value)
    if not path.is_absolute() or not path.is_dir():
        raise ValueError("OCR modelPath must be an existing absolute directory")
    return path


def _probe(request: WorkerRequest) -> dict[str, Any]:
    base_fields = {"requirementId", "artifactVersion", "modelPath"}
    payload_fields = frozenset(request.payload)
    if payload_fields not in {frozenset(base_fields), frozenset(base_fields | {"options"})}:
        raise ValueError("OCR worker payload fields are invalid")
    payload = request.payload
    if payload["requirementId"] != "windowsml-ocr":
        raise ValueError("OCR requirementId is invalid")
    options = payload.get("options", {})
    if not isinstance(options, dict) or set(options):
        raise ValueError("OCR probe options are invalid")
    model_path = _model_path(payload["modelPath"], required=False)
    if model_path is None:
        import importlib.util

        missing = [
            item
            for item in ("onnxruntime", "paddleocr", "pypdfium2", "PIL")
            if importlib.util.find_spec(item) is None
        ]
        return {
            "ready": not missing,
            "codeReady": not missing,
            "assetsReady": False,
            "detail": (
                "OCR worker code is ready."
                if not missing
                else "OCR worker dependencies are unavailable."
            ),
            "device": None,
        }
    adapter = WindowsMLOcrAdapter(model_path)
    probe = adapter.probe()
    device = None
    if probe.ready:
        providers = adapter._providers()
        device = "windowsml-dml" if "DmlExecutionProvider" in providers else "cpu"
    return {
        "ready": probe.ready,
        "codeReady": probe.code_ready,
        "assetsReady": probe.assets_ready,
        "detail": probe.detail,
        "device": device,
    }


def _preflight(request: WorkerRequest) -> dict[str, Any]:
    """Decide OCR compute in this worker's ORT/native environment only."""

    expected = {
        "requirementId",
        "artifactVersion",
        "modelPath",
        "contractSha256",
        "options",
    }
    payload = request.payload
    payload_fields = set(payload)
    if not expected.issubset(payload_fields) or not payload_fields.issubset(
        expected | {"expectedWorkerSha256"}
    ):
        raise ValueError("OCR compute preflight payload fields are invalid")
    if payload["requirementId"] != "windowsml-ocr" or payload["modelPath"] is not None:
        raise ValueError("OCR compute preflight worker identity is invalid")
    contract_sha256 = payload["contractSha256"]
    if (
        not isinstance(contract_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", contract_sha256) is None
    ):
        raise ValueError("OCR compute preflight contract SHA-256 is invalid")
    options = payload["options"]
    if not isinstance(options, dict) or set(options):
        raise ValueError("OCR compute preflight options are invalid")
    expected_worker_sha256 = payload.get("expectedWorkerSha256")
    if expected_worker_sha256 is not None and (
        not isinstance(expected_worker_sha256, str)
        or re.fullmatch(r"[0-9a-f]{64}", expected_worker_sha256) is None
    ):
        raise ValueError("OCR compute preflight worker SHA-256 is invalid")
    worker_sha256 = _worker_executable_sha256()
    if expected_worker_sha256 is not None and worker_sha256 != expected_worker_sha256:
        raise ValueError("OCR compute preflight worker executable identity mismatch")
    capability_probe = NativeOcrGpuCapabilityProbe()
    selection = OcrComputePlan(
        contract_sha256=contract_sha256,
        worker_sha256=worker_sha256,
        capability_probe=capability_probe,
    ).select()
    if selection is None:
        raise ValueError("OCR compute selection is unavailable")
    return selection.to_dict()


def _worker_executable_sha256() -> str:
    """Hash the worker image that owns this preflight decision.

    PyInstaller one-file workers expose their original executable through
    ``sys.executable``. The source-worker test seam has no frozen executable,
    so it hashes this module instead; production manager probes always send a
    catalog digest and therefore take the frozen path.
    """

    image = Path(sys.executable if getattr(sys, "frozen", False) else __file__)
    try:
        digest = hashlib.sha256()
        with image.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError as error:
        raise ValueError("OCR compute preflight worker executable is unreadable") from error


def _normalized_png(source: Path, max_pixels: int, scale: float = 1) -> bytes:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as image:
                if (image.format or "").upper() not in {"PNG", "JPEG", "WEBP"}:
                    raise ValueError("unsupported image format")
                width, height = image.size
                if width <= 0 or height <= 0 or width * height > max_pixels:
                    raise ValueError("image dimensions exceed limit")
                if getattr(image, "n_frames", 1) != 1 or bool(getattr(image, "is_animated", False)):
                    raise ValueError("animated images are unsupported")
                image.seek(0)
                image.load()
                oriented = ImageOps.exif_transpose(image)
                if "A" in oriented.getbands() or "transparency" in oriented.info:
                    rgba = oriented.convert("RGBA")
                    normalized = Image.new("RGB", rgba.size, "white")
                    normalized.paste(rgba, mask=rgba.getchannel("A"))
                else:
                    normalized = oriented.convert("RGB")
                if scale != 1:
                    normalized_width, normalized_height = normalized.size
                    scaled_width, scaled_height = bounded_scaled_dimensions(
                        normalized_width,
                        normalized_height,
                        scale,
                        max_pixels,
                    )
                    normalized = normalized.resize(
                        (scaled_width, scaled_height),
                        Image.Resampling.LANCZOS,
                    )
                output = BytesIO()
                normalized.save(output, format="PNG")
                return output.getvalue()
    except (
        OSError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as error:
        raise ValueError("uploaded image is not readable") from error


def _image_raster_metadata(source: Path, image_png: bytes) -> tuple[int, int, float]:
    with Image.open(source) as image:
        oriented = ImageOps.exif_transpose(image)
        source_width, source_height = oriented.size
    with Image.open(BytesIO(image_png)) as normalized:
        width, height = normalized.size
    if source_width <= 0 or source_height <= 0 or width <= 0 or height <= 0:
        raise ValueError("OCR image raster metadata is invalid")
    return width, height, min(width / source_width, height / source_height)


def _pdf_page_images(
    source: Path,
    max_pages: int,
    scale: float,
    cancellation: Event,
    *,
    page_numbers: tuple[int, ...] | None = None,
) -> Iterator[tuple[int, bytes]]:
    document = None
    try:
        document = pdfium.PdfDocument(str(source))
        page_count = len(document)
        if page_count < 1:
            raise ValueError("uploaded PDF has no pages")
        if page_count > max_pages:
            raise ValueError(f"PDF has {page_count} pages; limit is {max_pages}")
        selected_page_numbers = (
            tuple(range(1, page_count + 1)) if page_numbers is None else page_numbers
        )
        if (
            not selected_page_numbers
            or selected_page_numbers != tuple(range(1, len(selected_page_numbers) + 1))
            or selected_page_numbers[-1] > page_count
        ):
            raise ValueError("OCR PDF page selection must be an ordered prefix in the source")
        for page_number in selected_page_numbers:
            if cancellation.is_set():
                raise InterruptedError
            _report_stage("ocr-pdf-render-start")
            bitmap = None
            try:
                bitmap = document[page_number - 1].render(scale=scale)
                image = bitmap.to_pil().convert("RGB")
                output = BytesIO()
                image.save(output, format="PNG")
            except Exception as error:
                raise ValueError(f"could not render PDF page {page_number}") from error
            finally:
                if bitmap is not None:
                    bitmap.close()
            _report_stage("ocr-pdf-render-complete")
            yield page_number, output.getvalue()
    except (ValueError, InterruptedError):
        raise
    except Exception as error:
        raise ValueError("uploaded PDF is not readable") from error
    finally:
        if document is not None:
            document.close()


def _page_manifest(value: object) -> tuple[OcrPageManifest, ...]:
    if not isinstance(value, list) or not 1 <= len(value) <= 500:
        raise ValueError("OCR page manifest is invalid")
    manifest: list[OcrPageManifest] = []
    for expected_page, item in enumerate(value, 1):
        if not isinstance(item, dict) or set(item) != {"page", "raster"}:
            raise ValueError("OCR page manifest is invalid")
        if item["page"] != expected_page:
            raise ValueError("OCR page manifest is not ordered")
        raster = item["raster"]
        if not isinstance(raster, dict) or set(raster) != {
            "width",
            "height",
            "scale",
            "coordinateSystem",
        }:
            raise ValueError("OCR page manifest raster is invalid")
        width = raster["width"]
        height = raster["height"]
        scale = raster["scale"]
        coordinate_system = raster["coordinateSystem"]
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
            raise ValueError("OCR page manifest raster is invalid")
        manifest.append(
            OcrPageManifest(
                page=expected_page,
                raster_width=width,
                raster_height=height,
                raster_scale=float(scale),
            )
        )
    return tuple(manifest)


def _run(
    request: WorkerRequest,
    cancellation: Event,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    payload = _payload(
        request,
        {
            "requirementId",
            "artifactVersion",
            "modelPath",
            "sourcePath",
            "mediaType",
            "options",
        },
    )
    if payload["requirementId"] != "windowsml-ocr":
        raise ValueError("OCR requirementId is invalid")
    model_path = _model_path(payload["modelPath"], required=True)
    assert model_path is not None
    source_value = payload["sourcePath"]
    if not isinstance(source_value, str):
        raise ValueError("OCR sourcePath is invalid")
    source = Path(source_value)
    if not source.is_absolute() or not source.is_file() or source.stat().st_size > MAX_SOURCE_BYTES:
        raise ValueError("OCR sourcePath is invalid")
    media_type = payload["mediaType"]
    options = payload["options"]
    if not isinstance(media_type, str) or not isinstance(options, dict):
        raise ValueError("OCR run mediaType/options are invalid")
    manifest = _page_manifest(options.get("pageManifest"))
    compute_plan_value = options.get("computePlan")
    compute_plan = None
    if compute_plan_value is not None:
        try:
            compute_plan = OcrExecutionPlan.from_dict(compute_plan_value)
        except ValueError as error:
            raise ValueError("OCR compute plan is invalid") from error
        if "deviceId" in options:
            raise ValueError("OCR compute plan must be the only device selection")
    images: Iterable[tuple[int, bytes]]
    page_numbers: tuple[int, ...] | None = None
    if media_type == "application/pdf":
        max_pages = options.get("maxPages")
        render_scale = options.get("renderScale")
        base_options = {"maxPages", "renderScale", "pageManifest"}
        plan_base_options = base_options | {"computePlan"}
        if "pageNumbers" in options:
            raw_page_numbers = options["pageNumbers"]
            if (
                not isinstance(raw_page_numbers, list)
                or not 1 <= len(raw_page_numbers) <= 500
                or any(
                    type(page_number) is not int or page_number < 1
                    for page_number in raw_page_numbers
                )
                or raw_page_numbers != list(range(1, len(raw_page_numbers) + 1))
            ):
                raise ValueError("OCR PDF page selection is invalid")
            page_numbers = tuple(raw_page_numbers)
        if (
            set(options)
            not in (
                plan_base_options,
                plan_base_options | {"pageNumbers"},
                plan_base_options | {"runtimeSha256"},
                plan_base_options | {"pageNumbers", "runtimeSha256"},
            )
            or not isinstance(max_pages, int)
            or isinstance(max_pages, bool)
            or not 1 <= max_pages <= 500
            or not isinstance(render_scale, int | float)
            or isinstance(render_scale, bool)
            or not 0.5 <= float(render_scale) <= 8
        ):
            raise ValueError("OCR PDF options are invalid")
        if page_numbers is None:
            images = _pdf_page_images(source, max_pages, float(render_scale), cancellation)
        else:
            images = _pdf_page_images(
                source,
                max_pages,
                float(render_scale),
                cancellation,
                page_numbers=page_numbers,
            )
    elif media_type in {"image/png", "image/jpeg", "image/webp"}:
        max_pixels = options.get("maxImagePixels")
        scale = options.get("renderScale", 1)
        if not isinstance(max_pixels, int) or isinstance(max_pixels, bool) or max_pixels < 1:
            raise ValueError("OCR image pixel limit is invalid")
        if (
            not isinstance(scale, int | float)
            or isinstance(scale, bool)
            or not 1 <= float(scale) <= 4
        ):
            raise ValueError("OCR image renderScale is invalid")
        if len(manifest) != 1:
            raise ValueError("OCR image page manifest must contain one page")
        normalized_png = _normalized_png(source, max_pixels, float(scale))
        width, height, actual_scale = _image_raster_metadata(source, normalized_png)
        expected = manifest[0]
        if (
            expected.raster_width != width
            or expected.raster_height != height
            or abs(expected.raster_scale - actual_scale) > 1e-6
        ):
            raise ValueError("OCR image raster metadata does not match predictor input")
        images = [(1, normalized_png)]
    else:
        raise ValueError("OCR mediaType is unsupported")
    if compute_plan is None:
        raise ValueError("OCR run requires a retained compute plan")
    source_sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    runtime_sha256_value = options.get("runtimeSha256")
    if runtime_sha256_value is not None and (
        not isinstance(runtime_sha256_value, str)
        or re.fullmatch(r"[0-9a-f]{64}", runtime_sha256_value) is None
    ):
        raise ValueError("OCR runtime SHA-256 is invalid")
    runtime_sha256 = runtime_sha256_value if isinstance(runtime_sha256_value, str) else None
    requested_page_scope = page_numbers
    adapter = WindowsMLOcrAdapter(
        model_path,
        execution_plan=compute_plan,
        stage_reporter=_report_stage,
        source_sha256=source_sha256,
        requested_page_scope=requested_page_scope,
        runtime_sha256=runtime_sha256,
    )
    ocr_request = OcrRequest(
        capture_id=source_sha256,
        source=CaptureSource(
            sha256=source_sha256,
            file_name=source.name,
            media_type=media_type,
            bytes=source.stat().st_size,
        ),
        page_scope=page_numbers,
        manifest=manifest,
        created_at=datetime.now(UTC),
        warnings=(),
        is_cancelled=cancellation.is_set,
        progress=progress,
    )
    worker_engine = _WorkerOcrEngineAdapter(adapter, images)
    outcome = _OCR_PIPELINE.extract(ocr_request, worker_engine)
    if isinstance(outcome, OcrTerminalOutcome):
        if worker_engine.last_error is not None:
            raise worker_engine.last_error
        if outcome.failure.code == "ocr_no_text":
            _report_stage("ocr-output-empty")
            raise ValueError("OCR produced no non-empty segments")
        raise ValueError(outcome.failure.message)
    final_payload: dict[str, Any] = {
        "segments": _OCR_PIPELINE._segments(outcome),
        "pages": _OCR_PIPELINE._serialize_pages(worker_engine.last_pages),
        "provenance": outcome.provenance.model_dump(mode="json", by_alias=True),
        "warnings": list(outcome.warnings),
    }
    if worker_engine.execution_proof is not None:
        final_payload["executionProof"] = worker_engine.execution_proof.to_dict()
    return final_payload


def handle(
    request: WorkerRequest,
    cancellation: Event,
    progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    if request.operation == "probe":
        return _probe(request)
    if request.operation == "preflight":
        return _preflight(request)
    if request.operation == "run":
        return _run(request, cancellation, progress)
    raise ValueError("unsupported OCR operation")


def prepare(request: WorkerRequest) -> None:
    if request.operation == "run":
        _import_ocr_runtime()


if __name__ == "__main__":
    serve(handle, prepare=prepare)
