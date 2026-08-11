from __future__ import annotations

import hashlib
import io
import json
import os
import subprocess
import sys
import time
from collections.abc import Callable, Mapping
from datetime import UTC, datetime
from pathlib import Path

import pytest
from conftest import TOKEN, idempotency_headers, poll_installation
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
    SubprocessController,
)
from capture_runtime.release import (
    build_release_artifacts,
    write_capture_document_schema,
)


class MutableClock(Clock):
    def __init__(self) -> None:
        self.current = datetime(2026, 7, 20, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


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
    )
    assert manifest["platform"] == "windows"
    assert manifest["arch"] == "x86_64"
    assert manifest["bytes"] == len(b"deterministic executable")
    assert manifest["sha256"] == hashlib.sha256(b"deterministic executable").hexdigest()
    assert "runtimeRequirements" not in manifest
    assert (
        json.loads(
            (tmp_path / "release" / "capture-runtime-manifest.json").read_text(encoding="utf-8")
        )
        == manifest
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


class WaitingFakePopen:
    def __init__(self, pid: int) -> None:
        self.pid = pid
        self.wait_timeouts: list[float] = []

    def poll(self) -> int | None:
        return None

    def wait(self, timeout: float) -> int:
        self.wait_timeouts.append(timeout)
        return 1

    def kill(self) -> None:
        raise AssertionError("taskkill should release the owned process")


class ExitedFakePopen(WaitingFakePopen):
    def poll(self) -> int | None:
        return 1


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
    cuda_path = tmp_path / "cuda"
    poisoned = {
        "SystemRoot": r"C:\Windows",
        "PATH": r"C:\Windows\System32",
        "TEMP": str(tmp_path),
        "CUDA_PATH": str(cuda_path),
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
        "CUDA_PATH": str(cuda_path),
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


def test_runtime_settings_never_inherit_an_ambient_ollama_model_store(
    tmp_path: Path,
) -> None:
    app_data = tmp_path / "capture-app-data"
    settings = RuntimeSettings.from_env(
        {
            "CAPTURE_APP_DATA_DIR": str(app_data),
            "OLLAMA_MODELS": str(tmp_path / "host-models"),
        }
    )

    assert settings.ollama.models_dir == app_data / "ollama" / "models"

    dedicated = RuntimeSettings.from_env(
        {
            "CAPTURE_APP_DATA_DIR": str(app_data),
            "OLLAMA_MODELS": str(tmp_path / "host-models"),
            "CAPTURE_OLLAMA_MODELS_DIR": str(tmp_path / "capture-models"),
        }
    )
    assert dedicated.ollama.models_dir == tmp_path / "capture-models"


def test_external_ollama_settings_require_a_safe_endpoint_and_keep_key_in_memory() -> None:
    settings = RuntimeSettings.from_env(
        {
            "CAPTURE_STRUCTURING_PROVIDER": "external-ollama",
            "CAPTURE_OLLAMA_ENDPOINT": "https://ollama.internal/",
            "CAPTURE_OLLAMA_MODEL": "qwen3.5:4b",
            "CAPTURE_OLLAMA_API_KEY": "secret-key",
        }
    )

    assert settings.external_ollama is not None
    assert settings.external_ollama.endpoint_url == "https://ollama.internal"
    assert settings.external_ollama.model == "qwen3.5:4b"
    assert settings.external_ollama.api_key == "secret-key"

    with pytest.raises(ValueError, match="required when using external-ollama"):
        RuntimeSettings.from_env({"CAPTURE_STRUCTURING_PROVIDER": "external-ollama"})
    with pytest.raises(ValueError, match="without credentials"):
        RuntimeSettings.from_env(
            {
                "CAPTURE_STRUCTURING_PROVIDER": "external-ollama",
                "CAPTURE_OLLAMA_ENDPOINT": "https://user:secret@ollama.internal",
            }
        )
    with pytest.raises(ValueError, match="without credentials"):
        RuntimeSettings.from_env(
            {
                "CAPTURE_STRUCTURING_PROVIDER": "external-ollama",
                "CAPTURE_OLLAMA_ENDPOINT": "https://ollama.internal/api",
            }
        )


def test_external_ollama_ignores_owned_ollama_host_override() -> None:
    settings = RuntimeSettings.from_env(
        {
            "CAPTURE_STRUCTURING_PROVIDER": "external-ollama",
            "CAPTURE_OLLAMA_ENDPOINT": "https://ollama.example.test",
            "CAPTURE_OLLAMA_HOST": "http://192.168.1.10:11434",
        }
    )

    assert settings.external_ollama is not None
    assert settings.external_ollama.endpoint_url == "https://ollama.example.test"
    assert settings.ollama.host_url == "http://127.0.0.1:11439"


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


@pytest.mark.skipif(os.name != "nt", reason="Windows process-tree release boundary")
def test_windows_process_controller_waits_for_owned_process_exit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = WaitingFakePopen(4242)
    output = io.BytesIO()
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", run)

    SubprocessController().stop_tree(
        OwnedProcess(process=popen, output=output)  # type: ignore[arg-type]
    )

    assert commands == [["taskkill", "/PID", "4242", "/T", "/F"]]
    assert popen.wait_timeouts == [15]
    assert output.closed


@pytest.mark.skipif(os.name != "nt", reason="Windows process-tree release boundary")
def test_windows_process_controller_still_releases_tree_after_parent_exits(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    popen = ExitedFakePopen(4242)
    output = io.BytesIO()
    commands: list[list[str]] = []

    def run(command: list[str], **_kwargs: object) -> subprocess.CompletedProcess[bytes]:
        commands.append(command)
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(subprocess, "run", run)

    SubprocessController().stop_tree(
        OwnedProcess(process=popen, output=output)  # type: ignore[arg-type]
    )

    assert commands == [["taskkill", "/PID", "4242", "/T", "/F"]]
    assert popen.wait_timeouts == [15]
    assert output.closed


@pytest.mark.skipif(os.name != "nt", reason="Windows process-tree release boundary")
def test_windows_process_controller_releases_real_descendant_after_parent_exits(
    tmp_path: Path,
) -> None:
    child_code = "import time; time.sleep(60)"
    parent_code = (
        "import subprocess,sys,time\n"
        "from pathlib import Path\n"
        "gate=Path(sys.argv[2])\n"
        "pid_file=Path(sys.argv[3])\n"
        "while not gate.exists():\n"
        "    time.sleep(0.01)\n"
        "child=subprocess.Popen([sys.executable,'-c',sys.argv[1]], "
        "stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, "
        "stderr=subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW); "
        "pid_file.write_text(str(child.pid), encoding='ascii')"
    )
    gate = tmp_path / "start-child"
    pid_file = tmp_path / "child.pid"
    controller = SubprocessController()
    owned = controller.spawn(
        sys.executable,
        ["-c", parent_code, child_code, str(gate), str(pid_file)],
        environment=sanitized_child_environment(),
        cwd=tmp_path,
        output_path=tmp_path / "parent.log",
    )
    gate.write_text("go", encoding="ascii")
    deadline = time.monotonic() + 5
    child_pid: int | None = None
    while time.monotonic() < deadline:
        if pid_file.is_file():
            raw_pid = pid_file.read_text(encoding="ascii").strip()
            if raw_pid:
                child_pid = int(raw_pid)
                break
        time.sleep(0.01)
    assert child_pid is not None
    owned.process.wait(timeout=5)

    try:
        assert controller.is_pid_running(child_pid)
        assert _windows_pid_is_live(child_pid)
        controller.stop_tree(owned)
        assert not _windows_pid_is_live(child_pid)
    finally:
        if _windows_pid_is_live(child_pid):
            subprocess.run(
                ["taskkill", "/PID", str(child_pid), "/T", "/F"],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                shell=False,
                check=False,
                timeout=15,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )


def _windows_pid_is_live(pid: int) -> bool:
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    synchronize = 0x00100000
    wait_timeout = 0x00000102
    handle = kernel32.OpenProcess(synchronize, False, pid)
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == wait_timeout
    finally:
        kernel32.CloseHandle(handle)


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
