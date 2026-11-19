"""Select the launch environment for Capture's owned Ollama server."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Literal

from capture_runtime.gpu_inventory import GpuAdapter, GpuAdapterClass, read_gpu_inventory

_NVIDIA_VENDOR_ID = 0x10DE
_AMD_VENDOR_ID = 0x1002
_GPU_UUID = re.compile(r"GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.IGNORECASE)
_GPU_OVERRIDES = frozenset(
    {
        "CUDA_VISIBLE_DEVICES",
        "HIP_VISIBLE_DEVICES",
        "GGML_VK_VISIBLE_DEVICES",
        "OLLAMA_VULKAN",
        "OLLAMA_IGPU_ENABLE",
        "ROCR_VISIBLE_DEVICES",
        "GPU_DEVICE_ORDINAL",
        "HSA_OVERRIDE_GFX_VERSION",
        "OLLAMA_LLM_LIBRARY",
    }
)


@dataclass(frozen=True, slots=True)
class OllamaDevicePolicy:
    target: Literal["cuda", "rocm", "vulkan", "cpu", "unmanaged"]
    integrated_gpu: bool = False
    cuda_uuid: str | None = None

    def serve_environment(self, base: Mapping[str, str]) -> dict[str, str]:
        if self.target == "unmanaged":
            return dict(base)
        child = {key: value for key, value in base.items() if key.upper() not in _GPU_OVERRIDES}
        child["OLLAMA_VULKAN"] = "1" if self.target == "vulkan" else "0"
        child["OLLAMA_IGPU_ENABLE"] = "1" if self.integrated_gpu else "0"
        if self.target != "cuda":
            child["CUDA_VISIBLE_DEVICES"] = "-1"
        elif self.cuda_uuid is not None:
            child["CUDA_VISIBLE_DEVICES"] = self.cuda_uuid
        if self.target != "rocm":
            child["HIP_VISIBLE_DEVICES"] = "-1"
        if self.target != "vulkan":
            child["GGML_VK_VISIBLE_DEVICES"] = "-1"
        return child


def resolve_device_policy() -> OllamaDevicePolicy:
    """Resolve one owned server launch from the current machine inventory."""

    if sys.platform != "win32":
        return OllamaDevicePolicy("unmanaged")
    inventory = read_gpu_inventory()
    if not inventory.complete:
        return OllamaDevicePolicy("unmanaged")

    dedicated = [
        adapter
        for adapter in inventory.adapters
        if adapter.adapter_class is GpuAdapterClass.DEDICATED
    ]
    if dedicated:
        selected = min(dedicated, key=_dedicated_sort_key)
        if selected.vendor_id == _NVIDIA_VENDOR_ID:
            return OllamaDevicePolicy(
                "cuda", cuda_uuid=_find_cuda_uuid(selected, inventory.adapters)
            )
        if selected.vendor_id == _AMD_VENDOR_ID:
            return OllamaDevicePolicy("rocm")
        return OllamaDevicePolicy("vulkan")

    classes = {adapter.adapter_class for adapter in inventory.adapters}
    if GpuAdapterClass.UNKNOWN in classes:
        return OllamaDevicePolicy("unmanaged")
    if GpuAdapterClass.INTEGRATED in classes:
        return OllamaDevicePolicy("vulkan", integrated_gpu=True)
    return OllamaDevicePolicy("cpu")


def _dedicated_sort_key(adapter: GpuAdapter) -> tuple[int, int, str]:
    vendor_rank = {_NVIDIA_VENDOR_ID: 0, _AMD_VENDOR_ID: 1}.get(adapter.vendor_id, 2)
    return -adapter.dedicated_memory_bytes, vendor_rank, adapter.description


def _find_cuda_uuid(selected: GpuAdapter, adapters: tuple[GpuAdapter, ...]) -> str | None:
    # DXGI exposes the PCI model id. Identical boards cannot be distinguished
    # by that id, so require a unique match on each side of the join.
    native_matches = sum(
        (adapter.vendor_id, adapter.device_id) == (selected.vendor_id, selected.device_id)
        for adapter in adapters
        if adapter.adapter_class is not GpuAdapterClass.SOFTWARE
    )
    if native_matches != 1:
        return None
    executable = shutil.which("nvidia-smi")
    if executable is None:
        return None
    try:
        result = subprocess.run(
            [
                executable,
                "--query-gpu=uuid,pci.device_id",
                "--format=csv,noheader,nounits",
            ],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=2,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    pci_id = f"0x{selected.device_id:04x}{selected.vendor_id:04x}"
    rows = [tuple(part.strip() for part in line.split(",")) for line in result.stdout.splitlines()]
    matches = [row[0] for row in rows if len(row) == 2 and row[1].casefold() == pci_id]
    if len(matches) != 1 or _GPU_UUID.fullmatch(matches[0]) is None:
        return None
    uuid = matches[0]
    if sum(row[0].casefold() == uuid.casefold() for row in rows) != 1:
        return None
    return uuid
