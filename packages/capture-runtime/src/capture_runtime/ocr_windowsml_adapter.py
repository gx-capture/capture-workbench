"""Standalone WindowsML OCR engine adapter.

The adapter deliberately owns its dependency and model probes. It never imports a host
application package, never downloads during extraction, and reports the exact missing runtime
asset instead of substituting deterministic content.
"""

from __future__ import annotations

import copy
import importlib.util
import sys
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4

from capture_runtime._engine_download_cache import default_cache_root
from capture_runtime.contracts import OcrProvenanceV3
from capture_runtime.ocr_alignment import (
    AlignmentCollector,
    AlignmentContractError,
    AlignmentRecord,
)
from capture_runtime.ocr_execution_evidence import (
    OcrExecutionEvidence,
    OcrExecutionEvidenceAdapter,
    OcrExecutionEvidenceError,
    OcrExecutionEvidenceFailure,
    OcrInferenceCleanupError,
    PaddleOcrExecutionEvidenceAdapter,
)
from capture_runtime.ocr_execution_proof import (
    OcrExecutionDeviceProofV1,
    OcrExecutionProofContextV1,
    OcrPipelineConstructionProofV1,
)
from capture_runtime.ocr_offline_stubs import (
    install_offline_aistudio_stubs,
    install_offline_huggingface_stubs,
)
from capture_runtime.ocr_paddle_normalization import (
    PaddleResultNormalizationError,
    compose_aligned_regions,
    normalize_paddle_results,
    paddle_results_sequence,
)
from capture_runtime.ocr_page_result import (
    OcrLayoutEvidence,
    OcrRegion,
    OcrTextResult,
    VerticalReader,
)
from capture_runtime.ocr_preflight import (
    NativeOcrAdapterMapLease,
    OcrExecutionPlan,
    OcrSelectionDeviceProofV1,
)
from capture_runtime.ocr_profile import (
    WINDOWSML_REQUIRED_MODEL_FILES,
    OcrProfileSpec,
    load_profile_spec,
    validate_model_artifacts,
)
from capture_runtime.ocr_reading_order import ReadingPlan, plan_reading_order
from capture_runtime.ocr_region_lineage import validate_region_sources
from capture_runtime.ocr_vertical_routing import (
    PageRoute,
    VerticalLayoutError,
    VerticalReaderAssetError,
    characters,
    reader_result_reason,
    route_reason,
    vertical_reader_directory,
    vertical_share,
)
from capture_runtime.worker_probe import (
    EngineProbe,
    EngineRuntimeUnavailableError,
    directory_digest,
)
from capture_runtime.worker_stage_policy import (
    ocr_probe_providers_stage,
    ocr_probe_readiness_stage,
    ocr_provider_evidence_stage,
    ocr_stage_failure,
    sanitize_worker_stage,
)


def _load_ocr_profile(model_dir: Path) -> OcrProfileSpec:
    profile = load_profile_spec(model_dir / "pipeline.json")
    validate_model_artifacts(model_dir, profile)
    return profile


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


def _default_paddle_pipeline(**kwargs: Any) -> Any:
    """Create PaddleOCR without mutating ONNX Runtime's process-global module.

    PaddleX 3.7 constructs ``InferenceSession`` internally and does not expose
    ORT's constructor fallback kwarg through ``engine_config``.  The factory
    therefore leaves the vendor modules untouched; the evidence adapter
    validates every returned session's provider identity before inference and
    fails closed if ORT returned a CPU-only retry session.
    """

    install_offline_aistudio_stubs()
    install_offline_huggingface_stubs()
    from paddleocr import PaddleOCR

    paddlex_config = _per_session_profile_config(kwargs)
    if paddlex_config is not None:
        kwargs = {**kwargs, "paddlex_config": paddlex_config}
    return PaddleOCR(**kwargs)


# Each OCR model's ONNX Runtime session profiles under its own prefix.
_SESSION_PROFILE_SUFFIXES = {
    "TextDetection": "det",
    "TextRecognition": "rec",
    "TextLineOrientation": "textline",
}


