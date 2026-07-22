from __future__ import annotations

import asyncio
import hashlib
import io
import json
import threading
from collections.abc import Callable, Mapping
from pathlib import Path

import httpx
import pytest
from conftest import TOKEN
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig, OllamaRuntimeConfig, RuntimeSettings
from capture_runtime.contracts import RuntimeRequirementStatus
from capture_runtime.engine_adapters import EngineProbe
from capture_runtime.ollama import (
    FakeRuntimeInstaller,
    IsolatedOllamaLifecycle,
    OwnedProcess,
    SystemRuntimeInstaller,
)


class ProbeAdapter:
    def probe(self) -> EngineProbe:
        return EngineProbe(True, True, True, "ready")


class FakePopen:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.running = True

    def poll(self) -> int | None:
        return None if self.running else 1


class FakeProcessController:
    def __init__(self, *, live_pids: set[int] | None = None) -> None:
        self.live_pids = set(live_pids or ())
        self.spawned: list[list[str]] = []
        self.environments: list[dict[str, str]] = []
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
        del cwd, output_path
        self.spawned.append([executable, *arguments])
        self.environments.append(dict(environment))
        return OwnedProcess(process=FakePopen(4242), output=io.BytesIO())  # type: ignore[arg-type]

    def stop_tree(self, process: OwnedProcess) -> None:
        self.stopped.append(process.pid)
        process.output.close()


def _ollama_config(tmp_path: Path) -> OllamaRuntimeConfig:
    root = tmp_path / "ollama"
    return OllamaRuntimeConfig(
        host_url="http://127.0.0.1:11555",
        app_data_dir=root,
        pid_file=root / "ollama.pid.json",
        models_dir=root / "models",
    )


