from __future__ import annotations

import asyncio
import hashlib
import json
import time
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from conftest import TOKEN
from fastapi import APIRouter
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.contracts import (
    CaptureEngineV1,
    CaptureEventV2,
    CaptureOperationV2,
    CaptureSourceKind,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StreamingCaptureStatus,
    StreamingEventType,
    TimeLocatorV1,
)
from capture_runtime.routes.streaming import register_streaming_routes
from capture_runtime.storage import StreamingEventOverflow, StreamingSubscriptionClosed


def _source() -> bytes:
    return b"ID3def"


class AdvancingClock:
    def __init__(self) -> None:
        self.current = datetime(2026, 8, 13, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        current = self.current
        self.current += timedelta(microseconds=1)
        return current


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


def test_streaming_api_rejects_ingestion_above_configured_upload_limit(settings_factory) -> None:
    settings = settings_factory(CAPTURE_MAX_UPLOAD_BYTES="5")
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as limited_client:
        response = limited_client.post(
            "/v2/ingestions",
            json={
                "clientRequestId": "api-upload-limit",
                "kind": "pdf",
                "fileName": "large.pdf",
                "mediaType": "application/pdf",
                "totalBytes": 6,
            },
        )

    assert response.status_code == 413
    assert response.json()["error"]["code"] == "upload_too_large"


def test_streaming_api_maps_finalize_upload_limit_to_413_after_limit_reload(
    settings_factory,
) -> None:
    source = _source()
    settings = settings_factory(CAPTURE_MAX_UPLOAD_BYTES=str(len(source)))
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as limited_client:
        opened = limited_client.post(
            "/v2/ingestions",
            json={
                "clientRequestId": "api-finalize-upload-limit",
                "kind": "audio",
                "fileName": "sample.mp3",
                "mediaType": "audio/mpeg",
                "totalBytes": len(source),
            },
        )
        assert opened.status_code == 201, opened.text
        ingestion_id = opened.json()["ingestionId"]
        uploaded = limited_client.put(
            f"/v2/ingestions/{ingestion_id}/chunks/0",
            content=source,
            headers={
                "Content-Range": f"bytes 0-{len(source) - 1}/{len(source)}",
                "Digest": f"sha-256={hashlib.sha256(source).hexdigest()}",
                "X-Idempotency-Key": "api-finalize-upload-limit-chunk",
            },
        )
        assert uploaded.status_code == 200, uploaded.text

        # Simulate a runtime restart with a lower configured ceiling after the
        # upload was accepted. Finalize must retain the same 413 contract as
        # open and append instead of leaking the transition superclass.
        limited_client.app.state.streaming_repository.max_upload_bytes = len(source) - 1
        finalized = limited_client.post(
            f"/v2/ingestions/{ingestion_id}/finalize",
            json={
                "totalBytes": len(source),
                "sha256": hashlib.sha256(source).hexdigest(),
            },
        )

    assert finalized.status_code == 413
    assert finalized.json()["error"]["code"] == "upload_too_large"


def test_streaming_api_finds_ingestion_by_client_request_id_for_lost_open_response_recovery(
    client: TestClient,
) -> None:
    source = _source()
    client_request_id = "api-stream-ingestion-recovery-lookup"
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": client_request_id,
            "kind": "audio",
            "fileName": "sample.mp3",
            "mediaType": "audio/mpeg",
            "totalBytes": len(source),
            "sourceSha256": hashlib.sha256(source).hexdigest(),
        },
    )
    assert opened.status_code == 201, opened.text
    ingestion_id = opened.json()["ingestionId"]

    recovered = client.get(
        "/v2/ingestions/by-client-request/" + client_request_id,
    )

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["ingestionId"] == ingestion_id
    assert client.get("/v2/ingestions/by-client-request/missing-request").status_code == 404


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


def test_streaming_api_rejects_deleting_an_active_capture(client: TestClient) -> None:
    ingestion_id, _ = _open(client)
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-active-delete",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]

    deleted = client.delete(f"/v2/captures/{capture_id}")

    assert deleted.status_code == 409
    assert deleted.json()["error"]["code"] == "capture_delete_rejected"
    assert client.get(f"/v2/captures/{capture_id}").status_code == 200
    assert client.get(f"/v2/ingestions/{ingestion_id}").status_code == 200


