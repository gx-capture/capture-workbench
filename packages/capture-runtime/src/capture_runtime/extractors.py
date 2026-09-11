"""Source sniffing and deterministic extraction seams."""

from __future__ import annotations

import asyncio
import hashlib
import tempfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.constants import WHISPER_REQUIREMENT_ID, WINDOWSML_REQUIREMENT_ID
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureOcrProjectionV3,
    CaptureSource,
    CaptureSourceKind,
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
from capture_runtime.engine_installation import EngineInstallationManager
from capture_runtime.image_normalization import bounded_scaled_dimensions
from capture_runtime.ocr_execution_proof import (
    OcrExecutionDeviceProofV1,
    acceptance_ocr_execution_runtime_sha256_from_environment,
)
from capture_runtime.ocr_profile import EngineRuntimeUnavailableError
from capture_runtime.ocr_projection import (
    OcrEngineFailure,
    OcrEngineRun,
    OcrExtractionFailure,
    OcrPageInput,
    OcrPageManifest,
    OcrPipeline,
    OcrTerminalOutcome,
    _OcrEngineRequest,
    _OcrRequest,
)
from capture_runtime.worker_client import (
    OcrWorkerFailure,
    WorkerOcrProgress,
    WorkerRunResult,
)
from capture_runtime.worker_process import WorkerCancelledError

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
    ) -> CaptureExtractionOutcome: ...


class _SyncOcrEngineAdapter:
    """Local rasterizer + WindowsML adapter behind the OCR engine port."""

    def __init__(
        self,
        extractor: StandaloneRuntimeCaptureExtractor,
        content: bytes,
        source_kind: CaptureSourceKind,
        cancel_event: asyncio.Event,
        raster_pages: tuple[bytes, ...] | None = None,
    ) -> None:
        self._extractor = extractor
        self._content = content
        self._source_kind = source_kind
        self._cancel_event = cancel_event
        self._raster_pages = raster_pages

    def recognize(self, manifest: tuple[OcrPageManifest, ...]) -> OcrEngineRun:
        adapter = self._extractor.ocr_adapter
        if adapter is None:
            raise OcrEngineFailure(kind="unavailable", completed_pages=())
        pages: list[OcrPageInput] = []
        warnings: list[str] = []
        provenance: OcrProvenanceV3 | None = None
        for expected in manifest:
            self._extractor._checkpoint(self._cancel_event)
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
            self._extractor._checkpoint(self._cancel_event)
            try:
                result = adapter.extract_png(image_png)
            except PaddleResultNormalizationError:
                raise
            except RuntimeError as error:
                raise OcrEngineFailure(
                    kind="unavailable",
                    completed_pages=pages,
                    provenance=provenance,
                ) from error
            pages.append(
                self._extractor.ocr_pipeline.normalize_observation(
                    expected,
                    result,
                    use_manifest_raster=True,
                )
            )
            if result.warning:
                warnings.append(result.warning)
            current = result.provenance or self._extractor.ocr_pipeline.observation_provenance(
                result
            )
            if provenance is None:
                provenance = current
            elif provenance != current:
                raise OcrEngineFailure(
                    kind="protocol", completed_pages=pages, provenance=provenance
                )
        if provenance is None:
            raise OcrEngineFailure(kind="worker", completed_pages=pages)
        return OcrEngineRun(
            pages=tuple(pages),
            provenance=provenance,
            warnings=tuple(_unique_warnings(warnings)),
        )


