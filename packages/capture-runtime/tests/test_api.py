from __future__ import annotations

from collections.abc import Callable

from conftest import TOKEN, idempotency_headers, poll_installation
from fastapi.testclient import TestClient

from capture_runtime.config import RuntimeSettings
from capture_runtime.ollama import FakeRuntimeInstaller


def test_health_auth_host_origin_and_version_handshake(client: TestClient) -> None:
    unauthorized = client.get("/v1/health/ready", headers={"Authorization": ""})
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "unauthorized"
    assert unauthorized.headers["www-authenticate"] == "Bearer"

    invalid_host = client.get("/v1/health/ready", headers={"Host": "attacker.invalid"})
    assert invalid_host.status_code == 400
    assert invalid_host.json()["error"]["code"] == "invalid_host"

    ready = client.get("/v1/health/ready", headers={"Origin": "tauri://localhost"})
    assert ready.status_code == 200
    assert ready.json()["service"] == "capture-runtime"
    assert ready.json()["capabilities"]["captureKinds"] == ["pdf", "image", "audio"]

    streaming = client.get("/v2/health/ready")
    assert streaming.status_code == 200
    assert streaming.json()["protocolVersion"] == "2"
    assert streaming.json()["captureKinds"] == ["pdf", "image", "audio"]


def test_runtime_installation_submission_and_cancellation(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    installer = FakeRuntimeInstaller(delay_seconds=5)
    from capture_runtime.app import create_app

    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        created = test_client.post(
            "/v1/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "whisper-primary", "consent": True},
        )
        assert created.status_code == 202, created.text
        installation_id = created.json()["installationId"]
        running = poll_installation(
            test_client,
            installation_id,
            lambda value: value["status"] in {"running", "completed"},
        )
        if running["status"] == "running":
            cancelled = test_client.post(f"/v1/runtime/installations/{installation_id}/cancel")
            assert cancelled.status_code == 200, cancelled.text
            assert cancelled.json()["status"] == "cancelled"
