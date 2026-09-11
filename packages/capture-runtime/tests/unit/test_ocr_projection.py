from collections.abc import Callable
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

import capture_runtime.ocr_projection as ocr_projection_module
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureFailureV2,
    CaptureOcrProjectionV3,
    CaptureSource,
    OcrBoxV3,
    OcrPageProjectionV3,
    OcrPageStatus,
    OcrProjectionStatus,
    OcrProvenanceV3,
    OcrRasterV3,
    PageLocator,
    RawCapture,
    RawCaptureSegment,
)
from capture_runtime.engine_adapters import OcrRegion, OcrTextResult
from capture_runtime.extractors import CaptureExtractionOutcome
from capture_runtime.ocr_projection import (
    OcrEngineFailure,
    OcrEngineRequest,
    OcrEngineRun,
    OcrExtractionFailure,
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


def _engine() -> OcrProvenanceV3:
    return OcrProvenanceV3(
        status="resolved",
        engine="windowsml-ocr",
        model="pp-ocrv6-medium-windowsml",
        model_digest="sha256:" + "b" * 64,
        device="windowsml-dml",
        profile_id="capture-workbench-ocr-pipeline-v1",
        profile_spec_sha256="c" * 64,
    )


def test_canonical_projection_requires_pages_but_allows_failed_empty_pages() -> None:
    schema = CaptureOcrProjectionV3.model_json_schema(by_alias=True)
    assert "pages" in schema["required"]
    assert "minItems" not in schema["properties"]["pages"]

    failure = CaptureFailureV2(
        code="ocr_worker_failed",
        message="OCR worker failed.",
        stage="ocr",
        retryable=True,
    )
    projection = CaptureOcrProjectionV3(
        capture_id="capture-empty-failed",
        status=OcrProjectionStatus.FAILED,
        source=None,
        pages=[],
        provenance=_engine(),
        api_version="2.0",
        schema_version="3",
        page_count=0,
        runtime_version="0.4.2",
        contract_sha256="d" * 64,
        failure=failure,
        created_at=datetime.now(UTC),
    )
    assert projection.pages == []

    with pytest.raises(ValidationError):
        CaptureOcrProjectionV3(
            capture_id="capture-missing-pages",
            status=OcrProjectionStatus.FAILED,
            source=None,
            provenance=None,
            failure=failure,
            created_at=datetime.now(UTC),
        )


def test_canonical_projection_requires_wire_identity_and_page_count() -> None:
    schema = CaptureOcrProjectionV3.model_json_schema(by_alias=True)
    required = set(schema["required"])
    assert {
        "apiVersion",
        "schemaVersion",
        "pageCount",
        "runtimeVersion",
        "contractSha256",
        "provenance",
    } <= required
    assert "coordinateSystem" in OcrRasterV3.model_json_schema(by_alias=True)["required"]


def test_canonical_box_schema_requires_polygon_text_and_confidence_shape() -> None:
    schema = OcrBoxV3.model_json_schema(by_alias=True)
    assert set(schema["required"]) == {"polygon", "text", "confidence"}
    assert "x" not in schema["properties"]
    assert schema["properties"]["polygon"]["minItems"] == 4

    with pytest.raises(ValidationError):
        OcrBoxV3(
            polygon=[
                {"x": 0, "y": 0},
                {"x": 10, "y": 0},
                {"x": 10, "y": 10},
            ],
            text="malformed",
        )
    with pytest.raises(ValidationError):
        OcrBoxV3(
            polygon=[
                {"x": 0, "y": 0},
                {"x": 10, "y": 0},
                {"x": 10, "y": 10},
                {"x": float("nan"), "y": 10},
            ],
            text="nan",
        )


def test_pre_inference_provenance_is_an_explicit_unavailable_variant() -> None:
    resolved_schema = OcrProvenanceV3.model_json_schema(by_alias=True)
    resolved_digest_schema = resolved_schema["$defs"]["OcrProvenanceResolvedV3"]["properties"][
        "modelDigest"
    ]
    assert resolved_digest_schema["not"]["const"] == "sha256:" + "0" * 64
    unavailable = {
        "status": "unavailable",
        "profileId": "capture-workbench-ocr-pipeline-v1",
        "profileSpecSha256": "c" * 64,
        "reason": "model_unavailable",
    }
    parsed = OcrProvenanceV3.model_validate(unavailable)
    assert parsed.status == "unavailable"
    assert parsed.profile_id == "capture-workbench-ocr-pipeline-v1"
    assert "modelDigest" not in parsed.model_dump(by_alias=True)
    assert "device" not in parsed.model_dump(by_alias=True)

    with pytest.raises(ValidationError):
        OcrProvenanceV3.model_validate(
            {
                **unavailable,
                "modelDigest": "sha256:" + "0" * 64,
                "device": "windowsml-dml",
            }
        )

    with pytest.raises(ValidationError, match="resolved model"):
        OcrProvenanceV3(
            status="resolved",
            engine="windowsml-ocr",
            model="pp-ocrv6-medium-windowsml",
            model_digest="sha256:" + "0" * 64,
            device="windowsml-dml",
            profile_id="capture-workbench-ocr-pipeline-v1",
            profile_spec_sha256="c" * 64,
        )


def test_unavailable_provenance_is_only_valid_for_failed_pages_and_documents() -> None:
    unavailable = OcrProvenanceV3(
        status="unavailable",
        profile_id="capture-workbench-ocr-pipeline-v1",
        profile_spec_sha256="c" * 64,
        reason="model_unavailable",
    )
    raster = OcrRasterV3(width=100, height=80, scale=2, coordinate_system="pixel")
    failure = CaptureFailureV2(
        code="ocr_worker_failed",
        message="OCR worker failed.",
        stage="ocr",
        retryable=True,
    )
    failed_page = OcrPageProjectionV3(
        page=1,
        status=OcrPageStatus.FAILED,
        raster=raster,
        provenance=unavailable,
        failure=failure,
    )
    failed = CaptureOcrProjectionV3(
        capture_id="capture-unavailable",
        status=OcrProjectionStatus.FAILED,
        source=None,
        pages=[failed_page],
        provenance=unavailable,
        api_version="2.0",
        schema_version="3",
        page_count=1,
        runtime_version="0.4.2",
        contract_sha256="d" * 64,
        failure=failure,
        created_at=datetime.now(UTC),
    )
    assert failed.provenance.status == "unavailable"

    with pytest.raises(ValidationError, match="resolved provenance"):
        OcrPageProjectionV3(
            page=1,
            status=OcrPageStatus.RECOGNIZED,
            raster=raster,
            text="recognized",
            confidence=0.9,
            provenance=unavailable,
        )
    with pytest.raises(ValidationError, match="resolved provenance"):
        CaptureOcrProjectionV3(
            capture_id="capture-completed-unavailable",
            status=OcrProjectionStatus.COMPLETED,
            source=_source(),
            pages=[failed_page],
            provenance=unavailable,
            api_version="2.0",
            schema_version="3",
            page_count=1,
            runtime_version="0.4.2",
            contract_sha256="d" * 64,
            created_at=datetime.now(UTC),
        )


def test_completed_projection_requires_recognized_pages_and_matching_page_provenance() -> None:
    empty_page = OcrPageProjectionV3(
        page=1,
        status=OcrPageStatus.EMPTY,
        raster=OcrRasterV3(width=100, height=80, scale=2, coordinate_system="pixel"),
        provenance=_engine(),
    )
    with pytest.raises(ValidationError, match="recognized"):
        CaptureOcrProjectionV3(
            capture_id="capture-no-recognized",
            status=OcrProjectionStatus.COMPLETED,
            source=_source(),
            pages=[empty_page],
            provenance=_engine(),
            api_version="2.0",
            schema_version="3",
            page_count=1,
            runtime_version="0.4.2",
            contract_sha256="d" * 64,
            created_at=datetime.now(UTC),
        )

    page_with_other_provenance = OcrPageProjectionV3(
        page=1,
        status=OcrPageStatus.RECOGNIZED,
        raster=OcrRasterV3(width=100, height=80, scale=2, coordinate_system="pixel"),
        text="recognized",
        confidence=0.5,
        provenance=OcrProvenanceV3(
            status="resolved",
            engine="windowsml-ocr",
            model="other",
            model_digest="sha256:" + "e" * 64,
            device="cpu",
            profile_id="capture-workbench-ocr-pipeline-v1",
            profile_spec_sha256="c" * 64,
        ),
    )
    with pytest.raises(ValidationError, match="provenance"):
        CaptureOcrProjectionV3(
            capture_id="capture-mismatched-provenance",
            status=OcrProjectionStatus.COMPLETED,
            source=_source(),
            pages=[page_with_other_provenance],
            provenance=_engine(),
            api_version="2.0",
            schema_version="3",
            page_count=1,
            runtime_version="0.4.2",
            contract_sha256="d" * 64,
            created_at=datetime.now(UTC),
        )


class _InMemoryOcrEngine:
    """Test adapter for the OCR pipeline seam; no Paddle transport leaks here."""

    def __init__(self, pages: tuple[OcrPageInput, ...]) -> None:
        self.pages = pages
        self.manifest: tuple[OcrPageManifest, ...] | None = None

    def recognize(self, manifest: tuple[OcrPageManifest, ...]) -> OcrEngineRun:
        self.manifest = manifest
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
        capture_id="capture-pipeline",
        source=_source(),
        manifest=(
            OcrPageManifest(page=1, raster_width=1200, raster_height=800, raster_scale=2),
            OcrPageManifest(page=2, raster_width=1200, raster_height=800, raster_scale=2),
        ),
        engine=engine,
        created_at=datetime.now(UTC),
    )

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

    assert isinstance(outcome, CaptureOcrProjectionV3)
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
@pytest.mark.parametrize("legacy", [False, True])
def test_public_extract_rejects_malformed_manifest_before_engine_or_progress(
    manifest: object,
    legacy: bool,
) -> None:
    progress: list[dict[str, object]] = []
    engine_calls = 0

    class NeverEngine:
        def recognize(self, _request: object) -> OcrEngineRun:
            nonlocal engine_calls
            engine_calls += 1
            raise AssertionError("invalid manifest must stop before the engine")

    pipeline = OcrPipeline()
    if legacy:
        with pytest.raises(OcrProjectionError):
            pipeline.extract(
                capture_id="capture-malformed-manifest",
                source=_source(),
                manifest=manifest,  # type: ignore[arg-type]
                engine=NeverEngine(),  # type: ignore[arg-type]
                created_at=datetime.now(UTC),
            )
    else:
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
            pipeline.extract(request, NeverEngine())  # type: ignore[arg-type]

    assert engine_calls == 0
    assert progress == []


