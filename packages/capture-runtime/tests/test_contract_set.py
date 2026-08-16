from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from conftest import TOKEN

from capture_runtime.contract_set import (
    CONTRACT_ASSET_PATH,
    CONTRACT_ASSET_SHA256_PATH,
    CONTRACT_SET_VERSION,
    ContractSet,
    ContractSetError,
    canonical_json_bytes,
    load_contract_set,
    validate_route_inventory,
)


def test_default_contract_set_is_deterministic_and_covers_v2() -> None:
    first = load_contract_set()
    second = load_contract_set()

    assert first.bundle_bytes == second.bundle_bytes
    assert first.index_bytes == second.index_bytes
    assert first.sha256 == hashlib.sha256(first.bundle_bytes).hexdigest()
    assert first.index["sha256"] == first.sha256
    assert {surface["id"] for surface in first.bundle["surfaces"]} == {"v2"}
    assert len(first.bundle["operations"]) == 31
    assert {operation["surface"] for operation in first.bundle["operations"]} == {"v2"}
    assert any(
        operation["path"] == "/v2/captures/{capture_id}/events"
        and operation["mediaType"] == "text/event-stream"
        for operation in first.bundle["operations"]
    )
    assert any(
        operation["id"] == "v2.health.ready"
        and operation["path"] == "/v2/health/ready"
        and operation["responseSchema"] == "RuntimeReady"
        for operation in first.bundle["operations"]
    )
    statuses = {
        operation["id"]: operation["responseStatusCodes"]
        for operation in first.bundle["operations"]
    }
    assert statuses["v2.ingestions.open"] == (201,)
    assert statuses["v2.captures.start"] == (202,)
    assert any(schema["name"] == "CaptureDocument" for schema in first.bundle["schemas"])
    unauthorized = next(
        problem for problem in first.bundle["problems"] if problem["code"] == "unauthorized"
    )
    assert unauthorized["category"] == "authentication"
    assert unauthorized["retryable"] is False
    assert unauthorized["detailsSchema"] == "ErrorDetailsV2"


def test_runtime_owned_schema_source_has_one_release_contract_identity() -> None:
    contract_set = load_contract_set()
    document = next(
        schema for schema in contract_set.bundle["schemas"] if schema["name"] == "CaptureDocument"
    )
    assert contract_set.bundle["contractSetVersion"] == CONTRACT_SET_VERSION
    assert document["schemaSha256"] == (
        "850afd212d049c25da41d3867ba5477451a6a2c6c7e41f116fe60f26b6a35335"
    )
    assert contract_set.sha256 == "71fdcf02ac4c836cc758172312fc536657068a5d91180da76f35d6d3266f8e3c"


def test_contract_set_index_bundle_loading_rejects_digest_drift() -> None:
    contract_set = load_contract_set()
    index = json.loads(contract_set.index_bytes)
    bundle = json.loads(contract_set.bundle_bytes)
    index["sha256"] = "0" * 64

    with pytest.raises(ContractSetError, match="does not match bundle"):
        load_contract_set(index=index, bundle=bundle)


def test_contract_set_deep_freezes_nested_catalog_data() -> None:
    contract_set = load_contract_set()
    with pytest.raises(TypeError):
        contract_set.bundle["operations"][0]["path"] = "/tampered"  # type: ignore[index]
    with pytest.raises(TypeError):
        contract_set.index["surfaces"][0]["id"] = "tampered"  # type: ignore[index]


def test_contract_set_canonical_json_is_sorted_and_compact() -> None:
    assert canonical_json_bytes({"z": 1, "a": [True, "\u00e9"]}) == b'{"a":[true,"\xc3\xa9"],"z":1}'


