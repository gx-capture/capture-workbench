"""Standalone WindowsML OCR and faster-whisper engine adapters.

The adapters deliberately own their dependency and model probes. They never import a host
application package, never download during extraction, and report the exact missing runtime
asset instead of substituting deterministic content.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import importlib.util
import sys
import tempfile
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from types import ModuleType
from typing import Any, Protocol

WINDOWSML_MODEL_NAME = "pp-ocrv6-medium-windowsml"
WINDOWSML_REQUIRED_MODEL_FILES = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocr_keys_v1.txt",
    "pipeline.json",
)
WHISPER_REQUIRED_FILES = (
    "config.json",
    "model.bin",
    "tokenizer.json",
)


class EngineRuntimeUnavailableError(RuntimeError):
    """Raised when installed code or local model assets cannot serve extraction."""


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
        self, source_path: Path, *, should_cancel: Callable[[], bool]
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


def _package_version_digest(package: str) -> str:
    version = importlib.metadata.version(package)
    return f"sha256:{hashlib.sha256(f'{package}:{version}'.encode()).hexdigest()}"


def _paddle_texts(results: Any) -> list[str]:
    texts: list[str] = []
    sequence = results if isinstance(results, list | tuple) else [results]
    for result in sequence:
        payload = getattr(result, "json", None)
        if not isinstance(payload, dict):
            to_dict = getattr(result, "to_dict", None)
            payload = to_dict() if callable(to_dict) else {}
        data = payload.get("res", {}) if isinstance(payload, dict) else {}
        recognized = data.get("rec_texts", []) if isinstance(data, dict) else []
        if isinstance(recognized, list):
            texts.extend(str(value).strip() for value in recognized if str(value).strip())
    return texts


class WindowsMLOcrAdapter:
    """PaddleOCR 3.7 ONNX pipeline with DML-first and strict CPU fallback."""

    def __init__(
        self,
        model_dir: Path,
        *,
        device_id: int = 0,
        pipeline_factory: Callable[..., Any] | None = None,
        provider_resolver: Callable[[], list[str]] | None = None,
    ) -> None:
        self.model_dir = model_dir
        self.device_id = device_id
        self._pipeline_factory = pipeline_factory
        self._provider_resolver = provider_resolver
        self._pipeline: Any | None = None
        self._device = "windowsml-dml"
        self._warning: str | None = None
        self._model_digest: str | None = None
        self._lock = Lock()

    def probe(self) -> EngineProbe:
        missing_modules = [
            module
            for module in ("onnxruntime", "paddleocr")
            if importlib.util.find_spec(module) is None
            and not (self._pipeline_factory is not None and self._provider_resolver is not None)
        ]
        missing_files = [
            relative
            for relative in WINDOWSML_REQUIRED_MODEL_FILES
            if not (self.model_dir / relative).is_file()
        ]
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
                return EngineProbe(False, True, True, f"Provider probe failed: {error}")
            if "CPUExecutionProvider" not in providers:
                return EngineProbe(
                    False,
                    True,
                    True,
                    "CPUExecutionProvider is required for deterministic fallback.",
                )
            detail = (
                "WindowsML DML and CPU fallback are ready."
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
            return self._extract_png_locked(image_png)

    def _extract_png_locked(self, image_png: bytes) -> OcrTextResult:
        probe = self.probe()
        if not probe.ready:
            raise EngineRuntimeUnavailableError(probe.detail)
        try:
            pipeline = self._get_pipeline()
            results = self._predict(pipeline, image_png)
        except Exception as error:
            if self._device == "cpu":
                raise
            raise EngineRuntimeUnavailableError(
                "WindowsML DirectML OCR execution failed while a GPU provider was available; "
                "CPU fallback is disabled: "
                f"{type(error).__name__}: {error}"
            ) from error
        if self._model_digest is None:
            self._model_digest = _directory_digest(self.model_dir, WINDOWSML_REQUIRED_MODEL_FILES)
        return OcrTextResult(
            text="\n".join(_paddle_texts(results)),
            device=self._device,
            model=WINDOWSML_MODEL_NAME,
            digest=self._model_digest,
            warning=self._warning,
        )

    def _providers(self) -> list[str]:
        if self._provider_resolver is not None:
            return list(self._provider_resolver())
        import onnxruntime as ort

        return list(ort.get_available_providers())

    def _get_pipeline(self) -> Any:
        if self._pipeline is not None:
            return self._pipeline
        providers = self._providers()
        use_dml = self._device != "cpu" and "DmlExecutionProvider" in providers
        if not use_dml:
            self._device = "cpu"
            if self._warning is None and "DmlExecutionProvider" not in providers:
                self._warning = "DmlExecutionProvider is unavailable; CPU OCR fallback was used."
        provider_names = ["CPUExecutionProvider"]
        provider_options: list[dict[str, Any]] = [{}]
        if use_dml:
            provider_names.insert(0, "DmlExecutionProvider")
            provider_options.insert(0, {"device_id": self.device_id})
        factory = self._pipeline_factory
        if factory is None:
            _install_offline_aistudio_stubs()
            from paddleocr import PaddleOCR

            factory = PaddleOCR
        self._pipeline = factory(
            text_detection_model_name="PP-OCRv6_medium_det",
            text_detection_model_dir=str(self.model_dir / "det"),
            text_recognition_model_name="PP-OCRv6_medium_rec",
            text_recognition_model_dir=str(self.model_dir / "rec"),
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            engine="onnxruntime",
            engine_config={
                "providers": provider_names,
                "provider_options": provider_options,
                "enable_mem_pattern": False,
                "execution_mode": "sequential",
            },
        )
        return self._pipeline

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


def _resource_failure(error: BaseException) -> bool:
    message = str(error).lower()
    return any(token in message for token in ("out of memory", "cuda", "cudnn", "cublas", "driver"))


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


class FasterWhisperAdapter:
    """Local-only faster-whisper adapter with bounded segments and CPU fallback."""

    def __init__(
        self,
        models_dir: Path,
        *,
        primary_model: str,
        fallback_model: str,
        prefer_gpu: bool,
        max_duration_ms: int,
        model_factory: Callable[..., Any] | None = None,
        cuda_count: Callable[[], int] | None = None,
    ) -> None:
        self.models_dir = models_dir
        self.primary_model = primary_model
        self.fallback_model = fallback_model
        self.prefer_gpu = prefer_gpu
        self.max_duration_ms = max_duration_ms
        self._model_factory = model_factory
        self._cuda_count = cuda_count

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
        self, source_path: Path, *, should_cancel: Callable[[], bool]
    ) -> WhisperTranscriptionResult:
        probe = self.probe()
        if not probe.ready:
            raise EngineRuntimeUnavailableError(probe.detail)
        if should_cancel():
            raise InterruptedError("Whisper transcription was cancelled.")
        use_gpu = self.prefer_gpu and self._cuda_devices() > 0
        if use_gpu:
            try:
                return self._run(
                    source_path,
                    model=self.primary_model,
                    device="cuda",
                    compute_type="float16",
                    should_cancel=should_cancel,
                )
            except InterruptedError:
                raise
            except Exception as error:
                if not _resource_failure(error):
                    raise
                return self._run(
                    source_path,
                    model=self.fallback_model,
                    device="cpu",
                    compute_type="int8",
                    should_cancel=should_cancel,
                    warning=f"Whisper GPU fallback: {error}"[:500],
                )
        return self._run(
            source_path,
            model=self.fallback_model,
            device="cpu",
            compute_type="int8",
            should_cancel=should_cancel,
        )

    def _cuda_devices(self) -> int:
        if self._cuda_count is not None:
            return self._cuda_count()
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
        device: str,
        compute_type: str,
        should_cancel: Callable[[], bool],
        warning: str | None = None,
    ) -> WhisperTranscriptionResult:
        factory = self._model_factory
        if factory is None:
            from faster_whisper import WhisperModel

            factory = WhisperModel
        model_root = self.model_path(model)
        runtime = factory(str(model_root), device=device, compute_type=compute_type)
        raw_segments, info = runtime.transcribe(
            str(source_path), beam_size=5, vad_filter=True, word_timestamps=False
        )
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
        if not segments:
            raise ValueError("Whisper produced no non-empty segments.")
        return WhisperTranscriptionResult(
            segments=tuple(segments),
            duration_ms=duration_ms,
            device=device,
            model=model,
            digest=_directory_digest(model_root),
            warning=warning,
        )


def pdf_embedded_engine_digest() -> str:
    return _package_version_digest("pypdf")


__all__ = [
    "EngineProbe",
    "EngineRuntimeUnavailableError",
    "FasterWhisperAdapter",
    "OcrAdapter",
    "OcrTextResult",
    "WhisperAdapter",
    "WhisperTextSegment",
    "WhisperTranscriptionResult",
    "WindowsMLOcrAdapter",
    "pdf_embedded_engine_digest",
]
