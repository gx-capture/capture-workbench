from __future__ import annotations

import asyncio
import logging
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.gpu_inventory import GpuAdapter, GpuAdapterClass, GpuInventory
from capture_runtime.structuring.infrastructure.ollama import device_policy
from capture_runtime.structuring.infrastructure.ollama.lifecycle_impl import IsolatedOllamaLifecycle
from tests.integration.test_ollama_restart_readiness import FakeProcessController, _ollama_config

_UUID = "GPU-12345678-1234-1234-1234-123456789abc"
_OVERRIDES = {
    "cuda_visible_devices": "ambient",
    "HIP_VISIBLE_DEVICES": "ambient",
    "ggml_vk_visible_devices": "ambient",
    "OLLAMA_VULKAN": "ambient",
    "OLLAMA_IGPU_ENABLE": "ambient",
    "ROCR_VISIBLE_DEVICES": "ambient",
    "GPU_DEVICE_ORDINAL": "ambient",
    "HSA_OVERRIDE_GFX_VERSION": "ambient",
    "ollama_llm_library": "ambient",
}


def _adapter(vendor: int, classification: GpuAdapterClass, memory: int = 0) -> GpuAdapter:
    return GpuAdapter("GPU", vendor, 0x1234, f"{vendor:016x}", classification, 0, 0, memory)


_NVIDIA = _adapter(0x10DE, GpuAdapterClass.DEDICATED)
_AMD = _adapter(0x1002, GpuAdapterClass.DEDICATED)
_OTHER = _adapter(0x8086, GpuAdapterClass.DEDICATED)
_INTEGRATED = _adapter(0x8086, GpuAdapterClass.INTEGRATED)
_UNKNOWN = _adapter(0x1234, GpuAdapterClass.UNKNOWN)
_SOFTWARE = _adapter(0x1414, GpuAdapterClass.SOFTWARE)


@pytest.mark.parametrize(
    ("platform", "inventory", "target", "mask_values"),
    [
        ("win32", GpuInventory(True, (_NVIDIA, _UNKNOWN)), "cuda", (_UUID, "-1", "-1", "0", "0")),
        ("win32", GpuInventory(True, (_AMD,)), "rocm", ("-1", None, "-1", "0", "0")),
        ("win32", GpuInventory(True, (_OTHER,)), "vulkan", ("-1", "-1", None, "1", "0")),
        ("win32", GpuInventory(True, (_INTEGRATED,)), "vulkan", ("-1", "-1", None, "1", "1")),
        ("win32", GpuInventory(True, (_SOFTWARE,)), "cpu", ("-1", "-1", "-1", "0", "0")),
        ("win32", GpuInventory(True), "cpu", ("-1", "-1", "-1", "0", "0")),
        ("win32", GpuInventory(True, (_INTEGRATED, _UNKNOWN)), "unmanaged", None),
        ("win32", GpuInventory(False), "unmanaged", None),
        ("linux", GpuInventory(True, (_NVIDIA,)), "unmanaged", None),
    ],
)
def test_exact_serve_environment(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    platform: str,
    inventory: GpuInventory,
    target: str,
    mask_values: tuple[str | None, ...] | None,
) -> None:
    inventory_reads: list[GpuInventory] = []

    def read_inventory() -> GpuInventory:
        inventory_reads.append(inventory)
        return inventory

    monkeypatch.setattr(device_policy, "sys", SimpleNamespace(platform=platform))
    monkeypatch.setattr(device_policy, "read_gpu_inventory", read_inventory)
    monkeypatch.setattr(device_policy.shutil, "which", lambda name: "fake-nvidia-smi")
    monkeypatch.setattr(
        device_policy.subprocess,
        "run",
        lambda args, **kwargs: SimpleNamespace(returncode=0, stdout=f"{_UUID}, 0x123410DE\n"),
    )
    base = {"PATH": "bin", "OLLAMA_HOST": "127.0.0.1:12222", "OLLAMA_MODELS": "models"}
    inherited = {**base, **_OVERRIDES}

    policy = device_policy.resolve_device_policy()

    assert policy.target == target
    if mask_values is None:
        expected = inherited
    else:
        keys = (
            "CUDA_VISIBLE_DEVICES",
            "HIP_VISIBLE_DEVICES",
            "GGML_VK_VISIBLE_DEVICES",
            "OLLAMA_VULKAN",
            "OLLAMA_IGPU_ENABLE",
        )
        masks = {
            key: value for key, value in zip(keys, mask_values, strict=True) if value is not None
        }
        expected = {**base, **masks}

    config = _ollama_config(tmp_path)
    monkeypatch.setattr(
        type(config), "process_environment", lambda self, host: {**inherited, "OLLAMA_HOST": host}
    )
    controller = FakeProcessController()
    lifecycle = IsolatedOllamaLifecycle(
        config,
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: 12222,
        listener_owner=SimpleNamespace(listener_pid=lambda port: 4242),
    )

    caplog.set_level("INFO")
    lifecycle.start()
    try:
        launch_records = [
            r for r in caplog.records if r.message.startswith("Starting owned Ollama:")
        ]
        assert launch_records[-1].levelno == logging.INFO
        assert controller.spawned == [["fake-ollama", "serve"]]
        assert controller.environments == [expected]
        assert inventory_reads == ([inventory, inventory] if platform == "win32" else [])
    finally:
        lifecycle.stop()


