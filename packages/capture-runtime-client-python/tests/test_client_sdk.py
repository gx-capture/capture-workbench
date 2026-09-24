from __future__ import annotations

import hashlib
import json
import tomllib
from collections.abc import Callable
from contextlib import contextmanager
from copy import deepcopy
from importlib.resources import files
from pathlib import Path

import httpx
import pytest
from pydantic import ValidationError

from capture_runtime_client import (
    CAPTURE_CONTRACT_SET_SHA256,
    CAPTURE_DOCUMENT_SCHEMA_SHA256,
    CaptureAuthenticationError,
    CaptureOcrProjection,
    CaptureProtocolError,
    CaptureRemoteError,
    CaptureRuntimeClient,
    CaptureRuntimeCompatibilityError,
    CaptureRuntimeError,
    CaptureUpload,
    InMemoryRuntimeTransport,
    RuntimeReady,
    validate_loopback_base_url,
)

SHARED_PERSPECTIVE_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/capture-runtime/tests/fixtures/ocr-projection-v3-perspective.json"
)
SHARED_REFERENCED_INVALID_CORPUS_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "packages/capture-runtime/tests/fixtures/ocr-projection-v3-referenced-invalid-corpus.json"
)


def _shared_perspective_payload() -> dict[str, object]:
    payload = json.loads(SHARED_PERSPECTIVE_FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(payload, dict)
    payload["contractSha256"] = CAPTURE_CONTRACT_SET_SHA256
    return payload


def _shared_referenced_invalid_corpus() -> list[dict[str, object]]:
    corpus = json.loads(SHARED_REFERENCED_INVALID_CORPUS_FIXTURE.read_text(encoding="utf-8"))
    assert isinstance(corpus, dict)
    cases = corpus.get("cases")
    assert isinstance(cases, list)
    assert all(isinstance(case, dict) for case in cases)
    return cases


def _apply_referenced_invalid_mutation(
    payload: dict[str, object], invalid: dict[str, object]
) -> None:
    path = invalid["path"]
    assert isinstance(path, list) and all(isinstance(part, str) for part in path)
    parent = payload
    for part in path[:-1]:
        value = parent[part]
        assert isinstance(value, dict)
        parent = value
    field = path[-1]
    assert isinstance(field, str)
    if invalid["operation"] == "remove":
        parent.pop(field)
    else:
        parent[field] = invalid["value"]


def test_packaged_contract_set_hash_matches_runtime_asset() -> None:
    runtime_asset = (
        Path(__file__).resolve().parents[2]
        / "capture-runtime"
        / "src"
        / "capture_runtime"
        / "assets"
    )
    runtime_bundle = (runtime_asset / "contract-set.json").read_bytes()
    runtime_digest = (runtime_asset / "contract-set.sha256").read_text(encoding="ascii").strip()
    packaged = files("capture_runtime_client.private.assets")
    packaged_bundle = packaged.joinpath("contract-set.json").read_bytes()
    packaged_digest = packaged.joinpath("contract-set.sha256").read_text(encoding="ascii").strip()
    assert hashlib.sha256(runtime_bundle).hexdigest() == runtime_digest
    assert packaged_bundle == runtime_bundle
    assert packaged_digest == runtime_digest == CAPTURE_CONTRACT_SET_SHA256


def test_python_project_declares_the_packaged_contract_set_hash() -> None:
    project = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    )

    assert (
        project["tool"]["capture_runtime_client"]["contract_set_sha256"]
        == CAPTURE_CONTRACT_SET_SHA256
    )


def _ready(**overrides: object) -> dict[str, object]:
    payload: dict[str, object] = {
        "ready": True,
        "service": "capture-runtime",
        "apiVersion": "2.0",
        "runtimeVersion": "0.4.2",
        "captureDocumentSchemaVersion": "2",
        "capabilities": {
            "captureKinds": ["pdf"],
            "structuringModes": ["host"],
            "supportsCancellation": True,
            "supportsRawDiagnostics": True,
            "maxUploadBytes": 100,
        },
    }
    payload.update(overrides)
    return payload


def _discovery_routes() -> dict[tuple[str, str], Callable[[httpx.Request], httpx.Response]]:
    packaged = files("capture_runtime_client.private.assets")
    bundle = packaged.joinpath("contract-set.json").read_bytes()
    digest = hashlib.sha256(bundle).hexdigest()
    href = f"/meta/v2/contracts/sha256/{digest}"
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.2",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": href,
    }
    return {
        ("GET", "/v2/health/ready"): lambda request: httpx.Response(
            200, json=_ready(), request=request
        ),
        ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
            200, json=index, request=request
        ),
        ("GET", href): lambda request: httpx.Response(
            200,
            content=bundle,
            headers={"X-Contract-SHA256": digest, "ETag": f'"{digest}"'},
            request=request,
        ),
        ("GET", "/v2/streaming/health/ready"): lambda request: httpx.Response(
            200,
            json={
                "protocolVersion": "2",
                "captureKinds": ["pdf", "image", "audio"],
                "supportsProgressiveAudio": True,
                "maxChunkBytes": 1_048_576,
                "checkpointIntervalMs": 500,
                "heartbeatIntervalMs": 1_000,
                "stallTimeoutMs": 5_000,
            },
            request=request,
        ),
    }


