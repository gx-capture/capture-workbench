"""Separately packaged WindowsML OCR worker."""

from __future__ import annotations

import warnings
from io import BytesIO
from pathlib import Path
from threading import Event
from typing import Any

import pypdfium2 as pdfium  # type: ignore[import-untyped]
from PIL import Image, ImageOps, UnidentifiedImageError

from capture_runtime.engine_adapters import WindowsMLOcrAdapter
from capture_runtime.worker_contracts import WorkerRequest
from capture_runtime.workers.server import serve

MAX_SOURCE_BYTES = 50 * 1024 * 1024


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
    if not isinstance(options, dict) or set(options) - {"deviceId"}:
        raise ValueError("OCR probe options are invalid")
    device_id = options.get("deviceId", 0)
    if not isinstance(device_id, int) or isinstance(device_id, bool) or device_id < 0:
        raise ValueError("OCR probe deviceId is invalid")
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
    adapter = WindowsMLOcrAdapter(model_path, device_id=device_id)
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


def _normalized_png(source: Path, max_pixels: int) -> bytes:
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


def _render_page(source: Path, page_index: int, scale: float) -> bytes:
    document = None
    bitmap = None
    try:
        document = pdfium.PdfDocument(str(source))
        if not 0 <= page_index < len(document):
            raise ValueError("PDF page index is invalid")
        bitmap = document[page_index].render(scale=scale)
        image = bitmap.to_pil().convert("RGB")
        output = BytesIO()
        image.save(output, format="PNG")
        return output.getvalue()
    finally:
        if bitmap is not None:
            bitmap.close()
        if document is not None:
            document.close()


def _run(request: WorkerRequest, cancellation: Event) -> dict[str, Any]:
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
    adapter = WindowsMLOcrAdapter(
        model_path,
        device_id=int(options.get("deviceId", 0)),
    )
    images: list[tuple[int, bytes]]
    if media_type == "application/pdf":
        pages = options.get("pages")
        scale = options.get("renderScale")
        if (
            not isinstance(pages, list)
            or not pages
            or len(pages) > 500
            or any(
                not isinstance(page, int) or isinstance(page, bool) or page < 1 for page in pages
            )
            or len(set(pages)) != len(pages)
            or not isinstance(scale, int | float)
            or isinstance(scale, bool)
            or not 0.5 <= float(scale) <= 8
        ):
            raise ValueError("OCR PDF options are invalid")
        images = [(page, _render_page(source, page - 1, float(scale))) for page in pages]
    elif media_type in {"image/png", "image/jpeg", "image/webp"}:
        max_pixels = options.get("maxImagePixels")
        if not isinstance(max_pixels, int) or isinstance(max_pixels, bool) or max_pixels < 1:
            raise ValueError("OCR image pixel limit is invalid")
        images = [(1, _normalized_png(source, max_pixels))]
    else:
        raise ValueError("OCR mediaType is unsupported")
    segments: list[dict[str, Any]] = []
    results = []
    warning_values: list[str] = []
    for page, image in images:
        if cancellation.is_set():
            raise InterruptedError
        result = adapter.extract_png(image)
        results.append(result)
        if result.text.strip():
            segments.append(
                {
                    "order": len(segments),
                    "text": result.text.strip(),
                    "page": page,
                    "startMs": None,
                    "endMs": None,
                }
            )
        if result.warning:
            warning_values.append(result.warning)
    if not results:
        raise ValueError("OCR produced no results")
    provenance = results[0]
    return {
        "segments": segments,
        "provenance": {
            "engine": "windowsml-ocr",
            "model": provenance.model,
            "digest": provenance.digest,
            "device": provenance.device,
        },
        "warnings": list(dict.fromkeys(warning_values)),
    }


def handle(request: WorkerRequest, cancellation: Event) -> dict[str, Any]:
    if request.operation == "probe":
        return _probe(request)
    if request.operation == "run":
        return _run(request, cancellation)
    raise ValueError("unsupported OCR operation")


if __name__ == "__main__":
    serve(handle)
