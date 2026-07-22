"""Source sniffing and deterministic extraction seams."""

from __future__ import annotations

import asyncio
import hashlib
import tempfile
import warnings as image_warnings
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Protocol

import pypdfium2 as pdfium  # type: ignore[import-untyped]
from PIL import Image, ImageOps, UnidentifiedImageError
from pypdf import PdfReader

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig
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
from capture_runtime.engine_adapters import (
    EngineRuntimeUnavailableError,
    FasterWhisperAdapter,
    OcrAdapter,
    WhisperAdapter,
    WindowsMLOcrAdapter,
    pdf_embedded_engine_digest,
)


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
    ) -> None:
        self._clock = clock
        self.config = config
        self.ocr_adapter = ocr_adapter or WindowsMLOcrAdapter(
            config.windowsml_model_dir, device_id=config.windowsml_device_id
        )
        self.whisper_adapter = whisper_adapter or FasterWhisperAdapter(
            config.whisper_models_dir,
            primary_model=config.whisper_primary_model,
            fallback_model=config.whisper_fallback_model,
            prefer_gpu=config.whisper_prefer_gpu,
            max_duration_ms=config.max_audio_duration_ms,
        )

    def sniff(self, content: bytes) -> SniffedSource:
        return sniff_source(content)

    async def extract(
        self,
        content: bytes,
        source: CaptureSourceV1,
        cancel_event: asyncio.Event,
    ) -> RawCaptureV1:
        try:
            return await asyncio.to_thread(self._extract_sync, content, source, cancel_event)
        except EngineRuntimeUnavailableError as error:
            raise ExtractionRuntimeUnavailableError(str(error)) from error
        except InterruptedError as error:
            raise asyncio.CancelledError from error

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