def _transport(
    routes: dict[tuple[str, str], Callable[[httpx.Request], httpx.Response]],
) -> InMemoryRuntimeTransport:
    return InMemoryRuntimeTransport({**_discovery_routes(), **routes})


def test_capture_upload_accepts_and_freezes_an_ordered_pdf_page_prefix() -> None:
    upload = CaptureUpload(
        "scan.pdf",
        b"pdf-bytes",
        "pdf",
        media_type="application/pdf",
        pdf_page_numbers=[1, 2],
    )

    assert upload.pdf_page_numbers == (1, 2)


@pytest.mark.parametrize("page_numbers", [(), (2,), (1, 3)])
def test_capture_upload_rejects_non_prefix_pdf_page_numbers(
    page_numbers: tuple[int, ...],
) -> None:
    with pytest.raises(ValueError, match="ordered prefix|1 to 500"):
        CaptureUpload(
            "scan.pdf",
            b"pdf-bytes",
            "pdf",
            media_type="application/pdf",
            pdf_page_numbers=page_numbers,
        )


def test_start_capture_sends_ordered_pdf_page_prefix() -> None:
    content = b"pdf-bytes"
    digest = hashlib.sha256(content).hexdigest()

    def ingestion(
        request: httpx.Request,
        *,
        received: int,
        next_chunk: int,
        status: str = "open",
        finalized: str | None = None,
    ) -> httpx.Response:
        return httpx.Response(
            201 if next_chunk == 0 else 200,
            json={
                "protocolVersion": "2",
                "kind": "pdf",
                "ingestionId": "ingestion-1",
                "status": status,
                "fileName": "scan.pdf",
                "mediaType": "application/pdf",
                "totalBytes": len(content),
                "receivedBytes": received,
                "contiguousBytes": received,
                "nextChunkIndex": next_chunk,
                "nextOffset": received,
                "sourceSha256": digest,
                "finalizedSha256": finalized,
                "expiresAt": "2026-01-01T00:00:00+00:00",
            },
            request=request,
        )

    def start(request: httpx.Request) -> httpx.Response:
        payload = json.loads(request.content)
        assert payload["pdfPageNumbers"] == [1]
        assert payload["structuringMode"] == "runtime"
        return httpx.Response(
            202,
            json={
                "protocolVersion": "2",
                "captureId": "capture-1",
                "ingestionId": "ingestion-1",
                "kind": "pdf",
                "status": "extracting",
                "progress": 0.0,
                "partialRevision": 0,
                "lastEventSequence": 0,
                "source": None,
                "error": None,
                "createdAt": "2026-01-01T00:00:00+00:00",
                "updatedAt": "2026-01-01T00:00:00+00:00",
                "completedAt": None,
            },
            request=request,
        )

    transport = _transport(
        {
            ("POST", "/v2/ingestions"): lambda request: ingestion(
                request, received=0, next_chunk=0
            ),
            ("PUT", "/v2/ingestions/ingestion-1/chunks/0"): lambda request: ingestion(
                request, received=len(content), next_chunk=1
            ),
            ("POST", "/v2/ingestions/ingestion-1/finalize"): lambda request: ingestion(
                request,
                received=len(content),
                next_chunk=1,
                status="ready",
                finalized=digest,
            ),
            ("POST", "/v2/captures"): start,
        }
    )

    operation = CaptureRuntimeClient(transport=transport).start_capture(
        CaptureUpload(
            "scan.pdf",
            content,
            "pdf",
            media_type="application/pdf",
            pdf_page_numbers=(1,),
        ),
        client_request_id="request-page-1",
    )

    assert operation.capture_id == "capture-1"


