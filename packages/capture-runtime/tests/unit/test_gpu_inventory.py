from __future__ import annotations

import ctypes
from types import SimpleNamespace

import pytest

from capture_runtime import gpu_inventory as native
from capture_runtime.contracts import OcrComputeMode
from capture_runtime.ocr.infrastructure.ocr_preflight import (
    NativeOcrGpuCapabilityProbe,
    OcrComputePreflight,
)


def _fake_native(
    monkeypatch: pytest.MonkeyPatch,
    *,
    ordinary: tuple[int, ...],
    high: tuple[int, ...] = (),
    uma: bool | None = None,
    software: bool = False,
    terminal_result: int = 0x887A0002,
) -> list[int]:
    released: list[int] = []

    def create_device(adapter, feature_level, iid, output):
        output._obj.value = 3
        return 0

    def check_architecture(device, feature, output, size):
        if uma is None:
            return -1
        output._obj.uma = int(uma)
        return 0

    def describe(adapter, output):
        description = output._obj
        description.description = f"Adapter {adapter.value}"
        description.vendor_id = 0x1234
        description.device_id = adapter.value
        description.subsystem_id = 0x5678
        description.revision = 2
        description.adapter_luid.low_part = adapter.value
        description.adapter_luid.high_part = -2
        description.flags = 2 if software else 0
        return 0

    def enumerate_table(table, index, output):
        if index == len(table):
            return terminal_result
        output._obj.value = table[index]
        return 0

    def com_method(pointer, index, result_type, *argument_types):
        if index == native._COM_VTABLE_RELEASE:
            return lambda handle: released.append(handle.value)
        if pointer.value == 3:
            assert index == native._D3D12_DEVICE_VTABLE_CHECK_FEATURE_SUPPORT
            return check_architecture
        if index == native._DXGI_FACTORY1_VTABLE_IS_CURRENT:
            return lambda factory: 1
        if index == native._DXGI_FACTORY1_VTABLE_ENUM_ADAPTERS1:
            return lambda factory, ordinal, output: enumerate_table(ordinary, ordinal, output)
        if index == native._DXGI_FACTORY6_VTABLE_ENUM_ADAPTER_BY_GPU_PREFERENCE:
            return lambda factory, ordinal, preference, iid, output: enumerate_table(
                high, ordinal, output
            )
        assert index == native._DXGI_ADAPTER_VTABLE_GET_DESC1
        return describe

    monkeypatch.setattr(native, "sys", SimpleNamespace(platform="win32"))
    monkeypatch.setattr(native, "_native_create_factory", lambda: ctypes.c_void_p(1))
    monkeypatch.setattr(native, "_native_query_factory6", lambda factory: ctypes.c_void_p(2))
    monkeypatch.setattr(native, "_com_method", com_method)
    monkeypatch.setattr(
        native.ctypes,
        "WinDLL",
        lambda name: SimpleNamespace(D3D12CreateDevice=create_device),
        raising=False,
    )
    return released


@pytest.mark.parametrize(
    ("uma", "expected"),
    [
        (True, native.GpuAdapterClass.INTEGRATED),
        (False, native.GpuAdapterClass.DEDICATED),
        (None, native.GpuAdapterClass.UNKNOWN),
    ],
)
def test_inventory_classifies_native_adapters_and_preserves_identity(
    monkeypatch: pytest.MonkeyPatch, uma: bool | None, expected: native.GpuAdapterClass
) -> None:
    released = _fake_native(monkeypatch, ordinary=(4,), uma=uma)

    assert native.read_gpu_inventory() == native.GpuInventory(
        complete=True,
        adapters=(
            native.GpuAdapter(
                description="Adapter 4",
                vendor_id=0x1234,
                device_id=4,
                luid="fffffffe00000004",
                adapter_class=expected,
                subsystem_id=0x5678,
                revision=2,
            ),
        ),
    )
    assert released == [3, 4, 1]


def test_software_only_inventory_skips_uma(monkeypatch: pytest.MonkeyPatch) -> None:
    released = _fake_native(monkeypatch, ordinary=(4,), software=True)

    inventory = native.read_gpu_inventory()

    assert inventory.complete
    assert [adapter.adapter_class for adapter in inventory.adapters] == [
        native.GpuAdapterClass.SOFTWARE
    ]
    assert released == [4, 1]


def test_failed_enumeration_discards_partial_inventory(monkeypatch: pytest.MonkeyPatch) -> None:
    released = _fake_native(monkeypatch, ordinary=(4,), terminal_result=-1)

    assert native.read_gpu_inventory() == native.GpuInventory(complete=False)
    assert released == [3, 4, 1]


def test_complete_empty_inventory_supports_ocr_cpu_fallback(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_native(monkeypatch, ordinary=())

    assert native.read_gpu_inventory() == native.GpuInventory(complete=True)
    decision = OcrComputePreflight(
        contract_set_sha256="a" * 64,
        capability_probe=NativeOcrGpuCapabilityProbe(
            provider_resolver=lambda: ("DmlExecutionProvider",),
            version_resolver=lambda: "1.24.4",
        ),
    ).decide()

    assert decision is not None
    assert decision.mode is OcrComputeMode.CPU_FALLBACK


def test_ocr_joins_preference_and_directml_ordinals_by_native_luid(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _fake_native(monkeypatch, ordinary=(4, 5), high=(5, 4), uma=False)

    snapshot = NativeOcrGpuCapabilityProbe(
        provider_resolver=lambda: ("DmlExecutionProvider",),
        version_resolver=lambda: None,
    ).probe()
    adapters = snapshot.joined_adapters()

    assert adapters is not None
    assert {
        adapter.luid: (adapter.dml_device_id, adapter.high_performance_rank)
        for adapter in adapters
    } == {"fffffffe00000004": (0, 1), "fffffffe00000005": (1, 0)}
