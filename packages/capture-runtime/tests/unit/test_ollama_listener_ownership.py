"""Built-in leases authenticate OS socket owners before exposing document text."""

from __future__ import annotations

import asyncio
import json
import os
import socket
import threading
from collections.abc import Mapping
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from capture_runtime.capture.application.streaming_capture_service import _safe_failure_message
from capture_runtime.clock import SystemClock
from capture_runtime.config import RuntimeSettings
from capture_runtime.structuring.infrastructure.ollama import (
    IsolatedOllamaLifecycle,
    OllamaCaptureStructuringProvider,
    OwnedProcess,
    RuntimeUnavailableError,
    SystemRuntimeInstaller,
)
from capture_runtime.structuring.infrastructure.ollama.listener_owner import (
    SystemListenerOwner,
    choose_loopback_port,
)
from tests.integration.test_ollama_restart_readiness import (
    FakePopen,
    FakeProcessController,
    _ollama_config,
    _record_installed_profile,
)
from tests.integration.test_ollama_structuring import _raw, _tags, _valid_candidate


def test_real_os_reports_listener_and_free_port() -> None:
    lookup = SystemListenerOwner()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        assert lookup.listener_pid(listener.getsockname()[1]) == os.getpid()
    assert lookup.listener_pid(choose_loopback_port()) is None


def test_structuring_safe_message_is_specific() -> None:
    assert _safe_failure_message(RuntimeUnavailableError("private detail")) == (
        "Structuring failed at a bounded runtime boundary."
    )


def test_race_recovery_uses_lease_for_tags_generate_and_next_start(tmp_path: Path) -> None:
    controller = FakeProcessController()
    config = _ollama_config(tmp_path)
    _record_installed_profile(config)
    ports = iter([12101, 12102, 12103, 12104])
    lifecycle = IsolatedOllamaLifecycle(
        config,
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: next(ports),
        listener_owner=SimpleNamespace(listener_pid=lambda port: 999 if port < 12103 else 4242),
    )
    requests: list[tuple[int | None, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append((request.url.port, request.url.path))
        if request.url.path == "/api/tags":
            return _tags(config)
        return httpx.Response(200, json={"response": _valid_candidate(json.loads(request.content))})

    provider = OllamaCaptureStructuringProvider(
        lifecycle,
        clock=SystemClock(),
        transport=httpx.MockTransport(handler),
    )
    asyncio.run(
        provider.structure(_raw(count=1), target_language=None, cancel_event=asyncio.Event())
    )
    assert requests == [(12103, "/api/tags"), (12103, "/api/generate")]
    assert len(controller.stopped) == 3
    lifecycle.start()
    try:
        assert lifecycle.host_url == "http://127.0.0.1:12104"
    finally:
        lifecycle.stop()


@pytest.mark.parametrize("owner", [None, 999])
def test_five_failed_attempts_stop_every_child(tmp_path: Path, owner: int | None) -> None:
    controller = FakeProcessController()
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        listener_timeout_seconds=0,
        listener_owner=SimpleNamespace(listener_pid=lambda _port: owner),
    )
    with pytest.raises(RuntimeUnavailableError, match="5 attempts"):
        lifecycle.start()
    assert len(controller.spawned) == len(controller.stopped) == 5
    assert not lifecycle.config.pid_file.exists()
    with pytest.raises(RuntimeUnavailableError):
        _ = lifecycle.host_url


def test_host_override_is_ignored_and_child_environment_uses_lease(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("CAPTURE_OLLAMA_HOST", "not even a URL")
    monkeypatch.setenv("OLLAMA_HOST", "http://foreign.invalid:11434")
    settings = RuntimeSettings.from_env(
        {
            "CAPTURE_STRUCTURING_PROVIDER": "ollama",
            "CAPTURE_OLLAMA_HOST": "invalid",
            "CAPTURE_APP_DATA_DIR": str(tmp_path),
        }
    )
    controller = FakeProcessController()
    lifecycle = IsolatedOllamaLifecycle(
        settings.ollama,
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: 12108,
        listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
    )
    lifecycle.start()
    try:
        assert controller.environments[0]["OLLAMA_HOST"] == "127.0.0.1:12108"
        assert lifecycle.process_environment()["OLLAMA_HOST"] == "127.0.0.1:12108"
    finally:
        lifecycle.stop()


def test_foreign_http_listener_receives_no_requests_or_install_commands(tmp_path: Path) -> None:
    requests: list[str] = []
    commands: list[object] = []
    config = _ollama_config(tmp_path)
    _record_installed_profile(config)

    class ForeignServer(BaseHTTPRequestHandler):
        def do_GET(self) -> None:
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(
                json.dumps(
                    {
                        "models": [
                            {
                                "name": config.profile_id,
                                "digest": "a" * 64,
                            }
                        ]
                    }
                ).encode()
            )

        def do_POST(self) -> None:
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"response":"{\\"blocks\\":[]}"}')

        def log_message(self, format: str, *args: object) -> None:
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), ForeignServer) as server:
        worker = threading.Thread(target=server.serve_forever)
        worker.start()
        controller = FakeProcessController()
        lifecycle = IsolatedOllamaLifecycle(
            config,
            clock=SystemClock(),
            process_controller=controller,
            executable_resolver=lambda: "fake-ollama",
            port_selector=lambda: server.server_port,
        )
        provider = OllamaCaptureStructuringProvider(lifecycle, clock=SystemClock())
        installer = SystemRuntimeInstaller(
            lifecycle,
            clock=SystemClock(),
            command_runner=SimpleNamespace(run=lambda *args, **kwargs: commands.append(args)),
        )
        try:
            with pytest.raises(RuntimeUnavailableError):
                asyncio.run(
                    provider.structure(
                        _raw(count=1),
                        target_language=None,
                        cancel_event=asyncio.Event(),
                    )
                )
            with pytest.raises(RuntimeUnavailableError):
                asyncio.run(
                    installer.install_model_option(
                        "qwen3.5-4b-v1",
                        cancel_event=asyncio.Event(),
                        report_progress=lambda _: None,
                    )
                )
            assert requests == []
            assert commands == []
            assert len(controller.spawned) == len(controller.stopped) == 10
        finally:
            server.shutdown()
            worker.join()


