"""Source sniffing and deterministic extraction seams."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from pypdf import PdfReader

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.constants import WHISPER_REQUIREMENT_ID, WINDOWSML_REQUIREMENT_ID
from capture_runtime.contracts import (
    CaptureEngineV1,
    CaptureSourceKind,
    CaptureSourceV1,
    PageLocatorV1,
    RawCaptureSegmentV1,
    RawCaptureV1,
    TimeLocatorV1,
    project_source_text,
)
from capture_runtime.engine_installation import EngineInstallationManager
from capture_runtime.worker_client import WorkerRunResult
from capture_runtime.worker_process import WorkerCancelledError

if TYPE_CHECKING:
    from PIL import Image

    from capture_runtime.engine_adapters import OcrAdapter, WhisperAdapter


class UnsupportedMediaError(ValueError):
    pass


class ExtractionRuntimeUnavailableError(RuntimeError):
    pass


@dataclass(frozen=True, slots=True)
class SniffedSource:
    kind: CaptureSourceKind
    media_type: str


class CaptureExtractor(Protocol):
    def sniff(self, content: bytes) -> SniffedSource: ...

    async def extract(
        self,
        content: bytes,
        source: CaptureSourceV1,
        cancel_event: asyncio.Event,
    ) -> RawCaptureV1: ...


def sniff_source(content: bytes) -> SniffedSource:
    if content.startswith(b"%PDF-"):
        return SniffedSource(CaptureSourceKind.PDF, "application/pdf")
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return SniffedSource(CaptureSourceKind.IMAGE, "image/png")
    if content.startswith(b"\xff\xd8\xff"):
        return SniffedSource(CaptureSourceKind.IMAGE, "image/jpeg")
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return SniffedSource(CaptureSourceKind.IMAGE, "image/webp")
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WAVE":
        return SniffedSource(CaptureSourceKind.AUDIO, "audio/wav")
    if content.startswith(b"ID3") or content[:2] in {b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"}:
        return SniffedSource(CaptureSourceKind.AUDIO, "audio/mpeg")
    if content.startswith(b"fLaC"):
        return SniffedSource(CaptureSourceKind.AUDIO, "audio/flac")
    if content.startswith(b"OggS"):
        return SniffedSource(CaptureSourceKind.AUDIO, "audio/ogg")
    if len(content) >= 12 and content[4:8] == b"ftyp":
        return SniffedSource(CaptureSourceKind.AUDIO, "audio/mp4")
    raise UnsupportedMediaError("Only PDF, PNG, JPEG, WebP, and common audio are supported")


class StandaloneRuntimeCaptureExtractor:
    """Production extractor using only package-owned WindowsML and Whisper adapters."""

    def __init__(
        self,
        clock: Clock,
        config: ExtractionRuntimeConfig,
        *,
        ocr_adapter: OcrAdapter | None = None,
        whisper_adapter: WhisperAdapter | None = None,
        engine_manager: EngineInstallationManager | None = None,
    ) -> None:
        self._clock = clock
        self.config = config
        self.ocr_adapter = ocr_adapter
        self.whisper_adapter = whisper_adapter
        self.engine_manager = engine_manager

    def sniff(self, content: bytes) -> SniffedSource:
        return sniff_source(content)

    async def extract(
        self,
        content: bytes,
        source: CaptureSourceV1,
        cancel_event: asyncio.Event,
    ) -> RawCaptureV1:
        if self.engine_manager is not None:
            return await self._extract_with_workers(content, source, cancel_event)
        try:
            return await asyncio.to_thread(self._extract_sync, content, source, cancel_event)
        except InterruptedError as error:
            raise asyncio.CancelledError from error

    async def _extract_with_workers(
        self,
        content: bytes,
        source: CaptureSourceV1,
        cancel_event: asyncio.Event,
    ) -> RawCaptureV1:
        sniffed = self.sniff(content)
        self._checkpoint(cancel_event)
        try:
            if sniffed.kind is CaptureSourceKind.PDF:
                segments, engine, warnings = await self._extract_pdf_with_worker(
                    content, cancel_event
                )
            elif sniffed.kind is CaptureSourceKind.IMAGE:
                result = await self._run_worker(
                    WINDOWSML_REQUIREMENT_ID,
                    content,
                    sniffed.media_type,
                    {
                        "deviceId": self.config.windowsml_device_id,
                        "maxImagePixels": self.config.max_image_pixels,
                    },
                    cancel_event,
                )
                segments = self._page_segments(result)
                engine = self._capture_engine(result, expected_engine="windowsml-ocr")
                warnings = list(result.warnings)
            else:
                result = await self._run_worker(
                    WHISPER_REQUIREMENT_ID,
                    content,
                    sniffed.media_type,
                    {
                        "maxDurationMs": self.config.max_audio_duration_ms,
                        "preferGpu": self.config.whisper_prefer_gpu,
                        "allowCpuFallback": self.config.whisper_allow_cpu_fallback,
                    },
                    cancel_event,
                )
                segments = self._time_segments(result)
                engine = self._capture_engine(result, expected_engine="whisper-primary")
                warnings = list(result.warnings)
        except WorkerCancelledError as error:
            raise asyncio.CancelledError from error
        self._checkpoint(cancel_event)
        if not segments:
            raise ValueError("Extraction produced no non-empty content.")
        return RawCaptureV1(
            source=source,
            segments=segments,
            source_text=project_source_text(segments),
            extraction_engine=engine,
            warnings=_unique_warnings(warnings),
            created_at=self._clock.now(),
        )

    async def _extract_pdf_with_worker(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
    ) -> tuple[list[RawCaptureSegmentV1], CaptureEngineV1, list[str]]:
        try:
            reader = PdfReader(BytesIO(content))
        except Exception as error:
            raise ValueError("Uploaded PDF is not readable.") from error
        if not reader.pages:
            raise ValueError("Uploaded PDF has no pages.")
        if len(reader.pages) > self.config.max_pdf_pages:
            raise ValueError(
                f"PDF has {len(reader.pages)} pages; limit is {self.config.max_pdf_pages}."
            )
        embedded: dict[int, str] = {}
        missing: list[int] = []
        for page_number, page in enumerate(reader.pages, start=1):
            self._checkpoint(cancel_event)
            try:
                text = (page.extract_text() or "").strip()
            except Exception as error:
                raise ValueError(f"Could not inspect PDF page {page_number}.") from error
            if text:
                embedded[page_number] = text
            else:
                missing.append(page_number)
        worker_result: WorkerRunResult | None = None
        worker_pages: dict[int, str] = {}
        warnings: list[str] = []
        if missing:
            worker_result = await self._run_worker(
                WINDOWSML_REQUIREMENT_ID,
                content,
                "application/pdf",
                {
                    "deviceId": self.config.windowsml_device_id,
                    "pages": missing,
                    "renderScale": self.config.ocr_render_scale,
                },
                cancel_event,
            )
            if worker_result.engine != "windowsml-ocr":
                raise ValueError("OCR worker returned incompatible engine provenance")
            if worker_result.device not in {"windowsml-dml", "cpu"}:
                raise ValueError("OCR worker returned incompatible device provenance")
            worker_pages = {
                item.page: item.text for item in worker_result.segments if item.page is not None
            }
            warnings.extend(worker_result.warnings)
        segments: list[RawCaptureSegmentV1] = []
        for page_number in range(1, len(reader.pages) + 1):
            text = embedded.get(page_number) or worker_pages.get(page_number, "")
            if text:
                segments.append(
                    RawCaptureSegmentV1(
                        segment_id=f"page-{page_number}",
                        order=len(segments),
                        locator=PageLocatorV1(page=page_number),
                        text=text,
                    )
                )
        if embedded:
            warnings.append(f"Used embedded PDF text on {len(embedded)} page(s).")
        if worker_result is not None and embedded:
            embedded_digest = pdf_embedded_engine_digest()
            digest = hashlib.sha256(
                f"{embedded_digest}:{worker_result.digest}".encode()
            ).hexdigest()
            engine = CaptureEngineV1(
                engine="pdf-embedded+windowsml-ocr",
                model=f"pypdf+{worker_result.model}",
                digest=f"sha256:{digest}",
                device=worker_result.device,
            )
        elif worker_result is not None:
            engine = self._capture_engine(worker_result, expected_engine="windowsml-ocr")
        else:
            version = importlib.metadata.version("pypdf")
            engine = CaptureEngineV1(
                engine="pdf-embedded-text",
                model=f"pypdf-{version}",
                digest=pdf_embedded_engine_digest(),
                device="cpu",
            )
        return segments, engine, warnings

    async def _run_worker(
        self,
        requirement_id: str,
        content: bytes,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
    ) -> WorkerRunResult:
        assert self.engine_manager is not None
        engine = await self.engine_manager.resolve_active_engine(requirement_id)
        if engine is None:
            raise ExtractionRuntimeUnavailableError(
                f"Runtime requirement {requirement_id} is not installed and ready."
            )
        self.config.temp_dir.mkdir(parents=True, exist_ok=True)
        suffix = {
            "application/pdf": ".pdf",
            "image/png": ".png",
            "image/jpeg": ".jpg",
            "image/webp": ".webp",
            "audio/wav": ".wav",
            "audio/mpeg": ".mp3",
            "audio/flac": ".flac",
            "audio/ogg": ".ogg",
            "audio/mp4": ".m4a",
        }.get(media_type, ".source")
        with tempfile.NamedTemporaryFile(
            prefix="capture-worker-source-",
            suffix=suffix,
            dir=self.config.temp_dir,
            delete=False,
        ) as temporary:
            temporary.write(content)
            path = Path(temporary.name).resolve()
        try:
            return await self.engine_manager.worker_client.run(
                engine,
                source_path=path,
                media_type=media_type,
                options=options,
                cancel_event=cancel_event,
            )
        finally:
            path.unlink(missing_ok=True)

    @staticmethod
    def _capture_engine(result: WorkerRunResult, *, expected_engine: str) -> CaptureEngineV1:
        if result.engine != expected_engine:
            raise ValueError("worker returned incompatible engine provenance")
        if expected_engine == "windowsml-ocr" and result.device not in {
            "windowsml-dml",
            "cpu",
        }:
            raise ValueError("OCR worker returned incompatible device provenance")
        return CaptureEngineV1(
            engine=result.engine,
            model=result.model,
            digest=result.digest,
            device=result.device,
        )

    @staticmethod
    def _page_segments(result: WorkerRunResult) -> list[RawCaptureSegmentV1]:
        return [
            RawCaptureSegmentV1(
                segment_id=f"page-{item.page}",
                order=index,
                locator=PageLocatorV1(page=item.page),
                text=item.text,
            )
            for index, item in enumerate(result.segments)
            if item.page is not None
        ]

    @staticmethod
    def _time_segments(result: WorkerRunResult) -> list[RawCaptureSegmentV1]:
        return [
            RawCaptureSegmentV1(
                segment_id=f"segment-{index + 1}",
                order=index,
                locator=TimeLocatorV1(start_ms=item.start_ms, end_ms=item.end_ms),
                text=item.text,
            )
            for index, item in enumerate(result.segments)
            if item.start_ms is not None and item.end_ms is not None
        ]

    def _extract_sync(
        self,
        content: bytes,
        source: CaptureSourceV1,
        cancel_event: asyncio.Event,
    ) -> RawCaptureV1:
        sniffed = self.sniff(content)
        self._checkpoint(cancel_event)
        if sniffed.kind is CaptureSourceKind.PDF:
            segments, engine, warnings = self._extract_pdf(content, cancel_event)
        elif sniffed.kind is CaptureSourceKind.IMAGE:
            segments, engine, warnings = self._extract_image(content, cancel_event)
        else:
            segments, engine, warnings = self._extract_audio(
                content, source.media_type, cancel_event
            )
        self._checkpoint(cancel_event)
        if not segments:
            raise ValueError("Extraction produced no non-empty content.")
        return RawCaptureV1(
            source=source,
            segments=segments,
            source_text=project_source_text(segments),
            extraction_engine=engine,
            warnings=warnings,
            created_at=self._clock.now(),
        )

    def _extract_pdf(
        self, content: bytes, cancel_event: asyncio.Event
    ) -> tuple[list[RawCaptureSegmentV1], CaptureEngineV1, list[str]]:
        try:
            reader = PdfReader(BytesIO(content))
        except Exception as error:
            raise ValueError("Uploaded PDF is not readable.") from error
        if not reader.pages:
            raise ValueError("Uploaded PDF has no pages.")
        if len(reader.pages) > self.config.max_pdf_pages:
            raise ValueError(
                f"PDF has {len(reader.pages)} pages; limit is {self.config.max_pdf_pages}."
            )
        segments: list[RawCaptureSegmentV1] = []
        warnings: list[str] = []
        ocr_results = []
        embedded_pages = 0
        for page_number, page in enumerate(reader.pages, start=1):
            self._checkpoint(cancel_event)
            try:
                embedded = (page.extract_text() or "").strip()
            except Exception as error:
                raise ValueError(f"Could not inspect PDF page {page_number}.") from error
            if embedded:
                text = embedded
                embedded_pages += 1
            else:
                if self.ocr_adapter is None:
                    raise ExtractionRuntimeUnavailableError(
                        "WindowsML OCR worker is not configured."
                    )
                image_png = self._render_pdf_page(content, page_number - 1)
                self._checkpoint(cancel_event)
                result = self.ocr_adapter.extract_png(image_png)
                ocr_results.append(result)
                text = result.text.strip()
                if result.warning:
                    warnings.append(result.warning)
            if text:
                segments.append(
                    RawCaptureSegmentV1(
                        segment_id=f"page-{page_number}",
                        order=len(segments),
                        locator=PageLocatorV1(page=page_number),
                        text=text,
                    )
                )
        if embedded_pages:
            warnings.append(f"Used embedded PDF text on {embedded_pages} page(s).")
        if ocr_results and embedded_pages:
            ocr = ocr_results[0]
            embedded_digest = pdf_embedded_engine_digest()
            digest = hashlib.sha256(f"{embedded_digest}:{ocr.digest}".encode()).hexdigest()
            engine = CaptureEngineV1(
                engine="pdf-embedded+windowsml-ocr",
                model=f"pypdf+{ocr.model}",
                digest=f"sha256:{digest}",
                device=ocr.device,
            )
        elif ocr_results:
            ocr = ocr_results[0]
            engine = CaptureEngineV1(
                engine="windowsml-ocr",
                model=ocr.model,
                digest=ocr.digest,
                device=ocr.device,
            )
        else:
            version = __import__("pypdf").__version__
            engine = CaptureEngineV1(
                engine="pdf-embedded-text",
                model=f"pypdf-{version}",
                digest=pdf_embedded_engine_digest(),
                device="cpu",
            )
        return segments, engine, _unique_warnings(warnings)

    def _render_pdf_page(self, content: bytes, page_index: int) -> bytes:
        import pypdfium2 as pdfium  # type: ignore[import-untyped]

        document = None
        bitmap = None
        try:
            document = pdfium.PdfDocument(BytesIO(content))
            bitmap = document[page_index].render(scale=self.config.ocr_render_scale)
            image = bitmap.to_pil().convert("RGB")
            output = BytesIO()
            image.save(output, format="PNG")
            return output.getvalue()
        except Exception as error:
            raise ValueError(f"Could not render PDF page {page_index + 1}.") from error
        finally:
            if bitmap is not None:
                bitmap.close()
            if document is not None:
                document.close()

    def _extract_image(
        self, content: bytes, cancel_event: asyncio.Event
    ) -> tuple[list[RawCaptureSegmentV1], CaptureEngineV1, list[str]]:
        import warnings as image_warnings

        from PIL import Image, UnidentifiedImageError

        try:
            with image_warnings.catch_warnings():
                image_warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(BytesIO(content)) as image:
                    if (image.format or "").upper() not in {"PNG", "JPEG", "WEBP"}:
                        raise ValueError("Only PNG, JPEG, and WebP images are supported.")
                    width, height = image.size
                    if width <= 0 or height <= 0:
                        raise ValueError("Image dimensions must be positive.")
                    if width * height > self.config.max_image_pixels:
                        raise ValueError("Image exceeds the configured pixel limit.")
                    if getattr(image, "n_frames", 1) != 1 or bool(
                        getattr(image, "is_animated", False)
                    ):
                        raise ValueError("Animated or multi-frame images are unsupported.")
                    image.seek(0)
                    image.load()
                    normalized_png = _normalize_image_png(image)
        except (
            OSError,
            UnidentifiedImageError,
            Image.DecompressionBombError,
            Image.DecompressionBombWarning,
        ) as error:
            raise ValueError("Uploaded image is not readable.") from error
        self._checkpoint(cancel_event)
        if self.ocr_adapter is None:
            raise ExtractionRuntimeUnavailableError("WindowsML OCR worker is not configured.")
        result = self.ocr_adapter.extract_png(normalized_png)
        text = result.text.strip()
        segments = (
            [
                RawCaptureSegmentV1(
                    segment_id="page-1",
                    order=0,
                    locator=PageLocatorV1(page=1),
                    text=text,
                )
            ]
            if text
            else []
        )
        warnings = [result.warning] if result.warning else []
        return (
            segments,
            CaptureEngineV1(
                engine="windowsml-ocr",
                model=result.model,
                digest=result.digest,
                device=result.device,
            ),
            warnings,
        )

    def _extract_audio(
        self, content: bytes, media_type: str, cancel_event: asyncio.Event
    ) -> tuple[list[RawCaptureSegmentV1], CaptureEngineV1, list[str]]:
        suffix = {
            "audio/wav": ".wav",
            "audio/mpeg": ".mp3",
            "audio/flac": ".flac",
            "audio/ogg": ".ogg",
            "audio/mp4": ".m4a",
        }.get(media_type, ".audio")
        self.config.temp_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            prefix="capture-workbench-whisper-",
            suffix=suffix,
            dir=self.config.temp_dir,
            delete=False,
        ) as temporary:
            temporary.write(content)
            path = Path(temporary.name)
        try:
            if self.whisper_adapter is None:
                raise ExtractionRuntimeUnavailableError("Whisper worker is not configured.")
            result = self.whisper_adapter.transcribe(path, should_cancel=cancel_event.is_set)
        finally:
            path.unlink(missing_ok=True)
        segments = [
            RawCaptureSegmentV1(
                segment_id=f"segment-{index + 1}",
                order=index,
                locator=TimeLocatorV1(start_ms=item.start_ms, end_ms=item.end_ms),
                text=item.text,
            )
            for index, item in enumerate(result.segments)
        ]
        warnings = [result.warning] if result.warning else []
        return (
            segments,
            CaptureEngineV1(
                engine="whisper-primary",
                model=result.model,
                digest=result.digest,
                device=result.device,
            ),
            warnings,
        )

    @staticmethod
    def _checkpoint(cancel_event: asyncio.Event) -> None:
        if cancel_event.is_set():
            raise InterruptedError("Capture extraction was cancelled.")


def _normalize_image_png(image: Image.Image) -> bytes:
    from PIL import Image, ImageOps

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


def _unique_warnings(warnings: list[str]) -> list[str]:
    return list(dict.fromkeys(warning[:500] for warning in warnings if warning.strip()))


def _engine_digest(engine: str, model: str) -> str:
    value = hashlib.sha256(f"{engine}:{model}".encode()).hexdigest()
    return f"sha256:{value}"


def pdf_embedded_engine_digest() -> str:
    version = importlib.metadata.version("pypdf")
    return _engine_digest("pypdf", version)


class DeterministicCaptureExtractor:
    """Content-sniffed fake for CI and the independently testable harness."""

    def __init__(self, clock: Clock, *, delay_seconds: float = 0) -> None:
        self._clock = clock
        self._delay_seconds = delay_seconds

    def sniff(self, content: bytes) -> SniffedSource:
        return sniff_source(content)

    async def extract(
        self,
        content: bytes,
        source: CaptureSourceV1,
        cancel_event: asyncio.Event,
    ) -> RawCaptureV1:
        sniffed = self.sniff(content)
        if self._delay_seconds:
            try:
                await asyncio.wait_for(cancel_event.wait(), timeout=self._delay_seconds)
            except TimeoutError:
                pass
        if cancel_event.is_set():
            raise asyncio.CancelledError

        text = self._fixture_text(content, sniffed.kind, source.sha256)
        if sniffed.kind is CaptureSourceKind.AUDIO:
            parts = [part.strip() for part in text.split("|") if part.strip()]
            segments = [
                RawCaptureSegmentV1(
                    segment_id=f"segment-{index + 1}",
                    order=index,
                    locator=TimeLocatorV1(
                        start_ms=index * 1000,
                        end_ms=(index + 1) * 1000,
                    ),
                    text=part,
                )
                for index, part in enumerate(parts)
            ]
            engine = CaptureEngineV1(
                engine="whisper-primary",
                model="deterministic-whisper-v1",
                digest=_engine_digest("whisper-primary", "deterministic-whisper-v1"),
                device="fake",
            )
        else:
            parts = [part.strip() for part in text.split("\f") if part.strip()]
            segments = [
                RawCaptureSegmentV1(
                    segment_id=f"segment-{index + 1}",
                    order=index,
                    locator=PageLocatorV1(page=index + 1),
                    text=part,
                )
                for index, part in enumerate(parts)
            ]
            engine = CaptureEngineV1(
                engine="windowsml-ocr",
                model="deterministic-windowsml-v1",
                digest=_engine_digest("windowsml-ocr", "deterministic-windowsml-v1"),
                device="fake",
            )
        if not segments:
            raise ValueError("extraction produced no non-empty content")
        return RawCaptureV1(
            source=source,
            segments=segments,
            source_text=project_source_text(segments),
            extraction_engine=engine,
            warnings=[],
            created_at=self._clock.now(),
        )

    @staticmethod
    def _fixture_text(content: bytes, kind: CaptureSourceKind, sha256: str) -> str:
        marker = b"CAPTURE_TEXT:"
        marker_index = content.find(marker)
        if marker_index >= 0:
            candidate = content[marker_index + len(marker) :].decode("utf-8", errors="ignore")
            candidate = candidate.strip("\x00\r\n ")
            if candidate:
                return candidate
        return f"Deterministic {kind.value} capture {sha256[:12]}"
