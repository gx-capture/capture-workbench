from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.clock import SystemClock
from capture_runtime.contract_set import SCHEMA_DIALECT, canonical_json_bytes
from capture_runtime.contracts import (
    CaptureEngine,
    OpenIngestion,
    OpenStructuringSession,
    PageLocator,
    RawCapture,
    RawCaptureSegment,
    StartCapture,
    StructuringMode,
    StructuringProviderCapability,
    TimeLocator,
)
from capture_runtime.structuring.infrastructure.structuring_session_repository import (
    StructuringSessionRecordCorruptError,
    StructuringSessionRepository,
)
from tests.conftest import TOKEN


def _seed_host_capture(client: TestClient, *, segment_count: int = 2, pdf: bool = False) -> str:
    repository = client.app.state.streaming_repository
    source = b"session-source"
    source_sha256 = hashlib.sha256(source).hexdigest()
    ingestion = repository.create_ingestion(
        OpenIngestion(
            client_request_id=f"session-ingestion-{uuid4()}",
            kind="pdf" if pdf else "recording",
            file_name="sample.pdf" if pdf else "sample.mp3",
            media_type="application/pdf" if pdf else "audio/mpeg",
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
        StartCapture(
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
            locator=(
                PageLocator(page=index + 1)
                if pdf
                else TimeLocator(start_ms=index * 1_000, end_ms=(index + 1) * 1_000)
            ),
            text=f"source words {index}",
        )
        for index in range(segment_count)
    ]
    raw = RawCapture(
        source=operation.source,
        segments=segments,
        source_text="\n".join(segment.text for segment in segments),
        extraction_engine=CaptureEngine(
            engine="text-recognition" if pdf else "speech-recognition",
            model="deterministic-ocr-v1" if pdf else "test-model",
            digest=f"sha256:{'a' * 64}",
            device="fake" if pdf else "cpu",
        ),
        created_at=created_at,
    )
    repository.write_raw(operation.capture_id, raw)
    repository.mark_awaiting_structuring(operation.capture_id)
    return operation.capture_id


def _open_request(profile_id: str = "qwen3.5-0.8b-structure-v1") -> dict:
    """An open-session body: the route names the capture, the header the request.

    The provider's model is its own name, unlike any profile id, so a planner
    that selected by the model would plan other batches.
    """
    return {
        "targetLanguage": "fr",
        "profileId": profile_id,
        "providerCapability": {
            "provider": {
                "engine": "ollama",
                "model": "host-provider-model",
                "digest": f"sha256:{'b' * 64}",
            },
            "schemaDialect": SCHEMA_DIALECT,
        },
        "schemaDialect": SCHEMA_DIALECT,
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
    request = _open_request()
    opened = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=request,
        headers={"X-Idempotency-Key": "session-request-1"},
    )
    assert opened.status_code == 201, opened.text
    session = opened.json()
    assert "capability" not in session["providerCapability"]
    stored = json.loads(
        (
            client.app.state.structuring_session_service.repository.root
            / session["sessionId"]
            / "metadata.json"
        ).read_bytes()
    )
    # The transport ids are kept beside the request, not in it.
    assert (stored["captureId"], stored["clientRequestId"]) == (capture_id, "session-request-1")
    assert "captureId" not in stored["request"]
    assert "clientRequestId" not in stored["request"]
    assert stored["request"]["profileId"] == request["profileId"]
    assert session["batchCount"] == 2
    assert session["nextBatchIndex"] == 0
    assert session["status"] == "open"
    assert session["sourceSha256"]
    assert "rawSourceSha256" not in session
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

    second_batch = client.get(f"/v2/captures/{capture_id}/structure/session/batches/1").json()
    out_of_order = client.put(
        f"/v2/captures/{capture_id}/structure/session/batches/1",
        json=_submit_payload(second_batch, "wrong-order"),
        headers={"X-Idempotency-Key": "session-batch-wrong-order"},
    )
    assert out_of_order.status_code == 409
    assert out_of_order.json()["error"]["code"] == "invalid_capture_state"
    assert client.get(f"/v2/captures/{capture_id}/structure/session").json()["nextBatchIndex"] == 0
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


def test_completed_structuring_session_reads_historical_ocr_document(client: TestClient) -> None:
    capture_id = _seed_host_capture(client, segment_count=1, pdf=True)
    route = f"/v2/captures/{capture_id}/structure/session"
    opened = client.post(
        route,
        json=_open_request(),
        headers={"X-Idempotency-Key": "session-request-1"},
    )
    assert opened.status_code == 201, opened.text
    session_id = opened.json()["sessionId"]
    batch_route = f"{route}/batches/0"
    batch = client.get(batch_route).json()
    submission = _submit_payload(batch, "legacy")
    submission["blocks"][0]["type"] = "paragraph"
    headers = {"X-Idempotency-Key": "legacy-batch"}
    completed = client.put(batch_route, json=submission, headers=headers)
    assert completed.status_code == 200, completed.text

    repository = client.app.state.structuring_session_service.repository
    path = repository.root / session_id / "metadata.json"
    historical = json.loads(path.read_bytes())
    historical["completedDocument"]["extractionEngine"].update(
        engine="windowsml-ocr", model="deterministic-windowsml-v1"
    )
    del historical["completedDocument"]["suggestedRequirementIds"]
    historical["completedDocument"]["suggestedUnits"] = ["windowsml-ocr", "capture-ollama-model"]
    path.write_text(json.dumps(historical, indent=2), encoding="utf-8")
    before = path.read_bytes()

    repository.initialize()
    assert client.get(route).json() == completed.json()
    assert client.put(batch_route, json=submission, headers=headers).json() == completed.json()
    document = repository.completed_document(session_id)
    assert document is not None
    assert document.extraction_engine.engine == "text-recognition"
    assert document.extraction_engine.model == "deterministic-ocr-v1"
    assert document.suggested_requirement_ids == ["text-recognition", "structuring-model"]
    assert path.read_bytes() == before


def test_pull_session_rejects_provenance_fields_and_digest_conflicts(client: TestClient) -> None:
    capture_id = _seed_host_capture(client, segment_count=1)
    request = _open_request()
    for removed in (
        {"captureId": capture_id},
        {"clientRequestId": "strict-session"},
        {
            "providerCapability": {
                **request["providerCapability"],
                "capability": "capture-structuring",
            }
        },
    ):
        rejected = client.post(
            f"/v2/captures/{capture_id}/structure/session",
            json={**request, **removed},
            headers={"X-Idempotency-Key": "strict-session"},
        )
        assert rejected.status_code == 422, rejected.text
        assert rejected.json()["error"]["code"] == "validation_error"
    missing_profile = {key: value for key, value in request.items() if key != "profileId"}
    rejected = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=missing_profile,
        headers={"X-Idempotency-Key": "strict-session"},
    )
    assert rejected.status_code == 422, rejected.text
    opened = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=request,
        headers={"X-Idempotency-Key": "strict-session"},
    )
    assert opened.status_code == 201
    other_profile = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json={**request, "profileId": "qwen3.5-4b-structure-v1"},
        headers={"X-Idempotency-Key": "strict-session"},
    )
    assert other_profile.status_code == 409
    assert other_profile.json()["error"]["code"] == "idempotency_conflict"
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
        request = _open_request()
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