def test_installer_tags_and_cli_use_verified_lease(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from capture_runtime.structuring.infrastructure.model_catalog import model_option
    from capture_runtime.structuring.infrastructure.ollama import CommandResult

    controller = FakeProcessController()
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: 12109,
        listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
    )
    option = model_option("qwen3.5-4b-v1")
    urls: list[str] = []
    commands: list[tuple[list[str], str]] = []

    def tags(url: str, **kwargs: object) -> httpx.Response:
        urls.append(url)
        return httpx.Response(
            200,
            request=httpx.Request("GET", url),
            json={
                "models": [
                    {
                        "name": option.model_reference,
                        "digest": option.expected_digest or "a" * 64,
                        "size": option.expected_bytes or 123,
                    }
                ]
            },
        )

    class Runner:
        async def run(self, arguments: list[str], **kwargs: object) -> CommandResult:
            environment = kwargs["environment"]
            assert isinstance(environment, dict)
            commands.append((arguments, str(environment["OLLAMA_HOST"])))
            return CommandResult(0, "")

    monkeypatch.setattr(httpx, "get", tags)
    installer = SystemRuntimeInstaller(lifecycle, clock=SystemClock(), command_runner=Runner())
    asyncio.run(
        installer.install_model_option(
            option.option_id,
            cancel_event=asyncio.Event(),
            report_progress=lambda _: None,
        )
    )
    assert urls == ["http://127.0.0.1:12109/api/tags"] * 2
    assert [arguments[1] for arguments, _ in commands] == ["pull", "create"]
    assert [host for _, host in commands] == ["127.0.0.1:12109"] * 2
    assert len(controller.stopped) == 1


def test_bind_exit_retries_before_any_http(tmp_path: Path) -> None:
    class ExitingController(FakeProcessController):
        def spawn(
            self,
            executable: str,
            arguments: list[str],
            *,
            environment: Mapping[str, str],
            cwd: Path,
            output_path: Path,
        ) -> OwnedProcess:
            owned = super().spawn(
                executable,
                arguments,
                environment=environment,
                cwd=cwd,
                output_path=output_path,
            )
            assert isinstance(owned.process, FakePopen)
            if len(self.spawned) < 3:
                owned.process.running = False
            return owned

    controller = ExitingController()
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
    )
    lifecycle.start()
    try:
        assert len(controller.spawned) == 3
        assert len(controller.stopped) == 2
        assert lifecycle.owns_running_process()
    finally:
        lifecycle.stop()