def _per_session_profile_config(
    kwargs: Mapping[str, Any],
    load_config: Callable[[str], Mapping[str, Any]] | None = None,
) -> dict[str, Any] | None:
    """Give every OCR model session its own ORT profile prefix.

    ORT opens a session's profile file when the session is created, naming it
    ``<prefix>_<timestamp to the second>.json``. PaddleX passes one prefix to
    every model, so two sessions created within the same second open the same
    file, and the shorter profile written at the end leaves the tail of the
    longer one behind it: invalid JSON, and a failed OCR run. A per-model
    ``engine_config`` replaces the pipeline's ``session_options``, so each
    model gets ``<prefix>_<model>``; ownership by ``<prefix>_`` is unchanged.
    Returns None when the kwargs do not enable profiling.
    """

    engine_config = kwargs.get("engine_config")
    if not isinstance(engine_config, Mapping):
        return None
    session_options = engine_config.get("session_options")
    if not isinstance(session_options, Mapping) or not session_options.get("enable_profiling"):
        return None
    prefix = session_options.get("profile_file_prefix")
    if not isinstance(prefix, str) or not prefix:
        return None
    if load_config is None:
        from paddlex.inference import load_pipeline_config

        load_config = load_pipeline_config
    config = copy.deepcopy(dict(load_config("OCR")))
    sub_modules = config.get("SubModules")
    if not isinstance(sub_modules, dict):
        raise EngineRuntimeUnavailableError("PaddleX OCR pipeline config has no SubModules.")
    for name, suffix in _SESSION_PROFILE_SUFFIXES.items():
        sub_module = sub_modules.get(name)
        if sub_module is None:
            continue
        if not isinstance(sub_module, dict):
            raise EngineRuntimeUnavailableError("PaddleX OCR pipeline config is invalid.")
        model_engine_config = sub_module.get("engine_config") or {}
        if not isinstance(model_engine_config, dict):
            raise EngineRuntimeUnavailableError("PaddleX OCR pipeline config is invalid.")
        sub_module["engine_config"] = {
            **model_engine_config,
            "session_options": {**session_options, "profile_file_prefix": f"{prefix}_{suffix}"},
        }
    return config


def _native_selected_adapter_map(
    plan: OcrExecutionPlan,
    lease: NativeOcrAdapterMapLease,
) -> tuple[str, str]:
    """Resolve the retained plan against the map owned by one DXGI lease."""

    if plan.mode.value != "gpu-dml" or plan.dml_device_id is None:
        raise EngineRuntimeUnavailableError("retained OCR plan is not a GPU plan")
    map_digest, joined = lease.adapter_map()
    selected = next((item for item in joined if item.index == plan.dml_device_id), None)
    if selected is None or selected.luid is None:
        raise EngineRuntimeUnavailableError("retained OCR adapter ordinal is unavailable")
    return map_digest, selected.luid


@dataclass(frozen=True, slots=True)
class ReusableOcrSession:
    """A pipeline whose execution was evidenced on its first run, for the worker's next run.

    Its ONNX Runtime sessions keep fallback disabled, and profiling ended when
    their DML evidence was read; a later run reuses that evidence with the same
    sessions. The plan's adapter map is still checked before each run.
    """

    model_dir: Path
    execution_plan: OcrExecutionPlan | None
    vertical_reader_dir: Path | None
    pipeline: Any
    device: str
    warning: str | None
    evidence: OcrExecutionEvidence | None
    model_digest: str | None
    vertical_reader: VerticalReader | None


