"""HTTP-level behaviour of the capture routes that their split must keep.

Each app binds its own capture and structuring services when it registers the
routes, the local request policy and Bearer check cover the capture routes,
a chunk body is bounded by the live limit and by its declared span, and the
event stream writes exact SSE frames.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.capture.api import streaming as streaming_api
from capture_runtime.capture.api.streaming import register_streaming_routes
from capture_runtime.config import RuntimeSettings
from capture_runtime.contracts import CaptureEvent, CaptureEventType, CaptureSourceKind
from capture_runtime.dependencies import RuntimeDependencies
from tests.conftest import TOKEN
from tests.integration.test_structuring_session import _open_request, _seed_host_capture

OTHER_TOKEN = "capture-other-token-zyxwvutsrqponmlkjihgfedcba-654321"


def _client(settings: RuntimeSettings, token: str) -> TestClient:
    return TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {token}"},
    )


def _open_ingestion(client: TestClient, request_id: str, total_bytes: int) -> Any:
    return client.post(
        "/v2/ingestions",
        json={
            "kind": "recording",
            "clientRequestId": request_id,
            "fileName": "sample.mp3",
            "mediaType": "audio/mpeg",
            "totalBytes": total_bytes,
        },
        headers={"X-Idempotency-Key": request_id},
    )


def _put_chunk(client: TestClient, ingestion_id: str, content_range: str, body: bytes) -> Any:
    return client.put(
        f"/v2/ingestions/{ingestion_id}/chunks/0",
        content=body,
        headers={
            "Content-Range": content_range,
            "Digest": f"sha-256={hashlib.sha256(body).hexdigest()}",
            "X-Idempotency-Key": f"chunk-{ingestion_id}",
        },
    )


def test_two_apps_keep_their_own_capture_services_tokens_and_limits(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    first_settings = settings_factory()
    second_settings = settings_factory(CAPTURE_API_TOKEN=OTHER_TOKEN)
    with (
        _client(first_settings, TOKEN) as first,
        _client(second_settings, OTHER_TOKEN) as second,
    ):
        opened = _open_ingestion(first, "isolation-open", 6)
        assert opened.status_code == 201, opened.text
        first_id = opened.json()["ingestionId"]

        assert second.get(f"/v2/ingestions/{first_id}").status_code == 404
        # The same request id with other metadata is new to the second app.
        reopened = _open_ingestion(second, "isolation-open", 9)
        assert reopened.status_code == 201, reopened.text
        second_id = reopened.json()["ingestionId"]
        conflict = _open_ingestion(first, "isolation-open", 9)
        assert conflict.status_code == 409
        assert conflict.json()["error"]["code"] == "idempotency_conflict"
        assert first.get(f"/v2/ingestions/{second_id}").status_code == 404

        # Each app reads the chunk limit of its own service at request time.
        first.app.state.streaming_capture_service.max_chunk_bytes = 2
        too_large = _put_chunk(first, first_id, "bytes 0-2/6", b"abc")
        assert too_large.status_code == 413
        assert too_large.json()["error"]["code"] == "chunk_too_large"
        accepted = _put_chunk(second, second_id, "bytes 0-2/9", b"abc")
        assert accepted.status_code == 200, accepted.text
        assert accepted.json()["nextOffset"] == 3

        assert first.get(f"/v2/ingestions/{first_id}").json()["receivedBytes"] == 0

        # A structuring session opened in one app does not exist in the other.
        first_capture = _seed_host_capture(first)
        second_capture = _seed_host_capture(second)
        session = first.post(
            f"/v2/captures/{first_capture}/structure/session",
            json=_open_request(),
            headers={"X-Idempotency-Key": "isolation-session"},
        )
        assert session.status_code == 201, session.text
        missing = second.get(f"/v2/captures/{first_capture}/structure/session")
        assert missing.status_code == 404
        assert missing.json()["error"]["code"] == "structuring_session_not_found"
        assert second.get(f"/v2/captures/{second_capture}/structure/session").status_code == 404
        read = first.get(f"/v2/captures/{first_capture}/structure/session")
        assert read.status_code == 200, read.text
        assert read.json()["sessionId"] == session.json()["sessionId"]

        crossed = first.get(
            f"/v2/ingestions/{first_id}",
            headers={"Authorization": f"Bearer {OTHER_TOKEN}"},
        )
        assert crossed.status_code == 401
        crossed = second.get(
            f"/v2/ingestions/{second_id}",
            headers={"Authorization": f"Bearer {TOKEN}"},
        )
        assert crossed.status_code == 401


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("POST", "/v2/ingestions"),
        ("PUT", "/v2/ingestions/unknown/chunks/0"),
        ("GET", "/v2/captures/unknown/events"),
        ("POST", "/v2/captures/unknown/structure/session"),
        ("PUT", "/v2/captures/unknown/structure/session/batches/0"),
        ("DELETE", "/v2/captures/unknown"),
    ],
)
def test_capture_routes_reject_foreign_host_origin_and_missing_bearer(
    client: TestClient, method: str, path: str
) -> None:
    invalid_host = client.request(method, path, headers={"Host": "attacker.invalid"})
    assert invalid_host.status_code == 400
    assert invalid_host.json()["error"]["code"] == "invalid_host"

    invalid_origin = client.request(method, path, headers={"Origin": "https://attacker.invalid"})
    assert invalid_origin.status_code == 403
    assert invalid_origin.json()["error"]["code"] == "origin_not_allowed"

    unauthorized = client.request(method, path, headers={"Authorization": ""})
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "unauthorized"
    assert unauthorized.headers["www-authenticate"] == "Bearer"


def _put_chunk_in_messages(
    client: TestClient, ingestion_id: str, content_range: str, parts: list[bytes]
) -> tuple[int, dict[str, Any]]:
    """PUT a chunk whose body reaches the app as one ASGI message per part.

    TestClient joins a streamed body into one message, so the app is called
    directly on the client's event loop.
    """
    body = b"".join(parts)
    path = f"/v2/ingestions/{ingestion_id}/chunks/0"
    headers = {
        "host": client.base_url.netloc.decode("ascii"),
        "authorization": client.headers["authorization"],
        "content-range": content_range,
        "digest": f"sha-256={hashlib.sha256(body).hexdigest()}",
        "x-idempotency-key": f"chunk-{ingestion_id}",
    }
    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "PUT",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "root_path": "",
        "headers": [(name.encode(), value.encode()) for name, value in headers.items()],
        "client": ("testclient", 50000),
        "server": ("127.0.0.1", client.base_url.port),
        "state": {},
    }
    messages = [
        {"type": "http.request", "body": part, "more_body": index < len(parts) - 1}
        for index, part in enumerate(parts)
    ]
    sent: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        if messages:
            return messages.pop(0)
        return {"type": "http.disconnect"}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def call() -> None:
        await client.app(scope, receive, send)

    assert client.portal is not None
    client.portal.call(call)
    status = next(message["status"] for message in sent if message["type"] == "http.response.start")
    payload = b"".join(
        message.get("body", b"") for message in sent if message["type"] == "http.response.body"
    )
    return status, json.loads(payload)


def test_chunk_body_outside_its_declared_span_appends_nothing(client: TestClient) -> None:
    opened = _open_ingestion(client, "chunk-bounds-open", 6)
    assert opened.status_code == 201, opened.text
    ingestion_id = opened.json()["ingestionId"]
    client.app.state.streaming_capture_service.max_chunk_bytes = 4

    # The declared span fits the limit and so does each message; their sum does not.
    status, overflowing = _put_chunk_in_messages(
        client, ingestion_id, "bytes 0-2/6", [b"ab", b"cde"]
    )
    assert status == 413
    assert overflowing["error"]["code"] == "chunk_too_large"

    status, short = _put_chunk_in_messages(client, ingestion_id, "bytes 0-2/6", [b"a", b"b"])
    assert status == 422
    assert short["error"]["code"] == "chunk_length_mismatch"

    untouched = client.get(f"/v2/ingestions/{ingestion_id}").json()
    assert untouched["receivedBytes"] == 0
    assert untouched["nextOffset"] == 0
    # The whole body is read, not only its first message.
    status, accepted = _put_chunk_in_messages(client, ingestion_id, "bytes 0-2/6", [b"ab", b"c"])
    assert status == 200, accepted
    assert accepted["nextOffset"] == 3


def _event(sequence: int, event_type: CaptureEventType, stage: str) -> CaptureEvent:
    return CaptureEvent(
        event_id=f"event-{sequence}",
        sequence=sequence,
        capture_id="capture-sse",
        kind=CaptureSourceKind.RECORDING,
        event_type=event_type,
        stage=stage,
        created_at=datetime(2026, 1, 2, 3, 4, 5, tzinfo=UTC),
    )


class _ScriptedEventSource:
    """Event polls and close decisions in a fixed order, on a stepped clock."""

    def __init__(self, polls: list[tuple[float, list[CaptureEvent]]], closes: list[bool]):
        self._polls = polls
        self._closes = closes
        self.now = 0.0
        self.cursors: list[int] = []
        self.close_checks = 0

    def execute(self, capture_id: str, *, after_sequence: int = -1) -> list[CaptureEvent]:
        assert capture_id == "capture-sse"
        self.now, events = self._polls[len(self.cursors)]
        self.cursors.append(after_sequence)
        return events

    def should_close(self, capture_id: str) -> bool:
        assert capture_id == "capture-sse"
        decision = self._closes[self.close_checks]
        self.close_checks += 1
        return decision

    def monotonic(self) -> float:
        return self.now


def _frame(event: CaptureEvent) -> str:
    return (
        f"id: {event.sequence}\nevent: {event.event_type.value}\n"
        f"data: {event.model_dump_json(by_alias=True)}\n\n"
    )


def test_event_stream_writes_exact_frames_heartbeats_and_the_durable_tail(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    accepted = _event(1, CaptureEventType.ACCEPTED, "accepted")
    checkpoint = _event(2, CaptureEventType.INPUT_CHECKPOINT, "input")
    transcribing = _event(3, CaptureEventType.CHECKPOINT, "轉寫中")
    completed = _event(4, CaptureEventType.COMPLETED, "completed")
    source = _ScriptedEventSource(
        polls=[
            (0.0, [accepted, checkpoint]),  # before the response starts
            (1.5, []),  # past the first deadline: one heartbeat
            (2.6, [transcribing]),  # an event moves the deadline to 3.6
            (2.7, []),  # the capture closes on this poll
            (2.7, [completed]),  # the durable tail before EOF
        ],
        closes=[False, False, False, True],
    )
    monkeypatch.setattr(streaming_api, "time", SimpleNamespace(monotonic=source.monotonic))
    service = SimpleNamespace(
        open_ingestion_use_case=None,
        append_chunk_use_case=None,
        finalize_ingestion_use_case=None,
        start_capture_use_case=None,
        cancel_capture_use_case=None,
        events_use_case=source,
        commit_host_result_use_case=None,
        heartbeat_interval_ms=1_000,
        event_stream_should_close=source.should_close,
    )
    app = FastAPI()
    router = APIRouter(prefix="/v2")
    register_streaming_routes(
        router,
        cast(
            RuntimeDependencies,
            SimpleNamespace(
                streaming_capture_service=service,
                structuring_session_service=SimpleNamespace(
                    open_use_case=None, submit_use_case=None, get_use_case=None
                ),
            ),
        ),
    )
    app.include_router(router)

    with TestClient(app) as client:
        response = client.get("/v2/captures/capture-sse/events", headers={"Last-Event-ID": "0"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "text/event-stream; charset=utf-8"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-accel-buffering"] == "no"
    assert source.cursors == [0, 2, 2, 3, 3]
    assert source.close_checks == 4
    assert response.content.decode("utf-8") == (
        _frame(accepted)
        + _frame(checkpoint)
        + ": heartbeat\n\n"
        + "id: 3\nevent: checkpoint\ndata: "
        '{"protocolVersion":"2","eventId":"event-3","sequence":3,"captureId":"capture-sse",'
        '"kind":"recording","eventType":"checkpoint","stage":"轉寫中","progress":null,'
        '"partialRevision":null,"coveredUntilMs":null,"segments":[],"error":null,'
        '"createdAt":"2026-01-02T03:04:05Z","pagesDone":null,"pagesTotal":null,'
        '"durationMs":null}\n\n' + _frame(completed)
    )