def _record_installed_profile(config: OllamaRuntimeConfig) -> None:
    modelfile = config.app_data_dir / "Capture.Modelfile"
    modelfile.parent.mkdir(parents=True, exist_ok=True)
    modelfile.write_text(f"FROM {config.base_model}\n", encoding="utf-8")
    marker = config.app_data_dir / "requirements" / "capture-ollama-model.ready.json"
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(
        json.dumps(
            {
                "profileId": config.profile_id,
                "baseModel": config.base_model,
                "modelfileSha256": hashlib.sha256(modelfile.read_bytes()).hexdigest(),
                "installedAt": "2026-07-22T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )


def _installer(
    tmp_path: Path,
    controller: FakeProcessController,
    *,
    readiness_timeout_seconds: float = 0.1,
) -> tuple[SystemRuntimeInstaller, IsolatedOllamaLifecycle]:
    config = _ollama_config(tmp_path)
    lifecycle = IsolatedOllamaLifecycle(
        config,
        process_controller=controller,
        executable_resolver=lambda: "C:/Program Files/Ollama/ollama.exe",
        clock=SystemClock(),
    )
    extraction = ExtractionRuntimeConfig(
        windowsml_model_dir=tmp_path / "windowsml",
        whisper_models_dir=tmp_path / "whisper",
        temp_dir=tmp_path / "temp",
        windowsml_device_id=0,
        max_pdf_pages=10,
        max_image_pixels=100_000,
        ocr_render_scale=2,
        max_audio_duration_ms=60_000,
        whisper_primary_model="large-v3-turbo",
        whisper_fallback_model="small",
        whisper_prefer_gpu=False,
        windowsml_bundle_url=None,
        windowsml_bundle_sha256=None,
        windowsml_bundle_bytes=None,
    )
    installer = SystemRuntimeInstaller(
        lifecycle,
        winget_resolver=lambda: None,
        extraction_config=extraction,
        ocr_adapter=ProbeAdapter(),  # type: ignore[arg-type]
        whisper_adapter=ProbeAdapter(),  # type: ignore[arg-type]
        clock=SystemClock(),
        model_readiness_timeout_seconds=readiness_timeout_seconds,
        model_readiness_poll_interval_seconds=0,
    )
    return installer, lifecycle


def _tags_response(config: OllamaRuntimeConfig, models: list[dict[str, str]]) -> httpx.Response:
    request = httpx.Request("GET", f"{config.host_url}/api/tags")
    return httpx.Response(200, request=request, json={"models": models})


def _model_status(installer: SystemRuntimeInstaller) -> RuntimeRequirementStatus:
    return next(
        item.status
        for item in installer.requirements()
        if item.requirement_id == "capture-ollama-model"
    )


def test_lifecycle_start_is_idempotent_and_uses_only_isolated_state(tmp_path: Path) -> None:
    controller = FakeProcessController()
    config = _ollama_config(tmp_path)
    lifecycle = IsolatedOllamaLifecycle(
        config,
        process_controller=controller,
        executable_resolver=lambda: "ollama.exe",
        clock=SystemClock(),
    )

    assert lifecycle.start() == lifecycle.start() == 4242
    assert controller.spawned == [["ollama.exe", "serve"]]
    assert controller.environments[0]["OLLAMA_HOST"] == "127.0.0.1:11555"
    assert controller.environments[0]["OLLAMA_MODELS"] == str(config.models_dir)


def test_installer_lazily_starts_once_and_recovers_stored_profile(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = FakeProcessController()
    installer, lifecycle = _installer(tmp_path, controller)
    _record_installed_profile(lifecycle.config)
    calls = 0

    def get_tags(*_args: object, **_kwargs: object) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("isolated Ollama is still starting")
        return _tags_response(
            lifecycle.config,
            [
                {
                    "name": f"{lifecycle.config.profile_id}:latest",
                    "digest": "a" * 64,
                }
            ],
        )

    monkeypatch.setattr(httpx, "get", get_tags)

    assert _model_status(installer) is RuntimeRequirementStatus.READY
    assert _model_status(installer) is RuntimeRequirementStatus.READY
    assert controller.spawned == [["C:/Program Files/Ollama/ollama.exe", "serve"]]
    assert calls == 3


def test_marker_alone_does_not_make_a_missing_profile_ready(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = FakeProcessController()
    installer, lifecycle = _installer(tmp_path, controller)
    _record_installed_profile(lifecycle.config)
    monkeypatch.setattr(
        httpx,
        "get",
        lambda *_args, **_kwargs: _tags_response(
            lifecycle.config,
            [{"name": "another-model:latest", "digest": "b" * 64}],
        ),
    )

    assert _model_status(installer) is RuntimeRequirementStatus.INSTALLABLE
    assert controller.spawned == [["C:/Program Files/Ollama/ollama.exe", "serve"]]


def test_model_probe_rejects_a_foreign_response_after_owned_exit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = FakeProcessController()
    installer, lifecycle = _installer(tmp_path, controller)
    _record_installed_profile(lifecycle.config)
    ownership_checks = iter((True, False))
    monkeypatch.setattr(
        lifecycle,
        "owns_running_process",
        lambda: next(ownership_checks, False),
    )
    monkeypatch.setattr(
        httpx,
        "get",
        lambda *_args, **_kwargs: _tags_response(
            lifecycle.config,
            [{"name": lifecycle.config.profile_id, "digest": "d" * 64}],
        ),
    )

    assert _model_status(installer) is RuntimeRequirementStatus.INSTALLABLE


def test_missing_install_record_does_not_start_ollama(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = FakeProcessController()
    installer, _lifecycle = _installer(tmp_path, controller)

    def reject_probe(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("an uninstalled profile must not start or probe Ollama")

    monkeypatch.setattr(httpx, "get", reject_probe)

    assert _model_status(installer) is RuntimeRequirementStatus.INSTALLABLE
    assert controller.spawned == []


def test_ownership_failure_never_probes_or_touches_foreign_process(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    controller = FakeProcessController(live_pids={7331})
    installer, lifecycle = _installer(tmp_path, controller)
    _record_installed_profile(lifecycle.config)
    lifecycle.config.pid_file.write_text('{"pid":7331}', encoding="utf-8")

    def reject_probe(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("ownership failure must not probe the occupied endpoint")

    monkeypatch.setattr(httpx, "get", reject_probe)

    assert _model_status(installer) is RuntimeRequirementStatus.INSTALLABLE
    lifecycle.stop()
    assert controller.spawned == []
    assert controller.stopped == []


def test_requirements_api_recovers_installed_profile_after_process_restart(
    settings_factory: Callable[..., RuntimeSettings],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = settings_factory(
        CAPTURE_STRUCTURING_PROVIDER="ollama",
        CAPTURE_EXTRACTION_PROVIDER="fake",
    )
    _record_installed_profile(settings.ollama)
    monkeypatch.setattr(
        "capture_runtime.ollama.shutil.which",
        lambda executable: "C:/Program Files/Ollama/ollama.exe" if executable == "ollama" else None,
    )
    monkeypatch.setattr(
        httpx,
        "get",
        lambda *_args, **_kwargs: _tags_response(
            settings.ollama,
            [{"name": settings.ollama.profile_id, "digest": "c" * 64}],
        ),
    )
    headers = {"Authorization": f"Bearer {TOKEN}"}

    controllers = [FakeProcessController(), FakeProcessController()]
    for controller in controllers:
        with TestClient(
            create_app(settings, process_controller=controller),
            base_url=f"http://127.0.0.1:{settings.port}",
            headers=headers,
        ) as client:
            response = client.get("/v1/runtime/requirements")
            assert response.status_code == 200
            model = next(
                item
                for item in response.json()["items"]
                if item["requirementId"] == "capture-ollama-model"
            )
            assert model["status"] == "ready"

    assert [controller.spawned for controller in controllers] == [
        [["C:/Program Files/Ollama/ollama.exe", "serve"]],
        [["C:/Program Files/Ollama/ollama.exe", "serve"]],
    ]
    assert [controller.stopped for controller in controllers] == [[4242], [4242]]


def test_requirements_api_runs_sync_installer_off_the_event_loop(
    settings_factory: Callable[..., RuntimeSettings],
) -> None:
    class ThreadRecordingInstaller(FakeRuntimeInstaller):
        thread_id: int | None = None

        def requirements(self, enabled_requirement_ids=None):
            self.thread_id = threading.get_ident()
            return super().requirements(enabled_requirement_ids)

    async def scenario() -> tuple[int, int | None]:
        settings = settings_factory()
        installer = ThreadRecordingInstaller()
        app = create_app(settings, installer=installer)
        loop_thread_id = threading.get_ident()
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url=f"http://127.0.0.1:{settings.port}",
            headers={"Authorization": f"Bearer {TOKEN}"},
        ) as client:
            response = await client.get("/v1/runtime/requirements")
        assert response.status_code == 200
        return loop_thread_id, installer.thread_id

    loop_thread_id, installer_thread_id = asyncio.run(scenario())

    assert installer_thread_id is not None
    assert installer_thread_id != loop_thread_id