def test_streaming_api_finds_capture_by_client_request_id_for_lost_response_recovery(
    client: TestClient,
) -> None:
    ingestion_id, _ = _open(client)
    client_request_id = "api-stream-recovery-lookup"
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": client_request_id,
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]

    recovered = client.get(
        "/v2/captures/by-client-request/" + client_request_id,
    )

    assert recovered.status_code == 200, recovered.text
    assert recovered.json()["captureId"] == capture_id
    assert client.get("/v2/captures/by-client-request/missing-request").status_code == 404


def test_streaming_api_cascades_terminal_capture_cleanup_to_unreferenced_ingestion(
    client: TestClient,
) -> None:
    ingestion_id, _ = _open(client)
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-cascade-delete",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]
    cancelled = client.post(f"/v2/captures/{capture_id}/cancel")
    assert cancelled.status_code == 200, cancelled.text

    deleted = client.delete(f"/v2/captures/{capture_id}")

    assert deleted.status_code == 204
    assert client.get(f"/v2/captures/{capture_id}").status_code == 404
    assert client.get(f"/v2/ingestions/{ingestion_id}").status_code == 404


def test_streaming_api_closes_replay_after_event_window_resync(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        "capture_runtime.storage.streaming_repository._MAX_EVENT_REPLAY",
        1,
    )
    ingestion_id, _ = _open(client)
    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-resync-capture",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]
    cancelled = client.post(f"/v2/captures/{capture_id}/cancel")
    assert cancelled.status_code == 200, cancelled.text

    replay = client.get(
        f"/v2/captures/{capture_id}/events",
        headers={"Last-Event-ID": "0"},
    )

    assert replay.status_code == 200
    assert replay.text.endswith("\n\n")
    assert "event: resync_required" in replay.text
    assert "event: accepted" not in replay.text
    resync_payload = json.loads(
        next(
            line.removeprefix("data: ")
            for line in replay.text.splitlines()
            if line.startswith("data: ")
        )
    )
    assert resync_payload["eventId"] == f"{capture_id}/{resync_payload['sequence']}"


def test_streaming_api_closes_when_terminal_cursor_has_no_replay() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    operation = CaptureOperationV2(
        capture_id="capture-terminal-cursor",
        ingestion_id="ingestion-terminal-cursor",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.CANCELLED,
        progress=0.5,
        partial_revision=0,
        last_event_sequence=3,
        created_at=now,
        updated_at=now,
        completed_at=now,
    )

    class EmptyTerminalSubscription:
        replay = []
        closed = False

        def get(self, _timeout: float) -> StreamingEventOverflow:
            raise AssertionError("terminal replay must not enter the heartbeat loop")

        def close(self) -> None:
            self.closed = True

    subscription = EmptyTerminalSubscription()
    service = SimpleNamespace(
        get_capture=lambda _capture_id: operation,
        subscribe_events=lambda _capture_id, *, after_sequence: subscription,
    )
    router = APIRouter()
    register_streaming_routes(
        router,
        SimpleNamespace(streaming_capture_service=service),
    )
    endpoint = next(
        route.endpoint for route in router.routes if route.path == "/captures/{capture_id}/events"
    )

    async def collect() -> str:
        response = await endpoint("capture-terminal-cursor", "3")
        return "".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(collect()) == ""
    assert subscription.closed


def test_streaming_api_refreshes_terminal_status_after_subscribe_to_avoid_empty_heartbeat() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    active = CaptureOperationV2(
        capture_id="capture-terminal-race",
        ingestion_id="ingestion-terminal-race",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.EXTRACTING,
        progress=0.5,
        partial_revision=0,
        last_event_sequence=3,
        created_at=now,
        updated_at=now,
    )
    terminal = active.model_copy(
        update={
            "status": StreamingCaptureStatus.CANCELLED,
            "updated_at": now,
            "completed_at": now,
        }
    )
    snapshots = iter([active, terminal])

    class EmptySubscription:
        replay = []
        closed = False

        def get(self, _timeout: float) -> StreamingEventOverflow:
            raise AssertionError("terminal status must close before the heartbeat loop")

        def close(self) -> None:
            self.closed = True

    subscription = EmptySubscription()
    service = SimpleNamespace(
        get_capture=lambda _capture_id: next(snapshots),
        subscribe_events=lambda _capture_id, *, after_sequence: subscription,
    )
    router = APIRouter()
    register_streaming_routes(
        router,
        SimpleNamespace(streaming_capture_service=service),
    )
    endpoint = next(
        route.endpoint for route in router.routes if route.path == "/captures/{capture_id}/events"
    )

    async def collect() -> str:
        response = await endpoint("capture-terminal-race", "3")
        return "".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(collect()) == ""
    assert subscription.closed


