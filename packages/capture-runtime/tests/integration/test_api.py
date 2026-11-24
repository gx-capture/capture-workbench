from __future__ import annotations

import sys

import pytest
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.contract_set import load_contract_set
from capture_runtime.contracts import (
    OcrAdapterClass,
    OcrComputeMode,
    OpenIngestion,
    StartCapture,
    StructuringMode,
)
from capture_runtime.contracts import (
    OcrComputePreflight as OcrComputePreflightContract,
)
from capture_runtime.dependencies import build_runtime_dependencies
from capture_runtime.ocr.infrastructure.ocr_preflight import (
    OcrComputePreflight,
    OcrGpuAdapter,
    OcrGpuCapabilitySnapshot,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineFilesInUseError,
    EngineInstallationError,
    EngineInstallBusyError,
)
from capture_runtime.provisioning.infrastructure.system_requirement_installer import (
    SystemRequirementInstaller,
)
from tests.conftest import TOKEN, idempotency_headers
from tests.support.fake_requirement_installer import FakeRequirementInstaller


class StaticCapabilityProbe:
    def probe(self) -> OcrGpuCapabilitySnapshot:
        return OcrGpuCapabilitySnapshot(
            adapters=(OcrGpuAdapter(index=0, adapter_class=OcrAdapterClass.DEDICATED),),
            dml_provider_available=True,
        )


def test_v2_health_auth_host_origin_and_version_handshake(client: TestClient) -> None:
    unauthorized = client.get("/v2/health/ready", headers={"Authorization": ""})
    assert unauthorized.status_code == 401
    assert unauthorized.json()["error"]["code"] == "unauthorized"
    assert unauthorized.headers["www-authenticate"] == "Bearer"

    invalid_host = client.get("/v2/health/ready", headers={"Host": "attacker.invalid"})
    assert invalid_host.status_code == 400
    assert invalid_host.json()["error"]["code"] == "invalid_host"

    invalid_origin = client.get("/v2/health/ready", headers={"Origin": "https://attacker.invalid"})
    assert invalid_origin.status_code == 403
    assert invalid_origin.json()["error"]["code"] == "origin_not_allowed"

    runtime_ready = client.get("/v2/health/ready", headers={"Origin": "tauri://localhost"})
    assert runtime_ready.status_code == 200
    assert runtime_ready.headers["cache-control"] == "no-store"
    runtime_payload = runtime_ready.json()
    assert runtime_payload["capabilities"]["captureKinds"] == ["pdf", "image", "recording"]
    assert "protocolVersion" not in runtime_payload["capabilities"]
    assert runtime_payload["ready"] is True
    assert runtime_payload["apiVersion"] == "2.0"
    assert runtime_payload["captureDocumentSchemaVersion"] == "2"
    assert runtime_payload["captureDocumentSchemaSha256"]
    assert "schemaSha256" not in runtime_payload
    assert runtime_payload["contractSetVersion"] == "2"


def test_legacy_runtime_paths_are_not_public(client: TestClient) -> None:
    legacy_prefix = "/v" + "1"
    assert client.get(f"{legacy_prefix}/health/ready").status_code == 404
    assert client.get(f"{legacy_prefix}/captures").status_code == 404