def _ocr_projection(*, status: str = "completed") -> dict[str, object]:
    engine = {
        "status": "resolved",
        "engine": "windowsml-ocr",
        "model": "pp-ocrv6-medium-windowsml",
        "modelDigest": f"sha256:{'a' * 64}",
        "device": "windowsml-dml",
        "profileId": "capture-workbench-ocr-pipeline-v1",
        "profileSpecSha256": "b" * 64,
    }
    source = {
        "sha256": "b" * 64,
        "fileName": "scan.pdf",
        "mediaType": "application/pdf",
        "bytes": 1024,
    }
    if status == "failed":
        return {
            "apiVersion": "2.0",
            "schemaVersion": "3",
            "captureId": "cap",
            "status": "failed",
            "pages": [],
            "pageCount": 0,
            "runtimeVersion": "0.4.2",
            "contractSha256": CAPTURE_CONTRACT_SET_SHA256,
            "source": None,
            "provenance": engine,
            "warnings": [],
            "failure": {
                "code": "ocr_unavailable",
                "message": "PaddleOCR is not available.",
                "stage": "ocr",
                "retryable": True,
            },
            "createdAt": "2026-01-01T00:00:00+00:00",
        }
    return {
        "apiVersion": "2.0",
        "schemaVersion": "3",
        "captureId": "cap",
        "status": "completed",
        "source": source,
        "pageCount": 1,
        "runtimeVersion": "0.4.2",
        "contractSha256": CAPTURE_CONTRACT_SET_SHA256,
        "pages": [
            {
                "page": 1,
                "status": "recognized",
                "raster": {
                    "width": 1200,
                    "height": 1600,
                    "scale": 2,
                    "coordinateSystem": "pixel",
                },
                "text": "第一頁 法律文件",
                "boxes": [
                    {
                        "polygon": [
                            {"x": 10.5, "y": 20.25},
                            {"x": 310.75, "y": 12.5},
                            {"x": 320, "y": 80.5},
                            {"x": 5, "y": 90},
                        ],
                        "text": "蝚砌???瘜??辣",
                        "confidence": 0.98,
                    }
                ],
                "confidence": 0.98,
                "provenance": engine,
                "failure": None,
            }
        ],
        "provenance": engine,
        "warnings": [],
        "failure": None,
        "createdAt": "2026-01-01T00:00:00+00:00",
    }


def test_loopback_transport_and_handshake() -> None:
    def operation(path: str, **overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
            "path": path,
            "method": "GET",
            "surface": "v2",
            "body": {"kind": "none"},
            "requiredHeaders": [],
            "idempotency": {"mode": "none", "header": None},
            "responseStatusCodes": [200],
        }
        value.update(overrides)
        return value

    bundle = {
        "contractSetVersion": "2",
        "schemaDialect": "https://json-schema.org/draft/2020-12/schema",
        "surfaces": [{"id": "v2"}],
        "schemas": [{"name": "CaptureDocument", "schemaSha256": CAPTURE_DOCUMENT_SCHEMA_SHA256}],
        "operations": [
            operation("/v2/health/ready"),
            operation(
                "/v2/captures",
                method="POST",
                body={"kind": "json"},
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation("/v2/streaming/health/ready"),
            operation("/v2/runtime/requirements"),
            operation(
                "/v2/runtime/installations",
                method="POST",
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation("/v2/runtime/model-options"),
            operation(
                "/v2/runtime/model-installations",
                method="POST",
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation(
                "/v2/ingestions/{ingestion_id}/chunks/{chunk_index}",
                method="PUT",
                body={"kind": "binary"},
                requiredHeaders=["Content-Range", "Digest", "X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation(
                "/v2/captures/{capture_id}/events",
                mediaType="text/event-stream",
                optionalHeaders=["Last-Event-ID"],
                streaming={"kind": "sse", "lastEventIdHeader": "Last-Event-ID"},
            ),
            operation("/v2/captures/{capture_id}/raw"),
            operation(
                "/v2/captures/{capture_id}/ocr",
                responseSchema="CaptureOcrProjectionV3",
            ),
            operation("/v2/captures/{capture_id}/result"),
            operation(
                "/v2/captures/{capture_id}/structure/session",
                method="POST",
                body={"kind": "json"},
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
            operation(
                "/v2/captures/{capture_id}/structure/session/batches/{batch_index}",
                method="GET",
            ),
            operation(
                "/v2/captures/{capture_id}/structure/session/batches/{batch_index}",
                method="PUT",
                body={"kind": "json"},
                requiredHeaders=["X-Idempotency-Key"],
                idempotency={"mode": "required", "header": "X-Idempotency-Key"},
            ),
        ],
        "problems": [],
        "invariants": [],
    }
    bundle_bytes = json.dumps(bundle, separators=(",", ":"), sort_keys=True).encode()
    digest = hashlib.sha256(bundle_bytes).hexdigest()
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.2",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": f"/meta/v2/contracts/sha256/{digest}",
    }
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(), request=request
            ),
            ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
                200, json=index, request=request
            ),
            ("GET", "/v2/streaming/health/ready"): lambda request: httpx.Response(
                200,
                json={
                    "protocolVersion": "2",
                    "maxChunkBytes": 10,
                    "checkpointIntervalMs": 500,
                    "heartbeatIntervalMs": 1000,
                    "stallTimeoutMs": 5000,
                },
                request=request,
            ),
            ("GET", index["href"]): lambda request: httpx.Response(
                200,
                content=bundle_bytes,
                headers={"X-Contract-SHA256": digest, "ETag": f'"{digest}"'},
                request=request,
            ),
        }
    )
    client = CaptureRuntimeClient(transport=transport, allowed_contract_set_sha256=[digest])
    ready = client.handshake()
    assert isinstance(ready, RuntimeReady)
    assert client.discover().schema_sha256 == CAPTURE_DOCUMENT_SCHEMA_SHA256