def test_streaming_api_drains_terminal_event_queued_after_replay_snapshot() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    operation = CaptureOperationV2(
        capture_id="capture-terminal-after-replay",
        ingestion_id="ingestion-terminal-after-replay",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.COMPLETED,
        progress=1,
        partial_revision=0,
        last_event_sequence=4,
        created_at=now,
        updated_at=now,
        completed_at=now,
    )
    terminal_event = CaptureEventV2(
        event_id="capture-terminal-after-replay/4",
        sequence=4,
        capture_id="capture-terminal-after-replay",
        kind=CaptureSourceKind.IMAGE,
        event_type=StreamingEventType.COMPLETED,
        stage="completed",
        progress=1,
        created_at=now,
    )

    class LateTerminalSubscription:
        replay = []
        closed = False

        def get(self, _timeout: float) -> CaptureEventV2:
            return terminal_event

        def close(self) -> None:
            self.closed = True

    subscription = LateTerminalSubscription()
    service = SimpleNamespace(
        get_capture=lambda _capture_id: operation,
        subscribe_events=lambda _capture_id, *, after_sequence: subscription,
    )
    router = APIRouter()
    register_streaming_routes(
        router,
        SimpleNamespace(streaming_capture_service=service),
    )
    endpoint = next(
        route.endpoint for route in router.routes if route.path == "/captures/{capture_id}/events"
    )

    async def collect() -> str:
        response = await endpoint("capture-terminal-after-replay", "3")
        return "".join([chunk async for chunk in response.body_iterator])

    body = asyncio.run(collect())

    assert "event: completed" in body
    assert '"sequence":4' in body
    assert subscription.closed


def test_streaming_api_returns_when_a_terminal_event_arrives_behind_the_client_cursor() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    operation = CaptureOperationV2(
        capture_id="capture-terminal-behind-cursor",
        ingestion_id="ingestion-terminal-behind-cursor",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.EXTRACTING,
        progress=0.5,
        partial_revision=0,
        last_event_sequence=3,
        created_at=now,
        updated_at=now,
    )
    terminal_event = CaptureEventV2(
        event_id="capture-terminal-behind-cursor/3",
        sequence=3,
        capture_id="capture-terminal-behind-cursor",
        kind=CaptureSourceKind.IMAGE,
        event_type=StreamingEventType.COMPLETED,
        stage="completed",
        progress=1,
        created_at=now,
    )

    class LateTerminalSubscription:
        replay = []
        closed = False

        def get(self, _timeout: float) -> CaptureEventV2:
            return terminal_event

        def close(self) -> None:
            self.closed = True

    subscription = LateTerminalSubscription()
    service = SimpleNamespace(
        get_capture=lambda _capture_id: operation,
        subscribe_events=lambda _capture_id, *, after_sequence: subscription,
    )
    router = APIRouter()
    register_streaming_routes(
        router,
        SimpleNamespace(streaming_capture_service=service),
    )
    endpoint = next(
        route.endpoint for route in router.routes if route.path == "/captures/{capture_id}/events"
    )

    async def collect() -> str:
        response = await endpoint("capture-terminal-behind-cursor", "5")
        return "".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(collect()) == ""
    assert subscription.closed


def test_streaming_api_returns_when_subscription_close_wakes_the_queue_wait() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    operation = CaptureOperationV2(
        capture_id="capture-subscription-closed",
        ingestion_id="ingestion-subscription-closed",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.EXTRACTING,
        progress=0.5,
        partial_revision=0,
        last_event_sequence=3,
        created_at=now,
        updated_at=now,
    )

    class ClosedSubscription:
        replay = []
        closed = False

        def get(self, _timeout: float) -> StreamingSubscriptionClosed:
            return StreamingSubscriptionClosed()

        def close(self) -> None:
            self.closed = True

    subscription = ClosedSubscription()
    service = SimpleNamespace(
        get_capture=lambda _capture_id: operation,
        subscribe_events=lambda _capture_id, *, after_sequence: subscription,
    )
    router = APIRouter()
    register_streaming_routes(
        router,
        SimpleNamespace(streaming_capture_service=service),
    )
    endpoint = next(
        route.endpoint for route in router.routes if route.path == "/captures/{capture_id}/events"
    )

    async def collect() -> str:
        response = await endpoint("capture-subscription-closed", None)
        return "".join([chunk async for chunk in response.body_iterator])

    assert asyncio.run(collect()) == ""
    assert subscription.closed


