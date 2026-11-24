from collections.abc import Callable
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

import capture_runtime.ocr.infrastructure.ocr_projection as ocr_projection_module
from capture_runtime.capture.infrastructure.capture_extraction import CaptureExtractionOutcome
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureOcrProjection,
    CaptureSource,
    OcrBox,
    OcrPageProjection,
    OcrPageStatus,
    OcrProjectionStatus,
    OcrProvenance,
    OcrRaster,
    OperationFailure,
    PageLocator,
    RawCapture,
    RawCaptureSegment,
)
from capture_runtime.ocr.infrastructure.ocr_page_result import OcrRegion, OcrTextResult
from capture_runtime.ocr.infrastructure.ocr_projection import (
    OcrEngineFailure,
    OcrEngineRequest,
    OcrEngineRun,
    OcrPageInput,
    OcrPageManifest,
    OcrPipeline,
    OcrProjectionError,
    OcrRequest,
    OcrTerminalOutcome,
)


def _source() -> CaptureSource:
    return CaptureSource(
        sha256="a" * 64,
        file_name="scan.pdf",
        media_type="application/pdf",
        bytes=128,
    )


def _engine() -> OcrProvenance:
    return OcrProvenance(
        status="resolved",
        engine="text-recognition",
        model="pp-ocrv6-medium",
        model_digest="sha256:" + "b" * 64,
        device="directml",
        profile_id="ocr-pipeline-v1",
        profile_spec_sha256="c" * 64,
    )


def test_canonical_projection_requires_pages_but_allows_failed_empty_pages() -> None:
    schema = CaptureOcrProjection.model_json_schema(by_alias=True)
    assert "pages" in schema["required"]
    assert "minItems" not in schema["properties"]["pages"]

    failure = OperationFailure(
        code="ocr_worker_failed",
        message="OCR worker failed.",
        stage="ocr",
        retryable=True,
    )
    projection = CaptureOcrProjection(
        capture_id="capture-empty-failed",
        status=OcrProjectionStatus.FAILED,
        source=None,
        pages=[],
        provenance=_engine(),
        api_version="2.0",
        schema_version="3",
        processed_page_count=0,
        runtime_version=RUNTIME_VERSION,
        contract_set_sha256="d" * 64,
        failure=failure,
        created_at=datetime.now(UTC),
    )
    assert projection.pages == []

    with pytest.raises(ValidationError):
        CaptureOcrProjection(
            capture_id="capture-missing-pages",
            status=OcrProjectionStatus.FAILED,
            source=None,
            provenance=None,
            failure=failure,
            created_at=datetime.now(UTC),
        )


def test_canonical_projection_requires_wire_identity_and_processed_page_count() -> None:
    schema = CaptureOcrProjection.model_json_schema(by_alias=True)
    required = set(schema["required"])
    assert {
        "apiVersion",
        "schemaVersion",
        "processedPageCount",
        "runtimeVersion",
        "contractSetSha256",
        "provenance",
    } <= required
    assert "coordinateSystem" in OcrRaster.model_json_schema(by_alias=True)["required"]


def test_canonical_box_schema_requires_polygon_text_and_confidence_shape() -> None:
    schema = OcrBox.model_json_schema(by_alias=True)
    assert set(schema["required"]) == {"polygon", "text", "confidence"}
    assert "x" not in schema["properties"]
    assert schema["properties"]["polygon"]["minItems"] == 4

    with pytest.raises(ValidationError):
        OcrBox(
            polygon=[
                {"x": 0, "y": 0},
                {"x": 10, "y": 0},
                {"x": 10, "y": 10},
            ],
            text="malformed",
        )
    with pytest.raises(ValidationError):
        OcrBox(
            polygon=[
                {"x": 0, "y": 0},
                {"x": 10, "y": 0},
                {"x": 10, "y": 10},
                {"x": float("nan"), "y": 10},
            ],
            text="nan",
        )


def test_pre_inference_provenance_is_an_explicit_unavailable_variant() -> None:
    resolved_schema = OcrProvenance.model_json_schema(by_alias=True)
    resolved_digest_schema = resolved_schema["$defs"]["OcrProvenanceResolved"]["properties"][
        "modelDigest"
    ]
    assert resolved_digest_schema["not"]["const"] == "sha256:" + "0" * 64
    unavailable = {
        "status": "unavailable",
        "profileId": "ocr-pipeline-v1",
        "profileSpecSha256": "c" * 64,
        "reason": "model_unavailable",
    }
    parsed = OcrProvenance.model_validate(unavailable)
    assert parsed.status == "unavailable"
    assert parsed.profile_id == "ocr-pipeline-v1"
    assert "modelDigest" not in parsed.model_dump(by_alias=True)
    assert "device" not in parsed.model_dump(by_alias=True)

    with pytest.raises(ValidationError):
        OcrProvenance.model_validate(
            {
                **unavailable,
                "modelDigest": "sha256:" + "0" * 64,
                "device": "directml",
            }
        )

    with pytest.raises(ValidationError, match="resolved model"):
        OcrProvenance(
            status="resolved",
            engine="text-recognition",
            model="pp-ocrv6-medium",
            model_digest="sha256:" + "0" * 64,
            device="directml",
            profile_id="ocr-pipeline-v1",
            profile_spec_sha256="c" * 64,
        )


