from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from capture_runtime.structuring.infrastructure.ollama.device_policy import (
    OllamaDevicePolicy,
    corrected_device_policy,
)
from capture_runtime.structuring.infrastructure.ollama.device_verification import (
    verify_device_execution,
)
from capture_runtime.structuring.infrastructure.ollama.server_log import (
    MAX_LINE_LENGTH,
    MAX_RECORD_HISTORY,
    BackendLoaded,
    LayerOffload,
    OllamaLogParser,
    RunnerDevice,
    SchedulerSelection,
)

_FIXTURES = Path(__file__).parents[1] / "fixtures" / "ollama_0_40_13"
_NVIDIA = "NVIDIA GeForce RTX 4060 Laptop GPU"
_ROCM_LOG = "rocm-igpu-selected-with-cuda-present"
_CUDA = OllamaDevicePolicy("cuda", adapter_name=_NVIDIA)


def _parse_fixture(name: str) -> OllamaLogParser:
    parser = OllamaLogParser()
    log = (_FIXTURES / f"{name}.log").read_text(encoding="utf-8")
    for start in range(0, len(log), 73):
        parser.feed(log[start : start + 73])
    return parser


@pytest.mark.parametrize(
    ("fixture", "policy", "state", "backend", "description", "pci", "layers", "token"),
    [
        (
            "cpu-all-gpus-hidden",
            OllamaDevicePolicy("cpu"),
            "verified",
            "cpu",
            None,
            None,
            None,
            "ollama",
        ),
        (
            "cuda-dgpu-hip-hidden",
            _CUDA,
            "verified",
            "cuda",
            _NVIDIA,
            "0000:63:00.0",
            34,
            "cuda_v13",
        ),
        (
            _ROCM_LOG,
            _CUDA,
            "mismatch",
            "rocm",
            "AMD Radeon(TM) 880M Graphics",
            "0000:65:00.0",
            34,
            "rocm_v7_1",
        ),
        (
            "vulkan-igpu-enabled",
            OllamaDevicePolicy("vulkan", integrated_gpu=True),
            "verified",
            "vulkan",
            "AMD Radeon(TM) 880M Graphics",
            None,
            34,
            "vulkan",
        ),
    ],
)
def test_fixture_execution(
    fixture: str,
    policy: OllamaDevicePolicy,
    state: str,
    backend: str,
    description: str | None,
    pci: str | None,
    layers: int | None,
    token: str,
) -> None:
    parser = _parse_fixture(fixture)
    load = parser.latest_load()
    devices = parser.discovered_devices()
    assert any(device.library.casefold() == backend for device in devices)
    assert any(
        isinstance(record, BackendLoaded)
        and record.library.casefold() == backend
        and record.token == token
        for record in load
    )
    result = verify_device_execution(policy, load, devices)
    assert result.state == state
    assert result.observed_backend == backend
    assert result.observed_description == description
    assert result.observed_pci_bus == pci
    assert result.offloaded_layers == layers
    assert result.total_layers == layers

    unmanaged = verify_device_execution(OllamaDevicePolicy("unmanaged"), load, devices)
    assert unmanaged == replace(result, target="unmanaged", state="unknown")


def test_discovery_or_selection_is_not_execution() -> None:
    devices = _parse_fixture(_ROCM_LOG).discovered_devices()
    result = verify_device_execution(
        _CUDA, (SchedulerSelection("ROCm", "ROCm0", "AMD", True, "0", "0"),), devices
    )
    assert result.state == "selected_unverified"
    assert result.observed_backend is None
    assert verify_device_execution(_CUDA, (), devices).state == "selected_unverified"
    assert verify_device_execution(_CUDA, (), ()).state == "unknown"


def test_runner_requires_positive_gpu_layers_and_matching_identity() -> None:
    devices = _parse_fixture(_ROCM_LOG).discovered_devices()
    runner = RunnerDevice("CUDA0", _NVIDIA, "63:00.0")
    for records in ((runner,), (runner, LayerOffload(0, 34))):
        result = verify_device_execution(_CUDA, records, devices)
        assert result.state == "selected_unverified"
        assert result.observed_backend is None
        assert (
            result.observed_library
            is result.observed_description
            is result.observed_pci_bus
            is None
        )
    partial = (runner, LayerOffload(1, 34))
    result = verify_device_execution(_CUDA, partial, devices)
    assert result.state == "verified"
    assert result.observed_library == runner.device_name
    assert result.observed_description == runner.description
    assert result.observed_pci_bus == runner.pci_bus
    assert verify_device_execution(OllamaDevicePolicy("cpu"), partial, devices).state == "mismatch"
    wrong_bus = (replace(runner, pci_bus="64:00.0"), LayerOffload(1, 34))
    assert verify_device_execution(_CUDA, wrong_bus, devices).state == "mismatch"


def test_cpu_backend_loading_alone_is_not_cpu_execution() -> None:
    result = verify_device_execution(OllamaDevicePolicy("cpu"), (BackendLoaded("CPU", "cpu"),), ())
    assert result.state == "selected_unverified"
    assert result.observed_backend is None


def test_correction_pins_unique_discovered_target_and_keeps_masks() -> None:
    devices = _parse_fixture(_ROCM_LOG).discovered_devices()
    rocm, cuda = devices
    corrected = corrected_device_policy(_CUDA, devices)
    assert corrected is not None
    assert corrected.pci_bus == "0000:63:00.0"
    assert corrected.serve_environment({"ollama_llm_library": "inherited"}) == {
        "CUDA_VISIBLE_DEVICES": "0",
        "HIP_VISIBLE_DEVICES": "-1",
        "GGML_VK_VISIBLE_DEVICES": "-1",
        "OLLAMA_VULKAN": "0",
        "OLLAMA_IGPU_ENABLE": "0",
        "OLLAMA_LLM_LIBRARY": "cuda_v13",
    }
    assert corrected_device_policy(corrected, devices) is None
    assert corrected_device_policy(_CUDA, (rocm,)) is None
    assert corrected_device_policy(_CUDA, (*devices, replace(cuda, id="1"))) is None
    assert corrected_device_policy(OllamaDevicePolicy("unmanaged"), devices) is None
    assert corrected_device_policy(_CUDA, (replace(cuda, filter_id="-1"),)) is None


def test_vulkan_correction_preserves_integrated_gpu_enablement() -> None:
    devices = _parse_fixture("vulkan-igpu-enabled").discovered_devices()
    corrected = corrected_device_policy(OllamaDevicePolicy("vulkan", integrated_gpu=True), devices)
    assert corrected is not None
    env = corrected.serve_environment({})
    assert env["GGML_VK_VISIBLE_DEVICES"] == "0"
    assert env["OLLAMA_VULKAN"] == env["OLLAMA_IGPU_ENABLE"] == "1"
    assert env["OLLAMA_LLM_LIBRARY"] == "vulkan"


def test_new_load_invalidates_old_execution_and_history_is_bounded() -> None:
    parser = _parse_fixture("cuda-dgpu-hip-hidden")
    parser.feed('time=now msg="using llama-server for model" model=private\n')
    assert parser.latest_load() == ()
    parser.feed('time=now msg="starting llama-server"\n')
    parser.feed("x" * (MAX_LINE_LENGTH + 1))
    parser.feed("load_tensors: offloaded 34/34 layers to GPU\r\n")
    assert parser.latest_load() == ()
    parser.feed("load_tensors: offloaded 1/2 layers to GPU\r\n" * (MAX_RECORD_HISTORY + 1))
    assert len(parser.records()) == MAX_RECORD_HISTORY
    assert parser.latest_load() == ()
    assert "private" not in repr(parser.records())