def test_installation_request_rejects_retired_ocr_requirement(client: TestClient) -> None:
    response = client.post(
        "/v2/runtime/installations",
        headers=idempotency_headers(),
        json={"requirementId": "windowsml-ocr", "consent": True},
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "text-recognition" in response.text


def test_enabled_requirements_reject_retired_ocr_id() -> None:
    structuring = FakeRequirementInstaller()
    with pytest.raises(ValueError, match="use text-recognition"):
        SystemRequirementInstaller(structuring, enabled_requirement_ids={"windowsml-ocr"})
    installer = SystemRequirementInstaller(structuring)
    with pytest.raises(ValueError, match="use text-recognition"):
        installer.requirements({"windowsml-ocr"})


def test_v2_runtime_requirements_and_installation_lifecycle(settings_factory) -> None:
    settings = settings_factory()
    with TestClient(
        create_app(settings, installer=FakeRequirementInstaller()),
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
            json={"requirementId": "structuring-runtime", "consent": True},
        )
        assert created.status_code == 202, created.text
        installation_id = created.json()["installationId"]
        replay = client.post(
            "/v2/runtime/installations",
            headers=headers,
            json={"requirementId": "structuring-runtime", "consent": True},
        )
        assert replay.status_code == 202
        assert replay.json()["installationId"] == installation_id

        detail = client.get(f"/v2/runtime/installations/{installation_id}")
        assert detail.status_code == 200
        assert detail.json()["requirementId"] == "structuring-runtime"

        # The structuring model is chosen and installed through model installation.
        model = client.post(
            "/v2/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "structuring-model", "consent": True},
        )
        assert model.status_code == 422, model.text
        assert model.json()["error"]["code"] == "validation_error"
        assert "installed through structuring model installation" in model.text


def test_v2_runtime_ready_reports_authenticated_ocr_compute_decision(settings_factory) -> None:
    settings = settings_factory()
    contract_set = load_contract_set()
    preflight = OcrComputePreflight(
        contract_set_sha256=contract_set.sha256,
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
        "contractSetSha256": contract_set.sha256,
        "workerSha256": None,
        "mode": "gpu",
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
    decision = OcrComputePreflightContract(
        contract_set_sha256=contract_set.sha256,
        mode=OcrComputeMode.GPU,
        adapter_class=OcrAdapterClass.INTEGRATED,
        user_notice_required=False,
    )
    dependencies = build_runtime_dependencies(settings)
    calls: list[str] = []

    async def worker_probe(*, contract_set_sha256: str) -> object:
        calls.append(contract_set_sha256)
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
    assert "catalogVersion" not in index.json()
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
    installer = FakeRequirementInstaller(initially_ready={"text-recognition"})
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        first = _uninstall(client, "text-recognition")
        second = _uninstall(client, "text-recognition")

    assert first.status_code == 200, first.text
    assert first.json()["requirementId"] == "text-recognition"
    assert first.json()["status"] == "installable"
    assert "text-recognition" not in installer.ready
    assert second.status_code == 200
    assert second.json() == first.json()


def test_v2_uninstall_rejects_unknown_disabled_and_non_engine_requirements(
    settings_factory,
) -> None:
    settings = settings_factory()
    with TestClient(
        create_app(settings, installer=FakeRequirementInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        unknown = _uninstall(client, "no-such-engine")
        model = _uninstall(client, "structuring-model")
    host_settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="host")
    with TestClient(
        create_app(host_settings, installer=FakeRequirementInstaller()),
        base_url=f"http://127.0.0.1:{host_settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        disabled = _uninstall(client, "structuring-model")

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


@pytest.mark.parametrize(
    ("error", "status", "code"),
    [
        (RuntimeError("private detail"), 500, "uninstall_failed"),
        (OSError("private detail"), 500, "uninstall_failed"),
        (EngineInstallationError("private detail"), 500, "uninstall_failed"),
        (EngineInstallBusyError("busy"), 409, "requirement_in_use"),
        (EngineFilesInUseError("in use"), 409, "requirement_in_use"),
    ],
)
def test_v2_uninstall_tells_a_busy_engine_from_a_failed_uninstall(
    settings_factory, error: Exception, status: int, code: str
) -> None:
    settings = settings_factory()
    installer = FakeRequirementInstaller(initially_ready={"text-recognition"})

    async def failing_uninstall(requirement_id: str) -> None:
        raise error

    installer.uninstall = failing_uninstall  # type: ignore[method-assign]
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        response = _uninstall(client, "text-recognition")

    assert (response.status_code, response.json()["error"]["code"]) == (status, code)
    assert "private detail" not in response.text


def test_disabled_structuring_model_management_says_so_in_every_branch(
    settings_factory,
) -> None:
    settings = settings_factory(CAPTURE_STRUCTURING_PROVIDER="host")
    with TestClient(
        create_app(settings, installer=FakeRequirementInstaller()),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        responses = [
            _uninstall(client, "structuring-model"),
            client.get("/v2/runtime/structuring-model-options"),
            client.post(
                "/v2/runtime/structuring-model-installations",
                headers=idempotency_headers(),
                json={"optionId": "qwen3.5-4b-v1", "consent": True},
            ),
        ]
    expected = "Structuring model management is not available in this runtime's structuring mode."
    for response in responses:
        assert response.status_code == 422, response.text
        assert response.json()["error"]["code"] == "requirement_disabled"
        assert response.json()["error"]["message"] == expected


def test_v2_uninstall_conflicts_while_its_installation_runs(settings_factory) -> None:
    settings = settings_factory()
    installer = FakeRequirementInstaller(initially_ready={"text-recognition"}, delay_seconds=30)
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        created = client.post(
            "/v2/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "text-recognition", "consent": True},
        )
        assert created.status_code == 202, created.text
        in_use = _uninstall(client, "text-recognition")
        cancelled = client.post(
            f"/v2/runtime/installations/{created.json()['installationId']}/cancel"
        )
        assert cancelled.status_code == 200, cancelled.text
        after = _uninstall(client, "text-recognition")

    assert (in_use.status_code, in_use.json()["error"]["code"]) == (409, "requirement_in_use")
    assert after.status_code == 200, after.text
    assert after.json()["status"] == "installable"


def test_v2_uninstall_conflicts_while_a_capture_is_active(settings_factory) -> None:
    settings = settings_factory()
    installer = FakeRequirementInstaller(initially_ready={"speech-recognition"})
    with TestClient(
        create_app(settings, installer=installer),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as client:
        ingestion = client.post(
            "/v2/ingestions",
            json={
                "kind": "recording",
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


def test_startup_removes_only_owned_session_directories(settings_factory, tmp_path):
    settings = settings_factory()
    temporary = settings.extraction.temp_dir
    abandoned = temporary / "capture-speech-session-abcd"
    unrelated = temporary / "keep"
    shared = tmp_path / "shared-temp"
    shared_session = shared / abandoned.name
    for directory in (abandoned, unrelated, shared_session):
        directory.mkdir(parents=True)
        (directory / "window.wav").write_bytes(b"audio")
    (temporary / "notes.txt").write_bytes(b"keep")

    with TestClient(create_app(settings)):
        assert not abandoned.exists()
        assert (unrelated / "window.wav").read_bytes() == b"audio"
        assert (temporary / "notes.txt").read_bytes() == b"keep"

    with TestClient(create_app(settings_factory(CAPTURE_EXTRACTION_TEMP_DIR=str(shared)))):
        assert (shared_session / "window.wav").read_bytes() == b"audio"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows junctions")
def test_startup_preserves_the_target_of_a_session_directory_junction(settings_factory, tmp_path):
    import _winapi

    settings = settings_factory()
    temporary = settings.extraction.temp_dir
    temporary.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    audio = outside / "window.wav"
    audio.write_bytes(b"audio")
    junction = temporary / "capture-speech-session-abcd"
    _winapi.CreateJunction(str(outside), str(junction))
    try:
        with TestClient(create_app(settings)):
            assert audio.read_bytes() == b"audio"
    finally:
        if junction.is_junction():
            junction.rmdir()


def test_startup_reports_failed_waiting_capture_to_host(settings_factory):
    settings = settings_factory()
    app = create_app(settings)
    repository = app.state.streaming_repository
    repository.initialize()
    ingestion = repository.create_ingestion(
        OpenIngestion(
            kind="recording",
            client_request_id="restart-ingestion",
            file_name="sample.mp3",
            media_type="audio/mpeg",
            total_bytes=4,
        )
    )
    capture = repository.create_capture(
        StartCapture(
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
        assert response.json()["error"]["code"] == "ingestion_source_unavailable"


@pytest.mark.parametrize(
    ("retired_id", "current_id"),
    [
        ("ollama-runtime", "structuring-runtime"),
        ("capture-ollama-model", "structuring-model"),
    ],
)
def test_retired_requirement_ids_are_rejected(
    client: TestClient, retired_id: str, current_id: str
) -> None:
    response = client.post(
        "/v2/runtime/installations",
        json={"requirementId": retired_id, "consent": True},
        headers=idempotency_headers(),
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    if current_id == "structuring-model":
        # The model is installed through structuring model installation.
        assert "installed through structuring model installation" in response.text
    else:
        assert f"{retired_id} is retired; use {current_id}" in response.text

    response = client.delete(f"/v2/runtime/requirements/{retired_id}/installation")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert f"{retired_id} is retired; use {current_id}" in response.text


def test_open_ingestion_rejects_retired_recording_kind(client: TestClient) -> None:
    response = client.post(
        "/v2/ingestions",
        headers={"X-Idempotency-Key": "retired-kind"},
        json={
            "clientRequestId": "retired-kind",
            "kind": "audio",
            "fileName": "recording.mp3",
            "mediaType": "audio/mpeg",
            "totalBytes": 1,
            "sourceSha256": "0" * 64,
        },
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "validation_error"
    assert "recording" in response.text