def test_unavailable_provenance_is_only_valid_for_failed_pages_and_documents() -> None:
    unavailable = OcrProvenance(
        status="unavailable",
        profile_id="ocr-pipeline-v1",
        profile_spec_sha256="c" * 64,
        reason="model_unavailable",
    )
    raster = OcrRaster(width=100, height=80, scale=2, coordinate_system="pixel")
    failure = OperationFailure(
        code="ocr_worker_failed",
        message="OCR worker failed.",
        stage="ocr",
        retryable=True,
    )
    failed_page = OcrPageProjection(
        page=1,
        status=OcrPageStatus.FAILED,
        raster=raster,
        provenance=unavailable,
        failure=failure,
    )
    failed = CaptureOcrProjection(
        capture_id="capture-unavailable",
        status=OcrProjectionStatus.FAILED,
        source=None,
        pages=[failed_page],
        provenance=unavailable,
        api_version="2.0",
        schema_version="3",
        processed_page_count=1,
        runtime_version=RUNTIME_VERSION,
        contract_set_sha256="d" * 64,
        failure=failure,
        created_at=datetime.now(UTC),
    )
    assert failed.provenance.status == "unavailable"

    with pytest.raises(ValidationError, match="resolved provenance"):
        OcrPageProjection(
            page=1,
            status=OcrPageStatus.RECOGNIZED,
            raster=raster,
            text="recognized",
            confidence=0.9,
            provenance=unavailable,
        )
    with pytest.raises(ValidationError, match="resolved provenance"):
        CaptureOcrProjection(
            capture_id="capture-completed-unavailable",
            status=OcrProjectionStatus.COMPLETED,
            source=_source(),
            pages=[failed_page],
            provenance=unavailable,
            api_version="2.0",
            schema_version="3",
            processed_page_count=1,
            runtime_version=RUNTIME_VERSION,
            contract_set_sha256="d" * 64,
            created_at=datetime.now(UTC),
        )


def test_completed_projection_requires_recognized_pages_and_matching_page_provenance() -> None:
    empty_page = OcrPageProjection(
        page=1,
        status=OcrPageStatus.EMPTY,
        raster=OcrRaster(width=100, height=80, scale=2, coordinate_system="pixel"),
        provenance=_engine(),
    )
    with pytest.raises(ValidationError, match="recognized"):
        CaptureOcrProjection(
            capture_id="capture-no-recognized",
            status=OcrProjectionStatus.COMPLETED,
            source=_source(),
            pages=[empty_page],
            provenance=_engine(),
            api_version="2.0",
            schema_version="3",
            processed_page_count=1,
            runtime_version=RUNTIME_VERSION,
            contract_set_sha256="d" * 64,
            created_at=datetime.now(UTC),
        )

    page_with_other_provenance = OcrPageProjection(
        page=1,
        status=OcrPageStatus.RECOGNIZED,
        raster=OcrRaster(width=100, height=80, scale=2, coordinate_system="pixel"),
        text="recognized",
        confidence=0.5,
        provenance=OcrProvenance(
            status="resolved",
            engine="text-recognition",
            model="other",
            model_digest="sha256:" + "e" * 64,
            device="cpu",
            profile_id="ocr-pipeline-v1",
            profile_spec_sha256="c" * 64,
        ),
    )
    with pytest.raises(ValidationError, match="provenance"):
        CaptureOcrProjection(
            capture_id="capture-mismatched-provenance",
            status=OcrProjectionStatus.COMPLETED,
            source=_source(),
            pages=[page_with_other_provenance],
            provenance=_engine(),
            api_version="2.0",
            schema_version="3",
            processed_page_count=1,
            runtime_version=RUNTIME_VERSION,
            contract_set_sha256="d" * 64,
            created_at=datetime.now(UTC),
        )


class _InMemoryOcrEngine:
    """Test adapter for the OCR pipeline seam; no Paddle transport leaks here."""

    def __init__(self, pages: tuple[OcrPageInput, ...]) -> None:
        self.pages = pages
        self.manifest: tuple[OcrPageManifest, ...] | None = None

    def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
        self.manifest = request.manifest
        return OcrEngineRun(
            pages=self.pages,
            provenance=_engine(),
            warnings=("adapter warning",),
        )


