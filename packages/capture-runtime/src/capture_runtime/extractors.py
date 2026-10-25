"""Source sniffing and deterministic extraction seams."""

from __future__ import annotations

import asyncio
import hashlib
import math
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.constants import (
    DIARIZATION_REQUIREMENT_ID,
    SPEECH_RECOGNITION_REQUIREMENT_ID,
    VERTICAL_READER_REQUIREMENT_ID,
    WINDOWSML_REQUIREMENT_ID,
)
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureOcrProjectionV3,
    CaptureSource,
    CaptureSourceKind,
    CaptureSpeaker,
    OcrPageScopeV2,
    OcrPageStatus,
    OcrProvenanceV3,
    PageLocator,
    RawCapture,
    RawCaptureSegment,
    TimeLocator,
    project_source_text,
)
from capture_runtime.engine_adapters import PaddleResultNormalizationError
from capture_runtime.engine_catalog import EngineCatalogError
from capture_runtime.engine_installation import EngineInstallationManager
from capture_runtime.image_normalization import bounded_scaled_dimensions, ocr_image_scale
from capture_runtime.ocr_execution_proof import (
    OcrExecutionDeviceProofV1,
    acceptance_ocr_execution_runtime_sha256_from_environment,
)
from capture_runtime.ocr_profile import EngineRuntimeUnavailableError
from capture_runtime.ocr_projection import (
    OcrEngineFailure,
    OcrEngineRequest,
    OcrEngineRun,
    OcrExtractionFailure,
    OcrPageInput,
    OcrPageManifest,
    OcrPipeline,
    OcrRequest,
    OcrTerminalOutcome,
)
from capture_runtime.ocr_vertical_routing import (
    MODEL_SUBDIRECTORY as VERTICAL_READER_SUBDIRECTORY,
)
from capture_runtime.pdf_page_selection import is_ascending_page_numbers, is_pdf_page_selection
from capture_runtime.speaker_alignment import TimedWord, speaker_samples, speaker_segments
from capture_runtime.worker_client import (
    OcrWorkerFailure,
    WorkerDiarizationResult,
    WorkerOcrProgress,
    WorkerRunResult,
)
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS, WorkerCancelledError

if TYPE_CHECKING:
    from PIL import Image

    from capture_runtime.engine_adapters import OcrAdapter, WhisperAdapter


class UnsupportedMediaError(ValueError):
    pass


class ExtractionRuntimeUnavailableError(RuntimeError):
    pass


class OcrSourcePreflightError(RuntimeError):
    """A source manifest could not be established before OCR execution."""

    def __init__(self) -> None:
        super().__init__("OCR source preflight failed.")


class PdfPageSelectionError(ValueError):
    """The requested PDF pages are not all in the source, or are too many to read.

    The message names only page numbers and counts, so it is safe to report.
    """


@dataclass(frozen=True, slots=True)
class SniffedSource:
    kind: CaptureSourceKind
    media_type: str


@dataclass(frozen=True, slots=True)
class CaptureExtractionOutcome:
    """Typed extraction result carrying raw data and optional OCR projection."""

    raw: RawCapture
    ocr_projection: CaptureOcrProjectionV3 | None = None
    # Private worker receipt retained until the owning capture reaches success.
    _execution_proof: OcrExecutionDeviceProofV1 | None = None