def test_extract_dispatch_rejects_mixed_and_request_keyword_forms() -> None:
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
    changed = OcrProvenanceV3(
        status="resolved",
        engine="windowsml-ocr",
        model="different-model",
        model_digest="sha256:" + "d" * 64,
        device="windowsml-dml",
        profile_id="capture-workbench-ocr-pipeline-v1",
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
        model="pp-ocrv6-medium-windowsml",
        digest="sha256:" + "b" * 64,
        regions=(OcrRegion(text="perspective", confidence=0.93, polygon=polygon),),
        raster_width=120,
        raster_height=80,
        raster_scale=1,
        provenance=_engine(),
    )
    pipeline = OcrPipeline()
    manifest = OcrPageManifest(page=1, raster_width=120, raster_height=80, raster_scale=1)

    normalized = pipeline.normalize_observation(manifest, observation)
    projection = pipeline.build(
        capture_id="capture-polygon",
        source=_source(),
        pages=[normalized],
        provenance=_engine(),
        created_at=datetime.now(UTC),
    )
    wire = projection.model_dump(mode="json", by_alias=True)

    assert wire["pages"][0]["boxes"][0] == {
        "polygon": [{"x": x, "y": y} for x, y in polygon],
        "text": "perspective",
        "confidence": 0.93,
    }

    worker_wire = pipeline.serialize_page(normalized)
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
        model="pp-ocrv6-medium-windowsml",
        digest="sha256:" + "b" * 64,
        regions=(OcrRegion(text="outside", confidence=0.9, polygon=polygon),),
        raster_width=120,
        raster_height=80,
        raster_scale=1,
        provenance=_engine(),
    )
    with pytest.raises(OcrProjectionError, match="polygon"):
        OcrPipeline().normalize_observation(
            OcrPageManifest(page=1, raster_width=120, raster_height=80, raster_scale=1),
            observation,
        )