def test_pipeline_interface_accepts_source_manifest_and_engine_port() -> None:
    engine = _InMemoryOcrEngine(
        (
            OcrPageInput(
                page=1,
                text="繁體中文 English",
                raster_width=1200,
                raster_height=800,
                raster_scale=2,
                boxes=((10, 20, 300, 40),),
                region_confidences=(0.94,),
            ),
            OcrPageInput(
                page=2,
                text="",
                raster_width=1200,
                raster_height=800,
                raster_scale=2,
            ),
        )
    )

    projection = OcrPipeline().extract(
        OcrRequest(
            capture_id="capture-pipeline",
            source=_source(),
            page_scope=None,
            manifest=(
                OcrPageManifest(page=1, raster_width=1200, raster_height=800, raster_scale=2),
                OcrPageManifest(page=2, raster_width=1200, raster_height=800, raster_scale=2),
            ),
            created_at=datetime.now(UTC),
            warnings=(),
            is_cancelled=lambda: False,
        ),
        engine,
    )

    assert isinstance(projection, CaptureOcrProjection)
    assert engine.manifest is not None
    assert projection.status is OcrProjectionStatus.COMPLETED
    assert [page.page for page in projection.pages] == [1, 2]
    assert projection.pages[0].status is OcrPageStatus.RECOGNIZED
    assert projection.pages[0].boxes[0].x == 10
    assert projection.pages[0].confidence == pytest.approx(0.94)
    assert projection.pages[1].status is OcrPageStatus.EMPTY
    assert projection.pages[1].raster.coordinate_system == "pixel"
    assert projection.warnings == ["adapter warning"]


def _streaming_request(
    manifest: tuple[OcrPageManifest, ...],
    progress: list[dict[str, object]],
    is_cancelled: Callable[[], bool],
    page_scope: tuple[int, ...] | None = None,
) -> OcrRequest:
    return OcrRequest(
        capture_id="capture-streaming-seam",
        source=_source(),
        page_scope=page_scope,
        manifest=manifest,
        created_at=datetime.now(UTC),
        warnings=(),
        is_cancelled=is_cancelled,
        progress=progress.append,
    )


def test_canonical_request_accepts_explicit_manifest_scope() -> None:
    manifest = (
        OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
        OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
    )
    progress: list[dict[str, object]] = []
    seen_manifests: list[tuple[OcrPageManifest, ...]] = []

    class ScopedEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            seen_manifests.append(request.manifest)
            pages = tuple(
                request.observe(
                    expected,
                    OcrPageInput(
                        page=expected.page,
                        text="page text",
                        raster_width=expected.raster_width,
                        raster_height=expected.raster_height,
                        raster_scale=expected.raster_scale,
                        provenance=_engine(),
                    ),
                    _engine(),
                )
                for expected in request.manifest
            )
            return OcrEngineRun(pages=pages, provenance=_engine())

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False, page_scope=(1, 2)),
        ScopedEngine(),
    )

    assert isinstance(outcome, CaptureOcrProjection)
    assert seen_manifests == [manifest]
    assert [page.page for page in outcome.pages] == [1, 2]


@pytest.mark.parametrize(
    "page_scope",
    [(2, 1), (1, 1), (1,), (1, 2, 3), (True, 2)],
)
def test_canonical_request_rejects_scope_before_engine_or_progress(
    page_scope: tuple[object, ...],
) -> None:
    manifest = (
        OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
        OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
    )
    progress: list[dict[str, object]] = []
    engine_calls = 0

    class NeverEngine:
        def recognize(self, _request: OcrEngineRequest) -> OcrEngineRun:
            nonlocal engine_calls
            engine_calls += 1
            raise AssertionError("invalid page scope must stop before the engine")

    with pytest.raises(OcrProjectionError, match="page scope"):
        OcrPipeline().extract(
            _streaming_request(
                manifest,
                progress,
                lambda: False,
                page_scope=page_scope,  # type: ignore[arg-type]
            ),
            NeverEngine(),
        )

    assert engine_calls == 0
    assert progress == []


def test_canonical_request_cancellation_stops_before_engine_or_progress() -> None:
    manifest = (OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),)
    progress: list[dict[str, object]] = []
    engine_calls = 0

    class NeverEngine:
        def recognize(self, _request: OcrEngineRequest) -> OcrEngineRun:
            nonlocal engine_calls
            engine_calls += 1
            raise AssertionError("pre-cancelled request must stop before the engine")

    with pytest.raises(InterruptedError):
        OcrPipeline().extract(
            _streaming_request(manifest, progress, lambda: True),
            NeverEngine(),
        )

    assert engine_calls == 0
    assert progress == []


