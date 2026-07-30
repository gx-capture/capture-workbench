from __future__ import annotations

import hashlib
import threading
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from io import BytesIO

import pytest
from conftest import TOKEN, idempotency_headers, poll_capture, poll_installation
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from capture_runtime.app import create_app
from capture_runtime.clock import SystemClock
from capture_runtime.config import RuntimeSettings
from capture_runtime.extractors import DeterministicCaptureExtractor
from capture_runtime.ollama import (
    FakeRuntimeInstaller,
    IsolatedOllamaLifecycle,
    SystemRuntimeInstaller,
)
from capture_runtime.structuring import FakeCaptureStructuringProvider


def test_health_auth_host_origin_and_version_handshake(client: TestClient) -> None:
    unauthorized = client.get("/v1/health/ready", headers={"Authorization": ""})
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "unauthorized"
    assert unauthorized.headers["www-authenticate"] == "Bearer"

    invalid_host = client.get("/v1/health/ready", headers={"Host": "attacker.invalid"})
    assert invalid_host.status_code == 400
    assert invalid_host.json()["error"]["code"] == "invalid_host"

    userinfo_host = client.get(
        "/v1/health/ready",
        headers={"Host": f"user@127.0.0.1:{client.app.state.settings.port}"},
    )
    assert userinfo_host.status_code == 400
    wrong_port = client.get("/v1/health/ready", headers={"Host": "127.0.0.1:65534"})
    assert wrong_port.status_code == 400

    invalid_origin = client.get("/v1/health/ready", headers={"Origin": "https://attacker.invalid"})
    assert invalid_origin.status_code == 403
    assert invalid_origin.json()["error"]["code"] == "origin_not_allowed"

    ready = client.get("/v1/health/ready", headers={"Origin": "tauri://localhost"})
    assert ready.status_code == 200
    assert ready.json() == {
        "ready": True,
        "service": "capture-runtime",
        "apiVersion": "1.0",
        "runtimeVersion": "0.3.4",
        "captureDocumentSchemaVersion": "1",
        "capabilities": {
            "captureKinds": ["pdf", "image", "audio"],
            "structuringModes": ["runtime", "host"],
            "supportsCancellation": True,
            "supportsRawDiagnostics": True,
            "maxUploadBytes": 50 * 1024 * 1024,
        },
        "message": None,
    }
    assert ready.headers["x-content-type-options"] == "nosniff"


