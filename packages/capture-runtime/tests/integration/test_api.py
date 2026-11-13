from __future__ import annotations

from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.contract_set import load_contract_set
from capture_runtime.contracts import (
    OcrAdapterClass,
    OcrComputeMode,
    OcrComputePreflightV2,
    OpenIngestionV2,
    StartCaptureV2,
    StructuringMode,
)
from capture_runtime.dependencies import build_runtime_dependencies
from capture_runtime.ocr.infrastructure.ocr_preflight import (
    OcrComputePreflight,
    OcrGpuAdapter,
    OcrGpuCapabilitySnapshot,
)
from capture_runtime.structuring.infrastructure.ollama import FakeRuntimeInstaller
from tests.conftest import TOKEN, idempotency_headers


class StaticCapabilityProbe:
    def probe(self) -> OcrGpuCapabilitySnapshot:
        return OcrGpuCapabilitySnapshot(
            adapters=(OcrGpuAdapter(index=0, adapter_class=OcrAdapterClass.DEDICATED),),
            dml_provider_available=True,
        )


def test_v2_health_auth_host_origin_and_version_handshake(client: TestClient) -> None:
    unauthorized = client.get("/v2/streaming/health/ready", headers={"Authorization": ""})
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "unauthorized"
    assert unauthorized.headers["www-authenticate"] == "Bearer"

    invalid_host = client.get("/v2/streaming/health/ready", headers={"Host": "attacker.invalid"})
    assert invalid_host.status_code == 400
    assert invalid_host.json()["error"]["code"] == "invalid_host"

    invalid_origin = client.get(
        "/v2/streaming/health/ready", headers={"Origin": "https://attacker.invalid"}
    )
    assert invalid_origin.status_code == 403
    assert invalid_origin.json()["error"]["code"] == "origin_not_allowed"

    ready = client.get("/v2/streaming/health/ready", headers={"Origin": "tauri://localhost"})
    assert ready.status_code == 200
    payload = ready.json()
    assert payload["protocolVersion"] == "2"
    assert payload["captureKinds"] == ["pdf", "image", "audio"]
    assert ready.headers["cache-control"] == "no-store"

    runtime_ready = client.get("/v2/health/ready")
    assert runtime_ready.status_code == 200
    runtime_payload = runtime_ready.json()
    assert runtime_payload["ready"] is True
    assert runtime_payload["apiVersion"] == "2.0"
    assert runtime_payload["captureDocumentSchemaVersion"] == "2"
    assert runtime_payload["captureDocumentSchemaSha256"]
    assert runtime_payload["contractSetVersion"] == "2"


def test_legacy_runtime_paths_are_not_public(client: TestClient) -> None:
    legacy_prefix = "/v" + "1"
    assert client.get(f"{legacy_prefix}/health/ready").status_code == 404
    assert client.get(f"{legacy_prefix}/captures").status_code == 404


