from __future__ import annotations

import importlib.util
import subprocess
import urllib.request
from contextlib import nullcontext
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "report_bundle_size.py"
SPEC = importlib.util.spec_from_file_location("capture_report_bundle_size", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
report_bundle_size = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report_bundle_size)


class FakeProcess:
    pid = 4312

    def __init__(self) -> None:
        self.waited = False

    def poll(self) -> None:
        return None

    def wait(self, timeout: float) -> int:
        assert timeout == 5
        self.waited = True
        return 0

    def kill(self) -> None:
        raise AssertionError("taskkill should have reaped the exact process tree")


class ReadyResponse:
    status = 200

    def __enter__(self) -> ReadyResponse:
        return self

    def __exit__(self, *_args: object) -> None:
        return None


def test_reporter_probes_public_ready_route(monkeypatch) -> None:
    requests: list[urllib.request.Request] = []
    process = FakeProcess()
    monkeypatch.setattr(
        report_bundle_size.urllib.request,
        "urlopen",
        lambda request, **_kwargs: requests.append(request) or ReadyResponse(),
    )

    report_bundle_size._wait_ready(8766, "a" * 48, process)  # type: ignore[arg-type]

    assert requests[0].full_url == "http://127.0.0.1:8766/v1/health/ready"
    assert requests[0].headers["Authorization"] == f"Bearer {'a' * 48}"


def test_reporter_uses_production_host_ready_providers(monkeypatch, tmp_path: Path) -> None:
    environments: list[dict[str, str]] = []

    class StartupProcess(FakeProcess):
        def __init__(self, _arguments: list[str], **kwargs: object) -> None:
            super().__init__()
            environments.append(kwargs["env"])  # type: ignore[arg-type]

    monkeypatch.setattr(
        report_bundle_size.tempfile,
        "TemporaryDirectory",
        lambda **_kwargs: nullcontext(tmp_path),
    )
    monkeypatch.setattr(report_bundle_size.subprocess, "Popen", StartupProcess)
    monkeypatch.setattr(report_bundle_size, "_wait_ready", lambda *_args: None)
    monkeypatch.setattr(report_bundle_size, "terminate_owned_process_tree", lambda *_args: None)

    result = report_bundle_size.measure_startup(tmp_path / "capture-runtime.exe", samples=1)

    assert result["blocker"] is None
    assert environments[0]["CAPTURE_EXTRACTION_PROVIDER"] == "runtime"
    assert environments[0]["CAPTURE_STRUCTURING_PROVIDER"] == "host"


def test_installed_size_evidence_requires_exact_installer_and_cleanup(
    tmp_path: Path,
) -> None:
    evidence = tmp_path / "installed-size.json"
    evidence.write_text(
        """
{
  "arch": "x86_64",
  "bundle": "nsis",
  "cleanup": {
    "installDirectoryRemoved": true,
    "isolatedRunDataRemoved": true,
    "nativeUninstallKeyRemoved": true,
    "productRegistryKeyRetainedAfterNativeUninstall": true,
    "registryResidueRemoved": true,
    "uninstallerCompleted": true
  },
  "disclaimer": "size only",
  "evidenceKind": "release-installed-size",
  "installedBytes": 1234,
  "installer": {
    "bytes": 99,
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "platform": "windows",
  "releaseGateSatisfied": false
}
""".strip(),
        encoding="utf-8",
    )
    installed_bytes, blocker = report_bundle_size.installed_bytes_evidence(
        evidence,
        installer={"bytes": 99, "sha256": "a" * 64},
    )
    assert installed_bytes == 1234
    assert blocker is None

    installed_bytes, blocker = report_bundle_size.installed_bytes_evidence(
        evidence,
        installer={"bytes": 100, "sha256": "a" * 64},
    )
    assert installed_bytes is None
    assert blocker is not None


def test_windows_reporter_terminates_only_its_owned_pid_tree(
    monkeypatch,
) -> None:
    calls: list[list[str]] = []
    fake = FakeProcess()
    monkeypatch.setattr(report_bundle_size.sys, "platform", "win32")
    monkeypatch.setattr(
        report_bundle_size.subprocess,
        "run",
        lambda arguments, **_kwargs: (
            calls.append(list(arguments)) or subprocess.CompletedProcess(arguments, 0)
        ),
    )
    report_bundle_size.terminate_owned_process_tree(fake)  # type: ignore[arg-type]
    assert calls == [["taskkill", "/PID", "4312", "/T", "/F"]]
    assert fake.waited is True