def test_compatibility_failure_is_machine_readable() -> None:
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(apiVersion="1.0"), request=request
            )
        }
    )
    with pytest.raises(CaptureRuntimeCompatibilityError):
        CaptureRuntimeClient(transport=transport).handshake()


def test_get_ocr_maps_completed_and_failed_page_projections() -> None:
    completed = _ocr_projection()
    failed = _ocr_projection(status="failed")
    transport = _transport(
        {
            ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                200, json=completed, request=request
            )
        }
    )
    result = CaptureRuntimeClient(transport=transport).get_ocr("cap")
    assert isinstance(result, CaptureOcrProjection)
    assert result.pages[0].provenance is not None
    assert result.pages[0].provenance.engine == "windowsml-ocr"
    assert [(point.x, point.y) for point in result.pages[0].boxes[0].polygon] == [
        (10.5, 20.25),
        (310.75, 12.5),
        (320, 80.5),
        (5, 90),
    ]

    failed_transport = _transport(
        {
            ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                200, json=failed, request=request
            )
        }
    )
    failed_result = CaptureRuntimeClient(transport=failed_transport).get_ocr("cap")
    assert failed_result.status.value == "failed"
    assert failed_result.failure is not None
    assert failed_result.failure.code == "ocr_unavailable"


@pytest.mark.parametrize(
    ("status_code", "code", "error_type"),
    [
        (401, "unauthorized", CaptureAuthenticationError),
        (404, "capture_not_found", CaptureRemoteError),
        (409, "ocr_unavailable", CaptureRemoteError),
    ],
)
def test_get_ocr_maps_auth_not_found_and_pending_errors(
    status_code: int, code: str, error_type: type[CaptureRuntimeError]
) -> None:
    transport = _transport(
        {
            ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                status_code,
                json={
                    "error": {
                        "code": code,
                        "message": "OCR is pending." if status_code == 409 else "OCR failed.",
                        "details": {"retryable": status_code == 409},
                    }
                },
                request=request,
            )
        }
    )
    with pytest.raises(error_type) as caught:
        CaptureRuntimeClient(transport=transport).get_ocr("cap")
    assert caught.value.status_code == status_code
    assert caught.value.code == code


def test_generated_ocr_model_rejects_invalid_box_and_projection_state() -> None:
    assert CaptureOcrProjection.model_fields["pages"].is_required()
    unavailable = {
        "status": "unavailable",
        "profileId": "capture-workbench-ocr-pipeline-v1",
        "profileSpecSha256": "b" * 64,
        "reason": "model_unavailable",
    }
    failed_with_unavailable = _ocr_projection(status="failed")
    failed_with_unavailable["provenance"] = unavailable
    failed_result = CaptureRuntimeClient(
        transport=_transport(
            {
                ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                    200, json=failed_with_unavailable, request=request
                )
            }
        )
    ).get_ocr("cap")
    assert failed_result.provenance.status == "unavailable"

    unresolved_model_digest = _ocr_projection()
    unresolved_provenance = unresolved_model_digest["provenance"]
    unresolved_pages = unresolved_model_digest["pages"]
    assert isinstance(unresolved_provenance, dict)
    assert isinstance(unresolved_pages, list) and isinstance(unresolved_pages[0], dict)
    unresolved_provenance["modelDigest"] = "sha256:" + "0" * 64
    unresolved_page_provenance = unresolved_pages[0]["provenance"]
    assert isinstance(unresolved_page_provenance, dict)
    unresolved_page_provenance["modelDigest"] = unresolved_provenance["modelDigest"]
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200, json=unresolved_model_digest, request=request
                    )
                }
            )
        ).get_ocr("cap")

    completed_with_unavailable = _ocr_projection()
    completed_with_unavailable["provenance"] = unavailable
    completed_page = completed_with_unavailable["pages"][0]
    assert isinstance(completed_page, dict)
    completed_page["provenance"] = unavailable
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200, json=completed_with_unavailable, request=request
                    )
                }
            )
        ).get_ocr("cap")

    invalid_box = _ocr_projection()
    page = invalid_box["pages"][0]
    assert isinstance(page, dict)
    boxes = page["boxes"]
    assert isinstance(boxes, list)
    boxes[0]["polygon"][0]["x"] = 1201
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200, json=invalid_box, request=request
                    )
                }
            )
        ).get_ocr("cap")

    rectangle_only = _ocr_projection()
    rectangle_page = rectangle_only["pages"][0]
    assert isinstance(rectangle_page, dict)
    rectangle_page["boxes"] = [{"x": 10, "y": 20, "width": 300, "height": 60}]
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200, json=rectangle_only, request=request
                    )
                }
            )
        ).get_ocr("cap")

    too_few_points = _ocr_projection()
    too_few_page = too_few_points["pages"][0]
    assert isinstance(too_few_page, dict)
    too_few_boxes = too_few_page["boxes"]
    assert isinstance(too_few_boxes, list) and isinstance(too_few_boxes[0], dict)
    too_few_boxes[0]["polygon"] = too_few_boxes[0]["polygon"][:3]
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200, json=too_few_points, request=request
                    )
                }
            )
        ).get_ocr("cap")

    non_finite_point = _ocr_projection()
    non_finite_page = non_finite_point["pages"][0]
    assert isinstance(non_finite_page, dict)
    non_finite_boxes = non_finite_page["boxes"]
    assert isinstance(non_finite_boxes, list) and isinstance(non_finite_boxes[0], dict)
    non_finite_boxes[0]["polygon"][0]["x"] = float("nan")
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200,
                        content=json.dumps(non_finite_point, allow_nan=True).encode("utf-8"),
                        request=request,
                    )
                }
            )
        ).get_ocr("cap")

    completed_without_page_provenance = _ocr_projection()
    page = completed_without_page_provenance["pages"][0]
    assert isinstance(page, dict)
    del page["provenance"]
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200,
                        json=completed_without_page_provenance,
                        request=request,
                    )
                }
            )
        ).get_ocr("cap")

    completed_without_recognized_text = _ocr_projection()
    page = completed_without_recognized_text["pages"][0]
    assert isinstance(page, dict)
    page.update(
        {
            "status": "empty",
            "text": "",
            "boxes": [],
            "confidence": None,
            "provenance": None,
        }
    )
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200,
                        json=completed_without_recognized_text,
                        request=request,
                    )
                }
            )
        ).get_ocr("cap")

    missing_pages = _ocr_projection()
    del missing_pages["pages"]
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200, json=missing_pages, request=request
                    )
                }
            )
        ).get_ocr("cap")

    completed_with_failure = _ocr_projection()
    completed_with_failure["failure"] = {
        "code": "ocr_unavailable",
        "message": "OCR failed.",
    }
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(
            transport=_transport(
                {
                    ("GET", "/v2/captures/cap/ocr"): lambda request: httpx.Response(
                        200, json=completed_with_failure, request=request
                    )
                }
            )
        ).get_ocr("cap")