def test_pipeline_failure_keeps_a_readable_typed_projection() -> None:
    class FailingEngine:
        def recognize(self, _manifest: tuple[OcrPageManifest, ...]) -> OcrEngineRun:
            raise OcrEngineFailure(kind="worker")

    with pytest.raises(OcrExtractionFailure) as raised:
        OcrPipeline().extract(
            capture_id="capture-failure",
            source=_source(),
            manifest=(
                OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
            ),
            engine=FailingEngine(),
            created_at=datetime.now(UTC),
        )

    projection = raised.value.projection
    assert projection.status is OcrProjectionStatus.FAILED
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_failed"
    assert projection.pages[0].status is OcrPageStatus.FAILED
    assert projection.pages[0].failure == projection.failure


def test_invalid_model_digest_fails_closed_with_unavailable_provenance() -> None:
    class InvalidIdentityEngine:
        def recognize(self, _manifest: tuple[OcrPageManifest, ...]) -> OcrEngineRun:
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
                    engine="windowsml-ocr",
                    model="pp-ocrv6-medium-windowsml",
                    digest="sha256:" + "0" * 64,
                    device="windowsml-dml",
                ),
            )

    with pytest.raises(OcrExtractionFailure) as raised:
        OcrPipeline().extract(
            capture_id="capture-invalid-model-digest",
            source=_source(),
            manifest=(
                OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
            ),
            engine=InvalidIdentityEngine(),
            created_at=datetime.now(UTC),
        )

    projection = raised.value.projection
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

    with pytest.raises(OcrExtractionFailure) as raised:
        OcrPipeline().extract(
            capture_id="capture-empty",
            source=_source(),
            manifest=(
                OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
                OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
            ),
            engine=engine,
            created_at=datetime.now(UTC),
        )

    projection = raised.value.projection
    assert projection.status is OcrProjectionStatus.FAILED
    assert projection.failure is not None
    assert projection.failure.code == "ocr_no_text"
    assert [page.status for page in projection.pages] == [OcrPageStatus.EMPTY, OcrPageStatus.EMPTY]


