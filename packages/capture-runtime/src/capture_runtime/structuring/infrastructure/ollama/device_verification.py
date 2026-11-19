"""Compare a load's execution evidence with the owned server's device policy."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from capture_runtime.structuring.infrastructure.ollama.device_policy import (
    DeviceTarget,
    OllamaDevicePolicy,
    matching_discovered_devices,
    normalize_device_name,
    same_pci_bus,
)
from capture_runtime.structuring.infrastructure.ollama.server_log import (
    BackendLoaded,
    CpuModelBuffer,
    DiscoveredDevice,
    LayerOffload,
    LogRecord,
    RunnerDevice,
)

VerificationState = Literal["verified", "mismatch", "selected_unverified", "unknown"]
ObservedBackend = Literal["cpu", "cuda", "rocm", "vulkan"]


@dataclass(frozen=True, slots=True)
class DeviceExecution:
    target: DeviceTarget
    state: VerificationState
    observed_backend: ObservedBackend | None
    observed_library: str | None
    observed_description: str | None
    observed_pci_bus: str | None
    offloaded_layers: int | None
    total_layers: int | None


def _backend(library: str) -> ObservedBackend | None:
    match = re.fullmatch(r"(cpu|cuda|rocm|hip|vulkan)[0-9]*", library.casefold())
    if match is None:
        return None
    match match[1]:
        case "cpu":
            return "cpu"
        case "cuda":
            return "cuda"
        case "rocm" | "hip":
            return "rocm"
        case "vulkan":
            return "vulkan"
    return None


def verify_device_execution(
    policy: OllamaDevicePolicy,
    load_records: Sequence[LogRecord],
    discovered: Sequence[DiscoveredDevice],
) -> DeviceExecution:
    """Verify the latest load and retain actual execution for provenance."""
    runners = tuple(dict.fromkeys(r for r in load_records if isinstance(r, RunnerDevice)))
    runner = runners[0] if len(runners) == 1 else None
    offload = next((r for r in reversed(load_records) if isinstance(r, LayerOffload)), None)
    loaded_libraries = {
        r.library
        for r in load_records
        if isinstance(r, BackendLoaded) and r.library.casefold() != "cpu"
    }
    libraries = {
        backend for library in loaded_libraries if (backend := _backend(library)) is not None
    }

    observed: ObservedBackend | None = None
    if offload is not None and offload.offloaded_layers > 0:
        if runner is not None:
            runner_backend = _backend(runner.device_name)
            if runner_backend != "cpu":
                observed = runner_backend
        elif not runners and len(loaded_libraries) == len(libraries) == 1:
            observed = next(iter(libraries))
    elif any(isinstance(r, CpuModelBuffer) for r in load_records) and (
        (offload is not None and offload.offloaded_layers == 0)
        or (not runners and not loaded_libraries)
    ):
        observed = "cpu"

    state: VerificationState = "unknown"
    if policy.target != "unmanaged":
        if policy.target == "cpu" and offload is not None and offload.offloaded_layers > 0:
            state = "mismatch"
        elif observed is not None and observed != policy.target:
            state = "mismatch"
        elif observed == "cpu":
            state = "verified"
        elif observed is not None and runner is not None:
            state = _verify_adapter(policy, runner, discovered)
        elif load_records or matching_discovered_devices(policy, discovered):
            state = "selected_unverified"

    return DeviceExecution(
        target=policy.target,
        state=state,
        observed_backend=observed,
        observed_library=(
            runner.device_name if runner is not None and observed != "cpu" else observed
        ),
        observed_description=(
            runner.description if runner is not None and observed != "cpu" else None
        ),
        observed_pci_bus=(runner.pci_bus if runner is not None and observed != "cpu" else None),
        offloaded_layers=offload.offloaded_layers if offload is not None else None,
        total_layers=offload.total_layers if offload is not None else None,
    )


def _verify_adapter(
    policy: OllamaDevicePolicy, runner: RunnerDevice, discovered: Sequence[DiscoveredDevice]
) -> VerificationState:
    runner_name = normalize_device_name(runner.description)
    if not runner_name:
        return "selected_unverified"
    if policy.adapter_name and runner_name != normalize_device_name(policy.adapter_name):
        return "mismatch"
    if policy.pci_bus:
        if not runner.pci_bus:
            return "selected_unverified"
        return "verified" if same_pci_bus(policy.pci_bus, runner.pci_bus) else "mismatch"

    candidates = matching_discovered_devices(policy, discovered)
    if len(candidates) != 1:
        return "selected_unverified"
    candidate = candidates[0]
    if runner_name != normalize_device_name(candidate.description):
        return "mismatch"
    if runner.pci_bus and candidate.pci_id and not same_pci_bus(runner.pci_bus, candidate.pci_id):
        return "mismatch"
    return "verified"