def test_shared_perspective_corpus_has_python_parity_with_rectangle_nan_and_bounds_rejections() -> (
    None
):
    payload = _shared_perspective_payload()
    parsed = CaptureOcrProjection.model_validate(payload)
    assert [(point.x, point.y) for point in parsed.pages[0].boxes[0].polygon] == [
        (11.25, 20.5),
        (91.75, 18.0),
        (104.0, 61.25),
        (4.5, 64.0),
    ]

    rectangle = deepcopy(payload)
    rectangle["pages"][0]["boxes"] = [{"x": 4, "y": 18, "width": 100, "height": 46}]
    with pytest.raises(ValidationError):
        CaptureOcrProjection.model_validate(rectangle)

    non_finite = deepcopy(payload)
    non_finite["pages"][0]["boxes"][0]["polygon"][0]["x"] = float("nan")
    with pytest.raises(ValidationError):
        CaptureOcrProjection.model_validate(non_finite)

    out_of_bounds = deepcopy(payload)
    out_of_bounds["pages"][0]["boxes"][0]["polygon"][0]["x"] = 121
    with pytest.raises(ValidationError):
        CaptureOcrProjection.model_validate(out_of_bounds)


def test_shared_referenced_invalid_corpus_has_python_parity_with_typescript_and_java() -> None:
    corpus = _shared_referenced_invalid_corpus()
    assert len(corpus) == 12
    for invalid in corpus:
        base = (
            _shared_perspective_payload()
            if invalid["base"] == "completed"
            else _ocr_projection(status="failed")
        )
        _apply_referenced_invalid_mutation(base, invalid)
        with pytest.raises(ValidationError):
            CaptureOcrProjection.model_validate(base)


def test_loopback_validation_rejects_remote_or_credentials() -> None:
    assert validate_loopback_base_url(43123) == "http://127.0.0.1:43123"
    with pytest.raises(CaptureRuntimeError):
        validate_loopback_base_url("https://example.test:43123")
    with pytest.raises(CaptureRuntimeError):
        validate_loopback_base_url("http://localhost:43123")


def test_discovery_rejects_unknown_contract_set_hash() -> None:
    bundle = b'{"contractSetVersion":"2","schemas":[],"operations":[]}'
    digest = hashlib.sha256(bundle).hexdigest()
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.2",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": f"/meta/v2/contracts/sha256/{digest}",
    }
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(), request=request
            ),
            ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
                200, json=index, request=request
            ),
            ("GET", index["href"]): lambda request: httpx.Response(
                200, content=bundle, request=request
            ),
        }
    )
    with pytest.raises(CaptureRuntimeCompatibilityError, match="allowlisted"):
        CaptureRuntimeClient(transport=transport).discover()


