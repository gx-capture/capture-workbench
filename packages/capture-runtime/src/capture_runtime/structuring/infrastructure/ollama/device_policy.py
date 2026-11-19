"""Select the launch environment for Capture's owned Ollama server."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Literal

from capture_runtime.gpu_inventory import GpuAdapter, GpuAdapterClass, read_gpu_inventory
from capture_runtime.structuring.infrastructure.ollama.server_log import DiscoveredDevice

type DeviceTarget = Literal["cuda", "rocm", "vulkan", "cpu", "unmanaged"]

_NVIDIA_VENDOR_ID = 0x10DE
_AMD_VENDOR_ID = 0x1002
_GPU_UUID = re.compile(r"GPU-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", re.IGNORECASE)
_DEVICE_FILTERS = {
    "cuda": "CUDA_VISIBLE_DEVICES",
    "rocm": "HIP_VISIBLE_DEVICES",
    "vulkan": "GGML_VK_VISIBLE_DEVICES",
}
_FILTER_ORDINAL = re.compile(r"[0-9]{1,10}")
_PCI_BUS = re.compile(
    r"(?:([0-9a-f]{1,8}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])", re.IGNORECASE
)
_LIBRARY_TOKEN = re.compile(r"[a-zA-Z0-9_-]{1,64}")
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
    target: DeviceTarget
    integrated_gpu: bool = False
    cuda_uuid: str | None = None
    adapter_name: str | None = None
    pci_bus: str | None = None
    device_filter: str | None = None
    library_token: str | None = None

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
        if self.device_filter is not None and self.target in _DEVICE_FILTERS:
            child[_DEVICE_FILTERS[self.target]] = self.cuda_uuid or self.device_filter
        if self.library_token is not None:
            child["OLLAMA_LLM_LIBRARY"] = self.library_token
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
                "cuda",
                cuda_uuid=_find_cuda_uuid(selected, inventory.adapters),
                adapter_name=selected.description,
            )
        if selected.vendor_id == _AMD_VENDOR_ID:
            return OllamaDevicePolicy("rocm", adapter_name=selected.description)
        return OllamaDevicePolicy("vulkan", adapter_name=selected.description)

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


def normalize_device_name(name: str) -> str:
    cleaned = re.sub(r"\((?:tm|r)\)", "", name, flags=re.IGNORECASE)
    return " ".join(cleaned.split()).casefold()


def same_pci_bus(left: str, right: str) -> bool:
    left_match = _PCI_BUS.fullmatch(left.strip())
    right_match = _PCI_BUS.fullmatch(right.strip())
    if left_match is None or right_match is None:
        return left.casefold() == right.casefold()
    return tuple(int(part or "0", 16) for part in left_match.groups()) == tuple(
        int(part or "0", 16) for part in right_match.groups()
    )


def matching_discovered_devices(
    policy: OllamaDevicePolicy, discovered: Sequence[DiscoveredDevice]
) -> tuple[DiscoveredDevice, ...]:
    """Match the target by backend and available inventory identity."""
    matches: dict[tuple[str, str | None, str, str | None], DiscoveredDevice] = {}
    if policy.target == "unmanaged":
        return ()
    for device in discovered:
        description = normalize_device_name(device.description)
        if device.library.casefold() != policy.target or not description:
            continue
        if policy.adapter_name and description != normalize_device_name(policy.adapter_name):
            continue
        if policy.integrated_gpu and device.type.casefold() != "igpu":
            continue
        if policy.pci_bus and (
            not device.pci_id or not same_pci_bus(policy.pci_bus, device.pci_id)
        ):
            continue
        if policy.cuda_uuid and _GPU_UUID.fullmatch(device.id):
            if device.id.casefold() != policy.cuda_uuid.casefold():
                continue
        matches[(device.id, device.filter_id, description, device.pci_id)] = device
    return tuple(matches.values())


def corrected_device_policy(
    policy: OllamaDevicePolicy, discovered: Sequence[DiscoveredDevice]
) -> OllamaDevicePolicy | None:
    """Pin a unique discovered target for a corrective launch."""
    if policy.target not in _DEVICE_FILTERS:
        return None
    candidates = matching_discovered_devices(policy, discovered)
    if len(candidates) != 1:
        return None
    device = candidates[0]
    filter_id = policy.cuda_uuid or device.filter_id or device.id
    if not (
        _FILTER_ORDINAL.fullmatch(filter_id)
        or (policy.target == "cuda" and _GPU_UUID.fullmatch(filter_id))
    ):
        return None
    library = next(
        (
            token
            for token in device.libdirs
            if token.casefold() != "ollama" and _LIBRARY_TOKEN.fullmatch(token)
        ),
        policy.target,
    )
    corrected = replace(
        policy,
        adapter_name=device.description,
        pci_bus=device.pci_id or policy.pci_bus,
        device_filter=filter_id,
        library_token=library,
    )
    return corrected if corrected.serve_environment({}) != policy.serve_environment({}) else None
