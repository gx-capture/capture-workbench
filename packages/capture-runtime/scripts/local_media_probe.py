"""Opt-in developer-only probe for explicit local OCR/Whisper assets.

This command is deliberately outside provisioning and release paths.  It materializes
only an ephemeral hard-link view of the caller-supplied model directories, runs the
same standalone adapters used by the production extractor, and emits redacted evidence.
It never reads the runtime catalog, installs an engine, stages the desktop, or changes
the consumer requirement state.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import re
import shutil
import tempfile
from io import StringIO
from pathlib import Path
from typing import Any

import yaml

from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.contracts import CaptureSourceV1
from capture_runtime.engine_adapters import FasterWhisperAdapter, WindowsMLOcrAdapter
from capture_runtime.extractors import StandaloneRuntimeCaptureExtractor

_DEFAULT_MAX_AUDIO_DURATION_MS = 5_400_000
_LOCAL_PATH_RE = re.compile(r"(?i)(?:[a-z]:[\\/]|\\\\)[^\"\s]+")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return f"sha256:{digest.hexdigest()}"


def _required_file(path: Path, label: str) -> Path:
    candidate = path.expanduser()
    if candidate.is_symlink():
        raise ValueError(f"{label} must be an explicit regular file")
    resolved = candidate.resolve()
    if not resolved.is_file():
        raise ValueError(f"{label} must be an explicit regular file")
    return resolved


def _required_directory(path: Path, label: str) -> Path:
    candidate = path.expanduser()
    if candidate.is_symlink():
        raise ValueError(f"{label} must be an explicit regular directory")
    resolved = candidate.resolve()
    if not resolved.is_dir():
        raise ValueError(f"{label} must be an explicit regular directory")
    return resolved


def _link_or_copy(source: Path, destination: Path) -> None:
    if source.is_symlink() or not source.is_file():
        raise ValueError(f"local model tree contains a non-regular file: {source.name}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def _materialize_tree(source: Path, destination: Path) -> None:
    files = sorted(path for path in source.rglob("*") if path.is_file())
    if not files:
        raise ValueError("local model directory is empty")
    for path in files:
        relative = path.relative_to(source)
        _link_or_copy(path, destination / relative)


def _write_ocr_contract(
    detection_source: Path,
    recognition_source: Path,
    destination: Path,
) -> None:
    detection = destination / "det"
    recognition = destination / "rec"
    _materialize_tree(detection_source, detection)
    _materialize_tree(recognition_source, recognition)
    yml_path = recognition / "inference.yml"
    try:
        payload = yaml.safe_load(yml_path.read_text(encoding="utf-8"))
        characters = payload["PostProcess"]["character_dict"]
    except (OSError, KeyError, TypeError, ValueError, yaml.YAMLError) as error:
        raise ValueError("recognition inference.yml has no readable character_dict") from error
    if (
        not isinstance(characters, list)
        or not characters
        or not all(isinstance(character, str) and character for character in characters)
    ):
        raise ValueError("recognition inference.yml character_dict is invalid")
    (recognition / "ppocrv6_dict.txt").write_text("\n".join(characters) + "\n", encoding="utf-8")
    (destination / "pipeline.json").write_text(
        json.dumps(
            {
                "developerLocalProbe": True,
                "detectionModel": "PP-OCRv6_medium_det",
                "recognitionModel": "PP-OCRv6_medium_rec",
            },
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )


def _source(path: Path, media_type: str) -> CaptureSourceV1:
    return CaptureSourceV1(
        sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
        file_name=path.name,
        media_type=media_type,
        bytes=path.stat().st_size,
    )


def _redact(value: object, paths: tuple[Path, ...]) -> str:
    text = str(value)
    for path in paths:
        text = text.replace(str(path), "<local>")
    return _LOCAL_PATH_RE.sub("<local>", text)


def _engine_payload(engine: Any) -> dict[str, object]:
    return {
        "engine": engine.engine,
        "model": engine.model,
        "device": engine.device,
        "digest": engine.digest,
    }


async def _run(arguments: argparse.Namespace) -> dict[str, object]:
    pdf = _required_file(arguments.pdf, "--pdf")
    audio = _required_file(arguments.audio, "--audio")
    detection = _required_directory(arguments.ocr_detection_dir, "--ocr-detection-dir")
    recognition = _required_directory(arguments.ocr_recognition_dir, "--ocr-recognition-dir")
    whisper_primary = _required_directory(arguments.whisper_primary_dir, "--whisper-primary-dir")
    whisper_fallback = _required_directory(arguments.whisper_fallback_dir, "--whisper-fallback-dir")
    with tempfile.TemporaryDirectory(prefix="capture-workbench-developer-probe-") as temporary:
        root = Path(temporary)
        ocr_model = root / "ocr"
        whisper_models = root / "whisper"
        _write_ocr_contract(detection, recognition, ocr_model)
        _materialize_tree(whisper_primary, whisper_models / "primary")
        _materialize_tree(whisper_fallback, whisper_models / "fallback")
        ocr = WindowsMLOcrAdapter(ocr_model)
        whisper = FasterWhisperAdapter(
            whisper_models,
            primary_model="primary",
            fallback_model="fallback",
            primary_provenance_model="large-v3-turbo",
            fallback_provenance_model="small",
            prefer_gpu=arguments.prefer_gpu,
            max_duration_ms=arguments.max_audio_duration_ms,
        )
        ocr_probe = ocr.probe()
        whisper_probe = whisper.probe()
        if not ocr_probe.ready:
            raise RuntimeError(f"local OCR probe failed: {ocr_probe.detail}")
        if not whisper_probe.ready:
            raise RuntimeError(f"local Whisper probe failed: {whisper_probe.detail}")
        extractor = StandaloneRuntimeCaptureExtractor(
            SystemClock(),
            ExtractionRuntimeConfig(
                windowsml_model_dir=ocr_model,
                whisper_models_dir=whisper_models,
                temp_dir=root / "temp",
                windowsml_device_id=0,
                max_pdf_pages=arguments.max_pdf_pages,
                max_image_pixels=50_000_000,
                ocr_render_scale=arguments.ocr_render_scale,
                max_audio_duration_ms=arguments.max_audio_duration_ms,
                whisper_primary_model="primary",
                whisper_fallback_model="fallback",
                whisper_prefer_gpu=arguments.prefer_gpu,
            ),
            ocr_adapter=ocr,
            whisper_adapter=whisper,
        )
        pdf_content = pdf.read_bytes()
        audio_content = audio.read_bytes()
        # Paddle/PaddleX may print model paths while constructing a pipeline.  Keep
        # those diagnostics out of the shell and retain only the redacted report.
        with contextlib.redirect_stdout(StringIO()), contextlib.redirect_stderr(StringIO()):
            pdf_raw = await extractor.extract(
                pdf_content, _source(pdf, "application/pdf"), asyncio.Event()
            )
            audio_raw = await extractor.extract(
                audio_content,
                _source(audio, extractor.sniff(audio_content).media_type),
                asyncio.Event(),
            )
        return {
            "evidenceKind": "developer-local-media-probe",
            "releaseGateSatisfied": False,
            "consumerE2e": False,
            "productionCatalogRead": False,
            "productionEngineStateChanged": False,
            "desktopStaged": False,
            "pdf": {
                "bytes": len(pdf_content),
                "sha256": _sha256(pdf),
                "segmentCount": len(pdf_raw.segments),
                "pageLocators": sum(1 for item in pdf_raw.segments if item.locator.kind == "page"),
                "extractionEngine": _engine_payload(pdf_raw.extraction_engine),
            },
            "audio": {
                "bytes": len(audio_content),
                "sha256": _sha256(audio),
                "segmentCount": len(audio_raw.segments),
                "timeLocators": sum(
                    1 for item in audio_raw.segments if item.locator.kind == "time"
                ),
                "extractionEngine": _engine_payload(audio_raw.extraction_engine),
            },
            "sourcePathsIncluded": False,
        }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True)
    parser.add_argument("--audio", type=Path, required=True)
    parser.add_argument("--ocr-detection-dir", type=Path, required=True)
    parser.add_argument("--ocr-recognition-dir", type=Path, required=True)
    parser.add_argument("--whisper-primary-dir", type=Path, required=True)
    parser.add_argument("--whisper-fallback-dir", type=Path, required=True)
    parser.add_argument("--max-pdf-pages", type=int, default=200)
    parser.add_argument("--ocr-render-scale", type=float, default=2.0)
    parser.add_argument("--max-audio-duration-ms", type=int, default=_DEFAULT_MAX_AUDIO_DURATION_MS)
    parser.add_argument("--prefer-gpu", action=argparse.BooleanOptionalAction, default=True)
    return parser


def main() -> int:
    arguments = _parser().parse_args()
    local_paths = tuple(
        path
        for path in (
            arguments.pdf,
            arguments.audio,
            arguments.ocr_detection_dir,
            arguments.ocr_recognition_dir,
            arguments.whisper_primary_dir,
            arguments.whisper_fallback_dir,
        )
    )
    try:
        report = asyncio.run(_run(arguments))
    except Exception as error:
        print(
            json.dumps(
                {
                    "evidenceKind": "developer-local-media-probe",
                    "releaseGateSatisfied": False,
                    "error": _redact(error, local_paths),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
        )
        return 1
    rendered = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    print(rendered, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