def test_pull_session_open_rejects_a_blank_idempotency_key(settings_factory) -> None:
    settings = settings_factory()
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as first_client:
        capture_id = _seed_host_capture(first_client, segment_count=1)
        route = f"/v2/captures/{capture_id}/structure/session"
        blank = first_client.post(route, json=_open_request(), headers={"X-Idempotency-Key": "   "})
        assert blank.status_code == 422, blank.text
        assert blank.json()["error"]["code"] == "validation_error"
        assert first_client.get(route).status_code == 404

    # Nothing was stored, so the runtime restarts and the capture can still open.
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as restarted_client:
        opened = restarted_client.post(
            route, json=_open_request(), headers={"X-Idempotency-Key": "after-blank"}
        )
        assert opened.status_code == 201, opened.text


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
    request = _open_request()
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


def _as_0_10_session(session_payload: dict, capability: dict) -> dict:
    """A session checkpoint the way 0.10.x stored it, with its digest in that form."""
    historical = dict(session_payload)
    historical["rawSourceSha256"] = historical.pop("sourceSha256")
    historical["providerCapability"] = capability
    digest_input = {key: value for key, value in historical.items() if key != "sessionDigest"}
    historical["sessionDigest"] = hashlib.sha256(canonical_json_bytes(digest_input)).hexdigest()
    return historical