@pytest.mark.parametrize(
    "query", ["missing", "timeout", "nonzero", "wrong_pci", "ambiguous", "identical"]
)
def test_cuda_pin_requires_a_unique_verified_match(
    monkeypatch: pytest.MonkeyPatch, query: str
) -> None:
    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        assert "--query-gpu=uuid,pci.device_id" in args
        assert kwargs["timeout"] == 15
        assert query not in {"missing", "identical"}
        if query == "timeout":
            raise subprocess.TimeoutExpired(args, 15)
        output = f"{_UUID}, 0x123410DE\n" * 2
        if query == "wrong_pci":
            output = f"{_UUID}, 0x567810DE\n"
        return subprocess.CompletedProcess(args, 1 if query == "nonzero" else 0, stdout=output)

    monkeypatch.delenv("SystemRoot", raising=False)
    adapters = (_NVIDIA, _NVIDIA) if query == "identical" else (_NVIDIA,)
    monkeypatch.setattr(device_policy, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(device_policy, "read_gpu_inventory", lambda: GpuInventory(True, adapters))
    monkeypatch.setattr(
        device_policy.shutil,
        "which",
        lambda name: None if query == "missing" else "fake-nvidia-smi",
    )
    monkeypatch.setattr(device_policy.subprocess, "run", run)

    policy = device_policy.resolve_device_policy()

    assert policy.target == "cuda"
    assert "CUDA_VISIBLE_DEVICES" not in policy.serve_environment(_OVERRIDES)
    assert policy.cuda_pin_reason == {
        "missing": "nvidia-smi not found",
        "timeout": "timeout",
        "nonzero": "non-zero exit",
    }.get(query, "no unique match")


def test_dedicated_memory_precedes_vendor_as_in_cert(monkeypatch: pytest.MonkeyPatch) -> None:
    larger_amd = _adapter(0x1002, GpuAdapterClass.DEDICATED, memory=2)
    monkeypatch.setattr(device_policy, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(
        device_policy, "read_gpu_inventory", lambda: GpuInventory(True, (_NVIDIA, larger_amd))
    )

    assert device_policy.resolve_device_policy().target == "rocm"


def test_cuda_pin_uses_system_root_when_path_lookup_misses(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    executable = tmp_path / "System32" / "nvidia-smi.exe"
    executable.parent.mkdir()
    executable.touch()
    monkeypatch.setenv("SystemRoot", str(tmp_path))
    monkeypatch.setattr(device_policy.shutil, "which", lambda name: None)

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        assert args[0] == str(executable)
        assert kwargs["timeout"] == 15
        return subprocess.CompletedProcess(args, 0, stdout=f"{_UUID}, 0x123410DE\n")

    monkeypatch.setattr(device_policy.subprocess, "run", run)
    assert device_policy._find_cuda_uuid(_NVIDIA, (_NVIDIA,)) == (_UUID, None)


def test_cuda_pin_timeout_is_logged_and_next_start_resolves_again(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    queries = 0

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        nonlocal queries
        queries += 1
        if queries == 1:
            raise subprocess.TimeoutExpired(args, 15)
        return subprocess.CompletedProcess(args, 0, stdout=f"{_UUID}, 0x123410DE\n")

    monkeypatch.setattr(device_policy, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(device_policy, "read_gpu_inventory", lambda: GpuInventory(True, (_NVIDIA,)))
    monkeypatch.setattr(device_policy.shutil, "which", lambda name: "fake-nvidia-smi")
    monkeypatch.setattr(device_policy.subprocess, "run", run)
    controller = FakeProcessController()
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: 12222,
        listener_owner=SimpleNamespace(listener_pid=lambda port: 4242),
    )
    caplog.set_level("INFO")
    try:
        lifecycle.start()
        previous = lifecycle.device_policy
        assert previous is not None and previous.cuda_pin_reason == "timeout"
        assert "CUDA_VISIBLE_DEVICES" not in controller.environments[0]
        assert "target=cuda cuda_uuid_pin=False reason=timeout" in caplog.text
        launch_records = [
            r for r in caplog.records if r.message.startswith("Starting owned Ollama:")
        ]
        assert launch_records[-1].levelno == logging.WARNING
        lifecycle.stop()
        # The next ordinary launch resolves the policy again instead of reusing
        # the failed lookup (a corrective restart passes its own policy instead).
        lifecycle.start()
        assert queries == 2
        launch_records = [
            r for r in caplog.records if r.message.startswith("Starting owned Ollama:")
        ]
        assert launch_records[-1].levelno == logging.INFO
        assert controller.environments[1]["CUDA_VISIBLE_DEVICES"] == _UUID
        assert "target=cuda cuda_uuid_pin=True reason=applied" in caplog.text
    finally:
        lifecycle.stop()


@pytest.mark.parametrize("corrective", [False, True])
def test_listener_retries_keep_policy_and_corrective_restart_does_not_query(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
    corrective: bool,
) -> None:
    from capture_runtime.structuring.infrastructure.ollama import lifecycle_impl
    from capture_runtime.structuring.infrastructure.ollama.server_log import DiscoveredDevice

    queries = 0
    policy = device_policy.OllamaDevicePolicy("cuda", cuda_pin_reason="timeout")

    def resolve() -> device_policy.OllamaDevicePolicy:
        nonlocal queries
        queries += 1
        return policy

    monkeypatch.setattr(lifecycle_impl, "resolve_device_policy", resolve)
    controller = FakeProcessController()
    ports = iter([12221, 12222])
    lifecycle = IsolatedOllamaLifecycle(
        _ollama_config(tmp_path),
        clock=SystemClock(),
        process_controller=controller,
        executable_resolver=lambda: "fake-ollama",
        port_selector=lambda: next(ports),
        listener_owner=SimpleNamespace(listener_pid=lambda port: 999 if port == 12221 else 4242),
    )
    caplog.set_level("INFO")
    try:
        if corrective:
            correction = device_policy.corrected_device_policy(
                policy,
                [DiscoveredDevice("cuda", _UUID, None, "GPU", "GPU", None, "GPU", ("cuda",))],
            )
            assert correction is not None
            assert correction.cuda_pin_reason is None
            asyncio.run(lifecycle.restart_for_device(correction, asyncio.Event()))
            assert queries == 0
            assert all(env["CUDA_VISIBLE_DEVICES"] == _UUID for env in controller.environments)
            assert "target=cuda cuda_uuid_pin=True reason=applied" in caplog.text
        else:
            lifecycle.start()
            assert queries == 1
            assert all("CUDA_VISIBLE_DEVICES" not in env for env in controller.environments)
        assert len(controller.environments) == 2
    finally:
        lifecycle.stop()


@pytest.mark.parametrize("present", [False, True])
@pytest.mark.parametrize("lookup_succeeds", [False, True])
def test_cuda_query_child_environment(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, present: bool, lookup_succeeds: bool
) -> None:
    variables = ("ProgramFiles", "ProgramW6432")
    for variable in variables:
        monkeypatch.delenv(variable, raising=False)
        if present:
            monkeypatch.setenv(variable, str(tmp_path / f"existing-{variable}"))
    before = dict(os.environ)
    lookups: list[str] = []

    def lookup(variable: str) -> str | None:
        lookups.append(variable)
        return str(tmp_path / variable) if lookup_succeeds else None

    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        expected = dict(before)
        if not present and lookup_succeeds:
            expected.update({variable: str(tmp_path / variable) for variable in variables})
        assert kwargs["env"] == expected
        return subprocess.CompletedProcess(args, 0, stdout=f"{_UUID}, 0x123410DE\n")

    monkeypatch.setattr(device_policy, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(device_policy, "_known_program_folder", lookup)
    monkeypatch.setattr(device_policy.shutil, "which", lambda name: "fake-nvidia-smi")
    monkeypatch.setattr(device_policy.subprocess, "run", run)
    assert device_policy._find_cuda_uuid(_NVIDIA, (_NVIDIA,)) == (_UUID, None)
    assert lookups == ([] if present else list(variables))
    assert dict(os.environ) == before