def test_streaming_api_marks_a_live_subscriber_overflow_as_reconnectable_resync() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    operation = CaptureOperationV2(
        capture_id="capture-overflow",
        ingestion_id="ingestion-overflow",
        kind=CaptureSourceKind.IMAGE,
        status=StreamingCaptureStatus.EXTRACTING,
        progress=0.5,
        partial_revision=2,
        last_event_sequence=7,
        created_at=now,
        updated_at=now,
    )

    class OverflowSubscription:
        replay = []
        closed = False

        def get(self, _timeout: float) -> StreamingEventOverflow:
            return StreamingEventOverflow()

        def close(self) -> None:
            self.closed = True

    subscription = OverflowSubscription()
    service = SimpleNamespace(
        subscribe_events=lambda _capture_id, *, after_sequence: subscription,
        get_capture=lambda _capture_id: operation,
        events=lambda *_args, **_kwargs: pytest.fail(
            "queue overflow must not replay an ambiguous active event suffix"
        ),
    )
    router = APIRouter()
    register_streaming_routes(
        router,
        SimpleNamespace(streaming_capture_service=service),
    )
    endpoint = next(
        route.endpoint for route in router.routes if route.path == "/captures/{capture_id}/events"
    )

    async def collect() -> str:
        response = await endpoint("capture-overflow", None)
        return "".join([chunk async for chunk in response.body_iterator])

    body = asyncio.run(collect())

    assert "id: 7" in body
    assert "event: resync_required" in body
    assert "event: checkpoint" not in body
    assert body.endswith("\n\n")
    resync_payload = json.loads(
        next(line.removeprefix("data: ") for line in body.splitlines() if line.startswith("data: "))
    )
    assert resync_payload["eventId"] == "capture-overflow/7"
    assert subscription.closed


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


def test_streaming_api_fails_closed_when_source_content_kind_mismatches_declared_kind(
    client: TestClient,
) -> None:
    source = b"\x89PNG\r\n\x1a\nCAPTURE_TEXT:image page"
    digest = hashlib.sha256(source).hexdigest()
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": "api-stream-kind-mismatch",
            "kind": "pdf",
            "fileName": "mismatch.pdf",
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
            "X-Idempotency-Key": "api-stream-kind-mismatch-chunk",
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
            "clientRequestId": "api-stream-kind-mismatch-capture",
            "ingestionId": ingestion_id,
            "structuringMode": "runtime",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]

    operation: dict[str, object] = {}
    for _ in range(100):
        response = client.get(f"/v2/captures/{capture_id}")
        assert response.status_code == 200, response.text
        operation = response.json()
        if operation["status"] == "failed":
            break
        time.sleep(0.01)

    assert operation["status"] == "failed"
    assert operation["error"]["code"] == "source_kind_mismatch"
    assert operation["error"]["stage"] == "extraction"
    assert operation["error"]["retryable"] is False
    assert "does not match" in operation["error"]["message"]


def test_streaming_api_commits_host_structuring_idempotently(client: TestClient) -> None:
    clock = AdvancingClock()
    service = client.app.state.streaming_capture_service
    extractor = service._extractor
    assert extractor is not None
    service._clock = clock
    extractor._clock = clock

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
    raw = client.app.state.streaming_repository.read_raw(capture_id)
    assert partial["updatedAt"] == raw.model_dump(mode="json", by_alias=True)["createdAt"]
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