class _WorkerOcrEngineAdapter:
    """Remote-owned worker result adapter; no worker transport leaks into policy."""

    def __init__(
        self,
        result: WorkerRunResult,
        engine: OcrProvenanceV3,
    ) -> None:
        self._result = result
        self._engine = engine

    def recognize(self, request: _OcrEngineRequest) -> OcrEngineRun:
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
    def _check_cancelled(request: _OcrEngineRequest) -> None:
        if request.is_cancelled():
            raise InterruptedError("Capture extraction was cancelled.")

    def _validate_terminal_result(self, manifest: tuple[OcrPageManifest, ...]) -> None:
        expected_numbers = tuple(item.page for item in manifest)
        if expected_numbers != tuple(range(1, len(manifest) + 1)):
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
    ) -> CaptureExtractionOutcome:
        if self.engine_manager is not None:
            return await self._extract_with_workers(
                content,
                source,
                cancel_event,
                pdf_page_numbers=pdf_page_numbers,
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
    ) -> CaptureExtractionOutcome:
        sniffed = self.sniff(content)
        self._checkpoint(cancel_event)
        ocr_projection = None
        expected_ocr_pages: tuple[OcrPageManifest, ...] | None = None
        ocr_page_scope: OcrPageScopeV2 | None = None
        execution_proof: OcrExecutionDeviceProofV1 | None = None
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
                    )
                except (ExtractionRuntimeUnavailableError, EngineRuntimeUnavailableError) as error:
                    raise OcrWorkerFailure(kind="unavailable", progress=None) from error
                execution_proof = result.execution_proof
                try:
                    engine = self._capture_engine(result, expected_engine="windowsml-ocr")
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
                            "renderScale": self.config.ocr_render_scale,
                        },
                        cancel_event,
                        page_manifest=expected_ocr_pages,
                    )
                except (ExtractionRuntimeUnavailableError, EngineRuntimeUnavailableError) as error:
                    raise OcrWorkerFailure(kind="unavailable", progress=None) from error
                execution_proof = result.execution_proof
                try:
                    engine = self._capture_engine(result, expected_engine="windowsml-ocr")
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
        except OcrWorkerFailure as error:
            if expected_ocr_pages is None:
                raise
            raise self._ocr_extraction_failure(source, expected_ocr_pages, error) from error
        self._checkpoint(cancel_event)
        if not segments:
            raise ValueError("Extraction produced no non-empty content.")
        raw = RawCapture(
            source=source,
            segments=segments,
            source_text=project_source_text(segments),
            extraction_engine=engine,
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
        request = _OcrRequest(
            capture_id=source.sha256,
            source=source,
            page_scope=tuple(page.page for page in expected_pages),
            manifest=expected_pages,
            created_at=self._clock.now(),
            warnings=(),
            is_cancelled=cancel_event.is_set,
        )
        outcome = self.ocr_pipeline._execute(
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
            )
        finally:
            path.unlink(missing_ok=True)

    def _ocr_pdf_page_manifest(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        raster_cache: list[bytes] | None = None,
        page_numbers: tuple[int, ...] | None = None,
    ) -> tuple[OcrPageManifest, ...]:
        page_count = self._pdf_page_count(content)
        if page_count > self.config.max_pdf_pages:
            raise ValueError(f"PDF has {page_count} pages; limit is {self.config.max_pdf_pages}.")
        selected_page_numbers = (
            tuple(range(1, page_count + 1)) if page_numbers is None else page_numbers
        )
        if (
            not selected_page_numbers
            or selected_page_numbers != tuple(range(1, len(selected_page_numbers) + 1))
            or selected_page_numbers[-1] > page_count
        ):
            raise ValueError("OCR PDF page selection must be an ordered prefix in the source.")
        pages: list[OcrPageManifest] = []
        for page_number in selected_page_numbers:
            self._checkpoint(cancel_event)
            raster = self._render_pdf_page(content, page_number - 1)
            if raster_cache is not None:
                raster_cache.append(raster)
            width, height = _raster_dimensions(raster)
            if width is None or height is None:
                raise ValueError(f"OCR raster metadata is unavailable for PDF page {page_number}.")
            pages.append(
                OcrPageManifest(
                    page=page_number,
                    raster_width=width,
                    raster_height=height,
                    raster_scale=self.config.ocr_render_scale,
                )
            )
        return tuple(pages)

    def _preflight_pdf_manifest(
        self,
        content: bytes,
        cancel_event: asyncio.Event,
        *,
        raster_cache: list[bytes] | None = None,
        page_numbers: tuple[int, ...] | None = None,
    ) -> tuple[OcrPageManifest, ...]:
        try:
            return self._ocr_pdf_page_manifest(
                content,
                cancel_event,
                raster_cache=raster_cache,
                page_numbers=page_numbers,
            )
        except (InterruptedError, OcrSourcePreflightError):
            raise
        except Exception as error:
            raise OcrSourcePreflightError from error

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
    ) -> OcrExtractionFailure:
        return self.ocr_pipeline.failure(
            capture_id=source.sha256,
            source=source,
            manifest=expected_pages,
            kind=error.kind,
            completed_pages=self._worker_progress_inputs(error.progress),
            provenance=error.provenance,
            created_at=self._clock.now(),
        )

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
        raster_pages: list[bytes] = []
        manifest = self._preflight_pdf_manifest(
            content,
            cancel_event,
            raster_cache=raster_pages,
            page_numbers=page_numbers,
        )
        projection = self.ocr_pipeline.extract(
            capture_id=source.sha256,
            source=source,
            manifest=manifest,
            engine=_SyncOcrEngineAdapter(
                self,
                content,
                CaptureSourceKind.PDF,
                cancel_event,
                raster_pages=tuple(raster_pages),
            ),
            created_at=self._clock.now(),
        )
        return _projection_segments(projection), projection

    @staticmethod
    def _pdf_page_count(content: bytes) -> int:
        import pypdfium2 as pdfium  # type: ignore[import-untyped]

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
        projection = self.ocr_pipeline.extract(
            capture_id=source.sha256,
            source=source,
            manifest=manifest,
            engine=_SyncOcrEngineAdapter(
                self,
                content,
                CaptureSourceKind.IMAGE,
                cancel_event,
                raster_pages=tuple(raster_pages),
            ),
            created_at=self._clock.now(),
        )
        return _projection_segments(projection), projection

    def _extract_audio(
        self, content: bytes, media_type: str, cancel_event: asyncio.Event
    ) -> tuple[list[RawCaptureSegment], CaptureEngine, list[str]]:
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
                return _normalize_image_png(image, scale=scale, max_pixels=max_pixels)
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


def _oriented_image_dimensions(content: bytes) -> tuple[int, int]:
    from PIL import Image, ImageOps

    with Image.open(BytesIO(content)) as image:
        oriented = ImageOps.exif_transpose(image)
        width, height = oriented.size
    if width <= 0 or height <= 0:
        raise ValueError("Image dimensions must be positive.")
    return width, height


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
                engine="whisper-primary",
                model="deterministic-whisper-v1",
                digest=_engine_digest("whisper-primary", "deterministic-whisper-v1"),
                device="fake",
            )
        else:
            parts = [part.strip() for part in text.split("\f") if part.strip()]
            if pdf_page_numbers is not None:
                if (
                    not pdf_page_numbers
                    or pdf_page_numbers != tuple(range(1, len(pdf_page_numbers) + 1))
                    or pdf_page_numbers[-1] > len(parts)
                ):
                    raise ValueError(
                        "OCR PDF page selection must be an ordered prefix in the source."
                    )
                parts = [parts[page_number - 1] for page_number in pdf_page_numbers]
            segments = [
                RawCaptureSegment(
                    segment_id=f"segment-{index + 1}",
                    order=index,
                    locator=PageLocator(page=index + 1),
                    text=part,
                )
                for index, part in enumerate(parts)
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
    "SniffedSource",
    "StandaloneRuntimeCaptureExtractor",
    "UnsupportedMediaError",
    "sniff_source",
]