class CaptureExtractor(Protocol):
    def sniff(self, content: bytes) -> SniffedSource: ...

    async def extract(
        self,
        content: bytes,
        source: CaptureSource,
        cancel_event: asyncio.Event,
        *,
        pdf_page_numbers: tuple[int, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
        identify_speakers: bool = False,
        speaker_progress: Callable[[str, int], None] | None = None,
    ) -> CaptureExtractionOutcome: ...


class _SyncOcrEngineAdapter:
    """Local rasterizer + WindowsML adapter behind the OCR engine port."""

    def __init__(
        self,
        extractor: StandaloneRuntimeCaptureExtractor,
        content: bytes,
        source_kind: CaptureSourceKind,
        raster_pages: tuple[bytes, ...] | None = None,
    ) -> None:
        self._extractor = extractor
        self._content = content
        self._source_kind = source_kind
        self._raster_pages = raster_pages

    def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
        adapter = self._extractor.ocr_adapter
        if adapter is None:
            raise OcrEngineFailure(kind="unavailable", completed_pages=())
        pages: list[OcrPageInput] = []
        warnings: list[str] = []
        provenance: OcrProvenanceV3 | None = None
        for expected in request.manifest:
            self._check_cancelled(request)
            image_png: bytes | None = None
            try:
                if self._raster_pages is not None:
                    image_png = self._raster_pages[expected.page - 1]
                elif self._source_kind is CaptureSourceKind.PDF:
                    image_png = self._extractor._render_pdf_page(self._content, expected.page - 1)
                else:
                    image_png = _normalize_image_content(
                        self._content,
                        scale=self._extractor.config.ocr_render_scale,
                        max_pixels=self._extractor.config.max_image_pixels,
                    )
                self._check_cancelled(request)
                try:
                    result = adapter.extract_png(image_png)
                except PaddleResultNormalizationError:
                    if request.is_cancelled():
                        raise InterruptedError("Capture extraction was cancelled.") from None
                    raise
                except RuntimeError as error:
                    if request.is_cancelled():
                        raise InterruptedError("Capture extraction was cancelled.") from error
                    raise OcrEngineFailure(
                        kind="unavailable",
                        completed_pages=pages,
                        provenance=provenance,
                    ) from error
                self._check_cancelled(request)
                current = result.provenance or self._provenance(result)
                pages.append(request.observe(expected, result, current))
                if result.warning:
                    warnings.append(result.warning)
                if provenance is None:
                    provenance = current
            finally:
                # Do not leave a completed page raster in an exception traceback
                # while the next page is being rendered.
                image_png = None
        self._check_cancelled(request)
        if provenance is None:
            raise OcrEngineFailure(kind="worker", completed_pages=pages)
        return OcrEngineRun(
            pages=tuple(pages),
            provenance=provenance,
            warnings=tuple(_unique_warnings(warnings)),
        )

    def _provenance(self, result: object) -> OcrProvenanceV3:
        return self._extractor.ocr_pipeline.observation_provenance(result)

    @staticmethod
    def _check_cancelled(request: OcrEngineRequest) -> None:
        if request.is_cancelled():
            raise InterruptedError("Capture extraction was cancelled.")


class _WorkerOcrEngineAdapter:
    """Remote-owned worker result adapter; no worker transport leaks into policy."""

    def __init__(
        self,
        result: WorkerRunResult,
        engine: OcrProvenanceV3,
    ) -> None:
        self._result = result
        self._engine = engine

    def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
        self._check_cancelled(request)
        try:
            self._validate_terminal_result(request.manifest)
        except InterruptedError:
            raise
        except Exception as error:
            # Validate the complete terminal envelope before normalizing a page so
            # an extra/unknown locator cannot become raw capture text first.
            if request.is_cancelled():
                raise InterruptedError("Capture extraction was cancelled.") from error
            raise OcrEngineFailure(
                kind="protocol",
                completed_pages=(),
                provenance=self._engine,
            ) from error
        self._check_cancelled(request)

        pages: list[OcrPageInput] = []
        try:
            for expected, actual in zip(request.manifest, self._result.pages, strict=True):
                self._check_cancelled(request)
                pages.append(request.observe(expected, actual, self._engine))
        except InterruptedError:
            raise
        except Exception as error:
            if request.is_cancelled():
                raise InterruptedError("Capture extraction was cancelled.") from error
            raise OcrEngineFailure(kind="protocol", completed_pages=pages) from error
        self._check_cancelled(request)
        return OcrEngineRun(
            pages=tuple(pages),
            provenance=self._engine,
            warnings=tuple(self._result.warnings),
        )

    @staticmethod
    def _check_cancelled(request: OcrEngineRequest) -> None:
        if request.is_cancelled():
            raise InterruptedError("Capture extraction was cancelled.")

    def _validate_terminal_result(self, manifest: tuple[OcrPageManifest, ...]) -> None:
        expected_numbers = tuple(item.page for item in manifest)
        if not expected_numbers or not is_ascending_page_numbers(expected_numbers):
            raise ValueError("OCR manifest page numbers are not canonical")

        actual_numbers = tuple(item.page for item in self._result.pages)
        if any(type(number) is not int for number in actual_numbers) or (
            actual_numbers != expected_numbers
        ):
            raise ValueError("OCR worker terminal page cardinality or order is invalid")

        previous_page: int | None = None
        for segment in self._result.segments:
            page_number = segment.page
            if (
                type(page_number) is not int
                or page_number not in expected_numbers
                or segment.start_ms is not None
                or segment.end_ms is not None
            ):
                raise ValueError("OCR worker terminal segment locator is invalid")
            if previous_page is not None and page_number <= previous_page:
                raise ValueError("OCR worker terminal segment page mapping is not unique")
            previous_page = page_number


class _OcrWorkerFailureEngineAdapter:
    """Re-enter the canonical pipeline for a worker's sanitized terminal error."""

    def __init__(
        self,
        *,
        kind: Literal["timeout", "protocol", "worker", "unavailable"],
        completed_pages: tuple[OcrPageInput, ...],
        provenance: OcrProvenanceV3 | None,
    ) -> None:
        self._kind = kind
        self._completed_pages = completed_pages
        self._provenance = provenance

    def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
        if request.is_cancelled():
            raise InterruptedError("Capture extraction was cancelled.")
        raise OcrEngineFailure(
            kind=self._kind,
            completed_pages=self._completed_pages,
            provenance=self._provenance,
        )


SNIFF_BYTES = 200
"""How much of a source's start `sniff_source` needs (MPEG-TS repeats its sync byte at 188)."""

_MP4_BOX_TYPES = frozenset({b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip", b"pnot"})

# The suffix a worker's copy of a source gets; decoders sniff the content, so
# the suffix only has to be plausible.
_SOURCE_SUFFIXES = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "audio/wav": ".wav",
    "audio/mpeg": ".mp3",
    "audio/aac": ".aac",
    "audio/flac": ".flac",
    "audio/ogg": ".ogg",
    "audio/mp4": ".m4a",
    "audio/amr": ".amr",
    "audio/aiff": ".aiff",
    "audio/x-caf": ".caf",
    "video/quicktime": ".mov",
    "video/x-matroska": ".mkv",
    "video/x-ms-asf": ".asf",
    "video/x-msvideo": ".avi",
    "video/x-flv": ".flv",
    "video/mpeg": ".mpg",
    "video/mp2t": ".ts",
}


def sniff_source(content: bytes) -> SniffedSource:
    """The kind of a source and its media type, from the signature of its first bytes.

    Audio is whatever FFmpeg decodes: recordings arrive as phone memos (M4A,
    3GP, AMR), dictaphone files (WMA, MP3), and meetings or hearings recorded
    as video (MP4, MOV, MKV, WebM, AVI, MPEG-TS), whose audio track is
    transcribed.
    """
    if content.startswith(b"%PDF-"):
        return SniffedSource(CaptureSourceKind.PDF, "application/pdf")
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return SniffedSource(CaptureSourceKind.IMAGE, "image/png")
    if content.startswith(b"\xff\xd8\xff"):
        return SniffedSource(CaptureSourceKind.IMAGE, "image/jpeg")
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return SniffedSource(CaptureSourceKind.IMAGE, "image/webp")
    media_type = _audio_media_type(content)
    if media_type is not None:
        return SniffedSource(CaptureSourceKind.AUDIO, media_type)
    raise UnsupportedMediaError(
        "Only PDF, PNG, JPEG, WebP, and audio or video recordings are supported"
    )


def _audio_media_type(content: bytes) -> str | None:
    if len(content) >= 12 and content[:4] == b"RIFF":
        return {b"WAVE": "audio/wav", b"AVI ": "video/x-msvideo"}.get(content[8:12])
    if content.startswith(b"ID3"):
        return "audio/mpeg"
    if len(content) >= 2 and content[0] == 0xFF and content[1] & 0xE0 == 0xE0:
        # Both open with an 11-bit sync word; ADTS marks its layer bits zero.
        return "audio/aac" if content[1] & 0x06 == 0 else "audio/mpeg"
    if content.startswith(b"fLaC"):
        return "audio/flac"
    if content.startswith(b"OggS"):
        return "audio/ogg"
    if len(content) >= 12 and content[4:8] == b"ftyp":
        return "audio/mp4"
    if len(content) >= 8 and content[4:8] in _MP4_BOX_TYPES:
        return "video/quicktime"
    if content.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/x-matroska"
    if content.startswith(b"\x30\x26\xb2\x75\x8e\x66\xcf\x11"):
        return "video/x-ms-asf"
    if content.startswith(b"#!AMR"):
        return "audio/amr"
    if len(content) >= 12 and content[:4] == b"FORM" and content[8:12] in {b"AIFF", b"AIFC"}:
        return "audio/aiff"
    if content.startswith(b"caff"):
        return "audio/x-caf"
    if content.startswith(b"FLV"):
        return "video/x-flv"
    if content.startswith(b"\x00\x00\x01\xba"):
        return "video/mpeg"
    if len(content) > 188 and content[0] == 0x47 and content[188] == 0x47:
        return "video/mp2t"
    return None


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
        contract_sha256: str | None = None,
    ) -> None:
        self._clock = clock
        self.config = config
        self.ocr_adapter = ocr_adapter
        self.whisper_adapter = whisper_adapter
        self.engine_manager = engine_manager
        self._contract_sha256 = contract_sha256
        self.ocr_pipeline = OcrPipeline()

    def sniff(self, content: bytes) -> SniffedSource:
        return sniff_source(content)

    async def extract(
        self,
        content: bytes,
        source: CaptureSource,
        cancel_event: asyncio.Event,
        *,
        pdf_page_numbers: tuple[int, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
        identify_speakers: bool = False,
        speaker_progress: Callable[[str, int], None] | None = None,
    ) -> CaptureExtractionOutcome:
        if self.engine_manager is not None:
            return await self._extract_with_workers(
                content,
                source,
                cancel_event,
                pdf_page_numbers=pdf_page_numbers,
                ocr_progress=ocr_progress,
                identify_speakers=identify_speakers,
                speaker_progress=speaker_progress,
            )
        if identify_speakers:
            raise ExtractionRuntimeUnavailableError(
                "Speaker identification needs the installed worker runtime."
            )
        try:
            return await asyncio.to_thread(
                self._extract_sync,
                content,
                source,
                cancel_event,
                pdf_page_numbers,
            )
        except InterruptedError as error:
            raise asyncio.CancelledError from error

    async def _extract_with_workers(
        self,
        content: bytes,
        source: CaptureSource,
        cancel_event: asyncio.Event,
        *,
        pdf_page_numbers: tuple[int, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
        identify_speakers: bool = False,
        speaker_progress: Callable[[str, int], None] | None = None,
    ) -> CaptureExtractionOutcome:
        sniffed = self.sniff(content)
        self._checkpoint(cancel_event)
        ocr_projection = None
        expected_ocr_pages: tuple[OcrPageManifest, ...] | None = None
        ocr_page_scope: OcrPageScopeV2 | None = None
        execution_proof: OcrExecutionDeviceProofV1 | None = None
        diarization_engine: CaptureEngine | None = None
        speakers: list[CaptureSpeaker] = []
        suggested_units: set[str] = set()
        try:
            if sniffed.kind is CaptureSourceKind.PDF:
                expected_ocr_pages = self._preflight_pdf_manifest(
                    content,
                    cancel_event,
                    page_numbers=pdf_page_numbers,
                )
                source_page_count = self._pdf_page_count(content)
                try:
                    result = await self._extract_pdf_with_worker(
                        content,
                        cancel_event,
                        page_manifest=expected_ocr_pages,
                        page_numbers=pdf_page_numbers,
                        ocr_progress=ocr_progress,
                    )
                except (ExtractionRuntimeUnavailableError, EngineRuntimeUnavailableError) as error:
                    raise OcrWorkerFailure(kind="unavailable", progress=None) from error
                execution_proof = result.execution_proof
                try:
                    engine = self._capture_engine(result, expected_engine="windowsml-ocr")
                    suggested_units.update(result.suggested_units)
                    ocr_provenance = self._capture_ocr_provenance(result)
                except ValueError as error:
                    raise OcrWorkerFailure(
                        kind="protocol",
                        progress=result.ocr_progress,
                    ) from error
                warnings = list(result.warnings)
                try:
                    ocr_projection = self._worker_projection(
                        source,
                        result,
                        ocr_provenance,
                        cancel_event=cancel_event,
                        expected_pages=expected_ocr_pages,
                    )
                except OcrExtractionFailure:
                    raise
                except ValueError as error:
                    raise OcrWorkerFailure(
                        kind="protocol",
                        progress=result.ocr_progress,
                    ) from error
                self._validate_worker_segments_against_projection(result, ocr_projection)
                segments = _projection_segments(ocr_projection)
                ocr_page_scope = OcrPageScopeV2(
                    source_page_count=source_page_count,
                    requested_page_numbers=[page.page for page in expected_ocr_pages],
                    processed_page_numbers=[page.page for page in result.pages],
                )
            elif sniffed.kind is CaptureSourceKind.IMAGE:
                if pdf_page_numbers is not None:
                    raise ValueError("PDF page selection is only valid for PDF sources.")
                expected_ocr_pages = self._preflight_image_manifest(content, cancel_event)
                try:
                    result = await self._run_worker(
                        WINDOWSML_REQUIREMENT_ID,
                        content,
                        sniffed.media_type,
                        {
                            "maxImagePixels": self.config.max_image_pixels,
                            "renderScale": _image_ocr_scale(content, self.config.ocr_render_scale),
                        },
                        cancel_event,
                        page_manifest=expected_ocr_pages,
                        ocr_progress=ocr_progress,
                    )
                except (ExtractionRuntimeUnavailableError, EngineRuntimeUnavailableError) as error:
                    raise OcrWorkerFailure(kind="unavailable", progress=None) from error
                execution_proof = result.execution_proof
                try:
                    engine = self._capture_engine(result, expected_engine="windowsml-ocr")
                    suggested_units.update(result.suggested_units)
                    ocr_provenance = self._capture_ocr_provenance(result)
                except ValueError as error:
                    raise OcrWorkerFailure(
                        kind="protocol",
                        progress=result.ocr_progress,
                    ) from error
                warnings = list(result.warnings)
                try:
                    ocr_projection = self._worker_projection(
                        source,
                        result,
                        ocr_provenance,
                        cancel_event=cancel_event,
                        expected_pages=expected_ocr_pages,
                    )
                except OcrExtractionFailure:
                    raise
                except ValueError as error:
                    raise OcrWorkerFailure(
                        kind="protocol",
                        progress=result.ocr_progress,
                    ) from error
                self._validate_worker_segments_against_projection(result, ocr_projection)
                segments = _projection_segments(ocr_projection)
            else:
                if pdf_page_numbers is not None:
                    raise ValueError("PDF page selection is only valid for PDF sources.")
                result = await self._run_worker(
                    SPEECH_RECOGNITION_REQUIREMENT_ID,
                    content,
                    sniffed.media_type,
                    {
                        "maxDurationMs": self.config.max_audio_duration_ms,
                        "preferGpu": self.config.whisper_prefer_gpu,
                        "allowCpuFallback": self.config.whisper_allow_cpu_fallback,
                        **({"wordTimestamps": True} if identify_speakers else {}),
                    },
                    cancel_event,
                    progress=_stage_progress(speaker_progress, "transcribing", 0, 450),
                    timeout_seconds=_audio_run_timeout_seconds(
                        content, self.config.max_audio_duration_ms
                    ),
                )
                engine = self._capture_engine(result, expected_engine="speech-recognition")
                warnings = list(result.warnings)
                if identify_speakers:
                    diarization = await self._run_diarization(
                        content,
                        sniffed.media_type,
                        cancel_event,
                        _stage_progress(speaker_progress, "identifying-speakers", 450, 1000),
                        timeout_seconds=_audio_run_timeout_seconds(
                            content, self.config.max_audio_duration_ms
                        ),
                    )
                    segments, speakers = _speaker_capture_segments(result, diarization)
                    diarization_engine = CaptureEngine(
                        engine=diarization.engine,
                        model=diarization.model,
                        digest=diarization.digest,
                        device=diarization.device,
                        elapsed_ms=diarization.elapsed_ms,
                        stage_ms=diarization.stage_ms,
                    )
                    warnings.extend(diarization.warnings)
                else:
                    segments = self._time_segments(result)
        except WorkerCancelledError as error:
            raise asyncio.CancelledError from error
        except OcrWorkerFailure as error:
            if expected_ocr_pages is None:
                raise
            raise self._ocr_extraction_failure(
                source,
                expected_ocr_pages,
                error,
                cancel_event=cancel_event,
            ) from error
        self._checkpoint(cancel_event)
        if not segments:
            raise ValueError("Extraction produced no non-empty content.")
        raw = RawCapture(
            source=source,
            segments=segments,
            source_text=project_source_text(segments),
            extraction_engine=engine,
            diarization_engine=diarization_engine,
            speakers=speakers,
            suggested_units=sorted(suggested_units),
            warnings=_unique_warnings(warnings),
            ocr_page_scope=ocr_page_scope,
            created_at=self._clock.now(),
        )
        return CaptureExtractionOutcome(
            raw=raw,
            ocr_projection=ocr_projection,
            _execution_proof=execution_proof,
        )

    async def _extract_pdf_with_worker(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        page_manifest: tuple[OcrPageManifest, ...],
        page_numbers: tuple[int, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
    ) -> WorkerRunResult:
        options: dict[str, object] = {
            "maxPages": self.config.max_pdf_pages,
            "renderScale": self.config.ocr_render_scale,
        }
        if page_numbers is not None:
            options["pageNumbers"] = list(page_numbers)
        return await self._run_worker(
            WINDOWSML_REQUIREMENT_ID,
            content,
            "application/pdf",
            options,
            cancel_event,
            page_manifest=page_manifest,
            ocr_progress=ocr_progress,
        )

    def _worker_projection(
        self,
        source: CaptureSource,
        result: WorkerRunResult,
        engine: OcrProvenanceV3,
        *,
        cancel_event: asyncio.Event,
        expected_pages: tuple[OcrPageManifest, ...],
    ) -> CaptureOcrProjectionV3:
        request = OcrRequest(
            capture_id=source.sha256,
            source=source,
            page_scope=tuple(page.page for page in expected_pages),
            manifest=expected_pages,
            created_at=self._clock.now(),
            warnings=(),
            is_cancelled=cancel_event.is_set,
        )
        outcome = self.ocr_pipeline.extract(
            request,
            _WorkerOcrEngineAdapter(result, engine),
        )
        if isinstance(outcome, OcrTerminalOutcome):
            raise OcrExtractionFailure(failure=outcome.failure, projection=outcome.projection)
        return outcome

    async def _run_worker(
        self,
        requirement_id: str,
        content: bytes,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        *,
        page_manifest: tuple[OcrPageManifest, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
        progress: Callable[[int], None] | None = None,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
    ) -> WorkerRunResult:
        assert self.engine_manager is not None
        worker_options = dict(options)
        try:
            async with asyncio.timeout(self.config.engine_resolution_timeout_seconds):
                engine = await self.engine_manager.resolve_active_engine(requirement_id)
        except TimeoutError as error:
            raise ExtractionRuntimeUnavailableError(
                f"Runtime requirement {requirement_id} could not be resolved "
                "within the bounded timeout."
            ) from error
        if engine is None:
            raise ExtractionRuntimeUnavailableError(
                f"Runtime requirement {requirement_id} is not installed and ready."
            )
        if requirement_id == WINDOWSML_REQUIREMENT_ID:
            selection_resolver = getattr(self.engine_manager, "ocr_compute_selection", None)
            if not callable(selection_resolver):
                raise ExtractionRuntimeUnavailableError("OCR compute plan is unavailable.")
            if "deviceId" in worker_options:
                raise ExtractionRuntimeUnavailableError(
                    "OCR deviceId overrides are not accepted; use the retained compute plan."
                )
            selection = await selection_resolver(
                contract_sha256=self._contract_sha256 or "",
            )
            if selection is None:
                raise ExtractionRuntimeUnavailableError(
                    "OCR compute plan is unavailable or no longer valid."
                )
            worker_options["computePlan"] = selection.execution_plan.to_dict()
            try:
                acceptance_runtime_sha256 = (
                    acceptance_ocr_execution_runtime_sha256_from_environment()
                )
            except ValueError as error:
                raise ExtractionRuntimeUnavailableError(
                    "OCR execution evidence runtime identity is invalid."
                ) from error
            if acceptance_runtime_sha256 is not None:
                supplied_runtime_sha256 = worker_options.get("runtimeSha256")
                if (
                    supplied_runtime_sha256 is not None
                    and supplied_runtime_sha256 != acceptance_runtime_sha256
                ):
                    raise ExtractionRuntimeUnavailableError(
                        "OCR execution runtime identity drifted."
                    )
                worker_options["runtimeSha256"] = acceptance_runtime_sha256
        vertical_reader_dir = None
        if requirement_id == WINDOWSML_REQUIREMENT_ID:
            vertical_reader_dir = await self._vertical_reader_dir()
        path = self._worker_source(content, media_type)
        try:
            if page_manifest is not None:
                worker_options = {
                    **worker_options,
                    "pageManifest": self.ocr_pipeline.serialize_manifest(page_manifest),
                }
            return await self.engine_manager.worker_client.run(
                engine,
                source_path=path,
                media_type=media_type,
                options=worker_options,
                cancel_event=cancel_event,
                timeout_seconds=timeout_seconds,
                ocr_progress=ocr_progress,
                on_permille=progress,
                vertical_reader_dir=vertical_reader_dir,
            )
        finally:
            path.unlink(missing_ok=True)

    def _worker_source(self, content: bytes, media_type: str) -> Path:
        """Write the source where a worker can read it; the caller deletes it."""

        self.config.temp_dir.mkdir(parents=True, exist_ok=True)
        suffix = _SOURCE_SUFFIXES.get(media_type, ".source")
        with tempfile.NamedTemporaryFile(
            prefix="capture-worker-source-",
            suffix=suffix,
            dir=self.config.temp_dir,
            delete=False,
        ) as temporary:
            temporary.write(content)
            return Path(temporary.name).resolve()

    async def _vertical_reader_dir(self) -> Path | None:
        """Where the optional vertical reader unit is installed, if it is."""

        resolver = getattr(self.engine_manager, "active_model_unit", None)
        if not callable(resolver):
            return None
        unit = await asyncio.to_thread(resolver, VERTICAL_READER_REQUIREMENT_ID)
        if unit is None:
            return None
        directory = Path(unit) / VERTICAL_READER_SUBDIRECTORY
        return directory if directory.is_dir() else None

    async def _run_diarization(
        self,
        content: bytes,
        media_type: str,
        cancel_event: asyncio.Event,
        progress: Callable[[int], None] | None,
        *,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
    ) -> WorkerDiarizationResult:
        assert self.engine_manager is not None
        try:
            async with asyncio.timeout(self.config.engine_resolution_timeout_seconds):
                engine = await self.engine_manager.resolve_active_engine(DIARIZATION_REQUIREMENT_ID)
        except (TimeoutError, EngineCatalogError):
            engine = None
        if engine is None:
            raise ExtractionRuntimeUnavailableError(
                f"Runtime requirement {DIARIZATION_REQUIREMENT_ID} is not installed and ready."
            )
        path = self._worker_source(content, media_type)
        try:
            return await self.engine_manager.worker_client.diarize(
                engine,
                source_path=path,
                media_type=media_type,
                options={
                    "maxDurationMs": self.config.max_audio_duration_ms,
                    "preferGpu": self.config.whisper_prefer_gpu,
                    "allowCpuFallback": True,
                },
                cancel_event=cancel_event,
                timeout_seconds=timeout_seconds,
                on_permille=progress,
            )
        finally:
            path.unlink(missing_ok=True)

    def _ocr_pdf_page_manifest(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        page_numbers: tuple[int, ...] | None = None,
    ) -> tuple[OcrPageManifest, ...]:
        page_count = self._pdf_page_count(content)
        selected_page_numbers = self._selected_pdf_pages(page_count, page_numbers)
        raster_dimensions = self._pdf_page_raster_dimensions(
            content,
            cancel_event,
            selected_page_numbers,
        )
        if len(raster_dimensions) != len(selected_page_numbers):
            raise ValueError("OCR PDF page metadata cardinality is invalid.")
        pages: list[OcrPageManifest] = []
        for page_number, (width, height) in zip(
            selected_page_numbers, raster_dimensions, strict=True
        ):
            self._checkpoint(cancel_event)
            if (
                isinstance(width, bool)
                or isinstance(height, bool)
                or not isinstance(width, int | float)
                or not isinstance(height, int | float)
                or not math.isfinite(float(width))
                or not math.isfinite(float(height))
                or width <= 0
                or height <= 0
            ):
                raise ValueError(f"OCR raster metadata is invalid for PDF page {page_number}.")
            try:
                raster_width = math.ceil(float(width) * self.config.ocr_render_scale)
                raster_height = math.ceil(float(height) * self.config.ocr_render_scale)
            except (OverflowError, ValueError) as error:
                raise ValueError(
                    f"OCR raster metadata is invalid for PDF page {page_number}."
                ) from error
            if raster_width <= 0 or raster_height <= 0:
                raise ValueError(f"OCR raster metadata is invalid for PDF page {page_number}.")
            pages.append(
                OcrPageManifest(
                    page=page_number,
                    raster_width=raster_width,
                    raster_height=raster_height,
                    raster_scale=self.config.ocr_render_scale,
                )
            )
        return tuple(pages)

    def _selected_pdf_pages(
        self,
        page_count: int,
        page_numbers: tuple[int, ...] | None,
    ) -> tuple[int, ...]:
        """The source pages OCR reads: every page, or the requested selection.

        The page limit bounds the pages that are read. Without a selection that
        is every page of the source; with one, the source may be longer.
        """

        limit = self.config.max_pdf_pages
        if page_numbers is None:
            if page_count > limit:
                raise ValueError(f"PDF has {page_count} pages; limit is {limit}.")
            return tuple(range(1, page_count + 1))
        if not is_pdf_page_selection(page_numbers):
            raise PdfPageSelectionError(
                "PDF page selection must list source pages in ascending order without duplicates."
            )
        if len(page_numbers) > limit:
            raise PdfPageSelectionError(
                f"PDF page selection has {len(page_numbers)} pages; limit is {limit}."
            )
        if page_numbers[-1] > page_count:
            raise PdfPageSelectionError(
                f"PDF page selection includes page {page_numbers[-1]}, "
                f"but the PDF has {page_count} pages."
            )
        return tuple(page_numbers)

    def _preflight_pdf_manifest(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        page_numbers: tuple[int, ...] | None = None,
    ) -> tuple[OcrPageManifest, ...]:
        try:
            return self._ocr_pdf_page_manifest(
                content,
                cancel_event,
                page_numbers=page_numbers,
            )
        except (InterruptedError, OcrSourcePreflightError, PdfPageSelectionError):
            raise
        except Exception as error:
            raise OcrSourcePreflightError from error

    def _pdf_page_raster_dimensions(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        page_numbers: tuple[int, ...],
    ) -> tuple[tuple[float, float], ...]:
        """Read PDFium's effective page sizes without creating raster bytes.

        ``get_size`` is the size PDFium will use for a default render.  It
        already reflects the page's crop box and intrinsic rotation, so the
        metadata path must not reconstruct geometry from the media box.
        """

        import pypdfium2 as pdfium  # type: ignore[import-untyped]

        document = None
        try:
            document = pdfium.PdfDocument(BytesIO(content))
            dimensions: list[tuple[float, float]] = []
            for page_number in page_numbers:
                self._checkpoint(cancel_event)
                page = None
                try:
                    page = document[page_number - 1]
                    width, height = page.get_size()
                    dimensions.append((width, height))
                finally:
                    if page is not None:
                        page.close()
                self._checkpoint(cancel_event)
            return tuple(dimensions)
        finally:
            if document is not None:
                document.close()

    def _ocr_image_page_manifest(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        raster_cache: list[bytes] | None = None,
    ) -> tuple[OcrPageManifest, ...]:
        normalized = _normalize_image_content(
            content,
            scale=self.config.ocr_render_scale,
            max_pixels=self.config.max_image_pixels,
        )
        if raster_cache is not None:
            raster_cache.append(normalized)
        self._checkpoint(cancel_event)
        raster_width, raster_height = _raster_dimensions(normalized)
        if raster_width is None or raster_height is None:
            raise ValueError("OCR raster metadata is unavailable for image input.")
        source_width, source_height = _oriented_image_dimensions(content)
        raster_scale = min(raster_width / source_width, raster_height / source_height)
        return (
            OcrPageManifest(
                page=1,
                raster_width=raster_width,
                raster_height=raster_height,
                raster_scale=raster_scale,
            ),
        )

    def _preflight_image_manifest(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        raster_cache: list[bytes] | None = None,
    ) -> tuple[OcrPageManifest, ...]:
        try:
            return self._ocr_image_page_manifest(
                content,
                cancel_event,
                raster_cache=raster_cache,
            )
        except (InterruptedError, OcrSourcePreflightError):
            raise
        except Exception as error:
            raise OcrSourcePreflightError from error

    def _ocr_extraction_failure(
        self,
        source: CaptureSource,
        expected_pages: tuple[OcrPageManifest, ...],
        error: OcrWorkerFailure,
        *,
        cancel_event: asyncio.Event,
    ) -> OcrExtractionFailure:
        request = OcrRequest(
            capture_id=source.sha256,
            source=source,
            page_scope=tuple(page.page for page in expected_pages),
            manifest=expected_pages,
            created_at=self._clock.now(),
            warnings=(),
            is_cancelled=cancel_event.is_set,
        )
        outcome = self.ocr_pipeline.extract(
            request,
            _OcrWorkerFailureEngineAdapter(
                kind=error.kind,
                completed_pages=self._worker_progress_inputs(error.progress),
                provenance=error.provenance,
            ),
        )
        if not isinstance(outcome, OcrTerminalOutcome):
            raise AssertionError("worker failure adapter must produce a terminal failure")
        return OcrExtractionFailure(failure=outcome.failure, projection=outcome.projection)

    def _worker_progress_inputs(
        self,
        progress: WorkerOcrProgress | None,
    ) -> tuple[OcrPageInput, ...]:
        if progress is None:
            return ()
        provenance = progress.provenance or self.ocr_pipeline.default_provenance
        return tuple(
            OcrPageInput(
                page=page.page,
                text=page.text,
                boxes=page.boxes,
                region_confidences=page.region_confidences,
                confidence=page.confidence,
                raster_width=page.raster_width,
                raster_height=page.raster_height,
                raster_scale=page.raster_scale,
                status=OcrPageStatus(page.status),
                provenance=provenance,
                failure=page.failure,
            )
            for page in progress.pages
        )

    @staticmethod
    def _capture_engine(result: WorkerRunResult, *, expected_engine: str) -> CaptureEngine:
        if result.engine != expected_engine:
            raise ValueError("worker returned incompatible engine provenance")
        if expected_engine == "windowsml-ocr" and result.device not in {
            "windowsml-dml",
            "cpu",
        }:
            raise ValueError("OCR worker returned incompatible device provenance")
        return CaptureEngine(
            engine=result.engine,
            model=result.model,
            digest=result.digest,
            device=result.device,
            elapsed_ms=result.elapsed_ms if expected_engine == "speech-recognition" else None,
            stage_ms=result.stage_ms if expected_engine == "speech-recognition" else None,
        )

    def _capture_ocr_provenance(self, result: WorkerRunResult) -> OcrProvenanceV3:
        provenance = result.ocr_provenance
        if provenance is None:
            # In-memory test adapters predate the profile-bearing worker wire;
            # production WorkerClient always supplies this field.
            fallback = self.ocr_pipeline.default_provenance
            provenance = OcrProvenanceV3(
                status="resolved",
                engine="windowsml-ocr",
                model=result.model,
                model_digest=result.digest,
                device=result.device,
                profile_id=fallback.profile_id,
                profile_spec_sha256=fallback.profile_spec_sha256,
            )
        if not provenance.is_resolved or provenance.engine != "windowsml-ocr":
            raise ValueError("worker returned incomplete OCR profile provenance")
        if provenance.model != result.model or provenance.model_digest != result.digest:
            raise ValueError("worker OCR profile provenance does not match result identity")
        if provenance.device != result.device:
            raise ValueError("worker OCR profile provenance device does not match result")
        return provenance

    @staticmethod
    def _validate_worker_segments_against_projection(
        result: WorkerRunResult,
        projection: CaptureOcrProjectionV3,
    ) -> None:
        """Reject a legacy segment envelope that diverges from OCR pages.

        ``segments`` remains in the internal worker envelope for compatibility
        with older workers and the shared audio result parser.  It is not a
        source of OCR text: the normalized page projection is authoritative,
        and the compatibility envelope must exactly describe its recognized
        pages before the host may persist any raw segments.
        """

        expected = tuple(
            (page.page, page.text)
            for page in projection.pages
            if page.status is OcrPageStatus.RECOGNIZED and page.text
        )
        actual = tuple((segment.page, segment.text) for segment in result.segments)
        if actual != expected:
            raise OcrWorkerFailure(
                kind="protocol",
                progress=result.ocr_progress,
                provenance=projection.provenance if projection.provenance.is_resolved else None,
            )

    @staticmethod
    def _time_segments(result: WorkerRunResult) -> list[RawCaptureSegment]:
        return [
            RawCaptureSegment(
                segment_id=f"segment-{index + 1}",
                order=index,
                locator=TimeLocator(start_ms=item.start_ms, end_ms=item.end_ms),
                text=item.text,
            )
            for index, item in enumerate(result.segments)
            if item.start_ms is not None and item.end_ms is not None
        ]

    def _extract_sync(
        self,
        content: bytes,
        source: CaptureSource,
        cancel_event: asyncio.Event,
        pdf_page_numbers: tuple[int, ...] | None = None,
    ) -> CaptureExtractionOutcome:
        sniffed = self.sniff(content)
        self._checkpoint(cancel_event)
        ocr_page_scope: OcrPageScopeV2 | None = None
        if sniffed.kind is CaptureSourceKind.PDF:
            segments, ocr_projection = self._extract_pdf(
                content,
                source,
                cancel_event,
                page_numbers=pdf_page_numbers,
            )
            assert ocr_projection.provenance is not None
            engine = CaptureEngine(
                engine=ocr_projection.provenance.engine,
                model=ocr_projection.provenance.model,
                digest=ocr_projection.provenance.model_digest,
                device=ocr_projection.provenance.device,
            )
            warnings = list(ocr_projection.warnings)
            ocr_page_scope = OcrPageScopeV2(
                source_page_count=self._pdf_page_count(content),
                requested_page_numbers=[page.page for page in ocr_projection.pages],
                processed_page_numbers=[page.page for page in ocr_projection.pages],
            )
        elif sniffed.kind is CaptureSourceKind.IMAGE:
            if pdf_page_numbers is not None:
                raise ValueError("PDF page selection is only valid for PDF sources.")
            segments, ocr_projection = self._extract_image(content, source, cancel_event)
            assert ocr_projection.provenance is not None
            engine = CaptureEngine(
                engine=ocr_projection.provenance.engine,
                model=ocr_projection.provenance.model,
                digest=ocr_projection.provenance.model_digest,
                device=ocr_projection.provenance.device,
            )
            warnings = list(ocr_projection.warnings)
        else:
            if pdf_page_numbers is not None:
                raise ValueError("PDF page selection is only valid for PDF sources.")
            segments, engine, warnings = self._extract_audio(
                content, source.media_type, cancel_event
            )
            ocr_projection = None
        self._checkpoint(cancel_event)
        if not segments:
            raise ValueError("Extraction produced no non-empty content.")
        raw = RawCapture(
            source=source,
            segments=segments,
            source_text=project_source_text(segments),
            extraction_engine=engine,
            warnings=warnings,
            ocr_page_scope=ocr_page_scope,
            created_at=self._clock.now(),
        )
        return CaptureExtractionOutcome(raw=raw, ocr_projection=ocr_projection)

    def _extract_pdf(
        self,
        content: bytes,
        source: CaptureSource,
        cancel_event: asyncio.Event,
        *,
        page_numbers: tuple[int, ...] | None = None,
    ) -> tuple[list[RawCaptureSegment], CaptureOcrProjectionV3]:
        manifest = self._preflight_pdf_manifest(
            content,
            cancel_event,
            page_numbers=page_numbers,
        )
        request = OcrRequest(
            capture_id=source.sha256,
            source=source,
            page_scope=tuple(page.page for page in manifest),
            manifest=manifest,
            created_at=self._clock.now(),
            warnings=(),
            is_cancelled=cancel_event.is_set,
            use_manifest_raster=True,
        )
        outcome = self.ocr_pipeline.extract(
            request,
            _SyncOcrEngineAdapter(
                self,
                content,
                CaptureSourceKind.PDF,
            ),
        )
        if isinstance(outcome, OcrTerminalOutcome):
            raise OcrExtractionFailure(failure=outcome.failure, projection=outcome.projection)
        projection = outcome
        return _projection_segments(projection), projection

    @staticmethod
    def _pdf_page_count(content: bytes) -> int:
        import pypdfium2 as pdfium

        document = None
        try:
            document = pdfium.PdfDocument(BytesIO(content))
            page_count = len(document)
        except Exception as error:
            raise ValueError("Uploaded PDF is not readable.") from error
        finally:
            if document is not None:
                document.close()
        if page_count < 1:
            raise ValueError("Uploaded PDF has no pages.")
        return page_count

    def _render_pdf_page(self, content: bytes, page_index: int) -> bytes:
        import pypdfium2 as pdfium

        document = None
        bitmap = None
        image = None
        output = None
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
            # Clear conversion locals as well as native handles so a raised
            # traceback cannot retain a completed page buffer.
            image = None
            output = None
            try:
                if bitmap is not None:
                    bitmap.close()
            finally:
                bitmap = None
                try:
                    if document is not None:
                        document.close()
                finally:
                    document = None

    def _extract_image(
        self,
        content: bytes,
        source: CaptureSource,
        cancel_event: asyncio.Event,
    ) -> tuple[list[RawCaptureSegment], CaptureOcrProjectionV3]:
        raster_pages: list[bytes] = []
        manifest = self._preflight_image_manifest(
            content,
            cancel_event,
            raster_cache=raster_pages,
        )
        request = OcrRequest(
            capture_id=source.sha256,
            source=source,
            page_scope=tuple(page.page for page in manifest),
            manifest=manifest,
            created_at=self._clock.now(),
            warnings=(),
            is_cancelled=cancel_event.is_set,
            use_manifest_raster=True,
        )
        outcome = self.ocr_pipeline.extract(
            request,
            _SyncOcrEngineAdapter(
                self,
                content,
                CaptureSourceKind.IMAGE,
                raster_pages=tuple(raster_pages),
            ),
        )
        if isinstance(outcome, OcrTerminalOutcome):
            raise OcrExtractionFailure(failure=outcome.failure, projection=outcome.projection)
        projection = outcome
        return _projection_segments(projection), projection

    def _extract_audio(
        self, content: bytes, media_type: str, cancel_event: asyncio.Event
    ) -> tuple[list[RawCaptureSegment], CaptureEngine, list[str]]:
        suffix = _SOURCE_SUFFIXES.get(media_type, ".audio")
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
            RawCaptureSegment(
                segment_id=f"segment-{index + 1}",
                order=index,
                locator=TimeLocator(start_ms=item.start_ms, end_ms=item.end_ms),
                text=item.text,
            )
            for index, item in enumerate(result.segments)
        ]
        warnings = [result.warning] if result.warning else []
        return (
            segments,
            CaptureEngine(
                engine="speech-recognition",
                model=result.model,
                digest=result.digest,
                device=result.device,
                elapsed_ms=result.elapsed_ms,
                stage_ms=result.stage_ms,
            ),
            warnings,
        )

    @staticmethod
    def _checkpoint(cancel_event: asyncio.Event) -> None:
        if cancel_event.is_set():
            raise InterruptedError("Capture extraction was cancelled.")


def _normalize_image_png(
    image: Image.Image,
    *,
    scale: float = 1,
    max_pixels: int | None = None,
) -> bytes:
    from PIL import Image, ImageOps

    oriented = ImageOps.exif_transpose(image)
    if "A" in oriented.getbands() or "transparency" in oriented.info:
        rgba = oriented.convert("RGBA")
        normalized = Image.new("RGB", rgba.size, "white")
        normalized.paste(rgba, mask=rgba.getchannel("A"))
    else:
        normalized = oriented.convert("RGB")
    if scale != 1:
        width, height = normalized.size
        dimensions = (
            bounded_scaled_dimensions(width, height, scale, max_pixels)
            if max_pixels is not None
            else (round(width * scale), round(height * scale))
        )
        normalized = normalized.resize(dimensions, Image.Resampling.LANCZOS)
    output = BytesIO()
    normalized.save(output, format="PNG")
    return output.getvalue()


def _normalize_image_content(content: bytes, *, scale: float, max_pixels: int) -> bytes:
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
                if width * height > max_pixels:
                    raise ValueError("Image exceeds the configured pixel limit.")
                if getattr(image, "n_frames", 1) != 1 or bool(getattr(image, "is_animated", False)):
                    raise ValueError("Animated or multi-frame images are unsupported.")
                image.seek(0)
                image.load()
                return _normalize_image_png(
                    image, scale=ocr_image_scale(width, height, scale), max_pixels=max_pixels
                )
    except (
        OSError,
        UnidentifiedImageError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as error:
        raise ValueError("Uploaded image is not readable.") from error


def _raster_dimensions(image_png: bytes) -> tuple[int | None, int | None]:
    try:
        from PIL import Image

        with Image.open(BytesIO(image_png)) as image:
            width, height = image.size
            return (width, height) if width > 0 and height > 0 else (None, None)
    except Exception:
        return None, None


def _image_ocr_scale(content: bytes, scale: float) -> float:
    """The enlargement of an already validated image, as _normalize_image_content applies it."""

    from PIL import Image

    with Image.open(BytesIO(content)) as image:
        width, height = image.size
    return ocr_image_scale(width, height, scale)


def _oriented_image_dimensions(content: bytes) -> tuple[int, int]:
    from PIL import Image, ImageOps

    with Image.open(BytesIO(content)) as image:
        oriented = ImageOps.exif_transpose(image)
        width, height = oriented.size
    if width <= 0 or height <= 0:
        raise ValueError("Image dimensions must be positive.")
    return width, height


def _audio_run_timeout_seconds(content: bytes, max_duration_ms: int) -> float:
    """How long one Whisper or speaker-diarization run on this audio may take.

    Both take time in proportion to the recording, and diarization runs on the
    CPU at about a third of real time: with the standard limit alone a
    40-minute interview failed. The limit grows by the recording's own length,
    or by the longest allowed when the container does not say.
    """
    duration_seconds = _audio_duration_seconds(content)
    if duration_seconds is None:
        duration_seconds = max_duration_ms / 1000
    return DEFAULT_RUN_TIMEOUT_SECONDS + duration_seconds


def _audio_duration_seconds(content: bytes) -> float | None:
    try:
        import av

        with av.open(BytesIO(content), mode="r") as container:
            if container.duration is None:
                return None
            return container.duration / 1_000_000
    except Exception:
        return None


def _stage_progress(
    report: Callable[[str, int], None] | None, stage: str, start: int, end: int
) -> Callable[[int], None] | None:
    """Place one worker's 0-1000 progress inside its share of the whole capture."""

    if report is None:
        return None
    return lambda permille: report(stage, start + (end - start) * permille // 1000)


def _speaker_capture_segments(
    result: WorkerRunResult, diarization: WorkerDiarizationResult
) -> tuple[list[RawCaptureSegment], list[CaptureSpeaker]]:
    """Split the transcript where the speaker changes and list who spoke."""

    words = sorted(
        (
            TimedWord(word.start_ms, word.end_ms, word.text, segment.order)
            for segment in result.segments
            for word in segment.words
        ),
        key=lambda word: word.start_ms,
    )
    spoken = [
        item
        for item in speaker_segments(words, diarization.exclusive_turns, diarization.turns)
        if item.text
    ]
    segments = [
        RawCaptureSegment(
            segment_id=f"segment-{index + 1}",
            order=index,
            locator=TimeLocator(start_ms=item.start_ms, end_ms=max(item.end_ms, item.start_ms + 1)),
            text=item.text,
            speaker=item.speaker,
            speaker_overlap=item.overlap,
        )
        for index, item in enumerate(spoken)
    ]
    samples = {sample.speaker: sample for sample in speaker_samples(spoken)}
    speaker_ids = sorted(
        {turn.speaker for turn in diarization.turns}
        | {item.speaker for item in spoken if item.speaker is not None}
    )
    speakers = [
        CaptureSpeaker(
            speaker_id=speaker_id,
            sample=(
                TimeLocator(
                    start_ms=samples[speaker_id].start_ms, end_ms=samples[speaker_id].end_ms
                )
                if speaker_id in samples
                else None
            ),
        )
        for speaker_id in speaker_ids
    ]
    return segments, speakers


def _unique_warnings(warnings: list[str]) -> list[str]:
    return list(dict.fromkeys(warning[:500] for warning in warnings if warning.strip()))


def _projection_segments(projection: CaptureOcrProjectionV3) -> list[RawCaptureSegment]:
    return [
        RawCaptureSegment(
            segment_id=f"page-{page.page}",
            order=index,
            locator=PageLocator(page=page.page),
            text=page.text,
        )
        for index, page in enumerate(projection.pages)
        if page.status is OcrPageStatus.RECOGNIZED and page.text
    ]


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
        source: CaptureSource,
        cancel_event: asyncio.Event,
        *,
        pdf_page_numbers: tuple[int, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
        identify_speakers: bool = False,
        speaker_progress: Callable[[str, int], None] | None = None,
    ) -> CaptureExtractionOutcome:
        sniffed = self.sniff(content)
        if self._delay_seconds:
            try:
                await asyncio.wait_for(cancel_event.wait(), timeout=self._delay_seconds)
            except TimeoutError:
                pass
        if cancel_event.is_set():
            raise asyncio.CancelledError

        text = self._fixture_text(content, sniffed.kind, source.sha256)
        scope: OcrPageScopeV2 | None = None
        if sniffed.kind is CaptureSourceKind.AUDIO:
            parts = [part.strip() for part in text.split("|") if part.strip()]
            segments = [
                RawCaptureSegment(
                    segment_id=f"segment-{index + 1}",
                    order=index,
                    locator=TimeLocator(
                        start_ms=index * 1000,
                        end_ms=(index + 1) * 1000,
                    ),
                    text=part,
                )
                for index, part in enumerate(parts)
            ]
            engine = CaptureEngine(
                engine="speech-recognition",
                model="deterministic-whisper-v1",
                digest=_engine_digest("speech-recognition", "deterministic-whisper-v1"),
                device="fake",
            )
        else:
            source_pages = [part.strip() for part in text.split("\f")]
            page_numbers = tuple(range(1, len(source_pages) + 1))
            if pdf_page_numbers is not None:
                if not is_pdf_page_selection(pdf_page_numbers):
                    raise PdfPageSelectionError(
                        "PDF page selection must list source pages in ascending order "
                        "without duplicates."
                    )
                if pdf_page_numbers[-1] > len(source_pages):
                    raise PdfPageSelectionError(
                        f"PDF page selection includes page {pdf_page_numbers[-1]}, "
                        f"but the PDF has {len(source_pages)} pages."
                    )
                page_numbers = tuple(pdf_page_numbers)
            # Each page keeps its source page number, selected or not.
            page_texts = [
                (page_number, source_pages[page_number - 1])
                for page_number in page_numbers
                if source_pages[page_number - 1]
            ]
            segments = [
                RawCaptureSegment(
                    segment_id=f"segment-{index + 1}",
                    order=index,
                    locator=PageLocator(page=page_number),
                    text=part,
                )
                for index, (page_number, part) in enumerate(page_texts)
            ]
            engine = CaptureEngine(
                engine="windowsml-ocr",
                model="deterministic-windowsml-v1",
                digest=_engine_digest("windowsml-ocr", "deterministic-windowsml-v1"),
                device="fake",
            )
            scope = (
                OcrPageScopeV2(
                    source_page_count=len(text.split("\f")),
                    requested_page_numbers=list(pdf_page_numbers),
                    processed_page_numbers=list(pdf_page_numbers),
                )
                if sniffed.kind is CaptureSourceKind.PDF and pdf_page_numbers is not None
                else None
            )
        if not segments:
            raise ValueError("extraction produced no non-empty content")
        return CaptureExtractionOutcome(
            raw=RawCapture(
                source=source,
                segments=segments,
                source_text=project_source_text(segments),
                extraction_engine=engine,
                warnings=[],
                ocr_page_scope=scope,
                created_at=self._clock.now(),
            )
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


__all__ = [
    "CaptureExtractor",
    "CaptureExtractionOutcome",
    "DeterministicCaptureExtractor",
    "ExtractionRuntimeUnavailableError",
    "OcrExtractionFailure",
    "OcrSourcePreflightError",
    "PdfPageSelectionError",
    "SniffedSource",
    "StandaloneRuntimeCaptureExtractor",
    "UnsupportedMediaError",
    "SNIFF_BYTES",
    "sniff_source",
]