def _malformed_manifest_item(**changes: object) -> OcrPageManifest:
    item = object.__new__(OcrPageManifest)
    values: dict[str, object] = {
        "page": 1,
        "raster_width": 640,
        "raster_height": 480,
        "raster_scale": 1,
    }
    values.update(changes)
    for name, value in values.items():
        object.__setattr__(item, name, value)
    return item


@pytest.mark.parametrize(
    "manifest",
    [
        object(),
        (object(),),
        (_malformed_manifest_item(page=True),),
        (_malformed_manifest_item(raster_width=0),),
        (_malformed_manifest_item(raster_width=-1),),
        (_malformed_manifest_item(raster_height=float("inf")),),
        (_malformed_manifest_item(raster_scale=float("nan")),),
    ],
)
def test_public_extract_rejects_malformed_manifest_before_engine_or_progress(
    manifest: object,
) -> None:
    progress: list[dict[str, object]] = []
    engine_calls = 0

    class NeverEngine:
        def recognize(self, _request: object) -> OcrEngineRun:
            nonlocal engine_calls
            engine_calls += 1
            raise AssertionError("invalid manifest must stop before the engine")

    pipeline = OcrPipeline()
    request = OcrRequest(
        capture_id="capture-malformed-manifest",
        source=_source(),
        page_scope=None,
        manifest=manifest,  # type: ignore[arg-type]
        created_at=datetime.now(UTC),
        warnings=(),
        is_cancelled=lambda: False,
        progress=progress.append,
    )
    with pytest.raises(OcrProjectionError):
        pipeline.extract(request, NeverEngine())

    assert engine_calls == 0
    assert progress == []


def test_extract_requires_positional_request_and_engine() -> None:
    manifest = (OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),)
    request = _streaming_request(manifest, [], lambda: False)
    pipeline = OcrPipeline()

    with pytest.raises(TypeError):
        pipeline.extract(request, object(), warnings=())
    with pytest.raises(TypeError):
        pipeline.extract(request=request, engine=object())


def test_canonical_execution_stops_before_second_page_after_cancellation() -> None:
    manifest = (
        OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
        OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
    )
    progress: list[dict[str, object]] = []
    cancelled = False
    recognized_pages: list[int] = []

    class StreamingEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            nonlocal cancelled
            first = request.observe(
                manifest[0],
                OcrPageInput(
                    page=1,
                    text="first",
                    raster_width=640,
                    raster_height=480,
                    raster_scale=1,
                    provenance=_engine(),
                ),
                _engine(),
            )
            recognized_pages.append(first.page)
            cancelled = True
            if request.is_cancelled():
                raise InterruptedError
            raise AssertionError("second page recognition must not start")

    with pytest.raises(InterruptedError):
        OcrPipeline().extract(
            _streaming_request(manifest, progress, lambda: cancelled),
            StreamingEngine(),
        )

    assert recognized_pages == [1]
    assert [event["type"] for event in progress] == ["ocr-header", "ocr-page"]


def test_canonical_execution_emits_failed_page_and_no_success_on_provenance_change() -> None:
    manifest = (
        OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
        OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
    )
    progress: list[dict[str, object]] = []
    changed = OcrProvenance(
        status="resolved",
        engine="text-recognition",
        model="different-model",
        model_digest="sha256:" + "d" * 64,
        device="directml",
        profile_id="ocr-pipeline-v1",
        profile_spec_sha256="c" * 64,
    )

    class ChangingEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            request.observe(
                manifest[0],
                OcrPageInput(
                    page=1,
                    text="first",
                    raster_width=640,
                    raster_height=480,
                    raster_scale=1,
                    provenance=_engine(),
                ),
                _engine(),
            )
            try:
                request.observe(
                    manifest[1],
                    OcrPageInput(
                        page=2,
                        text="second",
                        raster_width=640,
                        raster_height=480,
                        raster_scale=1,
                        provenance=changed,
                    ),
                    changed,
                )
            except ValueError:
                request.fail_page(manifest[1])
                raise
            raise AssertionError("provenance drift must fail")

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False),
        ChangingEngine(),
    )

    assert isinstance(outcome, OcrTerminalOutcome)
    assert outcome.failure.code == "ocr_worker_protocol"
    assert outcome.projection.status is OcrProjectionStatus.FAILED
    assert [page.status for page in outcome.projection.pages] == [
        OcrPageStatus.RECOGNIZED,
        OcrPageStatus.FAILED,
    ]
    assert [event["type"] for event in progress] == [
        "ocr-header",
        "ocr-page",
        "ocr-page",
    ]
    assert progress[-1]["page"]["status"] == "failed"  # type: ignore[index]


