from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.structuring.infrastructure.model_catalog import (
    MODEL_OPTIONS,
    ActiveModelSelectionStore,
    catalog_sha256,
    legacy_catalog_sha256,
    legacy_profile_id,
)
from tests.conftest import TOKEN, idempotency_headers
from tests.support.fake_requirement_installer import FakeRequirementInstaller


def test_model_options_are_allowlisted_and_do_not_start_a_model_store(
    settings_factory,
) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="ollama")
    installer = FakeRequirementInstaller()
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v2/runtime/structuring-model-options")
        retired_options = client.get("/v2/runtime/model-options")
        retired_installations = client.post(
            "/v2/runtime/model-installations",
            headers=idempotency_headers(),
            json={"optionId": "qwen3.5-0.8b-v1", "consent": True},
        )

    assert response.status_code == 200, response.text
    assert retired_options.status_code == 404
    assert retired_installations.status_code == 404
    payload = response.json()
    assert payload["catalogSha256"] == catalog_sha256()
    assert [item["optionId"] for item in payload["items"]] == [
        option.option_id for option in MODEL_OPTIONS
    ]
    assert all(item["status"] == "not-installed" for item in payload["items"])
    assert all("downloadBytes" in item and "expectedBytes" not in item for item in payload["items"])
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
        create_app(settings, installer=FakeRequirementInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v2/runtime/structuring-model-options")

    assert response.status_code == 200, response.text
    active = [item for item in response.json()["items"] if item["status"] == "active"]
    assert [item["optionId"] for item in active] == [option.option_id]


def test_model_installation_accepts_only_option_id_and_is_idempotent(settings_factory) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="ollama")
    installer = FakeRequirementInstaller()
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        headers = idempotency_headers()
        response = client.post(
            "/v2/runtime/structuring-model-installations",
            headers=headers,
            json={"optionId": "qwen3.5-0.8b-v1", "consent": True},
        )
        assert response.status_code == 202, response.text
        installation_id = response.json()["installationId"]
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            job = client.get(
                f"/v2/runtime/structuring-model-installations/{installation_id}"
            ).json()
            if job["status"] == "completed":
                break
            time.sleep(0.01)
        assert job["status"] == "completed"
        metadata_path = (
            settings.app_data_dir
            / "jobs"
            / "model-installations"
            / installation_id
            / "metadata.json"
        )
        before_bytes = metadata_path.read_bytes()
        reread = client.get(f"/v2/runtime/structuring-model-installations/{installation_id}")
        assert reread.status_code == 200
        assert reread.json() == job
        assert metadata_path.read_bytes() == before_bytes
        replay = client.post(
            "/v2/runtime/structuring-model-installations",
            headers=headers,
            json={"optionId": "qwen3.5-0.8b-v1", "consent": True},
        )
        assert replay.status_code == 202
        assert replay.json()["installationId"] == installation_id
        unknown = client.post(
            "/v2/runtime/structuring-model-installations",
            headers=idempotency_headers(),
            json={"optionId": "qwen3.5-7b-v1", "consent": True},
        )
        assert unknown.status_code == 422
        assert unknown.json()["error"]["code"] == "model_option_unknown"
        extra_field = client.post(
            "/v2/runtime/structuring-model-installations",
            headers=idempotency_headers(),
            json={"optionId": "qwen3.5-0.8b-v1", "consent": True, "expectedBytes": 123},
        )
        assert extra_field.status_code == 422
        assert extra_field.json()["error"]["code"] == "validation_error"


def test_active_model_selection_is_runtime_owned_and_catalog_bound(tmp_path: Path) -> None:
    store = ActiveModelSelectionStore(tmp_path)
    option = MODEL_OPTIONS[0]
    store.save(option, observed_digest="a" * 64, observed_bytes=123)

    payload = store.load()
    assert payload is not None
    assert payload["optionId"] == option.option_id
    assert payload["catalogSha256"] == catalog_sha256()
    assert payload["profileId"] == option.profile_id
    assert payload["profileSpecSha256"] == option.profile_spec_sha256
    assert payload["modelReference"] == option.model_reference
    assert payload["observedModelBytes"] == 123

    payload["catalogSha256"] = "b" * 64
    store.path.write_text(json.dumps(payload), encoding="utf-8")
    assert store.load() is None


def test_historical_prefixed_model_selection_marker_stays_readable_without_mutation(
    settings_factory,
) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="ollama")
    option = MODEL_OPTIONS[0]
    ollama_dir = settings.app_data_dir / "ollama"
    ollama_dir.mkdir(parents=True, exist_ok=True)
    store = ActiveModelSelectionStore(ollama_dir)
    # A 0.10 runtime wrote the marker under its retired requirement id.
    historical_path = store.path.with_name("capture-ollama-model.active.json")
    historical_path.parent.mkdir(parents=True, exist_ok=True)
    historical_marker = {
        "schemaVersion": "1",
        "catalogSha256": legacy_catalog_sha256(),
        "optionId": option.option_id,
        "profileId": legacy_profile_id(option),
        "modelReference": option.model_reference,
        "profileSpecSha256": option.profile_spec_sha256,
        "observedModelDigest": "a" * 64,
        "observedModelBytes": 123,
    }
    historical_path.write_text(json.dumps(historical_marker, indent=2), encoding="utf-8")
    before = historical_path.read_bytes()

    assert store.load() == historical_marker
    with TestClient(
        create_app(settings, installer=FakeRequirementInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v2/runtime/structuring-model-options")

    assert response.status_code == 200, response.text
    active = [item for item in response.json()["items"] if item["status"] == "active"]
    assert [item["optionId"] for item in active] == [option.option_id]
    assert historical_path.read_bytes() == before

    # Mixed legacy/current pairs fail closed without touching the stored bytes.
    mixed = {**historical_marker, "catalogSha256": catalog_sha256()}
    historical_path.write_text(json.dumps(mixed, indent=2), encoding="utf-8")
    mixed_bytes = historical_path.read_bytes()
    assert store.load() is None
    assert historical_path.read_bytes() == mixed_bytes


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
        create_app(settings, installer=FakeRequirementInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = client.get("/v2/runtime/structuring-model-options")

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "requirement_disabled"
