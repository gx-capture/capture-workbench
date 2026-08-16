from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.clock import SystemClock
from capture_runtime.contract_set import SCHEMA_DIALECT, canonical_json_bytes
from capture_runtime.contracts import (
    CaptureEngine,
    OpenIngestionV2,
    OpenStructuringSessionV2,
    RawCapture,
    RawCaptureSegment,
    StartCaptureV2,
    StructuringMode,
    StructuringProviderCapabilityV2,
    TimeLocator,
)
from capture_runtime.storage import (
    StructuringSessionRecordCorruptError,
    StructuringSessionRepository,
)


def _seed_host_capture(client: TestClient, *, segment_count: int = 2) -> str:
    repository = client.app.state.streaming_repository
    source = b"session-source"
    source_sha256 = hashlib.sha256(source).hexdigest()
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id=f"session-ingestion-{uuid4()}",
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
            client_request_id=f"session-capture-{uuid4()}",
            ingestion_id=ingestion.ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    assert operation.source is not None
    created_at = datetime(2026, 8, 13, tzinfo=UTC)
    segments = [
        RawCaptureSegment(
            segment_id=f"segment-{index}",
            order=index,
            locator=TimeLocator(start_ms=index * 1_000, end_ms=(index + 1) * 1_000),
            text=f"source words {index}",
        )
        for index in range(segment_count)
    ]
    raw = RawCapture(
        source=operation.source,
        segments=segments,
        source_text="\n".join(segment.text for segment in segments),
        extraction_engine=CaptureEngine(
            engine="whisper-primary",
            model="test-model",
            digest=f"sha256:{'a' * 64}",
            device="cpu",
        ),
        created_at=created_at,
    )
    repository.write_raw(operation.capture_id, raw)
    repository.mark_awaiting_structuring(operation.capture_id)
    return operation.capture_id


def _open_request(capture_id: str, *, client_request_id: str = "session-request-1") -> dict:
    return {
        "captureId": capture_id,
        "targetLanguage": "fr",
        "providerCapability": {
            "provider": {
                "engine": "ollama",
                "model": "capture-workbench-qwen3.5-0.8b-structure-v1",
                "digest": f"sha256:{'b' * 64}",
            },
            "capability": "capture-structuring",
            "schemaDialect": SCHEMA_DIALECT,
        },
        "schemaDialect": SCHEMA_DIALECT,
        "clientRequestId": client_request_id,
    }


def _submit_payload(batch: dict[str, object], target_suffix: str) -> dict[str, object]:
    segment_id = batch["sourceSegmentIds"][0]
    return {
        "batchDigest": batch["batchDigest"],
        "blocks": [
            {
                "sourceSegmentId": segment_id,
                "type": "transcript",
                "targetText": f"translated {target_suffix}",
            }
        ],
    }


def test_pull_session_plans_tiny_profile_batches_and_reconstructs_result(
    client: TestClient,
) -> None:
    capture_id = _seed_host_capture(client, segment_count=2)
    request = _open_request(capture_id)
    opened = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=request,
        headers={"X-Idempotency-Key": request["clientRequestId"]},
    )
    assert opened.status_code == 201, opened.text
    session = opened.json()
    assert session["batchCount"] == 2
    assert session["nextBatchIndex"] == 0
    assert session["status"] == "open"
    assert session["rawSourceSha256"]
    assert session["contractSetSha256"]

    first_batch_response = client.get(f"/v2/captures/{capture_id}/structure/session/batches/0")
    assert first_batch_response.status_code == 200, first_batch_response.text
    first_batch = first_batch_response.json()
    assert first_batch["sourceSegmentIds"] == ["segment-0"]
    assert first_batch["providerPrompt"]["rawSegments"][0]["segmentId"] == "segment-0"
    assert first_batch["providerSchema"]["properties"]["blocks"]["maxItems"] == 1
    digest_input = {
        key: value for key, value in first_batch.items() if key not in {"batchDigest", "status"}
    }
    assert (
        hashlib.sha256(canonical_json_bytes(digest_input)).hexdigest() == first_batch["batchDigest"]
    )

    assert (
        client.put(
            f"/v2/captures/{capture_id}/structure/session/batches/1",
            json=_submit_payload(first_batch, "wrong-order"),
            headers={"X-Idempotency-Key": "session-batch-wrong-order"},
        ).status_code
        == 409
    )
    first_submit = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json=_submit_payload(first_batch, "zero"),
        headers={"X-Idempotency-Key": "session-batch-0"},
    )
    assert first_submit.status_code == 200, first_submit.text
    assert first_submit.json()["nextBatchIndex"] == 1

    replay = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json=_submit_payload(first_batch, "zero"),
        headers={"X-Idempotency-Key": "session-batch-0"},
    )
    assert replay.status_code == 200
    assert replay.json() == first_submit.json()

    conflict = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json=_submit_payload(first_batch, "changed"),
        headers={"X-Idempotency-Key": "session-batch-0"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"

    second_batch = client.get(f"/v2/captures/{capture_id}/structure/session/batches/1").json()
    final = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/1",
        json=_submit_payload(second_batch, "one"),
        headers={"X-Idempotency-Key": "session-batch-1"},
    )
    assert final.status_code == 200, final.text
    assert final.json()["status"] == "completed"
    assert final.json()["nextBatchIndex"] == 2

    result = client.get(f"/v2/captures/{capture_id}/result")
    assert result.status_code == 200, result.text
    assert result.json()["result"]["targetText"] == "translated zero\ntranslated one"
    assert [block["sourceSegmentId"] for block in result.json()["result"]["blocks"]] == [
        "segment-0",
        "segment-1",
    ]