def test_v2_runtime_requirements_and_installation_lifecycle(settings_factory) -> None:
    settings = settings_factory()
    with TestClient(
        create_app(settings, installer=FakeRuntimeInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        requirements = client.get("/v2/runtime/requirements")
        assert requirements.status_code == 200
        assert requirements.json()["items"]

        headers = idempotency_headers()
        created = client.post(
            "/v2/runtime/installations",
            headers=headers,
            json={"requirementId": "capture-ollama-model", "consent": True},
        )
        assert created.status_code == 202, created.text
        installation_id = created.json()["installationId"]
        replay = client.post(
            "/v2/runtime/installations",
            headers=headers,
            json={"requirementId": "capture-ollama-model", "consent": True},
        )
        assert replay.status_code == 202
        assert replay.json()["installationId"] == installation_id

        detail = client.get(f"/v2/runtime/installations/{installation_id}")
        assert detail.status_code == 200
        assert detail.json()["requirementId"] == "capture-ollama-model"


def test_v2_runtime_ready_reports_authenticated_ocr_compute_decision(settings_factory) -> None:
    settings = settings_factory()
    contract_set = load_contract_set()
    preflight = OcrComputePreflight(
        contract_sha256=contract_set.sha256,
        capability_probe=StaticCapabilityProbe(),
    )
    with TestClient(
        create_app(settings, ocr_preflight=preflight),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v2/health/ready")

    assert response.status_code == 200, response.text
    compute = response.json()["ocrCompute"]
    assert compute == {
        "apiVersion": "2.0",
        "schemaVersion": "1",
        "service": "capture-runtime",
        "runtimeVersion": RUNTIME_VERSION,
        "contractSetVersion": "2",
        "contractSha256": contract_set.sha256,
        "workerSha256": None,
        "mode": "gpu-dml",
        "adapterClass": "dedicated",
        "reasonCode": None,
        "userNoticeRequired": False,
        "noticeCode": None,
    }


def test_v2_runtime_ready_uses_worker_owned_compute_preflight(
    settings_factory,
    monkeypatch,
) -> None:
    settings = settings_factory()
    contract_set = load_contract_set()
    decision = OcrComputePreflightV2(
        contract_sha256=contract_set.sha256,
        mode=OcrComputeMode.GPU_DML,
        adapter_class=OcrAdapterClass.INTEGRATED,
        user_notice_required=False,
    )
    dependencies = build_runtime_dependencies(settings)
    calls: list[str] = []

    async def worker_probe(*, contract_sha256: str) -> object:
        calls.append(contract_sha256)
        return decision.model_dump(mode="json", by_alias=True)

    monkeypatch.setattr(dependencies.engine_manager, "ocr_compute_preflight", worker_probe)
    with TestClient(
        create_app(dependencies=dependencies),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v2/health/ready")

    assert response.status_code == 200, response.text
    assert response.json()["ocrCompute"] == decision.model_dump(mode="json", by_alias=True)
    assert calls == [contract_set.sha256]


def test_v2_runtime_ready_ocr_compute_requires_bearer_authentication(client: TestClient) -> None:
    response = client.get("/v2/health/ready", headers={"Authorization": ""})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_v2_contract_discovery_is_immutable_and_authenticated(client: TestClient) -> None:
    unauthorized = client.get("/meta/v2/contracts", headers={"Authorization": ""})
    assert unauthorized.status_code == 401
    index = client.get("/meta/v2/contracts")
    assert index.status_code == 200
    assert index.headers["cache-control"].endswith("immutable")
    href = index.json()["href"]
    bundle = client.get(href)
    assert bundle.status_code == 200
    assert bundle.headers["etag"] == index.headers["etag"]
    assert client.get(href, headers={"If-None-Match": bundle.headers["etag"]}).status_code == 304


def _uninstall(client: TestClient, requirement_id: str):
    return client.delete(f"/v2/runtime/requirements/{requirement_id}/installation")


def test_v2_uninstall_returns_the_requirement_not_installed_and_repeats_safely(
    settings_factory,
) -> None:
    settings = settings_factory()
    installer = FakeRuntimeInstaller(initially_ready={"windowsml-ocr"})
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        first = _uninstall(client, "windowsml-ocr")
        second = _uninstall(client, "windowsml-ocr")

    assert first.status_code == 200, first.text
    assert first.json()["requirementId"] == "windowsml-ocr"
    assert first.json()["status"] == "installable"
    assert "windowsml-ocr" not in installer.ready
    assert second.status_code == 200
    assert second.json() == first.json()


def test_v2_uninstall_rejects_unknown_disabled_and_non_engine_requirements(
    settings_factory,
) -> None:
    settings = settings_factory()
    with TestClient(
        create_app(settings, installer=FakeRuntimeInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        unknown = _uninstall(client, "no-such-engine")
        model = _uninstall(client, "capture-ollama-model")
    host_settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="host")
    with TestClient(
        create_app(host_settings, installer=FakeRuntimeInstaller()),
        base_url=f"http://127.0.0.1:{host_settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        disabled = _uninstall(client, "capture-ollama-model")

    assert (unknown.status_code, unknown.json()["error"]["code"]) == (
        404,
        "requirement_not_found",
    )
    assert (model.status_code, model.json()["error"]["code"]) == (
        422,
        "requirement_not_uninstallable",
    )
    assert (disabled.status_code, disabled.json()["error"]["code"]) == (
        422,
        "requirement_disabled",
    )


def test_v2_uninstall_conflicts_while_its_installation_runs(settings_factory) -> None:
    settings = settings_factory()
    installer = FakeRuntimeInstaller(initially_ready={"windowsml-ocr"}, delay_seconds=30)
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        created = client.post(
            "/v2/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "windowsml-ocr", "consent": True},
        )
        assert created.status_code == 202, created.text
        in_use = _uninstall(client, "windowsml-ocr")
        cancelled = client.post(
            f"/v2/runtime/installations/{created.json()['installationId']}/cancel"
        )
        assert cancelled.status_code == 200, cancelled.text
        after = _uninstall(client, "windowsml-ocr")

    assert (in_use.status_code, in_use.json()["error"]["code"]) == (409, "requirement_in_use")
    assert after.status_code == 200, after.text
    assert after.json()["status"] == "installable"


def test_v2_uninstall_conflicts_while_a_capture_is_active(settings_factory) -> None:
    settings = settings_factory()
    installer = FakeRuntimeInstaller(initially_ready={"speech-recognition"})
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        ingestion = client.post(
            "/v2/ingestions",
            json={
                "clientRequestId": "uninstall-ingestion",
                "fileName": "sample.mp3",
                "mediaType": "audio/mpeg",
                "totalBytes": 4,
            },
            headers={"X-Idempotency-Key": "uninstall-ingestion"},
        )
        assert ingestion.status_code == 201, ingestion.text
        capture = client.post(
            "/v2/captures",
            json={
                "clientRequestId": "uninstall-capture",
                "ingestionId": ingestion.json()["ingestionId"],
                "structuringMode": "host",
            },
            headers={"X-Idempotency-Key": "uninstall-capture"},
        )
        assert capture.status_code == 202, capture.text
        in_use = _uninstall(client, "speech-recognition")
        cancelled = client.post(f"/v2/captures/{capture.json()['captureId']}/cancel")
        assert cancelled.status_code == 200, cancelled.text
        after = _uninstall(client, "speech-recognition")

    assert (in_use.status_code, in_use.json()["error"]["code"]) == (409, "requirement_in_use")
    assert after.status_code == 200, after.text
    assert "speech-recognition" not in installer.ready


def test_startup_removes_legacy_spools_and_uploads_but_preserves_unrelated_files(
    settings_factory,
):
    settings = settings_factory()
    staging = settings.staging_root
    staging.mkdir(parents=True, exist_ok=True)
    for name in ("progressive-old-capture.spool", "abandoned.upload", "keep.spool", "notes.txt"):
        (staging / name).write_bytes(b"recording")
    with TestClient(create_app(settings)):
        assert {path.name for path in staging.iterdir()} == {"keep.spool", "notes.txt"}


def test_startup_cleans_only_owned_worker_temporary_files(settings_factory, tmp_path):
    from capture_runtime.constants import WORKER_TEMP_PREFIXES

    settings = settings_factory()
    temporary = settings.extraction.temp_dir
    temporary.mkdir(parents=True)
    names = [prefix + "abandoned.wav" for prefix in WORKER_TEMP_PREFIXES]
    for name in names:
        (temporary / name).write_bytes(b"audio")
    directory = temporary / (WORKER_TEMP_PREFIXES[0] + "directory")
    directory.mkdir()
    (directory / "nested.wav").write_bytes(b"keep")
    (temporary / "keep.wav").write_bytes(b"keep")
    with TestClient(create_app(settings)):
        assert all(not (temporary / name).exists() for name in names)
        assert (directory / "nested.wav").read_bytes() == b"keep"
        assert (temporary / "keep.wav").read_bytes() == b"keep"

    outside = tmp_path / "shared-temp"
    outside.mkdir()
    for name in names:
        (outside / name).write_bytes(b"shared")
    shared_settings = settings_factory(CAPTURE_EXTRACTION_TEMP_DIR=str(outside))
    with TestClient(create_app(shared_settings)):
        assert all((outside / name).read_bytes() == b"shared" for name in names)


def test_startup_reports_failed_waiting_capture_to_host(settings_factory):
    settings = settings_factory()
    app = create_app(settings)
    repository = app.state.streaming_repository
    repository.initialize()
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="restart-ingestion",
            file_name="sample.mp3",
            media_type="audio/mpeg",
            total_bytes=4,
        )
    )
    capture = repository.create_capture(
        StartCaptureV2(
            client_request_id="restart-capture",
            ingestion_id=ingestion.ingestion_id,
            structuring_mode=StructuringMode.HOST,
        )
    )
    repository.source_path(ingestion.ingestion_id).unlink()
    with TestClient(
        app,
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get(f"/v2/captures/{capture.capture_id}")
        assert response.status_code == 200, response.text
        assert response.json()["status"] == "failed"
        assert response.json()["error"]["code"] == "streaming_source_unavailable"