def test_canonical_execution_keeps_empty_pages_and_returns_typed_no_text_outcome() -> None:
    manifest = (
        OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
        OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
    )
    progress: list[dict[str, object]] = []

    class EmptyEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            pages = tuple(
                request.observe(
                    expected,
                    OcrPageInput(
                        page=expected.page,
                        text="",
                        raster_width=expected.raster_width,
                        raster_height=expected.raster_height,
                        raster_scale=expected.raster_scale,
                        provenance=_engine(),
                    ),
                    _engine(),
                )
                for expected in manifest
            )
            return OcrEngineRun(pages=pages, provenance=_engine())

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False),
        EmptyEngine(),
    )

    assert isinstance(outcome, OcrTerminalOutcome)
    assert outcome.failure.code == "ocr_no_text"
    assert [page.status for page in outcome.projection.pages] == [
        OcrPageStatus.EMPTY,
        OcrPageStatus.EMPTY,
    ]
    assert [event["type"] for event in progress] == [
        "ocr-header",
        "ocr-page",
        "ocr-page",
    ]


def test_canonical_execution_emits_no_progress_before_early_dml_failure() -> None:
    manifest = (OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),)
    progress: list[dict[str, object]] = []

    class UnavailableEngine:
        def recognize(self, _request: OcrEngineRequest) -> OcrEngineRun:
            raise OcrEngineFailure(kind="unavailable")

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False),
        UnavailableEngine(),
    )

    assert isinstance(outcome, OcrTerminalOutcome)
    assert outcome.failure.code == "ocr_runtime_unavailable"
    assert progress == []


@pytest.mark.parametrize("page_sequence", [(2, 1), (1, 1)])
def test_private_execution_rejects_out_of_order_or_duplicate_pages(
    page_sequence: tuple[int, int],
) -> None:
    manifest = (
        OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
        OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
    )
    progress: list[dict[str, object]] = []

    class InvalidOrderEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            pages = []
            for page_number in page_sequence:
                expected = manifest[page_number - 1]
                pages.append(
                    request.observe(
                        expected,
                        OcrPageInput(
                            page=page_number,
                            text=f"page {page_number}",
                            raster_width=640,
                            raster_height=480,
                            raster_scale=1,
                            provenance=_engine(),
                        ),
                        _engine(),
                    )
                )
            return OcrEngineRun(pages=tuple(pages), provenance=_engine())

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False),
        InvalidOrderEngine(),
    )

    assert isinstance(outcome, OcrTerminalOutcome)
    assert outcome.failure.code == "ocr_worker_protocol"
    assert outcome.projection.status is OcrProjectionStatus.FAILED
    if page_sequence == (2, 1):
        assert progress == []
    else:
        assert [event["type"] for event in progress] == ["ocr-header", "ocr-page"]


def test_polygon_round_trip_preserves_each_predictor_point_in_wire_order() -> None:
    polygon = (
        (11.25, 20.5),
        (91.75, 18.0),
        (104.0, 61.25),
        (4.5, 64.0),
    )
    observation = OcrTextResult(
        text="perspective",
        device="cpu",
        model="pp-ocrv6-medium",
        digest="sha256:" + "b" * 64,
        regions=(OcrRegion(text="perspective", confidence=0.93, polygon=polygon),),
        raster_width=120,
        raster_height=80,
        raster_scale=1,
        provenance=_engine(),
    )
    pipeline = OcrPipeline()
    manifest = (OcrPageManifest(page=1, raster_width=120, raster_height=80, raster_scale=1),)
    progress: list[dict[str, object]] = []

    class PolygonEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            page = request.observe(manifest[0], observation, _engine())
            return OcrEngineRun(pages=(page,), provenance=_engine())

    projection = pipeline.extract(
        _streaming_request(manifest, progress, lambda: False),
        PolygonEngine(),
    )
    assert isinstance(projection, CaptureOcrProjection)
    wire = projection.model_dump(mode="json", by_alias=True)

    assert wire["pages"][0]["boxes"][0] == {
        "polygon": [{"x": x, "y": y} for x, y in polygon],
        "text": "perspective",
        "confidence": 0.93,
    }

    worker_wire = progress[-1]["page"]
    assert isinstance(worker_wire, dict)
    assert worker_wire["boxes"] == [
        {
            "polygon": [{"x": x, "y": y} for x, y in polygon],
            "text": "perspective",
            "confidence": 0.93,
        }
    ]


