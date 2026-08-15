from __future__ import annotations

from conftest import TOKEN, idempotency_headers
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.ollama import FakeRuntimeInstaller


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