def test_pull_session_rejects_provenance_fields_and_digest_conflicts(client: TestClient) -> None:
    capture_id = _seed_host_capture(client, segment_count=1)
    request = _open_request(capture_id, client_request_id="strict-session")
    opened = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=request,
        headers={"X-Idempotency-Key": "strict-session"},
    )
    assert opened.status_code == 201
    batch = client.get(f"/v2/captures/{capture_id}/structure/session/batches/0").json()
    body = _submit_payload(batch, "strict")
    body["blocks"][0]["sourceText"] = "must-not-be-accepted"
    invalid = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json=body,
        headers={"X-Idempotency-Key": "strict-batch"},
    )
    assert invalid.status_code == 422
    assert invalid.json()["error"]["code"] == "validation_error"

    wrong_digest = _submit_payload(batch, "strict")
    wrong_digest["batchDigest"] = "0" * 64
    conflict = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json=wrong_digest,
        headers={"X-Idempotency-Key": "strict-batch-2"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "structuring_batch_digest_conflict"

    missing_header = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/0",
        json=_submit_payload(batch, "strict"),
    )
    assert missing_header.status_code == 422


def test_pull_session_open_replays_after_runtime_restart(settings_factory) -> None:
    settings = settings_factory()
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as first_client:
        capture_id = _seed_host_capture(first_client, segment_count=1)
        request = _open_request(capture_id, client_request_id="restart-session")
        opened = first_client.post(
            f"/v2/captures/{capture_id}/structure/session",
            json=request,
            headers={"X-Idempotency-Key": "restart-session"},
        )
        assert opened.status_code == 201
        session_id = opened.json()["sessionId"]
        batch = first_client.get(f"/v2/captures/{capture_id}/structure/session/batches/0").json()

    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as restarted_client:
        current = restarted_client.get(f"/v2/captures/{capture_id}/structure/session")
        assert current.status_code == 200
        assert current.json()["sessionId"] == session_id
        replay = restarted_client.post(
            f"/v2/captures/{capture_id}/structure/session",
            json=request,
            headers={"X-Idempotency-Key": "restart-session"},
        )
        assert replay.status_code == 201
        assert replay.json() == current.json()
        accepted = restarted_client.put(
            f"/v2/captures/{capture_id}/structure/session/batches/0",
            json=_submit_payload(batch, "restart"),
            headers={"X-Idempotency-Key": "restart-batch"},
        )
        assert accepted.status_code == 200


def test_pull_session_repository_fails_closed_on_malformed_record(tmp_path: Path) -> None:
    root = tmp_path / "structuring-sessions"
    root.mkdir()
    malformed = root / "not-a-uuid"
    malformed.mkdir()
    (malformed / "metadata.json").write_text(json.dumps({"request": {}}), encoding="utf-8")

    repository = StructuringSessionRepository(root, clock=SystemClock())
    with pytest.raises(StructuringSessionRecordCorruptError):
        repository.initialize()


def test_pull_session_repository_rejects_tampered_request_fingerprint(
    client: TestClient,
) -> None:
    capture_id = _seed_host_capture(client, segment_count=1)
    request = _open_request(capture_id, client_request_id="tampered-fingerprint")
    opened = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=request,
        headers={"X-Idempotency-Key": "tampered-fingerprint"},
    )
    assert opened.status_code == 201
    session_id = opened.json()["sessionId"]
    metadata = (
        client.app.state.structuring_session_service.repository.root / session_id / "metadata.json"
    )
    payload = json.loads(metadata.read_text(encoding="utf-8"))
    payload["requestFingerprint"] = "0" * 64
    metadata.write_text(json.dumps(payload), encoding="utf-8")

    repository = StructuringSessionRepository(
        client.app.state.structuring_session_service.repository.root,
        clock=SystemClock(),
    )
    with pytest.raises(StructuringSessionRecordCorruptError):
        repository.initialize()


def test_pull_session_contract_models_are_strict_and_camel_case() -> None:
    capability = StructuringProviderCapabilityV2(
        provider=CaptureEngine(
            engine="ollama",
            model="test-model",
            digest=f"sha256:{'a' * 64}",
        ),
        capability="capture-structuring",
        schema_dialect=SCHEMA_DIALECT,
    )
    request = OpenStructuringSessionV2(
        capture_id="capture-1",
        target_language="fr",
        provider_capability=capability,
        schema_dialect=SCHEMA_DIALECT,
        client_request_id="request-1",
    )
    assert (
        request.model_dump(by_alias=True)["providerCapability"]["schemaDialect"] == SCHEMA_DIALECT
    )
    with pytest.raises(ValueError):
        OpenStructuringSessionV2.model_validate(
            {**request.model_dump(by_alias=True), "unexpected": True}
        )