def test_pipeline_rejects_polygon_outside_manifest_raster() -> None:
    polygon = ((0, 0), (10, 0), (10, 81), (0, 10))
    observation = OcrTextResult(
        text="outside",
        device="cpu",
        model="pp-ocrv6-medium",
        digest="sha256:" + "b" * 64,
        regions=(OcrRegion(text="outside", confidence=0.9, polygon=polygon),),
        raster_width=120,
        raster_height=80,
        raster_scale=1,
        provenance=_engine(),
    )
    manifest = (OcrPageManifest(page=1, raster_width=120, raster_height=80, raster_scale=1),)
    progress: list[dict[str, object]] = []

    class InvalidPolygonEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            request.observe(manifest[0], observation, _engine())
            raise AssertionError("invalid polygon must fail during observation")

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False),
        InvalidPolygonEngine(),
    )

    assert isinstance(outcome, OcrTerminalOutcome)
    assert outcome.failure.code == "ocr_worker_protocol"
    assert outcome.projection.pages[0].status is OcrPageStatus.FAILED
    assert outcome.projection.pages[0].failure == outcome.failure
    assert progress == []


def test_public_pipeline_boundary_retired_helpers_are_absent() -> None:
    pipeline = OcrPipeline()

    for helper in ("normalize_observation", "serialize_page", "failed_page"):
        assert not hasattr(pipeline, helper)
    for private_alias in ("_OcrRequest", "_OcrEngineRequest", "_OcrEnginePort"):
        assert not hasattr(ocr_projection_module, private_alias)


def test_pipeline_failure_keeps_a_readable_typed_projection() -> None:
    class FailingEngine:
        def recognize(self, _request: OcrEngineRequest) -> OcrEngineRun:
            raise OcrEngineFailure(kind="worker")

    outcome = OcrPipeline().extract(
        OcrRequest(
            capture_id="capture-failure",
            source=_source(),
            page_scope=None,
            manifest=(
                OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
            ),
            created_at=datetime.now(UTC),
            warnings=(),
            is_cancelled=lambda: False,
        ),
        FailingEngine(),
    )
    assert isinstance(outcome, OcrTerminalOutcome)

    projection = outcome.projection
    assert projection.status is OcrProjectionStatus.FAILED
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_failed"
    assert projection.pages[0].status is OcrPageStatus.FAILED
    assert projection.pages[0].failure == projection.failure


def test_invalid_model_digest_fails_closed_with_unavailable_provenance() -> None:
    class InvalidIdentityEngine:
        def recognize(self, _request: OcrEngineRequest) -> OcrEngineRun:
            return OcrEngineRun(
                pages=(
                    OcrPageInput(
                        page=1,
                        text="should not be trusted",
                        raster_width=640,
                        raster_height=480,
                        raster_scale=1,
                    ),
                ),
                provenance=CaptureEngine(
                    engine="text-recognition",
                    model="pp-ocrv6-medium",
                    digest="sha256:" + "0" * 64,
                    device="directml",
                ),
            )

    outcome = OcrPipeline().extract(
        OcrRequest(
            capture_id="capture-invalid-model-digest",
            source=_source(),
            page_scope=None,
            manifest=(
                OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
            ),
            created_at=datetime.now(UTC),
            warnings=(),
            is_cancelled=lambda: False,
        ),
        InvalidIdentityEngine(),
    )
    assert isinstance(outcome, OcrTerminalOutcome)

    projection = outcome.projection
    assert projection.provenance.status == "unavailable"
    assert projection.provenance.reason == "protocol_failure"
    assert projection.pages[0].status is OcrPageStatus.FAILED
    assert projection.pages[0].provenance == projection.provenance
    assert "modelDigest" not in projection.provenance.model_dump(by_alias=True)


def test_all_empty_terminal_projection_is_failed_with_stable_no_text_failure() -> None:
    engine = _InMemoryOcrEngine(
        (
            OcrPageInput(page=1, text="", raster_width=640, raster_height=480, raster_scale=1),
            OcrPageInput(page=2, text="   ", raster_width=640, raster_height=480, raster_scale=1),
        )
    )

    outcome = OcrPipeline().extract(
        OcrRequest(
            capture_id="capture-empty",
            source=_source(),
            page_scope=None,
            manifest=(
                OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
                OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
            ),
            created_at=datetime.now(UTC),
            warnings=(),
            is_cancelled=lambda: False,
        ),
        engine,
    )
    assert isinstance(outcome, OcrTerminalOutcome)

    projection = outcome.projection
    assert projection.status is OcrProjectionStatus.FAILED
    assert projection.failure is not None
    assert projection.failure.code == "ocr_no_text"
    assert [page.status for page in projection.pages] == [OcrPageStatus.EMPTY, OcrPageStatus.EMPTY]