def test_contract_discovery_requires_bearer_and_serves_verified_bundle(client) -> None:
    unauthorized = client.get("/meta/v2/contracts", headers={"Authorization": ""})
    assert unauthorized.status_code == 401
    assert unauthorized.headers["www-authenticate"] == "Bearer"

    index_response = client.get("/meta/v2/contracts")
    assert index_response.status_code == 200
    contract_set = client.app.state.contract_set
    assert index_response.content == contract_set.index_bytes
    assert index_response.headers["etag"] == f'"{contract_set.sha256}"'
    assert index_response.headers["x-contract-sha256"] == contract_set.sha256
    index = index_response.json()
    assert index["catalogVersion"] == "2"
    assert index["runtimeVersion"] == "0.4.0"
    assert index["sha256"] == contract_set.sha256
    assert index["href"].endswith(f"/sha256/{contract_set.sha256}")
    assert index["mediaType"] == "application/json"

    bundle_response = client.get(index["href"])
    assert bundle_response.status_code == 200
    assert bundle_response.content == contract_set.bundle_bytes
    assert hashlib.sha256(bundle_response.content).hexdigest() == index["sha256"]
    assert bundle_response.headers["etag"] == index_response.headers["etag"]

    not_modified = client.get(
        index["href"],
        headers={"If-None-Match": bundle_response.headers["etag"]},
    )
    assert not_modified.status_code == 304
    assert not_modified.content == b""
    assert not_modified.headers["etag"] == bundle_response.headers["etag"]

    wrong_digest = client.get(f"/meta/v2/contracts/sha256/{'f' * 64}")
    assert wrong_digest.status_code == 404
    assert wrong_digest.json()["error"]["code"] == "contract_bundle_not_found"

    # The fixture's default client still carries the bearer token; make the
    # auth requirement explicit for a caller that supplies a different token.
    invalid_token = client.get(
        "/meta/v2/contracts",
        headers={"Authorization": f"Bearer {TOKEN[:-1]}x"},
    )
    assert invalid_token.status_code == 401


def test_v2_hard_cut_exposes_only_v2_public_operations_and_schemas() -> None:
    contract_set = load_contract_set()
    legacy_surface = "v" + "1"
    legacy_schema_suffix = "V" + "1"

    assert {surface["id"] for surface in contract_set.bundle["surfaces"]} == {"v2"}
    assert all(operation["surface"] == "v2" for operation in contract_set.bundle["operations"])
    assert all(
        not operation["path"].startswith(f"/{legacy_surface}/")
        for operation in contract_set.bundle["operations"]
    )
    assert all(
        not schema["name"].endswith(legacy_schema_suffix)
        for schema in contract_set.bundle["schemas"]
    )


def test_route_inventory_rejects_a_legacy_public_route() -> None:
    contract_set = load_contract_set()
    legacy_path = "/v" + "1/health/ready"

    with pytest.raises(ContractSetError, match="route inventory drift"):
        validate_route_inventory(
            [("GET", legacy_path)],
            contract_set,
        )


def test_packaged_contract_asset_is_byte_verified_and_matches_runtime(
    monkeypatch, tmp_path: Path
) -> None:
    bundle_path = tmp_path / "contract-set.json"
    digest_path = tmp_path / "contract-set.sha256"
    bundle_path.write_bytes(CONTRACT_ASSET_PATH.read_bytes())
    digest_path.write_bytes(CONTRACT_ASSET_SHA256_PATH.read_bytes())
    monkeypatch.setattr("capture_runtime.contract_set.CONTRACT_ASSET_PATH", bundle_path)
    monkeypatch.setattr("capture_runtime.contract_set.CONTRACT_ASSET_SHA256_PATH", digest_path)

    loaded = load_contract_set()
    assert loaded.bundle_bytes == bundle_path.read_bytes()

    digest_path.write_text("0" * 64 + "\n", encoding="ascii")
    with pytest.raises(ContractSetError, match="digest does not match bytes"):
        load_contract_set()


def test_app_fails_closed_when_contract_route_inventory_drifts(settings_factory) -> None:
    from capture_runtime.app import create_app

    bundle = json.loads(load_contract_set().bundle_bytes)
    bundle["operations"].pop()
    stale = ContractSet.from_bundle(bundle)
    with pytest.raises(RuntimeError, match="route inventory drift"):
        create_app(settings_factory(), contract_set=stale)


def test_executable_packaging_embeds_contract_bytes_and_digest() -> None:
    root = Path(__file__).resolve().parents[1]
    spec = (root / "pyinstaller" / "capture-runtime.spec").read_text(encoding="utf-8")
    pyproject = (root / "pyproject.toml").read_text(encoding="utf-8")

    assert 'contract_assets / "contract-set.json"' in spec
    assert 'contract_assets / "contract-set.sha256"' in spec
    assert '"src/capture_runtime/assets/contract-set.json"' in pyproject
    assert '"src/capture_runtime/assets/contract-set.sha256"' in pyproject
