from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from datetime import UTC, datetime, timedelta
from io import BytesIO
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from capture_runtime.clock import SystemClock
from capture_runtime.contract_set import SCHEMA_DIALECT
from capture_runtime.contracts import (
    CaptureBlock,
    CaptureDocument,
    CaptureEngine,
    CaptureFailureV2,
    CaptureSourceKind,
    OcrPageScopeV2,
    OpenIngestionV2,
    PageLocator,
    RawCapture,
    RawCaptureSegment,
    StartCaptureV2,
    StreamingCaptureStatus,
    StructuringMode,
    TimeLocator,
)
from capture_runtime.extractors import (
    CaptureExtractionOutcome,
    OcrExtractionFailure,
    SniffedSource,
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.ocr_execution_proof import (
    AcceptanceOcrExecutionEvidenceSink,
    InMemoryOcrExecutionEvidenceSink,
)
from capture_runtime.ocr_projection import OcrPageInput, OcrPipeline
from tests.conftest import TOKEN


@pytest.fixture(autouse=True)
def _stub_legacy_pdf_manifest_dimensions(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep marker-only service tests independent of PDFium source geometry."""

    original = StandaloneRuntimeCaptureExtractor._pdf_page_raster_dimensions

    def dimensions(
        extractor: StandaloneRuntimeCaptureExtractor,
        content: bytes,
        cancel_event: asyncio.Event,
        page_numbers: tuple[int, ...],
    ) -> tuple[tuple[int, int], ...]:
        if content.startswith(b"%PDF-1.7") and b"1 0 obj" not in content:
            extractor._checkpoint(cancel_event)
            return tuple((60, 40) for _ in page_numbers)
        return original(extractor, content, cancel_event, page_numbers)

    monkeypatch.setattr(
        StandaloneRuntimeCaptureExtractor,
        "_pdf_page_raster_dimensions",
        dimensions,
    )


def _source() -> bytes:
    return b"abcdef"


def _open(client: TestClient) -> tuple[str, str]:
    source = _source()
    response = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": "api-stream-open-1",
            "fileName": "sample.mp3",
            "mediaType": "audio/mpeg",
            "totalBytes": len(source),
            "sourceSha256": hashlib.sha256(source).hexdigest(),
        },
        headers={"X-Idempotency-Key": "api-stream-open-1"},
    )
    assert response.status_code == 201, response.text
    return response.json()["ingestionId"], hashlib.sha256(source).hexdigest()


def _seed_host_capture(client: TestClient) -> tuple[str, dict[str, object]]:
    repository = client.app.state.streaming_repository
    source = b"host-stream"
    source_sha256 = hashlib.sha256(source).hexdigest()
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id=f"host-ingestion-{uuid4()}",
            file_name="sample.mp3",
            media_type="audio/mpeg",
            total_bytes=len(source),
            source_sha256=source_sha256,
        )
    )
    repository.append_chunk(
        ingestion.ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=source_sha256,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(
        ingestion.ingestion_id,
        total_bytes=len(source),
        sha256=source_sha256,
    )
    operation = repository.create_capture(
        StartCaptureV2(
            client_request_id=f"host-capture-{uuid4()}",
            ingestion_id=ingestion.ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    assert operation.source is not None
    created_at = datetime(2026, 8, 13, tzinfo=UTC)
    segment = RawCaptureSegment(
        segment_id="segment-1",
        order=0,
        locator=TimeLocator(start_ms=0, end_ms=1_000),
        text="host words",
    )
    extraction_engine = CaptureEngine(
        engine="whisper-primary",
        model="test-model",
        digest=f"sha256:{'a' * 64}",
        device="cpu",
    )
    raw = RawCapture(
        source=operation.source,
        segments=[segment],
        source_text=segment.text,
        extraction_engine=extraction_engine,
        created_at=created_at,
    )
    repository.write_raw(operation.capture_id, raw)
    repository.mark_awaiting_structuring(operation.capture_id)
    structuring_engine = CaptureEngine(
        engine="host-provider",
        model="test-model",
        digest=f"sha256:{'b' * 64}",
    )
    candidate = CaptureDocument(
        source=raw.source,
        raw_segments=raw.segments,
        blocks=[
            CaptureBlock(
                block_id="block-1",
                order=0,
                type="transcript",
                source_segment_id=segment.segment_id,
                locator=segment.locator,
                source_text=segment.text,
                target_text="host words translated",
            )
        ],
        source_text=raw.source_text,
        target_text="host words translated",
        extraction_engine=raw.extraction_engine,
        structuring_engine=structuring_engine,
        created_at=created_at,
        completed_at=created_at + timedelta(seconds=1),
    )
    return operation.capture_id, candidate.model_dump(mode="json", by_alias=True)


def _start_pdf_capture(
    client: TestClient,
    source: bytes,
    prefix: str,
    *,
    page_numbers: list[int] | None = None,
    structuring_mode: str = "host",
) -> str:
    digest = hashlib.sha256(source).hexdigest()
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": f"{prefix}-open",
            "kind": "pdf",
            "fileName": f"{prefix}.pdf",
            "mediaType": "application/pdf",
            "totalBytes": len(source),
            "sourceSha256": digest,
        },
        headers={"X-Idempotency-Key": f"{prefix}-open"},
    )
    assert opened.status_code == 201, opened.text
    ingestion_id = opened.json()["ingestionId"]
    uploaded = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=source,
        headers={
            "Content-Range": f"bytes 0-{len(source) - 1}/{len(source)}",
            "Digest": f"sha-256={digest}",
            "X-Idempotency-Key": f"{prefix}-chunk-0",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    finalized = client.post(
        f"/v2/ingestions/{ingestion_id}/finalize",
        json={"totalBytes": len(source), "sha256": digest},
    )
    assert finalized.status_code == 200, finalized.text
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": f"{prefix}-capture",
            "ingestionId": ingestion_id,
            "structuringMode": structuring_mode,
            **({"pdfPageNumbers": page_numbers} if page_numbers is not None else {}),
        },
        headers={"X-Idempotency-Key": f"{prefix}-capture"},
    )
    assert started.status_code == 202, started.text
    return started.json()["captureId"]


def _wait_for_capture_status(service, capture_id: str, expected: StreamingCaptureStatus) -> None:
    for _ in range(100):
        if service.get_capture(capture_id).status is expected:
            return
        time.sleep(0.01)
    assert service.get_capture(capture_id).status is expected


def _wait_for_proof_artifact(root) -> None:
    for _ in range(100):
        if (root / "ocr-device-proof-v1.json").is_file():
            return
        time.sleep(0.01)
    assert (root / "ocr-device-proof-v1.json").is_file()


class _PrivateExecutionProof:
    def validate_digest(self) -> None:
        return None

    def to_dict(self) -> dict[str, str]:
        return {"executionSha256": "0" * 64}


class _HostProofExtractor:
    def __init__(self, text: str, *, with_projection: bool = False) -> None:
        self._text = text
        self._with_projection = with_projection

    def sniff(self, _content: bytes) -> SniffedSource:
        return SniffedSource(CaptureSourceKind.PDF, "application/pdf")

    async def extract(self, _content, source, cancel_event, *, pdf_page_numbers=None):
        del cancel_event, pdf_page_numbers
        segment = RawCaptureSegment(
            segment_id="host-proof-page-1",
            order=0,
            locator=PageLocator(page=1),
            text=self._text,
        )
        engine = CaptureEngine(
            engine="windowsml-ocr",
            model="test-ocr-model",
            digest="sha256:" + "1" * 64,
            device="windowsml-dml",
        )
        projection = (
            OcrPipeline().build(
                capture_id=source.sha256,
                source=source,
                provenance=engine,
                created_at=datetime.now(UTC),
                pages=[
                    OcrPageInput(
                        page=1,
                        text=segment.text,
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    )
                ],
            )
            if self._with_projection
            else None
        )
        return CaptureExtractionOutcome(
            raw=RawCapture(
                source=source,
                segments=[segment],
                source_text=segment.text,
                extraction_engine=engine,
                created_at=datetime.now(UTC),
            ),
            ocr_projection=projection,
            _execution_proof=_PrivateExecutionProof(),  # type: ignore[arg-type]
        )


class _GatedHostProofExtractor(_HostProofExtractor):
    """Hold extraction before the runtime can persist validated OCR output."""

    def __init__(self, text: str) -> None:
        super().__init__(text, with_projection=True)
        self.entered = threading.Event()
        self.release = threading.Event()
        self.finished = threading.Event()

    async def extract(self, content, source, cancel_event, *, pdf_page_numbers=None):
        self.entered.set()
        try:
            while not self.release.is_set():
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                await asyncio.sleep(0)
            return await super().extract(
                content,
                source,
                cancel_event,
                pdf_page_numbers=pdf_page_numbers,
            )
        finally:
            self.finished.set()


def test_streaming_capability_is_strictly_advertised(client: TestClient) -> None:
    response = client.get("/v2/streaming/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "protocolVersion": "2",
        "captureKinds": ["pdf", "image", "audio"],
        "supportsProgressiveAudio": True,
        "maxChunkBytes": 4 * 1024 * 1024,
        "checkpointIntervalMs": 300_000,
        "heartbeatIntervalMs": 5_000,
        "stallTimeoutMs": 90_000,
    }


def test_streaming_capability_keeps_ocr_available_without_progressive_decoder(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setattr("capture_runtime.routes.streaming.progressive_decoder_ready", lambda: False)

    response = client.get("/v2/streaming/health/ready")

    assert response.status_code == 200
    assert response.json()["captureKinds"] == ["pdf", "image", "audio"]
    assert response.json()["supportsProgressiveAudio"] is False


def test_open_ingestion_and_start_capture_require_matching_idempotency_headers(
    client: TestClient,
) -> None:
    source = _source()
    request = {
        "clientRequestId": "required-open-key",
        "fileName": "sample.mp3",
        "mediaType": "audio/mpeg",
        "totalBytes": len(source),
        "sourceSha256": hashlib.sha256(source).hexdigest(),
    }

    assert client.post("/v2/ingestions", json=request).status_code == 422
    mismatch = client.post(
        "/v2/ingestions",
        json=request,
        headers={"X-Idempotency-Key": "different-key"},
    )
    assert mismatch.status_code == 409
    assert mismatch.json()["error"]["code"] == "idempotency_conflict"


def test_v2_raw_capture_route_returns_the_strict_runtime_payload(client: TestClient) -> None:
    capture_id, _candidate = _seed_host_capture(client)

    response = client.get(f"/v2/captures/{capture_id}/raw")

    assert response.status_code == 200, response.text
    assert response.json()["sourceText"] == "host words"
    assert response.json()["segments"][0]["segmentId"] == "segment-1"


def test_pdf_page_scope_crosses_start_route_and_extractor_to_raw_route(
    client: TestClient,
    monkeypatch,
) -> None:
    calls: list[tuple[int, ...] | None] = []
    service = client.app.state.streaming_capture_service

    class ScopedExtractor:
        def sniff(self, _content: bytes) -> SniffedSource:
            return SniffedSource(CaptureSourceKind.PDF, "application/pdf")

        async def extract(
            self,
            _content: bytes,
            capture_source,
            _cancel_event,
            *,
            pdf_page_numbers: tuple[int, ...] | None = None,
        ) -> CaptureExtractionOutcome:
            calls.append(pdf_page_numbers)
            assert pdf_page_numbers == (1,)
            segment = RawCaptureSegment(
                segment_id="page-1",
                order=0,
                locator={"kind": "page", "page": 1},
                text="page one",
            )
            return CaptureExtractionOutcome(
                raw=RawCapture(
                    source=capture_source,
                    segments=[segment],
                    source_text=segment.text,
                    extraction_engine=CaptureEngine(
                        engine="windowsml-ocr",
                        model="test-model",
                        digest="sha256:" + "a" * 64,
                        device="windowsml-dml",
                    ),
                    ocr_page_scope=OcrPageScopeV2(
                        source_page_count=46,
                        requested_page_numbers=[1],
                        processed_page_numbers=[1],
                    ),
                    created_at=datetime.now(UTC),
                )
            )

    monkeypatch.setattr(service, "_extractor", ScopedExtractor())
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 canonical source",
        "scoped-pdf",
        page_numbers=[1],
    )

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    raw = client.get(f"/v2/captures/{capture_id}/raw")

    assert raw.status_code == 200, raw.text
    assert calls == [(1,)]
    assert raw.json()["ocrPageScope"] == {
        "sourcePageCount": 46,
        "requestedPageNumbers": [1],
        "processedPageNumbers": [1],
    }


def test_pdf_page_scope_omission_uses_legacy_all_page_extractor_path(
    client: TestClient,
    monkeypatch,
) -> None:
    calls: list[str] = []
    service = client.app.state.streaming_capture_service

    class LegacyExtractor:
        def sniff(self, _content: bytes) -> SniffedSource:
            return SniffedSource(CaptureSourceKind.PDF, "application/pdf")

        async def extract(
            self,
            _content: bytes,
            capture_source,
            _cancel_event,
        ) -> CaptureExtractionOutcome:
            calls.append("all-pages")
            segments = [
                RawCaptureSegment(
                    segment_id=f"page-{page}",
                    order=page - 1,
                    locator={"kind": "page", "page": page},
                    text=f"page {page}",
                )
                for page in range(1, 4)
            ]
            return CaptureExtractionOutcome(
                raw=RawCapture(
                    source=capture_source,
                    segments=segments,
                    source_text="\n".join(segment.text for segment in segments),
                    extraction_engine=CaptureEngine(
                        engine="windowsml-ocr",
                        model="test-model",
                        digest="sha256:" + "a" * 64,
                        device="windowsml-dml",
                    ),
                    ocr_page_scope=OcrPageScopeV2(
                        source_page_count=3,
                        requested_page_numbers=[1, 2, 3],
                        processed_page_numbers=[1, 2, 3],
                    ),
                    created_at=datetime.now(UTC),
                )
            )

    monkeypatch.setattr(service, "_extractor", LegacyExtractor())
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 canonical source",
        "legacy-all-pages-pdf",
    )

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    raw = client.get(f"/v2/captures/{capture_id}/raw")

    assert raw.status_code == 200, raw.text
    assert calls == ["all-pages"]
    assert raw.json()["ocrPageScope"] == {
        "sourcePageCount": 3,
        "requestedPageNumbers": [1, 2, 3],
        "processedPageNumbers": [1, 2, 3],
    }


def test_ocr_route_requires_bearer_authentication(client: TestClient) -> None:
    response = client.get(
        "/v2/captures/unauthorized/ocr",
        headers={"Authorization": "Bearer invalid-token"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_ocr_route_returns_not_found_for_unknown_capture(client: TestClient) -> None:
    response = client.get("/v2/captures/does-not-exist/ocr")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "capture_not_found"


def test_ocr_route_returns_conflict_while_projection_is_pending(client: TestClient) -> None:
    capture_id, _candidate = _seed_host_capture(client)

    response = client.get(f"/v2/captures/{capture_id}/ocr")

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ocr_unavailable"


def test_authenticated_ocr_route_returns_ordered_page_projection(client: TestClient) -> None:
    capture_id, _candidate = _seed_host_capture(client)
    repository = client.app.state.streaming_repository
    operation = repository.get_capture(capture_id)
    assert operation.source is not None
    engine = CaptureEngine(
        engine="windowsml-ocr",
        model="pp-ocrv6-medium-windowsml",
        digest="sha256:" + "c" * 64,
        device="windowsml-dml",
    )
    projection = OcrPipeline().build(
        capture_id=capture_id,
        source=operation.source,
        provenance=engine,
        created_at=datetime.now(UTC),
        pages=[
            OcrPageInput(
                page=1,
                text="page one",
                raster_width=100,
                raster_height=80,
                raster_scale=2,
                boxes=((4, 5, 20, 10),),
                region_confidences=(0.91,),
            ),
            OcrPageInput(
                page=2,
                text="",
                raster_width=100,
                raster_height=80,
                raster_scale=2,
            ),
        ],
    )
    repository.write_ocr_projection(capture_id, projection)

    response = client.get(f"/v2/captures/{capture_id}/ocr")

    assert response.status_code == 200, response.text
    assert response.json()["schemaVersion"] == "3"
    assert [page["page"] for page in response.json()["pages"]] == [1, 2]
    assert response.json()["pages"][1]["status"] == "empty"
    assert response.json()["pages"][0]["boxes"][0] == {
        "polygon": [
            {"x": 4.0, "y": 5.0},
            {"x": 24.0, "y": 5.0},
            {"x": 24.0, "y": 15.0},
            {"x": 4.0, "y": 15.0},
        ],
        "text": "page one",
        "confidence": 0.91,
    }


def test_failed_capture_exposes_readable_typed_ocr_projection(client: TestClient) -> None:
    capture_id, _candidate = _seed_host_capture(client)
    repository = client.app.state.streaming_repository
    repository.fail_capture(
        capture_id,
        CaptureFailureV2(
            code="ocr_worker_failed",
            message="OCR worker failed.",
            stage="ocr",
            retryable=True,
        ),
    )

    response = client.get(f"/v2/captures/{capture_id}/ocr")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "failed"
    assert payload["failure"]["code"] == "ocr_worker_failed"
    assert payload["pages"] == []


def test_worker_failure_persists_complete_ocr_projection_before_get_route(
    client: TestClient,
) -> None:
    source = b"%PDF-1.7 worker failure fixture"
    digest = hashlib.sha256(source).hexdigest()
    service = client.app.state.streaming_capture_service

    class FailingExtractor:
        def sniff(self, _content: bytes) -> SniffedSource:
            return SniffedSource(CaptureSourceKind.PDF, "application/pdf")

        async def extract(
            self, _content: bytes, capture_source, _cancel_event
        ) -> CaptureExtractionOutcome:
            failure = CaptureFailureV2(
                code="ocr_worker_timeout",
                message="OCR worker timed out before completing all pages.",
                stage="extraction",
                retryable=True,
            )
            projection = OcrPipeline().failed(
                capture_id=capture_source.sha256,
                source=capture_source,
                provenance=CaptureEngine(
                    engine="windowsml-ocr",
                    model="pp-ocrv6-medium-windowsml",
                    digest="sha256:" + "c" * 64,
                    device="windowsml-dml",
                ),
                failure=failure,
                created_at=datetime.now(UTC),
                pages=[
                    OcrPageInput(
                        page=1,
                        text="completed page",
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    ),
                    OcrPageInput(
                        page=2,
                        text="",
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                        failure=failure,
                    ),
                ],
            )
            raise OcrExtractionFailure(failure=failure, projection=projection)

    service._extractor = FailingExtractor()  # type: ignore[assignment]
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": "api-stream-pdf-failure-open-1",
            "kind": "pdf",
            "fileName": "failure.pdf",
            "mediaType": "application/pdf",
            "totalBytes": len(source),
            "sourceSha256": digest,
        },
        headers={"X-Idempotency-Key": "api-stream-pdf-failure-open-1"},
    )
    assert opened.status_code == 201, opened.text
    ingestion_id = opened.json()["ingestionId"]
    uploaded = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=source,
        headers={
            "Content-Range": f"bytes 0-{len(source) - 1}/{len(source)}",
            "Digest": f"sha-256={digest}",
            "X-Idempotency-Key": "api-stream-pdf-failure-chunk-0",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    finalized = client.post(
        f"/v2/ingestions/{ingestion_id}/finalize",
        json={"totalBytes": len(source), "sha256": digest},
    )
    assert finalized.status_code == 200, finalized.text
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-pdf-failure-capture-1",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
        },
        headers={"X-Idempotency-Key": "api-stream-pdf-failure-capture-1"},
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    assert "event: failed" in events.text
    projection = client.get(f"/v2/captures/{capture_id}/ocr")
    assert projection.status_code == 200, projection.text
    payload = projection.json()
    assert [page["page"] for page in payload["pages"]] == [1, 2]
    assert [page["status"] for page in payload["pages"]] == ["recognized", "failed"]
    assert payload["failure"]["code"] == "ocr_worker_timeout"


def test_runtime_unavailable_persists_manifest_complete_projection_for_get_route(
    client: TestClient, monkeypatch
) -> None:
    class MissingRuntimeManager:
        worker_client = object()

        async def resolve_active_engine(self, _requirement_id: str) -> None:
            return None

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        client.app.state.settings.extraction,
        engine_manager=MissingRuntimeManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 3)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    client.app.state.streaming_capture_service._extractor = extractor
    source = b"%PDF-1.7 runtime unavailable after three-page manifest"
    capture_id = _start_pdf_capture(client, source, "runtime-unavailable")

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    assert "event: failed" in events.text
    response = client.get(f"/v2/captures/{capture_id}/ocr")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["pageCount"] == 3
    assert [page["page"] for page in payload["pages"]] == [1, 2, 3]
    assert [page["status"] for page in payload["pages"]] == ["failed"] * 3
    assert all(
        page["raster"]
        == {
            "width": 120,
            "height": 80,
            "scale": 2.0,
            "coordinateSystem": "pixel",
        }
        for page in payload["pages"]
    )
    assert payload["provenance"]["status"] == "unavailable"
    assert payload["provenance"]["reason"] == "model_unavailable"
    assert payload["failure"]["code"] == "ocr_runtime_unavailable"


@pytest.mark.parametrize("completion_fails", [True, False])
def test_runtime_completion_publishes_only_after_successful_completion(
    client: TestClient, monkeypatch, tmp_path, completion_fails: bool
) -> None:
    service = client.app.state.streaming_capture_service
    root = tmp_path / "acceptance-run"
    root.mkdir()
    service._execution_evidence_sink = AcceptanceOcrExecutionEvidenceSink(
        root, preauthorized_root=root
    )

    class PrivateProof:
        def validate_digest(self) -> None:
            return None

        def to_dict(self) -> dict[str, str]:
            return {"executionSha256": "0" * 64}

    class SuccessfulExtractor:
        def sniff(self, _content: bytes) -> SniffedSource:
            return SniffedSource(CaptureSourceKind.PDF, "application/pdf")

        async def extract(self, content, source, cancel_event, *, pdf_page_numbers=None):
            del content, cancel_event, pdf_page_numbers
            segment = RawCaptureSegment(
                segment_id="page-1",
                order=0,
                locator=PageLocator(page=1),
                text="proof-backed page",
            )
            engine = CaptureEngine(
                engine="windowsml-ocr",
                model="test-ocr-model",
                digest="sha256:" + "1" * 64,
                device="windowsml-dml",
            )
            raw = RawCapture(
                source=source,
                segments=[segment],
                source_text=segment.text,
                extraction_engine=engine,
                created_at=datetime.now(UTC),
            )
            projection = OcrPipeline().build(
                capture_id=source.sha256,
                source=source,
                provenance=engine,
                created_at=datetime.now(UTC),
                pages=[
                    OcrPageInput(
                        page=1,
                        text=segment.text,
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    )
                ],
            )
            return CaptureExtractionOutcome(
                raw=raw,
                ocr_projection=projection,
                _execution_proof=PrivateProof(),  # type: ignore[arg-type]
            )

    service._extractor = SuccessfulExtractor()

    completion_calls = 0

    def fail_completion(_capture_id: str) -> None:
        nonlocal completion_calls
        completion_calls += 1
        raise RuntimeError("synthetic completion persistence failure")

    if completion_fails:
        monkeypatch.setattr(service.repository, "complete_capture", fail_completion)
    source = b"%PDF-1.7 completion persistence failure"
    capture_id = _start_pdf_capture(
        client,
        source,
        "proof-completion-failure",
        structuring_mode="runtime",
    )

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    if completion_fails:
        assert "event: failed" in events.text
        assert completion_calls == 1
        assert not (root / "ocr-device-proof-v1.json").exists()
        assert not list(root.glob(".ocr-device-proof-*.tmp"))
    else:
        assert "event: completed" in events.text
        assert completion_calls == 0
        assert (root / "ocr-device-proof-v1.json").is_file()
        assert not list(root.glob(".ocr-device-proof-*.tmp"))


def _host_proof_candidate(raw: RawCapture) -> CaptureDocument:
    segment = raw.segments[0]
    return CaptureDocument(
        source=raw.source,
        raw_segments=raw.segments,
        blocks=[
            CaptureBlock(
                block_id="block-1",
                order=0,
                type="transcript",
                source_segment_id=segment.segment_id,
                locator=segment.locator,
                source_text=segment.text,
                target_text="host words translated",
            )
        ],
        source_text=raw.source_text,
        target_text="host words translated",
        extraction_engine=raw.extraction_engine,
        structuring_engine=CaptureEngine(
            engine="host-provider",
            model="test-model",
            digest="sha256:" + "b" * 64,
        ),
        created_at=raw.created_at,
        completed_at=raw.created_at + timedelta(seconds=1),
    )


def test_host_proof_publishes_before_successful_host_commit(client: TestClient, tmp_path) -> None:
    service = client.app.state.streaming_capture_service
    root = tmp_path / "acceptance-host-run"
    root.mkdir()
    service._execution_evidence_sink = AcceptanceOcrExecutionEvidenceSink(
        root, preauthorized_root=root
    )

    service._extractor = _HostProofExtractor("host proof page", with_projection=True)
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host pending proof",
        "host-pending-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.AWAITING_STRUCTURING)
    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    _wait_for_proof_artifact(root)

    raw = service.repository.read_raw(capture_id)
    candidate = _host_proof_candidate(raw)
    committed = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        json=candidate.model_dump(mode="json", by_alias=True),
        headers={"X-Idempotency-Key": "host-proof-commit"},
    )
    assert committed.status_code == 200, committed.text
    assert committed.json()["status"] == "completed"
    _wait_for_proof_artifact(root)
    assert not list(root.glob(".ocr-device-proof-*.tmp"))


def test_host_ocr_success_publishes_execution_proof_at_awaiting_structuring_once(
    client: TestClient,
) -> None:
    service = client.app.state.streaming_capture_service
    sink = InMemoryOcrExecutionEvidenceSink()
    service._execution_evidence_sink = sink
    structurer_calls = 0

    class ForbiddenStructurer:
        async def structure(self, *_args, **_kwargs):
            nonlocal structurer_calls
            structurer_calls += 1
            raise AssertionError("host OCR must not invoke the runtime structurer")

    service._structurer = ForbiddenStructurer()  # type: ignore[assignment]
    service._extractor = _HostProofExtractor("host OCR awaiting page", with_projection=True)
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host OCR awaiting proof",
        "host-ocr-awaiting-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.AWAITING_STRUCTURING)

    raw = service.repository.read_raw(capture_id)
    assert raw.source_text == "host OCR awaiting page"
    projection = client.get(f"/v2/captures/{capture_id}/ocr")
    assert projection.status_code == 200, projection.text
    assert projection.json()["status"] == "completed"
    assert structurer_calls == 0
    assert len(sink.proofs) == 1
    assert sink.proofs[0][0] == capture_id

    cancelled = client.post(f"/v2/captures/{capture_id}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    deleted = client.delete(f"/v2/captures/{capture_id}")
    assert deleted.status_code == 204, deleted.text
    assert len(sink.proofs) == 1


def test_failed_host_ocr_never_publishes_success_execution_proof(client: TestClient) -> None:
    service = client.app.state.streaming_capture_service
    sink = InMemoryOcrExecutionEvidenceSink()
    service._execution_evidence_sink = sink
    source = b"%PDF-1.7 host OCR failure proof"

    class FailingExtractor:
        def sniff(self, _content: bytes) -> SniffedSource:
            return SniffedSource(CaptureSourceKind.PDF, "application/pdf")

        async def extract(self, _content, capture_source, _cancel_event):
            failure = CaptureFailureV2(
                code="ocr_worker_failed",
                message="OCR worker failed.",
                stage="extraction",
                retryable=True,
            )
            projection = OcrPipeline().failed(
                capture_id=capture_source.sha256,
                source=capture_source,
                provenance=CaptureEngine(
                    engine="windowsml-ocr",
                    model="test-ocr-model",
                    digest="sha256:" + "1" * 64,
                    device="windowsml-dml",
                ),
                failure=failure,
                created_at=datetime.now(UTC),
                pages=[],
            )
            raise OcrExtractionFailure(failure=failure, projection=projection)

    service._extractor = FailingExtractor()  # type: ignore[assignment]
    capture_id = _start_pdf_capture(
        client,
        source,
        "host-ocr-failure-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.FAILED)

    assert sink.proofs == []


@pytest.mark.parametrize("failure_point", ["raw", "projection", "transition"])
def test_host_ocr_checkpoint_requires_persistence_and_transition(
    client: TestClient, monkeypatch, failure_point: str
) -> None:
    service = client.app.state.streaming_capture_service
    sink = InMemoryOcrExecutionEvidenceSink()
    service._execution_evidence_sink = sink
    service._extractor = _HostProofExtractor(
        f"host OCR {failure_point} failure", with_projection=True
    )

    if failure_point == "raw":

        def fail_raw(_capture_id: str, _raw) -> None:
            raise RuntimeError("synthetic raw persistence failure")

        monkeypatch.setattr(service.repository, "write_raw", fail_raw)
    elif failure_point == "projection":
        original_write_projection = service.repository.write_ocr_projection
        projection_calls = 0

        def fail_projection(capture_id: str, projection) -> None:
            nonlocal projection_calls
            projection_calls += 1
            if projection_calls == 1:
                raise RuntimeError("synthetic OCR projection persistence failure")
            original_write_projection(capture_id, projection)

        monkeypatch.setattr(service.repository, "write_ocr_projection", fail_projection)
    else:

        def fail_transition(_capture_id: str) -> None:
            raise RuntimeError("synthetic awaiting_structuring transition failure")

        monkeypatch.setattr(service.repository, "mark_awaiting_structuring", fail_transition)

    capture_id = _start_pdf_capture(
        client,
        f"%PDF-1.7 host OCR {failure_point} failure".encode(),
        f"host-ocr-{failure_point}-failure",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.FAILED)

    assert sink.proofs == []


def test_cancel_before_host_ocr_checkpoint_publishes_no_execution_proof(
    client: TestClient,
) -> None:
    service = client.app.state.streaming_capture_service
    sink = InMemoryOcrExecutionEvidenceSink()
    service._execution_evidence_sink = sink
    extractor = _GatedHostProofExtractor("host OCR cancelled before checkpoint")
    service._extractor = extractor
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host OCR cancel before checkpoint",
        "host-ocr-cancel-before-checkpoint",
        structuring_mode="host",
    )

    assert extractor.entered.wait(timeout=5)
    assert service.get_capture(capture_id).status is StreamingCaptureStatus.EXTRACTING
    cancelled = client.post(f"/v2/captures/{capture_id}/cancel")
    assert cancelled.status_code == 200, cancelled.text
    assert extractor.finished.wait(timeout=5)

    assert sink.proofs == []
    assert capture_id not in service._pending_execution_proofs


def test_delete_before_host_ocr_checkpoint_publishes_no_execution_proof(
    client: TestClient,
) -> None:
    service = client.app.state.streaming_capture_service
    sink = InMemoryOcrExecutionEvidenceSink()
    service._execution_evidence_sink = sink
    extractor = _GatedHostProofExtractor("host OCR deleted before checkpoint")
    service._extractor = extractor
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host OCR delete before checkpoint",
        "host-ocr-delete-before-checkpoint",
        structuring_mode="host",
    )

    assert extractor.entered.wait(timeout=5)
    assert service.get_capture(capture_id).status is StreamingCaptureStatus.EXTRACTING
    deleted = client.delete(f"/v2/captures/{capture_id}")
    assert deleted.status_code == 204, deleted.text
    assert extractor.finished.wait(timeout=5)

    assert sink.proofs == []
    assert capture_id not in service._pending_execution_proofs


def test_host_proof_commit_persistence_failure_preserves_checkpoint_artifact(
    client: TestClient, monkeypatch, tmp_path
) -> None:
    service = client.app.state.streaming_capture_service
    root = tmp_path / "acceptance-host-commit-failure-run"
    root.mkdir()
    service._execution_evidence_sink = AcceptanceOcrExecutionEvidenceSink(
        root, preauthorized_root=root
    )
    service._extractor = _HostProofExtractor("host commit failure page", with_projection=True)
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host commit failure proof",
        "host-commit-failure-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.AWAITING_STRUCTURING)
    candidate = _host_proof_candidate(service.repository.read_raw(capture_id))
    _wait_for_proof_artifact(root)

    def fail_commit(_capture_id: str, **_kwargs):
        raise RuntimeError("synthetic host commit persistence failure")

    monkeypatch.setattr(service.repository, "commit_host_result", fail_commit)
    with pytest.raises(RuntimeError, match="persistence failure"):
        service.commit_host_result(capture_id, candidate, idempotency_key="host-commit-failure")

    assert capture_id not in service._pending_execution_proofs
    _wait_for_proof_artifact(root)
    assert not list(root.glob(".ocr-device-proof-*.tmp"))


def test_host_proof_pull_session_keeps_checkpoint_artifact_before_final_batch_commit(
    client: TestClient, tmp_path
) -> None:
    service = client.app.state.streaming_capture_service
    root = tmp_path / "acceptance-host-session-run"
    root.mkdir()
    service._execution_evidence_sink = AcceptanceOcrExecutionEvidenceSink(
        root, preauthorized_root=root
    )
    service._extractor = _HostProofExtractor("host pull session page", with_projection=True)
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host pull session proof",
        "host-pull-session-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.AWAITING_STRUCTURING)
    _wait_for_proof_artifact(root)

    opened = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json={
            "captureId": capture_id,
            "targetLanguage": "fr",
            "providerCapability": {
                "provider": {
                    "engine": "ollama",
                    "model": "capture-workbench-qwen3.5-0.8b-structure-v1",
                    "digest": "sha256:" + "b" * 64,
                },
                "capability": "capture-structuring",
                "schemaDialect": SCHEMA_DIALECT,
            },
            "schemaDialect": SCHEMA_DIALECT,
            "clientRequestId": "host-pull-session-proof-request",
        },
        headers={"X-Idempotency-Key": "host-pull-session-proof-request"},
    )
    assert opened.status_code == 201, opened.text
    batch = client.get(f"/v2/captures/{capture_id}/structure/session/batches/0")
    assert batch.status_code == 200, batch.text
    batch_payload = batch.json()
    submitted = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json={
            "batchDigest": batch_payload["batchDigest"],
            "blocks": [
                {
                    "sourceSegmentId": batch_payload["sourceSegmentIds"][0],
                    "type": "transcript",
                    "targetText": "host session translation",
                }
            ],
        },
        headers={"X-Idempotency-Key": "host-pull-session-proof-batch"},
    )
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["status"] == "completed"
    _wait_for_proof_artifact(root)
    assert not list(root.glob(".ocr-device-proof-*.tmp"))


def test_host_proof_pull_session_validation_failure_keeps_checkpoint_artifact(
    client: TestClient, tmp_path
) -> None:
    service = client.app.state.streaming_capture_service
    root = tmp_path / "acceptance-host-session-invalid-run"
    root.mkdir()
    service._execution_evidence_sink = AcceptanceOcrExecutionEvidenceSink(
        root, preauthorized_root=root
    )
    service._extractor = _HostProofExtractor("host invalid session page", with_projection=True)
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host invalid session proof",
        "host-invalid-session-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.AWAITING_STRUCTURING)
    _wait_for_proof_artifact(root)

    request = {
        "captureId": capture_id,
        "targetLanguage": "fr",
        "providerCapability": {
            "provider": {
                "engine": "ollama",
                "model": "capture-workbench-qwen3.5-0.8b-structure-v1",
                "digest": "sha256:" + "b" * 64,
            },
            "capability": "capture-structuring",
            "schemaDialect": SCHEMA_DIALECT,
        },
        "schemaDialect": SCHEMA_DIALECT,
        "clientRequestId": "host-invalid-session-request",
    }
    opened = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=request,
        headers={"X-Idempotency-Key": request["clientRequestId"]},
    )
    assert opened.status_code == 201, opened.text
    batch = client.get(f"/v2/captures/{capture_id}/structure/session/batches/0")
    assert batch.status_code == 200, batch.text
    invalid = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json={
            "batchDigest": batch.json()["batchDigest"],
            "blocks": [
                {
                    "sourceSegmentId": "not-a-raw-segment",
                    "type": "transcript",
                    "targetText": "invalid session output",
                }
            ],
        },
        headers={"X-Idempotency-Key": "host-invalid-session-batch"},
    )
    assert invalid.status_code == 422, invalid.text
    assert capture_id not in service._pending_execution_proofs
    assert (root / "ocr-device-proof-v1.json").is_file()
    assert not list(root.glob(".ocr-device-proof-*.tmp"))


def test_host_proof_validation_failure_preserves_checkpoint_artifact(
    client: TestClient, tmp_path
) -> None:
    service = client.app.state.streaming_capture_service
    root = tmp_path / "acceptance-host-invalid-run"
    root.mkdir()
    service._execution_evidence_sink = AcceptanceOcrExecutionEvidenceSink(
        root, preauthorized_root=root
    )

    service._extractor = _HostProofExtractor("host invalid page", with_projection=True)
    capture_id = _start_pdf_capture(
        client,
        b"%PDF-1.7 host invalid proof",
        "host-invalid-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.AWAITING_STRUCTURING)
    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    _wait_for_proof_artifact(root)
    raw = service.repository.read_raw(capture_id)
    invalid = _host_proof_candidate(raw).model_copy(
        update={"source": raw.source.model_copy(update={"sha256": "0" * 64})}
    )

    response = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        json=invalid.model_dump(mode="json", by_alias=True),
        headers={"X-Idempotency-Key": "host-invalid-commit"},
    )
    assert response.status_code == 422, response.text
    assert service.get_capture(capture_id).status is StreamingCaptureStatus.FAILED
    assert (root / "ocr-device-proof-v1.json").is_file()
    assert not list(root.glob(".ocr-device-proof-*.tmp"))


@pytest.mark.parametrize("action", ["failure", "cancel", "delete", "shutdown"])
def test_host_proof_abort_paths_do_not_duplicate_checkpoint_artifact(
    client: TestClient, tmp_path, action: str
) -> None:
    service = client.app.state.streaming_capture_service
    root = tmp_path / f"acceptance-host-{action}-run"
    root.mkdir()
    service._execution_evidence_sink = AcceptanceOcrExecutionEvidenceSink(
        root, preauthorized_root=root
    )

    service._extractor = _HostProofExtractor(f"host {action} page", with_projection=True)
    capture_id = _start_pdf_capture(
        client,
        f"%PDF-1.7 host {action} proof".encode(),
        f"host-{action}-proof",
        structuring_mode="host",
    )
    _wait_for_capture_status(service, capture_id, StreamingCaptureStatus.AWAITING_STRUCTURING)
    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    _wait_for_proof_artifact(root)

    if action == "failure":
        response = client.post(
            f"/v2/captures/{capture_id}/structure/failure",
            json={"code": "host_provider_failed", "message": "synthetic"},
            headers={"X-Idempotency-Key": "host-failure"},
        )
        assert response.status_code == 200, response.text
    elif action == "cancel":
        response = client.post(f"/v2/captures/{capture_id}/cancel")
        assert response.status_code == 200, response.text
    elif action == "delete":
        response = client.delete(f"/v2/captures/{capture_id}")
        assert response.status_code == 204, response.text
    else:
        asyncio.run(service.shutdown())

    assert (root / "ocr-device-proof-v1.json").is_file()
    assert not list(root.glob(".ocr-device-proof-*.tmp"))


def test_manifest_preflight_failure_is_typed_without_fabricated_pages(
    client: TestClient, monkeypatch
) -> None:
    class MissingRuntimeManager:
        worker_client = object()

        async def resolve_active_engine(self, _requirement_id: str) -> None:
            return None

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        client.app.state.settings.extraction,
        engine_manager=MissingRuntimeManager(),  # type: ignore[arg-type]
    )

    def fail_manifest(*_args, **_kwargs):
        raise ValueError("malformed source")

    monkeypatch.setattr(extractor, "_ocr_pdf_page_manifest", fail_manifest)
    client.app.state.streaming_capture_service._extractor = extractor
    source = b"%PDF-1.7 source manifest cannot be built"
    capture_id = _start_pdf_capture(client, source, "manifest-preflight-failure")

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    assert "event: failed" in events.text
    response = client.get(f"/v2/captures/{capture_id}/ocr")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["pageCount"] == 0
    assert payload["pages"] == []
    assert payload["failure"]["code"] == "ocr_source_preflight_failed"
    assert payload["provenance"]["status"] == "unavailable"


def test_streaming_service_persists_all_empty_ocr_projection_as_terminal_no_text(
    client: TestClient,
) -> None:
    capture_id, _candidate = _seed_host_capture(client)
    repository = client.app.state.streaming_repository
    operation = repository.get_capture(capture_id)
    assert operation.source is not None
    projection = OcrPipeline().build(
        capture_id=capture_id,
        source=operation.source,
        provenance=CaptureEngine(
            engine="windowsml-ocr",
            model="pp-ocrv6-medium-windowsml",
            digest="sha256:" + "c" * 64,
            device="windowsml-dml",
        ),
        created_at=datetime.now(UTC),
        pages=[
            OcrPageInput(
                page=1,
                text="",
                raster_width=120,
                raster_height=80,
                raster_scale=2,
            ),
            OcrPageInput(
                page=2,
                text="",
                raster_width=120,
                raster_height=80,
                raster_scale=2,
            ),
        ],
    )
    assert projection.failure is not None
    assert projection.failure.code == "ocr_no_text"

    service = client.app.state.streaming_capture_service
    service._fail(
        capture_id,
        projection.failure.code,
        projection.failure.message,
        stage=projection.failure.stage or "extraction",
        retryable=projection.failure.retryable,
        ocr_projection=projection,
    )

    response = client.get(f"/v2/captures/{capture_id}/ocr")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["status"] == "failed"
    assert payload["failure"]["code"] == "ocr_no_text"
    assert [page["status"] for page in payload["pages"]] == ["empty", "empty"]


def test_streaming_api_accepts_ordered_chunks_replays_sse_and_rejects_partial_before_worker(
    client: TestClient,
) -> None:
    ingestion_id, source_sha256 = _open(client)
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-capture-1",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
        headers={"X-Idempotency-Key": "api-stream-capture-1"},
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]
    assert started.json()["status"] == "waiting_input"

    first = b"abc"
    first_response = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=first,
        headers={
            "Content-Range": "bytes 0-2/6",
            "Digest": f"sha-256={hashlib.sha256(first).hexdigest()}",
            "X-Idempotency-Key": "api-stream-chunk-0",
        },
    )
    assert first_response.status_code == 200, first_response.text
    assert first_response.json()["nextOffset"] == 3

    duplicate = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=first,
        headers={
            "Content-Range": "bytes 0-2/6",
            "Digest": f"sha-256={hashlib.sha256(first).hexdigest()}",
            "X-Idempotency-Key": "api-stream-chunk-0-retry",
        },
    )
    assert duplicate.status_code == 200
    assert duplicate.json()["nextOffset"] == 3

    second = b"def"
    second_response = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/1",
        content=second,
        headers={
            "Content-Range": "bytes 3-5/6",
            "Digest": f"sha-256={hashlib.sha256(second).hexdigest()}",
            "X-Idempotency-Key": "api-stream-chunk-1",
        },
    )
    assert second_response.status_code == 200, second_response.text

    finalized = client.post(
        f"/v2/ingestions/{ingestion_id}/finalize",
        json={"totalBytes": 6, "sha256": source_sha256},
    )
    assert finalized.status_code == 200, finalized.text
    assert finalized.json()["status"] == "ready"
    assert finalized.json()["kind"] == "audio"

    capture = client.get(f"/v2/captures/{capture_id}")
    assert capture.status_code == 200
    assert capture.json()["status"] == "failed"
    assert capture.json()["kind"] == "audio"
    assert capture.json()["source"]["sha256"] == source_sha256

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200
    assert events.headers["content-type"].startswith("text/event-stream")
    assert [line for line in events.text.splitlines() if line.startswith("id: ")] == [
        "id: 1",
        "id: 2",
        "id: 3",
        "id: 4",
        "id: 5",
    ]
    assert "event: accepted" in events.text
    assert events.text.count("event: input_checkpoint") == 3
    assert TOKEN not in events.text

    replay = client.get(
        f"/v2/captures/{capture_id}/events",
        headers={"Last-Event-ID": "2"},
    )
    assert [line for line in replay.text.splitlines() if line.startswith("id: ")] == [
        "id: 3",
        "id: 4",
        "id: 5",
    ]

    partial = client.get(f"/v2/captures/{capture_id}/partial")
    assert partial.status_code == 409
    assert partial.json()["error"]["code"] == "partial_unavailable"


def test_streaming_api_processes_pdf_ocr_through_the_same_v2_sse_lifecycle(
    client: TestClient,
) -> None:
    source = b"%PDF-1.7\nCAPTURE_TEXT:ocr text from a PDF page"
    digest = hashlib.sha256(source).hexdigest()
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": "api-stream-pdf-open-1",
            "kind": "pdf",
            "fileName": "sample.pdf",
            "mediaType": "application/pdf",
            "totalBytes": len(source),
            "sourceSha256": digest,
        },
        headers={"X-Idempotency-Key": "api-stream-pdf-open-1"},
    )
    assert opened.status_code == 201, opened.text
    ingestion_id = opened.json()["ingestionId"]

    uploaded = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=source,
        headers={
            "Content-Range": f"bytes 0-{len(source) - 1}/{len(source)}",
            "Digest": f"sha-256={digest}",
            "X-Idempotency-Key": "api-stream-pdf-chunk-0",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    finalized = client.post(
        f"/v2/ingestions/{ingestion_id}/finalize",
        json={"totalBytes": len(source), "sha256": digest},
    )
    assert finalized.status_code == 200, finalized.text
    assert finalized.json()["kind"] == "pdf"

    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-pdf-capture-1",
            "ingestionId": ingestion_id,
            "structuringMode": "runtime",
            "startPolicy": "eager",
        },
        headers={"X-Idempotency-Key": "api-stream-pdf-capture-1"},
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200, events.text
    assert "event: segment" in events.text
    assert "event: completed" in events.text
    completed = client.get(f"/v2/captures/{capture_id}").json()
    assert completed["status"] == "completed", completed
    assert completed["kind"] == "pdf"
    result = client.get(f"/v2/captures/{capture_id}/result")
    assert result.status_code == 200, result.text
    assert result.json()["raw"]["sourceText"] == "ocr text from a PDF page"


def test_streaming_api_rejects_gap_checksum_and_invalid_cursor(client: TestClient) -> None:
    ingestion_id, _ = _open(client)
    data = b"abc"
    total_conflict = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=data,
        headers={
            "Content-Range": "bytes 0-2/99",
            "Digest": f"sha-256={hashlib.sha256(data).hexdigest()}",
            "X-Idempotency-Key": "api-stream-total-conflict",
        },
    )
    assert total_conflict.status_code == 409
    assert total_conflict.json()["error"]["code"] == "chunk_total_conflict"

    gap = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/1",
        content=data,
        headers={
            "Content-Range": "bytes 0-2/6",
            "Digest": f"sha-256={hashlib.sha256(data).hexdigest()}",
            "X-Idempotency-Key": "api-stream-gap",
        },
    )
    assert gap.status_code == 409
    assert gap.json()["error"]["code"] == "chunk_out_of_order"

    checksum = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=data,
        headers={
            "Content-Range": "bytes 0-2/6",
            "Digest": "sha-256=" + "0" * 64,
            "X-Idempotency-Key": "api-stream-checksum",
        },
    )
    assert checksum.status_code == 409
    assert checksum.json()["error"]["code"] == "chunk_checksum_mismatch"

    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-capture-cursor",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
        headers={"X-Idempotency-Key": "api-stream-capture-cursor"},
    )
    assert started.status_code == 202
    invalid_cursor = client.get(
        f"/v2/captures/{started.json()['captureId']}/events",
        headers={"Last-Event-ID": "not-a-number"},
    )
    assert invalid_cursor.status_code == 422
    assert invalid_cursor.json()["error"]["code"] == "invalid_event_cursor"

    cancelled = client.post(f"/v2/captures/{started.json()['captureId']}/cancel")
    assert cancelled.status_code == 200

    assert (
        json.loads(
            client.get(f"/v2/captures/{started.json()['captureId']}/events")
            .text.split("data: ")[1]
            .split("\n", 1)[0]
        )["protocolVersion"]
        == "2"
    )


def test_streaming_api_allows_ingestion_cleanup(client: TestClient) -> None:
    ingestion_id, _ = _open(client)

    deleted = client.delete(f"/v2/ingestions/{ingestion_id}")

    assert deleted.status_code == 204
    assert client.get(f"/v2/ingestions/{ingestion_id}").status_code == 404


def test_v2_host_commit_and_failure_routes_preserve_terminal_semantics(
    client: TestClient,
) -> None:
    capture_id, candidate = _seed_host_capture(client)
    commit_headers = {"X-Idempotency-Key": "v2-host-commit-1"}

    committed = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        headers=commit_headers,
        json=candidate,
    )

    assert committed.status_code == 200, committed.text
    assert committed.json()["status"] == "completed"
    assert client.get(f"/v2/captures/{capture_id}/result").json()["result"]["targetText"] == (
        "host words translated"
    )
    repeated = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        headers=commit_headers,
        json=candidate,
    )
    assert repeated.status_code == 200
    conflict = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        headers={"X-Idempotency-Key": "v2-host-commit-2"},
        json=candidate,
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"

    failed_id, _ = _seed_host_capture(client)
    failed = client.post(
        f"/v2/captures/{failed_id}/structure/failure",
        headers={"X-Idempotency-Key": "v2-host-failure-1"},
        json={"code": "host_model_failed", "message": "Host model did not respond."},
    )

    assert failed.status_code == 200, failed.text
    assert failed.json()["status"] == "failed"
    assert failed.json()["error"] == {
        "code": "host_model_failed",
        "message": "Host model did not respond.",
        "stage": "structuring",
        "retryable": False,
    }
    assert client.get(f"/v2/captures/{failed_id}/result").status_code == 409


def test_v2_host_commit_invalid_candidate_fails_the_capture(client: TestClient) -> None:
    capture_id, candidate = _seed_host_capture(client)
    invalid = {**candidate, "source": {**candidate["source"], "sha256": "0" * 64}}

    response = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        headers={"X-Idempotency-Key": "v2-host-invalid-1"},
        json=invalid,
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_structure"
    operation = client.get(f"/v2/captures/{capture_id}").json()
    assert operation["status"] == "failed"
    assert operation["error"]["code"] == "structuring_invalid_output"
    assert client.get(f"/v2/captures/{capture_id}/partial").status_code == 409