def test_runtime_capture_idempotency_result_raw_and_delete(client: TestClient) -> None:
    key = idempotency_headers()
    content = b"%PDF-1.7\nCAPTURE_TEXT:First page\fSecond page"
    create = client.post(
        "/v1/captures",
        headers=key,
        files={"file": ("sample.pdf", content, "application/octet-stream")},
        data={"sourceKind": "pdf", "structuringMode": "runtime", "targetLanguage": "zh-TW"},
    )
    assert create.status_code == 202, create.text
    capture_id = create.json()["captureId"]

    repeated = client.post(
        "/v1/captures",
        headers=key,
        files={"file": ("renamed.pdf", content, "application/pdf")},
        data={"sourceKind": "pdf", "structuringMode": "runtime", "targetLanguage": "zh-TW"},
    )
    assert repeated.status_code == 202
    assert repeated.json()["captureId"] == capture_id

    conflict = client.post(
        "/v1/captures",
        headers=key,
        files={"file": ("sample.pdf", content + b"changed", "application/pdf")},
        data={"sourceKind": "pdf", "structuringMode": "runtime", "targetLanguage": "zh-TW"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["error"]["code"] == "idempotency_conflict"

    completed = poll_capture(client, capture_id, lambda job: job["status"] == "completed")
    assert completed["stage"] == "completed"
    assert completed["progress"] == 1
    assert completed["source"]["sha256"] == hashlib.sha256(content).hexdigest()

    raw = client.get(f"/v1/captures/{capture_id}/raw")
    assert raw.status_code == 200
    assert raw.json()["diagnosticOnly"] is True
    assert [segment["locator"]["page"] for segment in raw.json()["segments"]] == [1, 2]

    result = client.get(f"/v1/captures/{capture_id}/result")
    assert result.status_code == 200
    payload = result.json()
    assert payload["sourceText"] == "First page\nSecond page"
    assert payload["targetText"] == "[zh-TW] First page\n[zh-TW] Second page"
    assert [block["type"] for block in payload["blocks"]] == ["paragraph", "paragraph"]
    assert not (client.app.state.capture_repository.root / capture_id / "source.bin").exists()

    deleted = client.delete(f"/v1/captures/{capture_id}")
    assert deleted.status_code == 204
    missing = client.get(f"/v1/captures/{capture_id}")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "capture_not_found"


def test_fake_image_and_audio_locators(client: TestClient) -> None:
    fixtures = [
        (
            b"\x89PNG\r\n\x1a\nCAPTURE_TEXT:Image words",
            "image.png",
            "page",
            "paragraph",
        ),
        (
            b"RIFF\x00\x00\x00\x00WAVECAPTURE_TEXT:Hello|World",
            "audio.wav",
            "time",
            "transcript",
        ),
    ]
    for content, name, locator_kind, block_type in fixtures:
        response = client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": (name, content, "application/octet-stream")},
            data={
                "sourceKind": "image" if name.endswith(".png") else "audio",
                "structuringMode": "runtime",
            },
        )
        assert response.status_code == 202
        capture_id = response.json()["captureId"]
        poll_capture(client, capture_id, lambda job: job["status"] == "completed")
        result = client.get(f"/v1/captures/{capture_id}/result").json()
        assert all(block["locator"]["kind"] == locator_kind for block in result["blocks"])
        assert all(block["type"] == block_type for block in result["blocks"])


def _host_candidate(raw: dict[str, object]) -> dict[str, object]:
    segments = raw["segments"]
    assert isinstance(segments, list)
    blocks = [
        {
            "blockId": f"host-block-{index + 1}",
            "order": index,
            "type": "paragraph",
            "sourceSegmentId": segment["segmentId"],
            "locator": segment["locator"],
            "sourceText": segment["text"],
            "targetText": segment["text"],
        }
        for index, segment in enumerate(segments)
    ]
    engine_text = "host-provider:model-v1"
    return {
        "schemaVersion": "1",
        "source": raw["source"],
        "rawSegments": segments,
        "blocks": blocks,
        "sourceText": raw["sourceText"],
        "targetText": "\n".join(block["targetText"] for block in blocks),
        "extractionEngine": raw["extractionEngine"],
        "structuringEngine": {
            "engine": "host-provider",
            "model": "model-v1",
            "digest": f"sha256:{hashlib.sha256(engine_text.encode()).hexdigest()}",
        },
        "warnings": raw["warnings"],
        "createdAt": raw["createdAt"],
        "completedAt": datetime.now(UTC).isoformat(),
    }


def test_host_structuring_strict_validation_commit_and_failure(client: TestClient) -> None:
    content = b"%PDF-1.7\nCAPTURE_TEXT:Host words"

    def create_host(name: str) -> tuple[str, dict[str, object]]:
        created = client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": (name, content, "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "host"},
        )
        capture_id = created.json()["captureId"]
        awaiting = poll_capture(
            client, capture_id, lambda job: job["stage"] == "awaiting_structuring"
        )
        assert awaiting["status"] == "running"
        unavailable = client.get(f"/v1/captures/{capture_id}/result")
        assert unavailable.status_code == 409
        return capture_id, client.get(f"/v1/captures/{capture_id}/raw").json()

    invalid_id, invalid_raw = create_host("invalid-extra.pdf")
    extra = {**_host_candidate(invalid_raw), "unexpected": True}
    invalid_extra = client.post(
        f"/v1/captures/{invalid_id}/structure",
        headers=idempotency_headers(),
        json=extra,
    )
    assert invalid_extra.status_code == 422
    assert invalid_extra.json()["error"]["code"] == "invalid_structure"
    invalid_job = client.get(f"/v1/captures/{invalid_id}").json()
    assert invalid_job["status"] == "failed"
    assert invalid_job["error"]["stage"] == "structuring"
    assert client.get(f"/v1/captures/{invalid_id}/raw").status_code == 200
    assert client.get(f"/v1/captures/{invalid_id}/result").status_code == 409

    digest_id, digest_raw = create_host("invalid-digest.pdf")
    extraction_digest_mismatch = _host_candidate(digest_raw)
    extraction_digest_mismatch["extractionEngine"] = {
        **digest_raw["extractionEngine"],
        "digest": f"sha256:{'0' * 64}",
    }
    invalid_digest_provenance = client.post(
        f"/v1/captures/{digest_id}/structure",
        headers=idempotency_headers(),
        json=extraction_digest_mismatch,
    )
    assert invalid_digest_provenance.status_code == 422
    assert invalid_digest_provenance.json()["error"]["code"] == "invalid_structure"
    assert client.get(f"/v1/captures/{digest_id}").json()["status"] == "failed"

    capture_id, raw = create_host("valid.pdf")
    candidate = _host_candidate(raw)
    commit_headers = idempotency_headers()
    committed = client.post(
        f"/v1/captures/{capture_id}/structure",
        headers=commit_headers,
        json=candidate,
    )
    assert committed.status_code == 200
    assert committed.json()["status"] == "completed"
    repeated = client.post(
        f"/v1/captures/{capture_id}/structure",
        headers=commit_headers,
        json=candidate,
    )
    assert repeated.status_code == 200

    second_id, _ = create_host("reported-failure.pdf")
    failed = client.post(
        f"/v1/captures/{second_id}/structuring-failure",
        json={"code": "host_model_failed", "message": "Host model did not respond."},
    )
    assert failed.status_code == 200
    assert failed.json()["status"] == "failed"
    assert client.get(f"/v1/captures/{second_id}/raw").status_code == 200
    assert client.get(f"/v1/captures/{second_id}/result").status_code == 409


