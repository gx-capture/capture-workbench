from __future__ import annotations

import hashlib
import json

from conftest import TOKEN
from fastapi.testclient import TestClient


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


def test_streaming_capability_is_strictly_advertised(client: TestClient) -> None:
    response = client.get("/v2/health/ready")

    assert response.status_code == 200
    assert response.json() == {
        "protocolVersion": "2",
        "supportsProgressiveAudio": True,
        "maxChunkBytes": 4 * 1024 * 1024,
        "checkpointIntervalMs": 300_000,
        "heartbeatIntervalMs": 5_000,
        "stallTimeoutMs": 90_000,
    }


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

    capture = client.get(f"/v2/captures/{capture_id}")
    assert capture.status_code == 200
    assert capture.json()["status"] == "extracting"
    assert capture.json()["source"]["sha256"] == source_sha256

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200
    assert events.headers["content-type"].startswith("text/event-stream")
    assert [line for line in events.text.splitlines() if line.startswith("id: ")] == [
        "id: 1",
        "id: 2",
        "id: 3",
        "id: 4",
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
    ]

    partial = client.get(f"/v2/captures/{capture_id}/partial")
    assert partial.status_code == 409
    assert partial.json()["error"]["code"] == "partial_unavailable"


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