def test_worker_failure_preserves_only_trusted_completed_pages() -> None:
    manifest = (
        OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
        OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
    )
    completed_pages = (
        OcrPageInput(
            page=1,
            text="trusted page",
            raster_width=640,
            raster_height=480,
            raster_scale=1,
            provenance=_engine(),
        ),
        OcrPageInput(
            page=2,
            text="untrusted raster",
            raster_width=641,
            raster_height=480,
            raster_scale=1,
        ),
    )

    class FailingEngine:
        def recognize(self, _request: OcrEngineRequest) -> OcrEngineRun:
            raise OcrEngineFailure(
                kind="protocol",
                completed_pages=completed_pages,
            )

    outcome = OcrPipeline().extract(
        OcrRequest(
            capture_id="capture-protocol",
            source=_source(),
            page_scope=(1, 2),
            manifest=manifest,
            created_at=datetime.now(UTC),
            warnings=(),
            is_cancelled=lambda: False,
        ),
        FailingEngine(),
    )
    assert isinstance(outcome, OcrTerminalOutcome)

    assert outcome.failure.code == "ocr_worker_protocol"
    assert outcome.failure.message == "OCR worker returned an invalid response."
    assert [page.status for page in outcome.projection.pages] == [
        OcrPageStatus.RECOGNIZED,
        OcrPageStatus.FAILED,
    ]
    assert outcome.projection.pages[0].text == "trusted page"
    assert outcome.projection.pages[1].failure == outcome.failure


def test_pipeline_rejects_box_outside_raw_raster_as_typed_failure() -> None:
    engine = _InMemoryOcrEngine(
        (
            OcrPageInput(
                page=1,
                text="text",
                raster_width=10,
                raster_height=10,
                raster_scale=1,
                boxes=((9, 9, 2, 2),),
            ),
        )
    )

    outcome = OcrPipeline().extract(
        OcrRequest(
            capture_id="capture-box",
            source=_source(),
            page_scope=None,
            manifest=(OcrPageManifest(page=1, raster_width=10, raster_height=10, raster_scale=1),),
            created_at=datetime.now(UTC),
            warnings=(),
            is_cancelled=lambda: False,
        ),
        engine,
    )
    assert isinstance(outcome, OcrTerminalOutcome)

    assert outcome.projection.failure is not None
    assert outcome.projection.failure.code == "ocr_worker_protocol"
    assert outcome.projection.pages[0].status is OcrPageStatus.FAILED


def test_pipeline_requires_a_nonempty_ordered_manifest() -> None:
    with pytest.raises(OcrProjectionError, match="complete and ordered"):
        OcrPipeline().extract(
            OcrRequest(
                capture_id="capture-no-pages",
                source=_source(),
                page_scope=None,
                manifest=(),
                created_at=datetime.now(UTC),
                warnings=(),
                is_cancelled=lambda: False,
            ),
            _InMemoryOcrEngine(()),
        )


def test_extraction_outcome_owns_projection_without_raw_capture_side_channel() -> None:
    raw = RawCapture(
        source=_source(),
        segments=[
            RawCaptureSegment(
                segment_id="page-1",
                order=0,
                locator=PageLocator(page=1),
                text="recognized",
            )
        ],
        source_text="recognized",
        extraction_engine=CaptureEngine(
            engine="text-recognition",
            model="model",
            digest="sha256:" + "d" * 64,
            device="cpu",
        ),
        created_at=datetime.now(UTC),
    )
    outcome = CaptureExtractionOutcome(raw=raw, ocr_projection=None)

    assert outcome.raw is raw
    assert outcome.ocr_projection is None
    assert not hasattr(ocr_projection_module, "OcrProjectionExtractor")
    assert not hasattr(RawCapture, "attach_ocr_projection")
    assert not hasattr(raw, "ocr_projection")


def _selection_manifest(pages: tuple[int, ...]) -> tuple[OcrPageManifest, ...]:
    return tuple(
        OcrPageManifest(page=page, raster_width=640, raster_height=480, raster_scale=1)
        for page in pages
    )


def test_canonical_request_keeps_source_page_numbers_of_a_non_contiguous_selection() -> None:
    selection = (3, 7, 8, 20)
    manifest = _selection_manifest(selection)
    progress: list[dict[str, object]] = []

    class SourcePageEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            pages = tuple(
                request.observe(
                    expected,
                    OcrPageInput(
                        page=expected.page,
                        text=f"source page {expected.page}",
                        raster_width=expected.raster_width,
                        raster_height=expected.raster_height,
                        raster_scale=expected.raster_scale,
                        provenance=_engine(),
                    ),
                    _engine(),
                )
                for expected in request.manifest
            )
            return OcrEngineRun(pages=pages, provenance=_engine())

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False, page_scope=selection),
        SourcePageEngine(),
    )

    assert isinstance(outcome, CaptureOcrProjection)
    assert outcome.processed_page_count == 4
    assert [page.page for page in outcome.pages] == list(selection)
    assert [page.text for page in outcome.pages] == [f"source page {page}" for page in selection]
    header = progress[0]
    assert header["type"] == "ocr-header"
    assert [item["page"] for item in header["pages"]] == list(selection)  # type: ignore[index]
    assert [event["page"]["page"] for event in progress[1:]] == list(selection)  # type: ignore[index]


