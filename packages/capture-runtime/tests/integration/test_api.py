from __future__ import annotations

from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.contract_set import load_contract_set
from capture_runtime.contracts import OcrAdapterClass, OcrComputeMode, OcrComputePreflightV2
from capture_runtime.dependencies import build_runtime_dependencies
from capture_runtime.ocr_preflight import (
    OcrComputePreflight,
    OcrGpuAdapter,
    OcrGpuCapabilitySnapshot,
)
from capture_runtime.ollama import FakeRuntimeInstaller
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
        "runtimeVersion": "0.4.2",
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