@pytest.mark.parametrize("switch_lease", [False, True])
def test_proxy_bypass_and_client_lease_binding(tmp_path, monkeypatch, switch_lease):
    requests = []
    proxy_requests = []
    config = _ollama_config(tmp_path)
    _record_installed_profile(config)

    class Listener(BaseHTTPRequestHandler):
        def do_GET(self):
            requests.append(self.path)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(_tags(config).content)

        def do_POST(self):
            requests.append(self.path)
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(json.dumps({"response": _valid_candidate(body)}).encode())

        def log_message(self, format, *args):
            pass

    class Proxy(Listener):
        def do_GET(self):
            proxy_requests.append(self.path)
            self.send_error(502)

        do_POST = do_GET

    with (
        ThreadingHTTPServer(("127.0.0.1", 0), Listener) as server,
        ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as proxy,
    ):
        workers = [threading.Thread(target=s.serve_forever) for s in (server, proxy)]
        for worker in workers:
            worker.start()
        for key in ("HTTP_PROXY", "ALL_PROXY", "http_proxy", "all_proxy"):
            monkeypatch.setenv(key, f"http://127.0.0.1:{proxy.server_port}")
        for key in ("NO_PROXY", "no_proxy"):
            monkeypatch.setenv(key, "")
        ports = iter([server.server_port, choose_loopback_port()])
        lifecycle = IsolatedOllamaLifecycle(
            config,
            clock=SystemClock(),
            process_controller=FakeProcessController(),
            executable_resolver=lambda: "fake-ollama",
            port_selector=lambda: next(ports),
            listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
        )
        provider = OllamaCaptureStructuringProvider(lifecycle, clock=SystemClock())
        original_generate = provider._generate_batch

        async def generate(*args, **kwargs):
            if switch_lease:
                lifecycle.stop()
                lifecycle.start()
            return await original_generate(*args, **kwargs)

        monkeypatch.setattr(provider, "_generate_batch", generate)
        try:
            if switch_lease:
                with pytest.raises(RuntimeUnavailableError):
                    asyncio.run(
                        provider.structure(
                            _raw(count=1), target_language=None, cancel_event=asyncio.Event()
                        )
                    )
                assert requests == ["/api/tags"]
            else:
                asyncio.run(
                    provider.structure(
                        _raw(count=1), target_language=None, cancel_event=asyncio.Event()
                    )
                )
                assert requests == ["/api/tags", "/api/generate"]
            assert proxy_requests == []
        finally:
            for s in (server, proxy):
                s.shutdown()
            for worker in workers:
                worker.join()


def test_pid_write_failure_stops_child(tmp_path, monkeypatch):
    controller = FakeProcessController()
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
    )

    def fail(*args):
        raise OSError("PID write failed")

    monkeypatch.setattr(
        "capture_runtime.structuring.infrastructure.ollama.lifecycle_impl._atomic_json", fail
    )
    with pytest.raises(OSError, match="PID write failed"):
        lifecycle.start()
    assert controller.stopped == [4242]
    assert not lifecycle.owns_running_process()
    with pytest.raises(RuntimeUnavailableError):
        _ = lifecycle.host_url


def test_installer_rejects_environment_from_previous_lease(tmp_path, monkeypatch):
    controller = FakeProcessController()
    ports = iter([12120, 12121])
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: next(ports),
        listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
    )
    commands = []
    installer = SystemRuntimeInstaller(
        lifecycle,
        clock=SystemClock(),
        command_runner=SimpleNamespace(run=lambda *args, **kwargs: commands.append(args)),
    )
    original_environment = lifecycle.process_environment

    def environment():
        result = original_environment()
        lifecycle.stop()
        lifecycle.start()
        return result

    async def ready(_cancel):
        pass

    monkeypatch.setattr(lifecycle, "process_environment", environment)
    monkeypatch.setattr(installer, "_wait_for_ollama_server", ready)
    with pytest.raises(RuntimeUnavailableError):
        asyncio.run(
            installer.install_model_option(
                "qwen3.5-4b-v1",
                cancel_event=asyncio.Event(),
                report_progress=lambda _: None,
            )
        )
    assert commands == []


def test_provider_rejects_response_from_previous_lease(tmp_path):
    config = _ollama_config(tmp_path)
    _record_installed_profile(config)
    ports = iter([12122, 12123])
    lifecycle = IsolatedOllamaLifecycle(
        config,
        clock=SystemClock(),
        process_controller=FakeProcessController(),
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: next(ports),
        listener_owner=SimpleNamespace(listener_pid=lambda _port: 4242),
    )

    def handler(request):
        if request.url.path == "/api/tags":
            return _tags(config)
        lifecycle.stop()
        lifecycle.start()
        return httpx.Response(200, json={"response": _valid_candidate(json.loads(request.content))})

    provider = OllamaCaptureStructuringProvider(
        lifecycle,
        clock=SystemClock(),
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(RuntimeUnavailableError):
        asyncio.run(
            provider.structure(
                _raw(count=1),
                target_language=None,
                cancel_event=asyncio.Event(),
            )
        )
