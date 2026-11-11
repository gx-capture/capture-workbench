"""Choosing and driving the engines that read one capture source.

The extractor sniffs the source, prepares it for the engine that reads
that media (PDF and image pages for OCR, a recording for speech recognition
and speaker diarization), runs the installed worker or the in-process
adapters, and assembles the raw capture with its OCR projection.
"""

from __future__ import annotations

import asyncio
import tempfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal, Protocol, cast

from capture_runtime._pdf_source import (
    PdfPageSelectionError,
    checkpoint,
    pdf_page_count,
    pdf_page_manifest,
    pdf_page_raster_dimensions,
    render_pdf_page,
    selected_pdf_pages,
)
from capture_runtime._worker_payloads import WorkerRunResult
from capture_runtime.capture.infrastructure.audio_run_timeout import audio_run_timeout_seconds
from capture_runtime.capture.infrastructure.pdf_page_selection import is_ascending_page_numbers
from capture_runtime.capture.infrastructure.source_sniffing import SniffedSource, sniff_source
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
from capture_runtime.diarization.application.use_cases import (
    AlignSpeakerTurns,
    DiarizeAudio,
    ExtractSpeakerSamples,
)
from capture_runtime.diarization.infrastructure.speaker_alignment import (
    TimedWord,
)
from capture_runtime.diarization.infrastructure.speaker_worker_result import WorkerDiarizationResult
from capture_runtime.ocr.application.use_cases import ExtractPageText
from capture_runtime.ocr.infrastructure.image_normalization import (
    image_ocr_scale,
    normalize_image_content,
    oriented_image_dimensions,
    png_raster_dimensions,
)
from capture_runtime.ocr.infrastructure.ocr_execution_proof import (
    OcrExecutionDeviceProofV1,
    acceptance_ocr_execution_runtime_sha256_from_environment,
)
from capture_runtime.ocr.infrastructure.ocr_paddle_normalization import (
    PaddleResultNormalizationError,
)
from capture_runtime.ocr.infrastructure.ocr_projection import (
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
from capture_runtime.ocr.infrastructure.ocr_vertical_routing import (
    MODEL_SUBDIRECTORY as VERTICAL_READER_SUBDIRECTORY,
)
from capture_runtime.ocr.infrastructure.ocr_worker_result import (
    OcrWorkerFailure,
    OcrWorkerRunResult,
    WorkerOcrProgress,
)
from capture_runtime.provisioning.infrastructure.engine_catalog import EngineCatalogError
from capture_runtime.provisioning.infrastructure.engine_content_selection import (
    speech_model_not_installed_message,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineInstallationManager,
    ExtractionRuntimeUnavailableError,
    SpeechModelNotInstalledError,
)
from capture_runtime.speech.application.use_cases import TranscribeAudio
from capture_runtime.worker_client import InstalledEngine
from capture_runtime.worker_probe import EngineRuntimeUnavailableError
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS, WorkerCancelledError

if TYPE_CHECKING:
    from capture_runtime.ocr.infrastructure.ocr_page_result import OcrAdapter
    from capture_runtime.speech.infrastructure.speech_transcript import WhisperAdapter


_OcrRunResult = OcrWorkerRunResult[OcrExecutionDeviceProofV1]


class _EngineWorkerClient(Protocol):
    """The capture aggregate's run and diarize, seen through the kernel client.

    EngineInstallationManager types the shared client as the kernel, which
    declares probe and shutdown. Production injects the aggregate.
    """

    async def run(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = ...,
        ocr_progress: Callable[[int, int], None] | None = ...,
        on_permille: Callable[[int], None] | None = ...,
        vertical_reader_dir: Path | None = ...,
    ) -> WorkerRunResult: ...

    async def run_ocr(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = ...,
        ocr_progress: Callable[[int, int], None] | None = ...,
        on_permille: Callable[[int], None] | None = ...,
        vertical_reader_dir: Path | None = ...,
    ) -> _OcrRunResult: ...

    async def diarize(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = ...,
        on_permille: Callable[[int], None] | None = ...,
    ) -> WorkerDiarizationResult: ...


class OcrSourcePreflightError(RuntimeError):
    """A source manifest could not be established before OCR execution."""

    def __init__(self) -> None:
        super().__init__("OCR source preflight failed.")


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
        spoken_language: str | None = None,
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
        extract_page = ExtractPageText(adapter)
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
                    image_png = normalize_image_content(
                        self._content,
                        scale=self._extractor.config.ocr_render_scale,
                        max_pixels=self._extractor.config.max_image_pixels,
                    )
                self._check_cancelled(request)
                try:
                    extracted = extract_page.execute(image_png, expected.page)
                    result = extracted.result
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
                pages.append(request.observe(expected, extracted, current))
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
        result: _OcrRunResult,
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

    async def release_warm_workers(self) -> None:
        """Close idle warm engine workers, freeing their GPU memory for another engine."""

        worker_client = getattr(self.engine_manager, "worker_client", None)
        release = getattr(getattr(worker_client, "process", None), "release_warm", None)
        if release is not None:
            await release()

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
        spoken_language: str | None = None,
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
                spoken_language=spoken_language,
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
                spoken_language,
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
        spoken_language: str | None = None,
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
                _report_pages_known(ocr_progress, expected_ocr_pages)
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
                _report_pages_known(ocr_progress, expected_ocr_pages)
                try:
                    result = await self._run_ocr_worker(
                        content,
                        sniffed.media_type,
                        {
                            "maxImagePixels": self.config.max_image_pixels,
                            "renderScale": image_ocr_scale(content, self.config.ocr_render_scale),
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
                speech_result = await self._run_worker(
                    SPEECH_RECOGNITION_REQUIREMENT_ID,
                    content,
                    sniffed.media_type,
                    {
                        "maxDurationMs": self.config.max_audio_duration_ms,
                        "preferGpu": self.config.whisper_prefer_gpu,
                        "allowCpuFallback": self.config.whisper_allow_cpu_fallback,
                        **({"wordTimestamps": True} if identify_speakers else {}),
                        **({"language": spoken_language} if spoken_language else {}),
                        **(
                            {"model": self.config.speech_recognition_model}
                            if self.config.speech_recognition_model != "auto"
                            else {}
                        ),
                    },
                    cancel_event,
                    progress=_stage_progress(speaker_progress, "transcribing", 0, 450),
                    timeout_seconds=audio_run_timeout_seconds(
                        content, self.config.max_audio_duration_ms
                    ),
                )
                engine = self._capture_engine(speech_result, expected_engine="speech-recognition")
                warnings = list(speech_result.warnings)
                if identify_speakers:
                    diarization = await self._run_diarization(
                        content,
                        sniffed.media_type,
                        cancel_event,
                        _stage_progress(speaker_progress, "identifying-speakers", 450, 1000),
                        timeout_seconds=audio_run_timeout_seconds(
                            content, self.config.max_audio_duration_ms
                        ),
                    )
                    segments, speakers = _speaker_capture_segments(speech_result, diarization)
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
                    segments = self._time_segments(speech_result)
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
    ) -> _OcrRunResult:
        options: dict[str, object] = {
            "maxPages": self.config.max_pdf_pages,
            "renderScale": self.config.ocr_render_scale,
        }
        if page_numbers is not None:
            options["pageNumbers"] = list(page_numbers)
        return await self._run_ocr_worker(
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
        result: _OcrRunResult,
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

    async def _prepare_worker_run(
        self,
        requirement_id: str,
        content: bytes,
        media_type: str,
        options: dict[str, object],
    ) -> tuple[InstalledEngine, Path, dict[str, object], Path | None]:
        """Resolve the engine and write the source file. The caller deletes that file."""

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
        return (
            engine,
            self._worker_source(content, media_type),
            worker_options,
            vertical_reader_dir,
        )

    async def _run_ocr_worker(
        self,
        content: bytes,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        *,
        page_manifest: tuple[OcrPageManifest, ...] | None = None,
        ocr_progress: Callable[[int, int], None] | None = None,
        progress: Callable[[int], None] | None = None,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
    ) -> _OcrRunResult:
        engine, path, worker_options, vertical_reader_dir = await self._prepare_worker_run(
            WINDOWSML_REQUIREMENT_ID,
            content,
            media_type,
            options,
        )
        try:
            if page_manifest is not None:
                worker_options = {
                    **worker_options,
                    "pageManifest": self.ocr_pipeline.serialize_manifest(page_manifest),
                }
            assert self.engine_manager is not None
            worker_client = cast(_EngineWorkerClient, self.engine_manager.worker_client)
            return await worker_client.run_ocr(
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
        engine, path, worker_options, vertical_reader_dir = await self._prepare_worker_run(
            requirement_id,
            content,
            media_type,
            options,
        )
        # The id was stored when the install lock was taken. Do not detect a
        # driver or infer a pack from which model folders are on disk.
        if requirement_id == SPEECH_RECOGNITION_REQUIREMENT_ID and engine.content_id is not None:
            worker_options["content"] = engine.content_id
        try:
            if requirement_id == SPEECH_RECOGNITION_REQUIREMENT_ID:
                missing = speech_model_not_installed_message(
                    engine.content_id, self.config.speech_recognition_model
                )
                if missing is not None:
                    raise SpeechModelNotInstalledError(missing)
            if page_manifest is not None:
                worker_options = {
                    **worker_options,
                    "pageManifest": self.ocr_pipeline.serialize_manifest(page_manifest),
                }
            assert self.engine_manager is not None
            worker_client = cast(_EngineWorkerClient, self.engine_manager.worker_client)
            return await worker_client.run(
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
            worker_client = cast(_EngineWorkerClient, self.engine_manager.worker_client)
            return await DiarizeAudio(worker_client).execute(
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
        return pdf_page_manifest(
            selected_page_numbers,
            raster_dimensions,
            cancel_event,
            self.config.ocr_render_scale,
        )

    def _selected_pdf_pages(
        self,
        page_count: int,
        page_numbers: tuple[int, ...] | None,
    ) -> tuple[int, ...]:
        return selected_pdf_pages(page_count, page_numbers, self.config.max_pdf_pages)

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
        return pdf_page_raster_dimensions(content, cancel_event, page_numbers)

    def _ocr_image_page_manifest(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        raster_cache: list[bytes] | None = None,
    ) -> tuple[OcrPageManifest, ...]:
        normalized = normalize_image_content(
            content,
            scale=self.config.ocr_render_scale,
            max_pixels=self.config.max_image_pixels,
        )
        if raster_cache is not None:
            raster_cache.append(normalized)
        self._checkpoint(cancel_event)
        raster_width, raster_height = png_raster_dimensions(normalized)
        if raster_width is None or raster_height is None:
            raise ValueError("OCR raster metadata is unavailable for image input.")
        source_width, source_height = oriented_image_dimensions(content)
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
        result: _OcrRunResult,
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
        spoken_language: str | None = None,
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
                content, source.media_type, cancel_event, spoken_language
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
        return pdf_page_count(content)

    def _render_pdf_page(self, content: bytes, page_index: int) -> bytes:
        return render_pdf_page(content, page_index, self.config.ocr_render_scale)

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
        self,
        content: bytes,
        media_type: str,
        cancel_event: asyncio.Event,
        spoken_language: str | None = None,
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
            result = TranscribeAudio(self.whisper_adapter).execute(
                path, should_cancel=cancel_event.is_set, language=spoken_language
            )
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
        checkpoint(cancel_event)


def _report_pages_known(
    ocr_progress: Callable[[int, int], None] | None,
    page_manifest: tuple[OcrPageManifest, ...],
) -> None:
    """Report the pages OCR will read before the first one finishes."""

    if ocr_progress is not None:
        ocr_progress(0, len(page_manifest))


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
        for item in AlignSpeakerTurns().execute(
            words, diarization.exclusive_turns, diarization.turns
        )
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
    samples = {sample.speaker: sample for sample in ExtractSpeakerSamples().execute(spoken)}
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


__all__ = [
    "CaptureExtractor",
    "CaptureExtractionOutcome",
    "OcrExtractionFailure",
    "OcrSourcePreflightError",
    "PdfPageSelectionError",
    "StandaloneRuntimeCaptureExtractor",
]