def test_streaming_api_sanitizes_host_failure_before_persistence_and_sse(
    client: TestClient,
) -> None:
    source = b"\x89PNG\r\n\x1a\nCAPTURE_TEXT:host failure"
    digest = hashlib.sha256(source).hexdigest()
    opened = client.post(
        "/v2/ingestions",
        json={
            "clientRequestId": "api-stream-host-failure-open",
            "kind": "image",
            "fileName": "host-failure.png",
            "mediaType": "image/png",
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
            "X-Idempotency-Key": "api-stream-host-failure-chunk",
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
            "clientRequestId": "api-stream-host-failure-capture",
            "ingestionId": ingestion_id,
            "structuringMode": "host",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]
    for _ in range(100):
        partial = client.get(f"/v2/captures/{capture_id}/partial")
        if partial.status_code == 200:
            break
        time.sleep(0.01)
    else:
        raise AssertionError("host capture did not reach awaiting structuring")

    secret = "captured_secret"
    failed = client.post(
        f"/v2/captures/{capture_id}/structure/failure",
        json={
            "code": f"access_token_{secret}",
            "message": f"Bearer {secret}",
        },
        headers={"X-Idempotency-Key": "api-stream-host-failure"},
    )
    assert failed.status_code == 200, failed.text
    assert failed.json()["error"] == {
        "code": "host_provider_failed",
        "message": "Host structuring failed.",
        "stage": "structuring",
        "retryable": False,
    }
    assert secret not in failed.text

    persisted = client.get(f"/v2/captures/{capture_id}")
    assert persisted.status_code == 200
    assert persisted.json()["error"] == failed.json()["error"]
    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200
    assert secret not in events.text
    assert '"code":"host_provider_failed"' in events.text
    assert '"message":"Host structuring failed."' in events.text


def test_streaming_api_terminalizes_direct_runtime_structuring_failure(
    client: TestClient,
) -> None:
    service = client.app.state.streaming_capture_service
    repository = client.app.state.streaming_repository
    service._extractor = None
    service._processor = None

    ingestion_id, source_sha256 = _open(client)
    uploaded = client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=_source(),
        headers={
            "Content-Range": "bytes 0-5/6",
            "Digest": f"sha-256={source_sha256}",
            "X-Idempotency-Key": "api-stream-direct-structure-chunk",
        },
    )
    assert uploaded.status_code == 200, uploaded.text
    finalized = client.post(
        f"/v2/ingestions/{ingestion_id}/finalize",
        json={"totalBytes": 6, "sha256": source_sha256},
    )
    assert finalized.status_code == 200, finalized.text

    started = client.post(
        "/v2/captures",
        json={
            "clientRequestId": "api-stream-direct-structure",
            "ingestionId": ingestion_id,
            "structuringMode": "runtime",
            "startPolicy": "eager",
        },
    )
    assert started.status_code == 202, started.text
    capture_id = started.json()["captureId"]
    operation = repository.get_capture(capture_id)
    repository.write_raw(
        capture_id,
        RawCaptureV1(
            source=operation.source,
            segments=[
                RawCaptureSegmentV1(
                    segment_id="direct-structure-segment",
                    order=0,
                    locator=TimeLocatorV1(start_ms=0, end_ms=1_000),
                    text="direct structure failure",
                )
            ],
            source_text="direct structure failure",
            extraction_engine=CaptureEngineV1(
                engine="test-extractor",
                model="test",
                digest="sha256:" + "a" * 64,
                device="test",
            ),
            created_at=datetime.now(UTC),
        ),
    )
    repository.mark_awaiting_structuring(capture_id)

    class FailingStructurer:
        engine_identity = None

        async def structure(self, raw, *, target_language, cancel_event):
            del raw, target_language, cancel_event
            raise RuntimeError("Bearer direct-structure-secret provider payload")

    service._structurer = FailingStructurer()
    response = client.post(f"/v2/captures/{capture_id}/structure")

    assert response.status_code == 500, response.text
    assert response.json() == {
        "error": {
            "code": "structuring_failed",
            "message": "Capture structuring failed.",
        }
    }
    assert "direct-structure-secret" not in response.text
    persisted = client.get(f"/v2/captures/{capture_id}")
    assert persisted.status_code == 200
    assert persisted.json()["status"] == "failed"
    assert persisted.json()["error"] == {
        "code": "structuring_failed",
        "message": "Capture structuring failed.",
        "stage": "structuring",
        "retryable": True,
    }
    events = client.get(f"/v2/captures/{capture_id}/events")
    assert events.status_code == 200
    assert "event: failed" in events.text
    assert "direct-structure-secret" not in events.text


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