def test_host_terminal_commit_failure_and_cancel_are_atomic(client: TestClient) -> None:
    content = b"%PDF-1.7\nCAPTURE_TEXT:Race words"

    def race_request(
        kind: str,
        barrier: threading.Barrier,
        capture_id: str,
        candidate: dict[str, object],
        commit_headers: dict[str, str],
    ) -> tuple[str, int]:
        barrier.wait()
        if kind == "commit":
            response = client.post(
                f"/v1/captures/{capture_id}/structure",
                headers=commit_headers,
                json=candidate,
            )
        elif kind == "failure":
            response = client.post(
                f"/v1/captures/{capture_id}/structuring-failure",
                json={"code": "host_race_failed", "message": "Concurrent host failure."},
            )
        else:
            response = client.post(f"/v1/captures/{capture_id}/cancel")
        return kind, response.status_code

    for iteration in range(5):
        created = client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": (f"race-{iteration}.pdf", content, "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "host"},
        )
        assert created.status_code == 202
        capture_id = created.json()["captureId"]
        poll_capture(client, capture_id, lambda job: job["stage"] == "awaiting_structuring")
        raw = client.get(f"/v1/captures/{capture_id}/raw").json()
        candidate = _host_candidate(raw)
        commit_headers = idempotency_headers()
        barrier = threading.Barrier(3)

        with ThreadPoolExecutor(max_workers=3) as executor:
            outcomes = [
                future.result()
                for future in [
                    executor.submit(
                        race_request,
                        kind,
                        barrier,
                        capture_id,
                        candidate,
                        commit_headers,
                    )
                    for kind in ["commit", "failure", "cancel"]
                ]
            ]

        assert all(status_code in {200, 409} for _, status_code in outcomes)
        terminal = client.get(f"/v1/captures/{capture_id}").json()
        assert terminal["status"] in {"completed", "failed", "cancelled"}
        assert terminal["completedAt"] is not None
        assert client.get(f"/v1/captures/{capture_id}/raw").status_code == 200
        result = client.get(f"/v1/captures/{capture_id}/result")
        assert result.status_code == (200 if terminal["status"] == "completed" else 409)
        assert not (client.app.state.capture_repository.root / capture_id / "source.bin").exists()

        repeated_commit = client.post(
            f"/v1/captures/{capture_id}/structure",
            headers=commit_headers,
            json=candidate,
        )
        assert repeated_commit.status_code == (200 if terminal["status"] == "completed" else 409)
        repeated_failure = client.post(
            f"/v1/captures/{capture_id}/structuring-failure",
            json={"code": "late_failure", "message": "Must not overwrite terminal state."},
        )
        assert repeated_failure.status_code == 409
        repeated_cancel = client.post(f"/v1/captures/{capture_id}/cancel")
        assert repeated_cancel.status_code == 200
        assert repeated_cancel.json()["status"] == terminal["status"]
        assert client.get(f"/v1/captures/{capture_id}").json()["status"] == terminal["status"]


