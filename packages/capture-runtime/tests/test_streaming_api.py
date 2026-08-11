from __future__ import annotations

import hashlib
import json
import time

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient


def _source() -> bytes:
    return b"ID3def"


def _open(client: TestClient) -> tuple[str, str]:
    source = _source()
    response = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": "api-stream-open-1",
            "kind": "audio",
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
        "captureKinds": ["pdf", "image", "audio"],
        "maxChunkBytes": 4 * 1024 * 1024,
        "checkpointIntervalMs": 300_000,
        "heartbeatIntervalMs": 5_000,
        "stallTimeoutMs": 90_000,
    }


def test_streaming_capability_fails_closed_without_progressive_decoder(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setattr("capture_runtime.routes.streaming.progressive_decoder_ready", lambda: False)

    response = client.get("/v2/health/ready")

    assert response.status_code == 200
    assert response.json()["captureKinds"] == ["pdf", "image"]
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

    first = b"ID3"
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
    assert capture.json()["status"] in {"extracting", "awaiting_structuring"}
    assert capture.json()["source"]["sha256"] == source_sha256

    cancelled = client.post(f"/v2/captures/{capture_id}/cancel")
    assert cancelled.status_code == 200
    assert cancelled.json()["status"] == "cancelled"

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200
    assert events.headers["content-type"].startswith("text/event-stream")
    ids = [
        int(line.removeprefix("id: "))
        for line in events.text.splitlines()
        if line.startswith("id: ")
    ]
    assert ids == sorted(ids)
    assert ids == list(range(1, len(ids) + 1))
    assert "event: accepted" in events.text
    assert "event: cancelled" in events.text
    assert TOKEN not in events.text

    replay = client.get(
        f"/v2/captures/{capture_id}/events",
        headers={"Last-Event-ID": "2"},
    )
    replay_ids = [
        int(line.removeprefix("id: "))
        for line in replay.text.splitlines()
        if line.startswith("id: ")
    ]
    assert replay_ids == ids[2:]


@pytest.mark.parametrize(
    "kind,media_type,file_name",
    [("pdf", "application/pdf", "sample.pdf"), ("image", "image/png", "sample.png")],
)
def test_streaming_api_accepts_non_audio_ingestion_kinds(
    client: TestClient, kind: str, media_type: str, file_name: str
) -> None:
    response = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": f"api-stream-open-{kind}",
            "kind": kind,
            "fileName": file_name,
            "mediaType": media_type,
            "totalBytes": 6,
            "sourceSha256": hashlib.sha256(b"abcdef").hexdigest(),
        },
    )

    assert response.status_code == 201, response.text
    assert response.json()["kind"] == kind


@pytest.mark.parametrize(
    "kind,media_type,file_name,source",
    [
        ("pdf", "application/pdf", "sample.pdf", b"%PDF-CAPTURE_TEXT:pdf page"),
        (
            "image",
            "image/png",
            "sample.png",
            b"\x89PNG\r\n\x1a\nCAPTURE_TEXT:image page",
        ),
        ("audio", "audio/mpeg", "sample.mp3", b"ID3CAPTURE_TEXT:audio line"),
    ],
)
def test_streaming_api_runs_one_lifecycle_for_every_capture_kind(
    client: TestClient,
    kind: str,
    media_type: str,
    file_name: str,
    source: bytes,
) -> None:
    digest = hashlib.sha256(source).hexdigest()
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": f"api-stream-all-kinds-{kind}",
            "kind": kind,
            "fileName": file_name,
            "mediaType": media_type,
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
            "X-Idempotency-Key": f"api-stream-all-kinds-chunk-{kind}",
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
            "clientRequestId": f"api-stream-all-kinds-capture-{kind}",
            "ingestionId": ingestion_id,
            "structuringMode": "runtime",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]
    events = client.get(f"/v2/captures/{capture_id}/events")

    assert events.status_code == 200
    assert f'"kind":"{kind}"' in events.text
    assert "event: accepted" in events.text
    assert "event: completed" in events.text
    assert client.get(f"/v2/captures/{capture_id}/result").status_code == 200


def test_streaming_api_commits_host_structuring_idempotently(client: TestClient) -> None:
    source = b"\x89PNG\r\n\x1a\nCAPTURE_TEXT:host page"
    digest = hashlib.sha256(source).hexdigest()
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": "api-stream-host-open",
            "kind": "image",
            "fileName": "host.png",
            "mediaType": "image/png",
            "totalBytes": len(source),
            "sourceSha256": digest,
        },
    )
    ingestion_id = opened.json()["ingestionId"]
    uploaded = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=source,
        headers={
            "Content-Range": f"bytes 0-{len(source) - 1}/{len(source)}",
            "Digest": f"sha-256={digest}",
            "X-Idempotency-Key": "api-stream-host-chunk",
        },
    )
    assert uploaded.status_code == 200
    assert (
        client.post(
            f"/v2/ingestions/{ingestion_id}/finalize",
            json={"totalBytes": len(source), "sha256": digest},
        ).status_code
        == 200
    )
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-host-capture",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
    )
    capture_id = started.json()["captureId"]

    partial: dict[str, object] = {}
    for _ in range(100):
        response = client.get(f"/v2/captures/{capture_id}/partial")
        if response.status_code == 200:
            partial = response.json()
            break
        time.sleep(0.01)
    assert partial
    segments = partial["segments"]
    blocks = [
        {
            "blockId": f"block-{index + 1}",
            "order": index,
            "type": "paragraph",
            "sourceSegmentId": segment["segmentId"],
            "locator": segment["locator"],
            "sourceText": segment["text"],
            "targetText": segment["text"],
        }
        for index, segment in enumerate(segments)
    ]
    candidate = {
        "source": partial["source"],
        "rawSegments": segments,
        "blocks": blocks,
        "sourceText": partial["sourceText"],
        "targetText": partial["sourceText"],
        "extractionEngine": partial["extractionEngine"],
        "structuringEngine": {
            "engine": "host-structurer",
            "model": "test",
            "digest": "sha256:" + "1" * 64,
            "device": "host",
        },
        "warnings": [],
        "createdAt": partial["updatedAt"],
        "completedAt": partial["updatedAt"],
    }
    headers = {"X-Idempotency-Key": "api-stream-host-commit"}
    committed = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        json=candidate,
        headers=headers,
    )
    assert committed.status_code == 200, committed.text
    assert committed.json()["status"] == "completed"
    retried = client.post(
        f"/v2/captures/{capture_id}/structure/commit",
        json=candidate,
        headers=headers,
    )
    assert retried.status_code == 200, retried.text
    assert retried.json()["captureId"] == capture_id

    events = client.get(f"/v2/captures/{capture_id}/events")
    assert "event: completed" in events.text


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