def test_discovery_rejects_wrong_content_addressed_href() -> None:
    digest = "a" * 64
    index = {
        "catalogVersion": "2",
        "runtimeVersion": "0.4.2",
        "contractSetVersion": "2",
        "surfaces": [{"id": "v2"}],
        "sha256": digest,
        "href": f"/meta/v2/contracts/sha256/{'b' * 64}",
    }
    transport = InMemoryRuntimeTransport(
        {
            ("GET", "/v2/health/ready"): lambda request: httpx.Response(
                200, json=_ready(), request=request
            ),
            ("GET", "/meta/v2/contracts"): lambda request: httpx.Response(
                200, json=index, request=request
            ),
        }
    )
    with pytest.raises(CaptureRuntimeCompatibilityError, match="href digest"):
        CaptureRuntimeClient(transport=transport, allowed_contract_set_sha256=[digest]).discover()


def test_error_taxonomy_preserves_remote_diagnostics() -> None:
    response = httpx.Response(
        409,
        json={
            "error": {
                "code": "new_problem",
                "message": "conflict",
                "details": {
                    "category": "conflict",
                    "retryable": True,
                    "issues": [{"location": ["id"], "message": "duplicate"}],
                    "requestId": "body-request",
                },
            }
        },
        headers={"X-Request-ID": "header-request"},
    )
    with pytest.raises(CaptureRemoteError) as caught:
        CaptureRuntimeClient(transport=_transport({})).get_capture("x")
    assert caught.value.status_code == 404

    with pytest.raises(CaptureRemoteError) as mapped:
        from capture_runtime_client.codec import decode_json

        decode_json(response)
    assert mapped.value.code == "new_problem"
    assert mapped.value.category == "conflict"
    assert mapped.value.retryable is True
    assert mapped.value.request_id == "header-request"
    assert mapped.value.issues[0]["message"] == "duplicate"

    unauthorized = httpx.Response(
        401,
        json={"error": {"code": "unauthorized", "message": "Bearer secret"}},
    )
    with pytest.raises(CaptureAuthenticationError):
        decode_json(unauthorized)


def test_malformed_json_and_sse_resume_are_protocol_safe() -> None:
    from capture_runtime_client.codec import decode_json

    with pytest.raises(CaptureProtocolError):
        decode_json(httpx.Response(200, content=b"not-json"))
    event = {
        "protocolVersion": "2",
        "eventId": "e1",
        "sequence": 2,
        "captureId": "cap",
        "kind": "audio",
        "eventType": "completed",
        "stage": "completed",
        "createdAt": "2026-01-01T00:00:00+00:00",
    }
    stream = f"id: 2\ndata: {json.dumps(event)}\n\n".encode()
    transport = _transport(
        {
            ("GET", "/v2/captures/cap/events"): lambda request: httpx.Response(
                200,
                content=stream,
                headers={"Content-Type": "text/event-stream"},
                request=request,
            )
        }
    )
    result = list(CaptureRuntimeClient(transport=transport).capture_events("cap", last_event_id=1))
    assert result[0].sequence == 2


def test_model_installation_operations_and_failure_idempotency_header() -> None:
    captured_headers: dict[str, str] = {}
    model_installation = {
        "installationId": "model-1",
        "optionId": "option-1",
        "status": "running",
        "progress": 0.5,
        "createdAt": "2026-01-01T00:00:00+00:00",
        "updatedAt": "2026-01-01T00:00:00+00:00",
    }
    job = {
        "protocolVersion": "2",
        "captureId": "cap",
        "ingestionId": "ingestion-1",
        "status": "failed",
        "progress": 1,
        "partialRevision": 0,
        "lastEventSequence": 1,
        "createdAt": "2026-01-01T00:00:00+00:00",
        "updatedAt": "2026-01-01T00:00:00+00:00",
        "completedAt": "2026-01-01T00:00:00+00:00",
    }

    def report(request: httpx.Request) -> httpx.Response:
        captured_headers.update(dict(request.headers))
        return httpx.Response(200, json=job, request=request)

    transport = _transport(
        {
            ("GET", "/v2/runtime/model-installations/model-1"): lambda request: httpx.Response(
                200, json=model_installation, request=request
            ),
            ("POST", "/v2/runtime/model-installations/model-1/cancel"): lambda request: (
                httpx.Response(
                    200,
                    json={**model_installation, "status": "cancelled"},
                    request=request,
                )
            ),
            ("POST", "/v2/captures/cap/structure/failure"): report,
        }
    )
    client = CaptureRuntimeClient(transport=transport)
    assert client.get_model_installation("model-1").status.value == "running"
    assert client.get_model_installation_status("model-1").status.value == "running"
    assert client.cancel_model_installation("model-1").status.value == "cancelled"
    client.report_structuring_failure(
        "cap", code="invalid", message="unable to structure", idempotency_key="failure-1"
    )
    assert captured_headers["x-idempotency-key"] == "failure-1"


