from __future__ import annotations

import hashlib
import io
import json
from collections.abc import Callable, Mapping
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import TOKEN, idempotency_headers, poll_capture, poll_installation
from fastapi.testclient import TestClient
from pydantic import ValidationError

from capture_runtime.app import create_app
from capture_runtime.clock import Clock, SystemClock
from capture_runtime.config import (
    OllamaRuntimeConfig,
    RuntimeSettings,
    sanitized_child_environment,
)
from capture_runtime.contracts import CaptureDocumentV1
from capture_runtime.ollama import (
    FakeRuntimeInstaller,
    IsolatedOllamaLifecycle,
    OllamaOwnershipError,
    OwnedProcess,
)
from capture_runtime.release import (
    build_release_artifacts,
    windowsml_requirement_descriptor,
    write_capture_document_schema,
)


class MutableClock(Clock):
    def __init__(self) -> None:
        self.current = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


def test_startup_recovery_preserves_raw_and_retention_prunes(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    clock = MutableClock()
    app = create_app(settings, clock=clock)
    headers = {"Authorization": f"Bearer {TOKEN}"}
    with TestClient(app, base_url=f"http://127.0.0.1:{settings.port}", headers=headers) as first:
        response = first.post(
            "/v1/captures",
            headers=idempotency_headers(),
            files={"file": ("recover.pdf", b"%PDF-1.7\nCAPTURE_TEXT:recover", "application/pdf")},
            data={"sourceKind": "pdf", "structuringMode": "host"},
        )
        capture_id = response.json()["captureId"]
        poll_capture(first, capture_id, lambda job: job["stage"] == "awaiting_structuring")

    restarted_app = create_app(settings, clock=clock)
    with TestClient(
        restarted_app, base_url=f"http://127.0.0.1:{settings.port}", headers=headers
    ) as restarted:
        recovered = restarted.get(f"/v1/captures/{capture_id}")
        assert recovered.status_code == 200
        assert recovered.json()["error"]["code"] == "runtime_restarted"
        assert restarted.get(f"/v1/captures/{capture_id}/raw").status_code == 200
        assert not (
            restarted.app.state.capture_repository.root / capture_id / "source.bin"
        ).exists()

    clock.current += timedelta(hours=25)
    pruned_app = create_app(settings, clock=clock)
    with TestClient(
        pruned_app, base_url=f"http://127.0.0.1:{settings.port}", headers=headers
    ) as pruned:
        assert pruned.get(f"/v1/captures/{capture_id}").status_code == 404


def test_startup_recovery_marks_interrupted_installation_failed(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    settings = settings_factory()
    headers = {"Authorization": f"Bearer {TOKEN}"}
    first_app = create_app(settings, installer=FakeRuntimeInstaller(delay_seconds=5))
    with TestClient(
        first_app, base_url=f"http://127.0.0.1:{settings.port}", headers=headers
    ) as first:
        response = first.post(
            "/v1/runtime/installations",
            headers=idempotency_headers(),
            json={"requirementId": "whisper-primary", "consent": True},
        )
        installation_id = response.json()["installationId"]
        poll_installation(first, installation_id, lambda job: job["status"] == "running")

    restarted_app = create_app(settings, installer=FakeRuntimeInstaller())
    with TestClient(
        restarted_app, base_url=f"http://127.0.0.1:{settings.port}", headers=headers
    ) as restarted:
        recovered = restarted.get(f"/v1/runtime/installations/{installation_id}")
        assert recovered.status_code == 200
        assert recovered.json()["status"] == "failed"
        assert recovered.json()["error"]["code"] == "runtime_restarted"


def test_schema_and_manifest_are_generated_from_pydantic(tmp_path: Path) -> None:
    schema_path = write_capture_document_schema(tmp_path / "capture-document-v1.schema.json")
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert "type" in schema["$defs"]["CaptureBlockV1"]["required"]
    assert "targetText" in schema["$defs"]["CaptureBlockV1"]["required"]
    assert schema["additionalProperties"] is False

    executable = tmp_path / "capture-runtime.exe"
    executable.write_bytes(b"deterministic executable")
    manifest = build_release_artifacts(
        executable=executable,
        schema=schema_path,
        output_dir=tmp_path / "release",
        windowsml_bundle_url=(
            "https://github.com/WodenWang820118/capture-workbench/releases/download/"
            "windowsml-v1/capture-windowsml-ocr-windows-x64.zip"
        ),
        windowsml_bundle_bytes=123456,
        windowsml_bundle_sha256="a" * 64,
    )
    assert manifest["platform"] == "windows"
    assert manifest["arch"] == "x86_64"
    assert manifest["bytes"] == len(b"deterministic executable")
    assert manifest["sha256"] == hashlib.sha256(b"deterministic executable").hexdigest()
    assert manifest["runtimeRequirements"]["windowsml-ocr"] == {
        "artifactUrl": (
            "https://github.com/WodenWang820118/capture-workbench/releases/download/"
            "windowsml-v1/capture-windowsml-ocr-windows-x64.zip"
        ),
        "artifactFileName": "capture-windowsml-ocr-windows-x64.zip",
        "bytes": 123456,
        "sha256": "a" * 64,
    }
    assert (
        json.loads(
            (tmp_path / "release" / "capture-runtime-manifest.json").read_text(encoding="utf-8")
        )
        == manifest
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://downloads.example.org/capture-windowsml.zip",
        "https://token@downloads.example.org/capture-windowsml.zip",
        "https://downloads.example.org:8443/capture-windowsml.zip",
        "https://downloads.example.org/capture-windowsml.zip?token=secret",
        "https://downloads.example.org/capture-windowsml.zip#secret",
        "https://example.invalid/capture-windowsml.zip",
        "https://downloads.example.org/not-a-zip.exe",
    ],
)
def test_windowsml_release_descriptor_rejects_unsafe_urls(url: str) -> None:
    with pytest.raises(ValueError):
        windowsml_requirement_descriptor(url, 123456, "a" * 64)


def test_windowsml_release_descriptor_rejects_non_lowercase_digest() -> None:
    with pytest.raises(ValueError):
        windowsml_requirement_descriptor(
            "https://downloads.example.org/capture-windowsml.zip",
            123456,
            "A" * 64,
        )


def test_contract_rejects_extra_fields() -> None:
    with pytest.raises(ValidationError) as raised:
        CaptureDocumentV1.model_validate({"schemaVersion": "1", "unexpected": True})
    assert any(issue["type"] == "extra_forbidden" for issue in raised.value.errors())


class FakePopen:
    def __init__(self, pid: int) -> None:
        self.pid = pid

    def poll(self) -> int | None:
        return None


class FakeProcessController:
    def __init__(self, *, live_pids: set[int] | None = None) -> None:
        self.live_pids = set(live_pids or ())
        self.spawned: list[list[str]] = []
        self.stopped: list[int] = []

    def is_pid_running(self, pid: int) -> bool:
        return pid in self.live_pids

    def spawn(
        self,
        executable: str,
        arguments: list[str],
        *,
        environment: Mapping[str, str],
        cwd: Path,
        output_path: Path,
    ) -> OwnedProcess:
        del environment, cwd, output_path
        self.spawned.append([executable, *arguments])
        return OwnedProcess(process=FakePopen(4242), output=io.BytesIO())  # type: ignore[arg-type]

    def stop_tree(self, process: OwnedProcess) -> None:
        self.stopped.append(process.pid)
        process.output.close()


def _ollama_config(tmp_path: Path) -> OllamaRuntimeConfig:
    return OllamaRuntimeConfig(
        host_url="http://127.0.0.1:11555",
        app_data_dir=tmp_path / "ollama",
        pid_file=tmp_path / "ollama" / "pid.json",
        models_dir=tmp_path / "ollama" / "models",
    )


def test_capture_child_environment_strips_provider_overrides_and_secrets(
    tmp_path: Path,
) -> None:
    poisoned = {
        "SystemRoot": r"C:\Windows",
        "PATH": r"C:\Windows\System32",
        "TEMP": str(tmp_path),
        "CAPTURE_STRUCTURING_PROVIDER": "fake",
        "CAPTURE_EXTRACTION_PROVIDER": "fake",
        "CAPTURE_OLLAMA_MODEL": "attacker/model",
        "CAPTURE_WINDOWSML_MODEL_DIR": r"C:\attacker",
        "OLLAMA_HOST": "0.0.0.0:11434",
        "OLLAMA_MODELS": r"C:\shared-models",
        "HF_TOKEN": "secret",
        "GITHUB_TOKEN": "secret",
        "CERT_PREP_API_TOKEN": "secret",
    }
    assert sanitized_child_environment(poisoned) == {
        "SystemRoot": r"C:\Windows",
        "PATH": r"C:\Windows\System32",
        "TEMP": str(tmp_path),
    }
    environment = _ollama_config(tmp_path).process_environment(poisoned)
    assert environment["OLLAMA_HOST"] == "127.0.0.1:11555"
    assert environment["OLLAMA_MODELS"] == str(tmp_path / "ollama" / "models")
    for forbidden in (
        "CAPTURE_STRUCTURING_PROVIDER",
        "CAPTURE_EXTRACTION_PROVIDER",
        "CAPTURE_OLLAMA_MODEL",
        "CAPTURE_WINDOWSML_MODEL_DIR",
        "HF_TOKEN",
        "GITHUB_TOKEN",
        "CERT_PREP_API_TOKEN",
    ):
        assert forbidden not in environment


def test_windowsml_descriptor_environment_is_atomic_and_bounded() -> None:
    base = {
        "CAPTURE_WINDOWSML_BUNDLE_URL": "https://downloads.example.org/windowsml.zip",
        "CAPTURE_WINDOWSML_BUNDLE_SHA256": "a" * 64,
    }
    with pytest.raises(ValueError, match="must be configured together"):
        RuntimeSettings.from_env(base)
    with pytest.raises(ValueError, match="between 1 and 536870912"):
        RuntimeSettings.from_env({**base, "CAPTURE_WINDOWSML_BUNDLE_BYTES": "536870913"})
    settings = RuntimeSettings.from_env({**base, "CAPTURE_WINDOWSML_BUNDLE_BYTES": "123456"})
    assert settings.extraction.windowsml_bundle_bytes == 123456


def test_ollama_lifecycle_stops_only_its_owned_process(tmp_path: Path) -> None:
    controller = FakeProcessController()
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        process_controller=controller,
        executable_resolver=lambda: "C:/Program Files/Ollama/ollama.exe",
        clock=SystemClock(),
    )
    assert lifecycle.start() == 4242
    assert controller.spawned == [["C:/Program Files/Ollama/ollama.exe", "serve"]]
    lifecycle.stop()
    assert controller.stopped == [4242]
    assert not lifecycle.config.pid_file.exists()


def test_ollama_lifecycle_refuses_unowned_live_pid(tmp_path: Path) -> None:
    config = _ollama_config(tmp_path)
    config.pid_file.parent.mkdir(parents=True)
    config.pid_file.write_text('{"pid":7331}', encoding="utf-8")
    controller = FakeProcessController(live_pids={7331})
    lifecycle = IsolatedOllamaLifecycle(
        config,
        process_controller=controller,
        executable_resolver=lambda: "ollama.exe",
        clock=SystemClock(),
    )
    with pytest.raises(OllamaOwnershipError):
        lifecycle.start()
    lifecycle.stop()
    assert controller.stopped == []