def test_worker_failure_of_a_selection_keeps_trusted_pages_by_source_number() -> None:
    manifest = _selection_manifest((3, 7))

    class FailingEngine:
        def recognize(self, _request: OcrEngineRequest) -> OcrEngineRun:
            raise OcrEngineFailure(
                kind="protocol",
                completed_pages=(
                    OcrPageInput(
                        page=3,
                        text="trusted source page 3",
                        raster_width=640,
                        raster_height=480,
                        raster_scale=1,
                        provenance=_engine(),
                    ),
                ),
            )

    outcome = OcrPipeline().extract(
        OcrRequest(
            capture_id="capture-selection-protocol",
            source=_source(),
            page_scope=(3, 7),
            manifest=manifest,
            created_at=datetime.now(UTC),
            warnings=(),
            is_cancelled=lambda: False,
        ),
        FailingEngine(),
    )

    assert isinstance(outcome, OcrTerminalOutcome)
    assert [(page.page, page.status) for page in outcome.projection.pages] == [
        (3, OcrPageStatus.RECOGNIZED),
        (7, OcrPageStatus.FAILED),
    ]


@pytest.mark.parametrize("pages", [(7, 3), (3, 3)])
def test_pipeline_rejects_a_manifest_that_is_not_ascending_source_pages(
    pages: tuple[int, ...],
) -> None:
    with pytest.raises(OcrProjectionError, match="complete and ordered"):
        OcrPipeline().extract(
            OcrRequest(
                capture_id="capture-unordered-selection",
                source=_source(),
                page_scope=None,
                manifest=_selection_manifest(pages),
                created_at=datetime.now(UTC),
                warnings=(),
                is_cancelled=lambda: False,
            ),
            _InMemoryOcrEngine(()),
        )


def test_engine_page_out_of_selection_order_is_a_typed_protocol_failure() -> None:
    manifest = _selection_manifest((3, 7))
    progress: list[dict[str, object]] = []

    class OutOfOrderEngine:
        def recognize(self, request: OcrEngineRequest) -> OcrEngineRun:
            page = request.observe(
                manifest[1],
                OcrPageInput(
                    page=7,
                    text="page 7 first",
                    raster_width=640,
                    raster_height=480,
                    raster_scale=1,
                    provenance=_engine(),
                ),
                _engine(),
            )
            return OcrEngineRun(pages=(page,), provenance=_engine())

    outcome = OcrPipeline().extract(
        _streaming_request(manifest, progress, lambda: False, page_scope=(3, 7)),
        OutOfOrderEngine(),
    )

    assert isinstance(outcome, OcrTerminalOutcome)
    assert outcome.failure.code == "ocr_worker_protocol"
    assert progress == []


@pytest.mark.parametrize("pages", [[7, 3], [3, 3], [0, 3]])
def test_projection_contract_requires_ascending_source_page_numbers(pages: list[int]) -> None:
    def page(number: int) -> dict[str, object]:
        return {
            "page": number,
            "status": "empty",
            "raster": {"width": 1, "height": 1, "scale": 1, "coordinateSystem": "pixel"},
            "provenance": _engine().model_dump(mode="json", by_alias=True),
        }

    payload = {
        "apiVersion": "2.0",
        "schemaVersion": "3",
        "captureId": "capture-contract",
        "status": "failed",
        "source": None,
        "pages": [page(3), page(7)],
        "processedPageCount": 2,
        "runtimeVersion": RUNTIME_VERSION,
        "contractSetSha256": "d" * 64,
        "provenance": _engine().model_dump(mode="json", by_alias=True),
        "failure": {
            "code": "ocr_no_text",
            "message": "No text.",
            "stage": "extraction",
            "retryable": False,
        },
        "createdAt": "2026-10-19T00:00:00+00:00",
    }
    assert [item.page for item in CaptureOcrProjection.model_validate(payload).pages] == [3, 7]

    with pytest.raises(ValidationError):
        CaptureOcrProjection.model_validate({**payload, "pages": [page(n) for n in pages]})
    legacy_page_count = {**payload}
    legacy_page_count["pageCount"] = legacy_page_count.pop("processedPageCount")
    with pytest.raises(ValidationError):
        CaptureOcrProjection.model_validate(legacy_page_count)
    legacy_contract = {**payload}
    legacy_contract["contractSha256"] = legacy_contract.pop("contractSetSha256")
    with pytest.raises(ValidationError):
        CaptureOcrProjection.model_validate(legacy_contract)
