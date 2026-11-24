"""Select the launch environment for Capture's owned Ollama server."""

from __future__ import annotations

import ctypes
import os
import re
import shutil
import subprocess
import sys
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Literal
from uuid import UUID

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
    cuda_pin_reason: str | None = None

    def cuda_pin_applied(self, environment: Mapping[str, str]) -> bool:
        return self.target == "cuda" and bool(
            _GPU_UUID.fullmatch(environment.get("CUDA_VISIBLE_DEVICES", ""))
        )

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
            cuda_uuid, reason = _find_cuda_uuid(selected, inventory.adapters)
            return OllamaDevicePolicy(
                "cuda",
                cuda_uuid=cuda_uuid,
                adapter_name=selected.description,
                cuda_pin_reason=reason,
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


def _known_program_folder(variable: str) -> str | None:
    """Resolve a Windows known folder without relying on inherited variables."""
    if sys.platform != "win32":
        return None
    folder_id = {
        "ProgramFiles": "905e63b6-c1bf-494e-b29c-65b732d3d21a",
        "ProgramW6432": "6d809377-6af0-444b-8957-a3773f02200e",
    }[variable]
    guid = (ctypes.c_ubyte * 16).from_buffer_copy(UUID(folder_id).bytes_le)
    path = ctypes.c_wchar_p()
    try:
        shell = ctypes.WinDLL("shell32", use_last_error=True)
        ole = ctypes.WinDLL("ole32", use_last_error=True)
        lookup = shell.SHGetKnownFolderPath
        lookup.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_wchar_p),
        ]
        lookup.restype = ctypes.c_long
        free = ole.CoTaskMemFree
        free.argtypes = [ctypes.c_void_p]
        free.restype = None
        try:
            if lookup(ctypes.byref(guid), 0, None, ctypes.byref(path)) != 0:
                return None
            return path.value or None
        finally:
            if path:
                free(ctypes.cast(path, ctypes.c_void_p))
    except (AttributeError, OSError):
        return None


def _find_cuda_uuid(
    selected: GpuAdapter, adapters: tuple[GpuAdapter, ...]
) -> tuple[str | None, str | None]:
    # DXGI exposes the PCI model id. Identical boards cannot be distinguished
    # by that id, so require a unique match on each side of the join.
    native_matches = sum(
        (adapter.vendor_id, adapter.device_id) == (selected.vendor_id, selected.device_id)
        for adapter in adapters
        if adapter.adapter_class is not GpuAdapterClass.SOFTWARE
    )
    if native_matches != 1:
        return None, "no unique match"
    executable = shutil.which("nvidia-smi")
    if executable is None and (system_root := os.environ.get("SystemRoot")):
        fallback = Path(system_root) / "System32" / "nvidia-smi.exe"
        if fallback.is_file():
            executable = str(fallback)
    if executable is None:
        return None, "nvidia-smi not found"
    environment = dict(os.environ)
    if sys.platform == "win32":
        # NVML fails to initialise without these variables, observed with the
        # host's minimal environment. Supply them only to the nvidia-smi child.
        for variable in ("ProgramFiles", "ProgramW6432"):
            if variable.upper() not in {key.upper() for key in environment}:
                folder = _known_program_folder(variable)
                if folder is not None:
                    environment[variable] = folder
    try:
        result = subprocess.run(
            [
                executable,
                "--query-gpu=uuid,pci.device_id",
                "--format=csv,noheader,nounits",
            ],
            env=environment,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            # A sleeping laptop GPU wakes during the first query.
            timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except OSError:
        return None, "nvidia-smi could not start"
    if result.returncode != 0:
        return None, "non-zero exit"
    pci_id = f"0x{selected.device_id:04x}{selected.vendor_id:04x}"
    rows = [tuple(part.strip() for part in line.split(",")) for line in result.stdout.splitlines()]
    matches = [row[0] for row in rows if len(row) == 2 and row[1].casefold() == pci_id]
    if len(matches) != 1 or _GPU_UUID.fullmatch(matches[0]) is None:
        return None, "no unique match"
    uuid = matches[0]
    if sum(row[0].casefold() == uuid.casefold() for row in rows) != 1:
        return None, "no unique match"
    return uuid, None


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
        cuda_pin_reason=(
            None
            if policy.target == "cuda" and _GPU_UUID.fullmatch(filter_id)
            else policy.cuda_pin_reason
        ),
        device_filter=filter_id,
        library_token=library,
    )
    return corrected if corrected.serve_environment({}) != policy.serve_environment({}) else None