def _rewrite_as_0_10_record(
    path: Path,
    capture_id: str,
    client_request_id: str,
    *,
    provider_model: str | None = None,
) -> dict:
    """Rewrite a stored session the way a 0.10.x runtime wrote it, with its digests.

    0.10.x had no profile id: it planned for the profile its provider's model
    named, which carried the consumer prefix.
    """
    record = json.loads(path.read_bytes())
    assert (record.pop("captureId"), record.pop("clientRequestId")) == (
        capture_id,
        client_request_id,
    )
    body = record["request"]
    provider = dict(body["providerCapability"]["provider"])
    if provider_model is not None:
        provider["model"] = provider_model
    capability = {
        **body["providerCapability"],
        "provider": provider,
        "capability": "capture-structuring",
    }
    record["request"] = {
        "protocolVersion": body["protocolVersion"],
        "captureId": capture_id,
        "targetLanguage": body["targetLanguage"],
        "providerCapability": capability,
        "schemaDialect": body["schemaDialect"],
        "clientRequestId": client_request_id,
    }
    source_sha256 = record["session"]["sourceSha256"]
    record["session"] = _as_0_10_session(record["session"], capability)
    for entry in record["batches"]:
        if entry["response"] is not None:
            entry["response"] = _as_0_10_session(entry["response"], capability)
    record["requestFingerprint"] = hashlib.sha256(
        canonical_json_bytes(
            {
                "request": record["request"],
                "rawSourceSha256": source_sha256,
                "contractSetSha256": record["session"]["contractSetSha256"],
                "batches": [
                    {
                        key: value
                        for key, value in batch.items()
                        if key not in {"sessionId", "batchDigest", "status"}
                    }
                    for batch in (entry["batch"] for entry in record["batches"])
                ],
            }
        )
    ).hexdigest()
    path.write_text(json.dumps(record, indent=2), encoding="utf-8")
    return record


_OLD_PROFILE_ID = "capture-workbench-qwen3.5-0.8b-structure-v1"


def _seed_0_10_session(
    client: TestClient, *, segment_count: int, accepted: int = 0
) -> tuple[str, Path, dict, list[dict]]:
    """Store a session the way 0.10.x wrote it, with `accepted` batches already accepted.

    The batches are planned and accepted by this runtime, then the record is
    rewritten in the 0.10.x form; a fresh request cannot name the old profile id.
    """
    capture_id = _seed_host_capture(client, segment_count=segment_count)
    route = f"/v2/captures/{capture_id}/structure/session"
    opened = client.post(
        route, json=_open_request(), headers={"X-Idempotency-Key": "legacy-open-1"}
    )
    assert opened.status_code == 201, opened.text
    submissions = []
    for index in range(accepted):
        batch = client.get(f"{route}/batches/{index}").json()
        submission = _submit_payload(batch, f"historical {index}")
        response = client.put(
            f"{route}/batches/{index}",
            json=submission,
            headers={"X-Idempotency-Key": f"legacy-batch-{index}"},
        )
        assert response.status_code == 200, response.text
        submissions.append(submission)
    repository = client.app.state.structuring_session_service.repository
    path = repository.root / opened.json()["sessionId"] / "metadata.json"
    historical = _rewrite_as_0_10_record(
        path, capture_id, "legacy-open-1", provider_model=_OLD_PROFILE_ID
    )
    repository.initialize()
    return capture_id, path, historical, submissions


def test_fresh_pull_session_rejects_the_retired_profile_id(client: TestClient) -> None:
    capture_id = _seed_host_capture(client, segment_count=2)
    rejected = client.post(
        f"/v2/captures/{capture_id}/structure/session",
        json=_open_request(_OLD_PROFILE_ID),
        headers={"X-Idempotency-Key": "fresh-old-profile"},
    )
    assert rejected.status_code == 422, rejected.text
    assert rejected.json()["error"]["code"] == "validation_error"
    assert client.get(f"/v2/captures/{capture_id}/structure/session").status_code == 404


