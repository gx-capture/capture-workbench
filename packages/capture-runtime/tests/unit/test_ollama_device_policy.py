from __future__ import annotations

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

    lifecycle.start()
    try:
        assert controller.spawned == [["fake-ollama", "serve"]]
        assert controller.environments == [expected]
        assert inventory_reads == ([inventory, inventory] if platform == "win32" else [])
    finally:
        lifecycle.stop()


@pytest.mark.parametrize("query", ["missing", "timeout", "wrong_pci", "ambiguous", "identical"])
def test_cuda_pin_requires_a_unique_verified_match(
    monkeypatch: pytest.MonkeyPatch, query: str
) -> None:
    def run(args: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        assert "--query-gpu=uuid,pci.device_id" in args
        assert kwargs["timeout"] == 2
        assert query not in {"missing", "identical"}
        if query == "timeout":
            raise subprocess.TimeoutExpired(args, 2)
        output = f"{_UUID}, 0x123410DE\n" * 2
        if query == "wrong_pci":
            output = f"{_UUID}, 0x567810DE\n"
        return subprocess.CompletedProcess(args, 0, stdout=output)

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


def test_dedicated_memory_precedes_vendor_as_in_cert(monkeypatch: pytest.MonkeyPatch) -> None:
    larger_amd = _adapter(0x1002, GpuAdapterClass.DEDICATED, memory=2)
    monkeypatch.setattr(device_policy, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(
        device_policy, "read_gpu_inventory", lambda: GpuInventory(True, (_NVIDIA, larger_amd))
    )

    assert device_policy.resolve_device_policy().target == "rocm"
