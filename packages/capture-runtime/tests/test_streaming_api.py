from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from conftest import TOKEN
from fastapi.testclient import TestClient

from capture_runtime.contracts import (
    CaptureBlockV1,
    CaptureDocumentV1,
    CaptureEngineV1,
    OpenIngestionV2,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StartCaptureV2,
    StructuringMode,
    TimeLocatorV1,
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
    segment = RawCaptureSegmentV1(
        segment_id="segment-1",
        order=0,
        locator=TimeLocatorV1(start_ms=0, end_ms=1_000),
        text="host words",
    )
    extraction_engine = CaptureEngineV1(
        engine="whisper-primary",
        model="test-model",
        digest=f"sha256:{'a' * 64}",
        device="cpu",
    )
    raw = RawCaptureV1(
        source=operation.source,
        segments=[segment],
        source_text=segment.text,
        extraction_engine=extraction_engine,
        created_at=created_at,
    )
    repository.write_raw(operation.capture_id, raw)
    repository.mark_awaiting_structuring(operation.capture_id)
    structuring_engine = CaptureEngineV1(
        engine="host-provider",
        model="test-model",
        digest=f"sha256:{'b' * 64}",
    )
    candidate = CaptureDocumentV1(
        source=raw.source,
        raw_segments=raw.segments,
        blocks=[
            CaptureBlockV1(
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


def test_streaming_capability_is_strictly_advertised(client: TestClient) -> None:
    response = client.get("/v2/health/ready")

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

    response = client.get("/v2/health/ready")

    assert response.status_code == 200
    assert response.json()["captureKinds"] == ["pdf", "image", "audio"]
    assert response.json()["supportsProgressiveAudio"] is False


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


def test_v2_host_commit_and_failure_routes_preserve_v1_terminal_semantics(
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