def test_invalid_runtime_structure_preserves_diagnostic_raw(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    clock = SystemClock()
    app = create_app(
        settings,
        clock=clock,
        extractor=DeterministicCaptureExtractor(clock),
        structurer=FakeCaptureStructuringProvider(clock, mode="invalid_order"),
        installer=FakeRuntimeInstaller(),
    )
    with TestClient(
        app,
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        response = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("invalid.pdf", b"%PDF-1.7\nCAPTURE_TEXT:raw", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        )
        capture_id = response.json()["captureId"]
        failed = poll_capture(test_client, capture_id, lambda job: job["status"] == "failed")
        assert failed["error"]["code"] == "structuring_invalid_output"
        assert test_client.get(f"/v1/captures/{capture_id}/raw").status_code == 200
        assert test_client.get(f"/v1/captures/{capture_id}/result").status_code == 409


def test_runtime_provider_identity_digest_is_strict(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    clock = SystemClock()
    app = create_app(
        settings,
        clock=clock,
        extractor=DeterministicCaptureExtractor(clock),
        structurer=FakeCaptureStructuringProvider(clock, mode="invalid_structuring_digest"),
        installer=FakeRuntimeInstaller(),
    )
    with TestClient(
        app,
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        response = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("digest.pdf", b"%PDF-1.7\nCAPTURE_TEXT:raw", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        )
        failed = poll_capture(
            test_client,
            response.json()["captureId"],
            lambda value: value["status"] == "failed",
        )
        assert failed["error"]["code"] == "structuring_invalid_output"


def test_capture_and_installation_cancellation_and_install_idempotency(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    clock = SystemClock()
    installer = FakeRuntimeInstaller(delay_seconds=5)
    app = create_app(
        settings,
        clock=clock,
        extractor=DeterministicCaptureExtractor(clock, delay_seconds=5),
        structurer=FakeCaptureStructuringProvider(clock),
        installer=installer,
    )
    with TestClient(
        app,
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        capture = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("slow.pdf", b"%PDF-1.7 slow", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        ).json()
        cancelled = test_client.post(f"/v1/captures/{capture['captureId']}/cancel")
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelled"

        key = idempotency_headers()
        install = test_client.post(
            "/v1/runtime/installations",
            headers=key,
            json={"requirementId": "windowsml-ocr", "consent": True},
        )
        assert install.status_code == 202
        installation_id = install.json()["installationId"]
        repeated = test_client.post(
            "/v1/runtime/installations",
            headers=key,
            json={"requirementId": "windowsml-ocr", "consent": True},
        )
        assert repeated.json()["installationId"] == installation_id
        conflict = test_client.post(
            "/v1/runtime/installations",
            headers=key,
            json={"requirementId": "whisper-primary", "consent": True},
        )
        assert conflict.status_code == 409
        cancelled_install = test_client.post(f"/v1/runtime/installations/{installation_id}/cancel")
        assert cancelled_install.status_code == 200
        assert cancelled_install.json()["status"] == "cancelled"


def test_manual_installation_status(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    installer = FakeRuntimeInstaller(manual_requirements={"windowsml-ocr"})
    app = create_app(settings, installer=installer)
    with TestClient(
        app,
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        requirements = test_client.get("/v1/runtime/requirements")
        assert requirements.status_code == 200
        item = next(
            entry
            for entry in requirements.json()["items"]
            if entry["requirementId"] == "windowsml-ocr"
        )
        assert item["status"] == "manual_action_required"
        response = test_client.post(
            "/v1/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "windowsml-ocr", "consent": True},
        )
        job = poll_installation(
            test_client,
            response.json()["installationId"],
            lambda value: value["status"] == "manual_action_required",
        )
        assert job["error"]["code"] == "manual_action_required"


def test_upload_validation_and_production_provider_fail_closed(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory(CAPTURE_MAX_UPLOAD_BYTES="16")
    app = create_app(settings)
    with TestClient(
        app,
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        missing_key = test_client.post(
            "/v1/captures",
            files={"file": ("input.pdf", b"%PDF-1.7", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        )
        assert missing_key.status_code == 422
        assert missing_key.json()["error"]["code"] == "validation_error"
        corrupt = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("input.pdf", b"broken", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        )
        assert corrupt.status_code == 415
        assert corrupt.json()["error"]["code"] == "unsupported_media_type"
        mismatch = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("input.pdf", b"%PDF-1.7", "application/pdf")},
            data={"sourceKind": "image", "structuringMode": "runtime"},
        )
        assert mismatch.status_code == 422
        assert mismatch.json()["error"]["code"] == "source_kind_mismatch"
        oversized = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("input.pdf", b"%PDF-1.7" + b"x" * 20, "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        )
        assert oversized.status_code == 413
        assert oversized.json()["error"]["code"] == "upload_too_large"
        assert list(test_client.app.state.staging_root.glob("*.upload")) == []

    production = settings_factory(
        CAPTURE_EXTRACTION_PROVIDER="runtime",
        CAPTURE_STRUCTURING_PROVIDER="fake",
    )
    scanned_pdf = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.write(scanned_pdf)
    with TestClient(
        create_app(production),
        base_url=f"http://127.0.0.1:{production.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as production_client:
        response = production_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("input.pdf", scanned_pdf.getvalue(), "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        )
        failed = poll_capture(
            production_client,
            response.json()["captureId"],
            lambda value: value["status"] == "failed",
        )
        assert failed["error"]["code"] == "requirement_unavailable"


def test_chunked_structuring_candidate_body_is_bounded(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory(CAPTURE_MAX_CANDIDATE_BYTES="32")
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        response = test_client.post(
            "/v1/captures/00000000-0000-0000-0000-000000000000/structure",
            headers={"Content-Type": "application/json"},
            content=iter([b'{"candidate":"', b"x" * 64, b'"}']),
        )
        assert response.status_code == 413, response.text
        assert response.json()["error"]["code"] == "candidate_too_large"


def test_successful_fake_install_updates_requirements(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    installer = FakeRuntimeInstaller()
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        response = test_client.post(
            "/v1/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "capture-ollama-model", "consent": True},
        )
        job = poll_installation(
            test_client,
            response.json()["installationId"],
            lambda value: value["status"] == "completed",
        )
        assert job["progress"] == 1
        listed = test_client.get("/v1/runtime/installations").json()["items"]
        assert any(item["installationId"] == job["installationId"] for item in listed)
        requirements = test_client.get("/v1/runtime/requirements").json()["items"]
        model = next(
            item for item in requirements if item["requirementId"] == "capture-ollama-model"
        )
        assert model["status"] == "ready"


def test_fake_installer_requirement_listing_preserves_default_behavior() -> None:
    installer = FakeRuntimeInstaller(initially_ready={"capture-ollama-model"})

    assert {item.requirement_id for item in installer.requirements()} == {
        "windowsml-ocr",
        "whisper-primary",
        "ollama-runtime",
        "capture-ollama-model",
    }


def test_host_requirements_scope_an_injected_installer_before_probing(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    class ScopeRecordingInstaller(FakeRuntimeInstaller):
        seen_requirement_ids: frozenset[str] | None = None

        def requirements(self, enabled_requirement_ids=None):
            self.seen_requirement_ids = frozenset(enabled_requirement_ids or ())
            if self.seen_requirement_ids.intersection({"ollama-runtime", "capture-ollama-model"}):
                raise AssertionError("host-only discovery received an Ollama requirement")
            return super().requirements(enabled_requirement_ids)

    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="host")
    installer = ScopeRecordingInstaller()
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        requirements = test_client.get("/v1/runtime/requirements")

    assert requirements.status_code == 200
    assert {item["requirementId"] for item in requirements.json()["items"]} == {
        "windowsml-ocr",
        "whisper-primary",
    }
    assert installer.seen_requirement_ids == frozenset({"windowsml-ocr", "whisper-primary"})


def test_host_only_process_advertises_and_accepts_only_host_structuring(
    settings_factory: Callable[..., RuntimeSettings],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def reject_ollama_probe(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("host-only requirement discovery must not probe Ollama")

    monkeypatch.setattr(IsolatedOllamaLifecycle, "executable", reject_ollama_probe)
    monkeypatch.setattr(SystemRuntimeInstaller, "_active_model_profile_ready", reject_ollama_probe)
    monkeypatch.setattr("capture_runtime.ollama.shutil.which", reject_ollama_probe)

    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="host")
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        ready = test_client.get("/v1/health/ready")
        assert ready.status_code == 200
        assert ready.json()["capabilities"]["structuringModes"] == ["host"]

        requirements = test_client.get("/v1/runtime/requirements").json()["items"]
        assert {item["requirementId"] for item in requirements} == {
            "windowsml-ocr",
            "whisper-primary",
        }
        for requirement_id in ("ollama-runtime", "capture-ollama-model"):
            ollama_install = test_client.post(
                "/v1/runtime/installations",
                headers=idempotency_headers(),
                json={"requirementId": requirement_id, "consent": True},
            )
            assert ollama_install.status_code == 422
            assert ollama_install.json()["error"]["code"] == "requirement_disabled"

        runtime_capture = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("runtime.pdf", b"%PDF-1.7 runtime", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "runtime"},
        )
        assert runtime_capture.status_code == 422
        assert runtime_capture.json()["error"]["code"] == "structuring_mode_unavailable"

        host_capture = test_client.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("host.pdf", b"%PDF-1.7\nCAPTURE_TEXT:host", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "host"},
        )
        assert host_capture.status_code == 202
        awaiting = poll_capture(
            test_client,
            host_capture.json()["captureId"],
            lambda value: value["stage"] == "awaiting_structuring",
        )
        assert awaiting["status"] == "running"


def test_external_ollama_mode_disables_local_ollama_installation(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory(
        CAPTURE_STRUCTURING_PROVIDER="external-ollama",
        CAPTURE_OLLAMA_ENDPOINT="https://ollama.internal",
        CAPTURE_OLLAMA_MODEL="qwen3.5:4b",
    )
    with TestClient(
        create_app(settings, installer=FakeRuntimeInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        ready = test_client.get("/v1/health/ready")
        assert ready.status_code == 200
        assert ready.json()["capabilities"]["structuringModes"] == ["runtime", "host"]

        requirements = test_client.get("/v1/runtime/requirements")
        assert requirements.status_code == 200
        assert {item["requirementId"] for item in requirements.json()["items"]} == {
            "windowsml-ocr",
            "whisper-primary",
        }

        installation = test_client.post(
            "/v1/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "capture-ollama-model", "consent": True},
        )
        assert installation.status_code == 422
        assert installation.json()["error"]["code"] == "requirement_disabled"