class WindowsMLOcrAdapter:
    """PaddleOCR 3.7 DML-first session with no separate CPU-only retry."""

    def __init__(
        self,
        model_dir: Path,
        *,
        execution_plan: OcrExecutionPlan | None = None,
        pipeline_factory: Callable[..., Any] | None = None,
        alignment_collector_factory: Callable[[Any], Any] | None = None,
        provider_resolver: Callable[[], list[str]] | None = None,
        provider_evidence_adapter: OcrExecutionEvidenceAdapter | None = None,
        stage_reporter: Callable[[str], None] | None = None,
        adapter_map_resolver: Callable[[], tuple[str, str] | tuple[str, str, bool]] | None = None,
        adapter_map_lease_factory: Callable[[], NativeOcrAdapterMapLease] | None = None,
        selection_proof: Any | None = None,
        execution_proof_context: OcrExecutionProofContextV1 | None = None,
        source_sha256: str | None = None,
        requested_page_scope: tuple[int, ...] | None = None,
        runtime_sha256: str | None = None,
        vertical_reader_factory: Callable[[], VerticalReader] | None = None,
        vertical_reader_dir: Path | None = None,
        reusable_session: ReusableOcrSession | None = None,
    ) -> None:
        self.model_dir = model_dir
        # Where the optional vertical reader unit is installed; without it the
        # reader is looked for inside the OCR model directory, as before it
        # became optional.
        self._vertical_reader_dir = vertical_reader_dir
        # A page would have gone to the vertical reader, but it is not installed.
        self.vertical_reader_wanted = False
        self._vertical_reader_factory = vertical_reader_factory
        self._vertical_reader: VerticalReader | None = None
        if adapter_map_resolver is not None and adapter_map_lease_factory is not None:
            raise ValueError("OCR adapter map resolver and lease factory are mutually exclusive")
        self.execution_plan = execution_plan
        self.device_id = None if execution_plan is None else execution_plan.dml_device_id
        self._pipeline_factory = pipeline_factory
        # Injected predictors may omit PaddleX internals. Production canonical
        # predictors must support collection; attachment errors never fall back.
        self._alignment_collector_factory = alignment_collector_factory or (
            AlignmentCollector if pipeline_factory is None else None
        )
        self._provider_resolver = provider_resolver
        self._adapter_map_resolver = adapter_map_resolver
        self._adapter_map_lease_factory = adapter_map_lease_factory or (
            (lambda: NativeOcrAdapterMapLease())
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
            PaddleOcrExecutionEvidenceAdapter(
                self._profile_file_prefix,
                stage_reporter=stage_reporter,
            )
        )
        self._profile = _load_ocr_profile(model_dir)
        if execution_proof_context is None and runtime_sha256 is not None:
            if execution_plan is None or execution_plan.worker_sha256 is None:
                raise ValueError("OCR execution proof requires a retained worker identity")
            if source_sha256 is None:
                raise ValueError("OCR execution proof requires a source identity")
            model_digest = directory_digest(model_dir, WINDOWSML_REQUIRED_MODEL_FILES)
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
        # An execution proof binds this run's own sessions, so a proof run never reuses one.
        self._reusable = (
            reusable_session
            if reusable_session is not None
            and execution_proof_context is None
            and reusable_session.model_dir == model_dir
            and reusable_session.execution_plan == execution_plan
            and reusable_session.vertical_reader_dir == vertical_reader_dir
            else None
        )
        if self._reusable is not None:
            self._model_digest = self._reusable.model_digest
            self._vertical_reader = self._reusable.vertical_reader

    def reusable_session(self) -> ReusableOcrSession | None:
        """This run's pipeline for the worker's next run, once its execution is evidenced."""

        if (
            self._pipeline is None
            or self._cleanup_pending
            or self._execution_proof_context is not None
            or (
                self._device != "cpu"
                and (not self._execution_evidence_finalized or self._execution_evidence is None)
            )
        ):
            return None
        return ReusableOcrSession(
            model_dir=self.model_dir,
            execution_plan=self.execution_plan,
            vertical_reader_dir=self._vertical_reader_dir,
            pipeline=self._pipeline,
            device=self._device,
            warning=self._warning,
            evidence=self._execution_evidence,
            model_digest=self._model_digest,
            vertical_reader=self._vertical_reader,
        )

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
            self._model_digest = directory_digest(self.model_dir, WINDOWSML_REQUIRED_MODEL_FILES)
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
        alignment_records: tuple[AlignmentRecord, ...] | None = None
        try:
            self._report_stage("ocr-pipeline-create-start")
            pipeline = self._get_pipeline()
            self._report_stage("ocr-pipeline-create-complete")
            failure_stage = "predict"
            self._report_stage("ocr-predict-start")
            if self._alignment_collector_factory is None:
                results = self._predict(pipeline, image_png)
            else:
                with self._alignment_collector_factory(pipeline) as collector:
                    results = self._predict(pipeline, image_png)
                alignment_records = collector.records
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
                    self._model_digest = directory_digest(
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
        result_failure_code = "ocr_provenance_failed"
        try:
            if self._model_digest is None:
                self._model_digest = directory_digest(
                    self.model_dir, WINDOWSML_REQUIRED_MODEL_FILES
                )
            raster_width, raster_height = _png_dimensions(image_png)
            if alignment_records is not None:
                result_failure_code = "ocr_composite_split_failed"
                results = paddle_results_sequence(results)
                if len(results) != 1 or any(record.page_index != 0 for record in alignment_records):
                    raise AlignmentContractError(
                        "OCR alignment requires the canonical single-PNG, single-result path."
                    )
            normalized = normalize_paddle_results(
                results,
                raster_width=raster_width,
                raster_height=raster_height,
            )
            result_failure_code = "ocr_composite_split_failed"
            layout_regions, sources, splits = compose_aligned_regions(
                normalized, alignment_records, raster_width, raster_height
            )
            result_failure_code = "ocr_reading_order_failed"
            reading_plan = plan_reading_order(
                layout_regions, raw_source_slots=normalized.source_slots if not splits else None
            )
            regions = tuple(layout_regions[index] for index in reading_plan.order)
            ordered_sources = tuple(sources[index] for index in reading_plan.order)
            validate_region_sources(
                normalized.regions, normalized.source_slots, regions, ordered_sources
            )
            text = reading_plan.text if reading_plan.applied or splits else normalized.text
            layout_evidence: OcrLayoutEvidence | None = OcrLayoutEvidence(
                reading_plan,
                ordered_sources,
                splits,
                normalized.regions,
                normalized.source_slots,
            )
            result_failure_code = "ocr_vertical_reader_failed"
            page_route, vertical_regions = self._read_vertical_page(
                image_png, normalized.regions, reading_plan
            )
            if vertical_regions is not None:
                regions = vertical_regions
                text = "\n".join(region.text for region in regions)
                layout_evidence = None
            result_failure_code = "ocr_provenance_failed"
            return OcrTextResult(
                text=text,
                device=self._device,
                model=self._profile.model,
                digest=self._model_digest,
                warning=self._warning,
                regions=regions,
                raster_width=raster_width,
                raster_height=raster_height,
                region_confidences=tuple(
                    region.confidence for region in regions if region.confidence is not None
                ),
                profile_id=self._profile.profile_id,
                profile_spec_sha256=self._profile.profile_spec_sha256,
                layout_evidence=layout_evidence,
                page_route=page_route,
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
            self._report_stage(ocr_stage_failure("normalize", error))
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
                    primary_code=result_failure_code,
                    cleanup_error=cleanup_error,
                ) from error
            raise

    def _read_vertical_page(
        self,
        image_png: bytes,
        first_pass: tuple[OcrRegion, ...],
        reading_plan: ReadingPlan,
    ) -> tuple[PageRoute | None, tuple[OcrRegion, ...] | None]:
        """Read a vertical-dominant page with the whole-page reader, when one is installed.

        Returns the routing record and the reader's regions in its reading order,
        or no regions when the page stays with the regular pipeline. A reader that
        cannot be loaded or fails in inference fails the page; a page it cannot
        lay out, or reads far shorter than the first pass, keeps the first pass.
        """

        measure = vertical_share(first_pass)
        if self._vertical_reader_factory is None and self._reader_directory() is None:
            # Not installed: the page keeps its first pass. Remember that the
            # reader would have run, so the host can offer the optional unit.
            if route_reason(measure, treated_as_vertical=bool(reading_plan.articles)) is None:
                self.vertical_reader_wanted = True
            return None, None

        def route(reader: str, reason: str, lines: tuple[OcrRegion, ...] | None) -> PageRoute:
            return PageRoute(
                reader=reader,
                reason=reason,
                vertical_share=measure.share,
                tall_boxes=measure.tall_boxes,
                first_pass_characters=measure.characters,
                kana_share=measure.kana_share,
                reader_characters=(
                    None if lines is None else sum(characters(line.text) for line in lines)
                ),
                reader_lines=None if lines is None else len(lines),
                recognizer_device=getattr(self._vertical_reader, "recognizer_device", None),
                derived_recognizers=getattr(self._vertical_reader, "derived_recognizers", None),
            )

        reason = route_reason(measure, treated_as_vertical=bool(reading_plan.articles))
        if reason is not None:
            return route("regular", reason, None), None
        if self._vertical_reader is None:
            self._vertical_reader = self._create_vertical_reader()
        try:
            lines = self._vertical_reader.read_png(image_png)
        except VerticalLayoutError:
            return route("regular", "reader_layout_failed", None), None
        regions = tuple(
            OcrRegion(text, line.confidence, line.polygon)
            for line in lines
            if (text := line.text.strip())
        )
        reason = reader_result_reason(measure.characters, [region.text for region in regions])
        if reason is not None:
            return route("regular", reason, regions), None
        return route("vertical", "vertical_dominant", regions), regions

    def _reader_directory(self) -> Path | None:
        if self._vertical_reader_dir is not None:
            return self._vertical_reader_dir if self._vertical_reader_dir.is_dir() else None
        return vertical_reader_directory(self.model_dir)

    def _create_vertical_reader(self) -> VerticalReader:
        if self._vertical_reader_factory is not None:
            return self._vertical_reader_factory()
        directory = self._reader_directory()
        if directory is None:
            raise EngineRuntimeUnavailableError("The vertical reader is not installed.")
        from capture_runtime.ocr_vertical_reader import (
            VerticalPageReader,
            VerticalReaderDeviceError,
        )

        # The recognizers follow the regular pipeline: its DirectML device when it runs
        # on one, and no separate CPU retry when that device refuses them.
        device_id = None if self._device == "cpu" else self.device_id
        try:
            return VerticalPageReader(
                directory, dml_device_id=device_id, cache_root=default_cache_root()
            )
        except (VerticalReaderAssetError, VerticalReaderDeviceError) as error:
            raise EngineRuntimeUnavailableError(str(error)) from error
        except Exception as error:
            raise EngineRuntimeUnavailableError(
                f"The vertical reader could not be loaded: {type(error).__name__}."
            ) from error

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
        lease: NativeOcrAdapterMapLease,
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
        if self._reusable is not None:
            return self._reuse_pipeline(self._reusable)
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

    def _reuse_pipeline(self, reusable: ReusableOcrSession) -> Any:
        """Take the evidenced pipeline after checking the plan's adapter is still current."""

        if reusable.device != "cpu":
            lease = None
            try:
                if self._adapter_map_lease_factory is not None:
                    try:
                        lease = self._adapter_map_lease_factory()
                    except Exception as error:
                        raise EngineRuntimeUnavailableError(
                            "retained OCR GPU plan could not create a native adapter map lease"
                        ) from error
                self._report_stage("ocr-native-map-before")
                if lease is not None:
                    self._validate_native_plan_map(lease)
                else:
                    self._validate_plan_map()
            finally:
                if lease is not None:
                    lease.close()
        self._device = reusable.device
        self._warning = reusable.warning
        self._execution_evidence = reusable.evidence
        self._execution_evidence_finalized = reusable.evidence is not None
        self._pipeline = reusable.pipeline
        return reusable.pipeline

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


__all__ = [
    "ReusableOcrSession",
    "WindowsMLOcrAdapter",
]