def test_historical_pull_session_metadata_stays_readable_and_preserves_bytes(
    client: TestClient,
) -> None:
    capture_id, path, historical, _submissions = _seed_0_10_session(client, segment_count=2)
    route = f"/v2/captures/{capture_id}/structure/session"
    repository = client.app.state.structuring_session_service.repository
    # A current client repeats the open with the header and the profile the record
    # names: 0.10.x named it through the provider's model.
    request = _open_request(_OLD_PROFILE_ID)
    request["providerCapability"]["provider"]["model"] = _OLD_PROFILE_ID
    session_payload = historical["session"]
    before = path.read_bytes()

    repository.initialize()
    read_response = client.get(route)
    assert read_response.status_code == 200, read_response.text
    view = read_response.json()
    assert view["sourceSha256"] == session_payload["rawSourceSha256"]
    assert "rawSourceSha256" not in view
    assert "capability" not in view["providerCapability"]
    assert view["providerCapability"]["provider"]["model"] == _OLD_PROFILE_ID
    assert view["sessionDigest"] == session_payload["sessionDigest"]
    assert view["batchCount"] == 2
    assert path.read_bytes() == before

    replay_response = client.post(
        route, json=request, headers={"X-Idempotency-Key": "legacy-open-1"}
    )
    assert replay_response.status_code == 201, replay_response.text
    assert replay_response.json() == view
    other_profile = client.post(
        route,
        json={**request, "profileId": "qwen3.5-4b-structure-v1"},
        headers={"X-Idempotency-Key": "legacy-open-1"},
    )
    assert other_profile.status_code == 409
    assert other_profile.json()["error"]["code"] == "idempotency_conflict"
    assert path.read_bytes() == before

    # A tampered or mixed record fails closed and is not rewritten.
    for tamper in ("capability", "mixed-key"):
        corrupt = json.loads(before)
        if tamper == "capability":
            corrupt["request"]["providerCapability"]["capability"] = "other-capability"
        else:
            corrupt["session"]["sourceSha256"] = session_payload["rawSourceSha256"]
        path.write_text(json.dumps(corrupt, indent=2), encoding="utf-8")
        tampered = path.read_bytes()
        with pytest.raises(StructuringSessionRecordCorruptError):
            repository.initialize()
        assert path.read_bytes() == tampered
    path.write_bytes(before)
    repository.initialize()

    # Accepting a batch keeps the record in its form: the request and its
    # fingerprint as written, the new checkpoint digested like the others.
    batch = client.get(f"{route}/batches/0").json()
    accepted = client.put(
        f"{route}/batches/0",
        json=_submit_payload(batch, "historical"),
        headers={"X-Idempotency-Key": "legacy-batch-0"},
    )
    assert accepted.status_code == 200, accepted.text
    rewritten = json.loads(path.read_bytes())
    assert rewritten["request"] == historical["request"]
    assert rewritten["requestFingerprint"] == historical["requestFingerprint"]
    assert "captureId" not in rewritten
    assert "rawSourceSha256" in rewritten["batches"][0]["response"]
    assert rewritten["session"]["providerCapability"]["capability"] == "capture-structuring"
    repository.initialize()
    assert client.get(route).json() == accepted.json()


def test_historical_replay_digest_survives_advancing_and_reopening(
    client: TestClient,
) -> None:
    capture_id, path, historical, submissions = _seed_0_10_session(
        client, segment_count=3, accepted=1
    )
    route = f"/v2/captures/{capture_id}/structure/session"
    repository = client.app.state.structuring_session_service.repository
    stored_response = historical["batches"][0]["response"]

    def replay_first_batch() -> dict:
        replayed = client.put(
            f"{route}/batches/0",
            json=submissions[0],
            headers={"X-Idempotency-Key": "legacy-batch-0"},
        )
        assert replayed.status_code == 200, replayed.text
        return replayed.json()

    # 0.10.x returned this digest when it accepted the batch.
    before = replay_first_batch()
    assert before["sessionDigest"] == stored_response["sessionDigest"]
    assert before["sourceSha256"] == stored_response["rawSourceSha256"]

    batch = client.get(f"{route}/batches/1").json()
    advanced = client.put(
        f"{route}/batches/1",
        json=_submit_payload(batch, "after upgrade"),
        headers={"X-Idempotency-Key": "current-batch-1"},
    )
    assert advanced.status_code == 200, advanced.text
    assert advanced.json()["nextBatchIndex"] == 2
    assert replay_first_batch() == before
    rewritten = json.loads(path.read_bytes())
    assert rewritten["batches"][0]["response"] == stored_response
    assert rewritten["request"] == historical["request"]
    assert rewritten["requestFingerprint"] == historical["requestFingerprint"]

    repository.initialize()
    assert replay_first_batch() == before
    assert client.get(route).json() == advanced.json()
    assert json.loads(path.read_bytes()) == rewritten


def test_pull_session_contract_models_are_strict_and_camel_case() -> None:
    capability = StructuringProviderCapability(
        provider=CaptureEngine(
            engine="ollama",
            model="test-model",
            digest=f"sha256:{'a' * 64}",
        ),
        schema_dialect=SCHEMA_DIALECT,
    )
    request = OpenStructuringSession(
        target_language="fr",
        profile_id="qwen3.5-0.8b-structure-v1",
        provider_capability=capability,
        schema_dialect=SCHEMA_DIALECT,
    )
    assert (
        request.model_dump(by_alias=True)["providerCapability"]["schemaDialect"] == SCHEMA_DIALECT
    )
    with pytest.raises(ValueError):
        OpenStructuringSession.model_validate(
            {**request.model_dump(by_alias=True), "unexpected": True}
        )
    with pytest.raises(ValueError):
        OpenStructuringSession.model_validate(
            {**request.model_dump(by_alias=True), "rawSourceSha256": "a" * 64}
        )
