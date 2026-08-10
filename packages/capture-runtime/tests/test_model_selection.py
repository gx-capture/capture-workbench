from __future__ import annotations

import json
import time
from pathlib import Path

from conftest import TOKEN, idempotency_headers
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.model_catalog import MODEL_OPTIONS, ActiveModelSelectionStore, catalog_sha256
from capture_runtime.ollama import FakeRuntimeInstaller


def test_model_options_are_allowlisted_and_do_not_start_a_model_store(
    settings_factory,
) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="ollama")
    installer = FakeRuntimeInstaller()
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v1/runtime/model-options")

    assert response.status_code == 200, response.text
    payload = response.json()
    assert payload["catalogSha256"] == catalog_sha256()
    assert [item["optionId"] for item in payload["items"]] == [
        option.option_id for option in MODEL_OPTIONS
    ]
    assert all(item["status"] == "not-installed" for item in payload["items"])
    assert not (settings.app_data_dir / "ollama" / "models").exists()


def test_model_options_report_selection_from_isolated_ollama_app_data(settings_factory) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="ollama")
    option = MODEL_OPTIONS[0]
    ActiveModelSelectionStore(settings.app_data_dir / "ollama").save(
        option,
        observed_digest="a" * 64,
        observed_bytes=123,
    )
    with TestClient(
        create_app(settings, installer=FakeRuntimeInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v1/runtime/model-options")

    assert response.status_code == 200, response.text
    active = [item for item in response.json()["items"] if item["status"] == "active"]
    assert [item["optionId"] for item in active] == [option.option_id]


def test_model_installation_accepts_only_option_id_and_is_idempotent(settings_factory) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="ollama")
    installer = FakeRuntimeInstaller()
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        headers = idempotency_headers()
        response = client.post(
            "/v1/runtime/model-installations",
            headers=headers,
            json={"optionId": "qwen3.5-0.8b-v1", "consent": True},
        )
        assert response.status_code == 202, response.text
        installation_id = response.json()["installationId"]
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            job = client.get(f"/v1/runtime/model-installations/{installation_id}").json()
            if job["status"] == "completed":
                break
            time.sleep(0.01)
        assert job["status"] == "completed"
        replay = client.post(
            "/v1/runtime/model-installations",
            headers=headers,
            json={"optionId": "qwen3.5-0.8b-v1", "consent": True},
        )
        assert replay.status_code == 202
        assert replay.json()["installationId"] == installation_id
        unknown = client.post(
            "/v1/runtime/model-installations",
            headers=idempotency_headers(),
            json={"optionId": "qwen3.5-7b-v1", "consent": True},
        )
        assert unknown.status_code == 422
        assert unknown.json()["error"]["code"] == "model_option_unknown"


def test_active_model_selection_is_runtime_owned_and_catalog_bound(tmp_path: Path) -> None:
    store = ActiveModelSelectionStore(tmp_path)
    option = MODEL_OPTIONS[0]
    store.save(option, observed_digest="a" * 64, observed_bytes=123)

    payload = store.load()
    assert payload is not None
    assert payload["optionId"] == option.option_id
    assert payload["catalogSha256"] == catalog_sha256()
    assert payload["observedModelBytes"] == 123

    payload["catalogSha256"] = "b" * 64
    store.path.write_text(json.dumps(payload), encoding="utf-8")
    assert store.load() is None


def test_active_model_selection_rejects_invalid_observed_digest_or_size(tmp_path: Path) -> None:
    store = ActiveModelSelectionStore(tmp_path)
    option = MODEL_OPTIONS[0]
    store.save(option, observed_digest="a" * 64, observed_bytes=123)

    payload = json.loads(store.path.read_text(encoding="utf-8"))
    payload["observedModelDigest"] = "not-a-digest"
    store.path.write_text(json.dumps(payload), encoding="utf-8")
    assert store.load() is None

    store.save(option, observed_digest="a" * 64, observed_bytes=123)
    payload = json.loads(store.path.read_text(encoding="utf-8"))
    payload["observedModelBytes"] = 0
    store.path.write_text(json.dumps(payload), encoding="utf-8")
    assert store.load() is None


def test_host_runtime_cannot_expose_model_selection(settings_factory) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="host")
    with TestClient(
        create_app(settings, installer=FakeRuntimeInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v1/runtime/model-options")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "requirement_disabled"