def test_worker_failure_preserves_only_trusted_completed_pages() -> None:
    outcome = OcrPipeline().failure(
        capture_id="capture-protocol",
        source=_source(),
        manifest=(
            OcrPageManifest(page=1, raster_width=640, raster_height=480, raster_scale=1),
            OcrPageManifest(page=2, raster_width=640, raster_height=480, raster_scale=1),
        ),
        kind="protocol",
        completed_pages=(
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
        ),
        created_at=datetime.now(UTC),
    )

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

    with pytest.raises(OcrExtractionFailure) as raised:
        OcrPipeline().extract(
            capture_id="capture-box",
            source=_source(),
            manifest=(OcrPageManifest(page=1, raster_width=10, raster_height=10, raster_scale=1),),
            engine=engine,
            created_at=datetime.now(UTC),
        )

    assert raised.value.projection.failure is not None
    assert raised.value.projection.failure.code == "ocr_worker_protocol"
    assert raised.value.projection.pages[0].status is OcrPageStatus.FAILED


def test_pipeline_requires_a_nonempty_ordered_manifest() -> None:
    with pytest.raises(OcrProjectionError, match="complete and ordered"):
        OcrPipeline().extract(
            capture_id="capture-no-pages",
            source=_source(),
            manifest=(),
            engine=_InMemoryOcrEngine(()),
            created_at=datetime.now(UTC),
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
            engine="windowsml-ocr",
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