def test_public_python_sdk_is_v2_only_and_hides_generated_wire_module() -> None:
    import capture_runtime_client as sdk
    import capture_runtime_client.contracts as contracts

    generated_suffixes = ("V" + "1", "V" + "2")
    assert not any(name.endswith(generated_suffixes) for name in sdk.__all__)
    assert "generated_models" not in sdk.__dict__
    source_root = Path(__file__).parents[1] / "src" / "capture_runtime_client"
    for path in source_root.glob("*.py"):
        if path.name in {"contracts.py", "__init__.py"}:
            continue
        assert "/v" + "1/" not in path.read_text(encoding="utf-8")
    assert all(not name.endswith(generated_suffixes) for name in contracts.__all__)


def test_retry_policy_retries_idempotent_requests_only() -> None:
    attempts = 0

    def ready(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(
                503,
                json={"error": {"code": "busy", "message": "retry"}},
                request=request,
            )
        return httpx.Response(200, json=_ready(), request=request)

    transport = InMemoryRuntimeTransport({("GET", "/v2/health/ready"): ready})
    result = CaptureRuntimeClient(transport=transport, max_retries=1).handshake()
    assert result.ready is True
    assert attempts == 2

    post_attempts = 0

    def non_idempotent(request: httpx.Request) -> httpx.Response:
        nonlocal post_attempts
        post_attempts += 1
        return httpx.Response(
            503,
            json={"error": {"code": "busy", "message": "retry"}},
            request=request,
        )

    transport = _transport({("POST", "/v2/captures/cap/cancel"): non_idempotent})
    with pytest.raises(CaptureRemoteError):
        CaptureRuntimeClient(transport=transport, max_retries=2).cancel_capture("cap")
    assert post_attempts == 1

    keyed_attempts = 0

    def keyed(request: httpx.Request) -> httpx.Response:
        nonlocal keyed_attempts
        keyed_attempts += 1
        if keyed_attempts == 1:
            return httpx.Response(
                503,
                json={"error": {"code": "busy", "message": "retry"}},
                request=request,
            )
        return httpx.Response(
            200,
            json={
                "protocolVersion": "2",
                "captureId": "cap",
                "ingestionId": "ingestion",
                "status": "failed",
                "partialRevision": 0,
                "lastEventSequence": 0,
                "createdAt": "2026-01-01T00:00:00+00:00",
                "updatedAt": "2026-01-01T00:00:00+00:00",
                "completedAt": "2026-01-01T00:00:00+00:00",
            },
            request=request,
        )

    transport = _transport({("POST", "/v2/captures/cap/structure/failure"): keyed})
    CaptureRuntimeClient(transport=transport, max_retries=1).report_structuring_failure(
        "cap", code="failed", message="failed", idempotency_key="request-1"
    )
    assert keyed_attempts == 2


def test_sse_reconnects_with_last_event_id_cursor() -> None:
    calls: list[dict[str, str]] = []
    events = [
        {
            "protocolVersion": "2",
            "eventId": "e1",
            "sequence": 1,
            "captureId": "cap",
            "kind": "audio",
            "eventType": "checkpoint",
            "stage": "extracting",
            "partialRevision": 1,
            "createdAt": "2026-01-01T00:00:00+00:00",
        },
        {
            "protocolVersion": "2",
            "eventId": "e2",
            "sequence": 2,
            "captureId": "cap",
            "kind": "audio",
            "eventType": "completed",
            "stage": "completed",
            "partialRevision": 1,
            "createdAt": "2026-01-01T00:00:01+00:00",
        },
    ]

    class ResumeTransport(InMemoryRuntimeTransport):
        def __init__(self) -> None:
            super().__init__(_discovery_routes())

        def stream(self, method: str, path: str, **kwargs: object) -> object:
            headers = {
                str(key): str(value) for key, value in dict(kwargs.get("headers", {})).items()
            }
            calls.append(headers)
            index = len(calls) - 1

            @contextmanager
            def response() -> object:
                payload = events[index]
                stream = f"id: {payload['sequence']}\ndata: {json.dumps(payload)}\n\n".encode()
                yield httpx.Response(
                    200,
                    content=stream,
                    headers={"Content-Type": "text/event-stream"},
                )

            return response()

    transport = ResumeTransport()
    result = list(CaptureRuntimeClient(transport=transport).capture_events("cap"))
    assert [event.sequence for event in result] == [1, 2]
    assert calls[0].get("Last-Event-ID") is None
    assert calls[1].get("Last-Event-ID") == "1"


def test_pull_session_methods_use_routes_and_matching_idempotency() -> None:
    session = {
        "protocolVersion": "2",
        "sessionId": "session-1",
        "captureId": "cap",
        "rawSourceSha256": "a" * 64,
        "contractSetSha256": CAPTURE_CONTRACT_SET_SHA256,
        "providerCapability": {
            "provider": {"engine": "ollama", "model": "model-1", "digest": "sha256:" + "b" * 64},
            "capability": "capture-structuring",
            "schemaDialect": "https://json-schema.org/draft/2020-12/schema",
        },
        "schemaDialect": "https://json-schema.org/draft/2020-12/schema",
        "batchCount": 1,
        "nextBatchIndex": 0,
        "sessionDigest": "c" * 64,
        "status": "open",
        "createdAt": "2026-01-01T00:00:00+00:00",
        "updatedAt": "2026-01-01T00:00:00+00:00",
        "completedAt": None,
    }
    batch = {
        "protocolVersion": "2",
        "sessionId": "session-1",
        "captureId": "cap",
        "batchIndex": 0,
        "batchCount": 1,
        "sourceSegmentIds": ["segment-1"],
        "providerPrompt": {"rawSegments": []},
        "providerSchema": {"type": "object"},
        "numCtx": 2048,
        "numPredict": 256,
        "batchDigest": "d" * 64,
        "status": "ready",
    }
    seen: dict[str, str] = {}

    def open_route(request: httpx.Request) -> httpx.Response:
        seen["open-key"] = request.headers["x-idempotency-key"]
        return httpx.Response(201, json=session, request=request)

    def submit_route(request: httpx.Request) -> httpx.Response:
        seen["submit-key"] = request.headers["x-idempotency-key"]
        return httpx.Response(
            200,
            json={
                **session,
                "status": "completed",
                "nextBatchIndex": 1,
                "completedAt": "2026-01-01T00:00:01+00:00",
            },
            request=request,
        )

    transport = _transport(
        {
            ("POST", "/v2/captures/cap/structure/session"): open_route,
            ("GET", "/v2/captures/cap/structure/session"): lambda request: httpx.Response(
                200, json=session, request=request
            ),
            ("GET", "/v2/captures/cap/structure/session/batches/0"): lambda request: httpx.Response(
                200, json=batch, request=request
            ),
            ("PUT", "/v2/captures/cap/structure/session/batches/0"): submit_route,
        }
    )
    client = CaptureRuntimeClient(transport=transport)
    request = {
        "captureId": "cap",
        "providerCapability": session["providerCapability"],
        "schemaDialect": session["schemaDialect"],
        "clientRequestId": "session-key",
    }
    assert client.open_structuring_session("cap", request).session_id == "session-1"
    assert client.open_structuring_session("cap", request).session_id == "session-1"
    assert client.get_structuring_session("cap").session_id == "session-1"
    assert client.pull_structuring_batch("cap", 0).batch_digest == batch["batchDigest"]
    client.submit_structuring_batch(
        "cap",
        0,
        {
            "batchDigest": batch["batchDigest"],
            "blocks": [{"sourceSegmentId": "segment-1", "type": "paragraph"}],
        },
        idempotency_key="batch-key",
    )
    client.submit_structuring_batch(
        "cap",
        0,
        {
            "batchDigest": batch["batchDigest"],
            "blocks": [{"sourceSegmentId": "segment-1", "type": "paragraph"}],
        },
        idempotency_key="batch-key",
    )
    assert seen == {"open-key": "session-key", "submit-key": "batch-key"}
    with pytest.raises(CaptureProtocolError):
        client.open_structuring_session("other", request)
    with pytest.raises(CaptureProtocolError):
        client.open_structuring_session("cap", request, idempotency_key="")


def test_pull_session_rejects_extra_semantic_fields_and_maps_conflict() -> None:
    def conflict(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            409,
            json={"error": {"code": "idempotency_conflict", "message": "same key"}},
            request=request,
        )

    transport = _transport({("PUT", "/v2/captures/cap/structure/session/batches/0"): conflict})
    client = CaptureRuntimeClient(transport=transport)
    with pytest.raises(CaptureProtocolError):
        client.submit_structuring_batch(
            "cap",
            0,
            {
                "batchDigest": "e" * 64,
                "blocks": [
                    {
                        "sourceSegmentId": "segment-1",
                        "type": "paragraph",
                        "sourceText": "must-not-cross-the-wire",
                    }
                ],
            },
            idempotency_key="batch-key",
        )
    with pytest.raises(CaptureRemoteError, match="idempotency_conflict"):
        client.submit_structuring_batch(
            "cap",
            0,
            {
                "batchDigest": "e" * 64,
                "blocks": [{"sourceSegmentId": "segment-1", "type": "paragraph"}],
            },
            idempotency_key="batch-key",
        )


def test_pull_session_rejects_extra_response_fields() -> None:
    batch = {
        "protocolVersion": "2",
        "sessionId": "session-1",
        "captureId": "cap",
        "batchIndex": 0,
        "batchCount": 1,
        "sourceSegmentIds": ["segment-1"],
        "providerPrompt": {},
        "providerSchema": {},
        "numCtx": 1,
        "numPredict": 1,
        "batchDigest": "e" * 64,
        "status": "ready",
        "unexpected": True,
    }
    transport = _transport(
        {
            ("GET", "/v2/captures/cap/structure/session/batches/0"): lambda request: httpx.Response(
                200, json=batch, request=request
            )
        }
    )
    with pytest.raises(CaptureProtocolError):
        CaptureRuntimeClient(transport=transport).get_structuring_batch("cap", 0)
