from __future__ import annotations

import asyncio
import ctypes

import pytest
from pydantic import ValidationError

from capture_runtime.contracts import (
    OcrAdapterClass,
    OcrComputeMode,
    OcrComputeNoticeCode,
    OcrComputePreflightV2,
    OcrComputeReasonCode,
)
from capture_runtime.ocr_preflight import (
    _DXGI_FACTORY1_VTABLE_IS_CURRENT,
    OcrComputePreflight,
    OcrGpuAdapter,
    OcrGpuCapabilitySnapshot,
    _classify_native_adapter,
    _NativeOcrAdapterMapLease,
)

CONTRACT_SHA256 = "a" * 64


class StaticCapabilityProbe:
    def __init__(self, snapshot: OcrGpuCapabilitySnapshot) -> None:
        self.snapshot = snapshot

    def probe(self) -> OcrGpuCapabilitySnapshot:
        return self.snapshot


def _decision(
    adapters: tuple[OcrGpuAdapter, ...],
    *,
    dml_provider_available: bool,
) -> OcrComputePreflightV2:
    return OcrComputePreflight(
        contract_sha256=CONTRACT_SHA256,
        capability_probe=StaticCapabilityProbe(
            OcrGpuCapabilitySnapshot(
                adapters=adapters,
                dml_provider_available=dml_provider_available,
            )
        ),
    ).decide()


@pytest.mark.parametrize("adapter_class", [OcrAdapterClass.DEDICATED, OcrAdapterClass.INTEGRATED])
def test_hardware_gpu_and_dml_select_gpu_mode(adapter_class: OcrAdapterClass) -> None:
    decision = _decision(
        (OcrGpuAdapter(index=0, adapter_class=adapter_class, is_software=False),),
        dml_provider_available=True,
    )

    assert decision.mode is OcrComputeMode.GPU_DML
    assert decision.adapter_class is adapter_class
    assert decision.reason_code is None
    assert decision.user_notice_required is False
    assert decision.notice_code is None
    assert decision.contract_sha256 == CONTRACT_SHA256


def test_software_only_adapters_are_not_compatible_gpu() -> None:
    decision = _decision(
        (OcrGpuAdapter(index=0, adapter_class=OcrAdapterClass.UNKNOWN, is_software=True),),
        dml_provider_available=True,
    )

    assert decision.mode is OcrComputeMode.CPU_FALLBACK
    assert decision.adapter_class is OcrAdapterClass.UNKNOWN
    assert decision.reason_code is OcrComputeReasonCode.NO_COMPATIBLE_GPU
    assert decision.user_notice_required is True
    assert decision.notice_code is OcrComputeNoticeCode.CPU_FALLBACK


def test_hardware_gpu_without_dml_reports_provider_reason() -> None:
    decision = _decision(
        (OcrGpuAdapter(index=0, adapter_class=OcrAdapterClass.INTEGRATED, is_software=False),),
        dml_provider_available=False,
    )

    assert decision.mode is OcrComputeMode.CPU_FALLBACK
    assert decision.adapter_class is OcrAdapterClass.INTEGRATED
    assert decision.reason_code is OcrComputeReasonCode.DML_PROVIDER_UNAVAILABLE
    assert decision.user_notice_required is True
    assert decision.notice_code is OcrComputeNoticeCode.CPU_FALLBACK


def test_no_adapter_reports_no_compatible_gpu_even_if_dml_is_registered() -> None:
    decision = _decision((), dml_provider_available=True)

    assert decision.mode is OcrComputeMode.CPU_FALLBACK
    assert decision.adapter_class is OcrAdapterClass.UNKNOWN
    assert decision.reason_code is OcrComputeReasonCode.NO_COMPATIBLE_GPU


@pytest.mark.parametrize(
    ("uma", "expected"),
    [
        (True, OcrAdapterClass.INTEGRATED),
        (False, OcrAdapterClass.DEDICATED),
        (None, OcrAdapterClass.UNKNOWN),
    ],
)
def test_native_hardware_classification_uses_architecture_uma_evidence(
    uma: bool | None,
    expected: OcrAdapterClass,
) -> None:
    assert _classify_native_adapter(is_software=False, uma=uma) is expected


def test_native_hardware_classification_never_uses_software_memory_as_gpu_class() -> None:
    assert _classify_native_adapter(is_software=True, uma=False) is OcrAdapterClass.UNKNOWN


@pytest.mark.parametrize("native_value", [0, 1])
def test_native_map_lease_reads_dxgi_factory_is_current_vtable_method(native_value: int) -> None:
    """The production lease must read COM IsCurrent, not an injected status tuple."""

    calls: list[ctypes.c_void_p] = []

    @ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)
    def is_current(pointer: ctypes.c_void_p) -> int:
        calls.append(pointer)
        return native_value

    vtable = (ctypes.c_void_p * (_DXGI_FACTORY1_VTABLE_IS_CURRENT + 1))()
    vtable[_DXGI_FACTORY1_VTABLE_IS_CURRENT] = ctypes.cast(is_current, ctypes.c_void_p)
    vtable_pointer = ctypes.cast(vtable, ctypes.POINTER(ctypes.c_void_p))
    factory = ctypes.cast(ctypes.pointer(vtable_pointer), ctypes.c_void_p)
    lease = _NativeOcrAdapterMapLease.__new__(_NativeOcrAdapterMapLease)
    lease._factory = factory
    lease._factory6 = ctypes.c_void_p(1)

    assert lease.is_current() is bool(native_value)
    assert len(calls) == 1
    assert calls[0] == factory.value


def test_preflight_contract_rejects_inconsistent_gpu_notice() -> None:
    with pytest.raises(ValidationError):
        OcrComputePreflightV2(
            contract_sha256=CONTRACT_SHA256,
            mode=OcrComputeMode.GPU_DML,
            adapter_class=OcrAdapterClass.DEDICATED,
            reason_code=OcrComputeReasonCode.DML_PROVIDER_UNAVAILABLE,
            user_notice_required=True,
            notice_code=OcrComputeNoticeCode.CPU_FALLBACK,
        )


def test_async_preflight_normalizes_worker_decision_and_rejects_contract_drift() -> None:
    decision = OcrComputePreflightV2(
        contract_sha256=CONTRACT_SHA256,
        mode=OcrComputeMode.GPU_DML,
        adapter_class=OcrAdapterClass.DEDICATED,
        user_notice_required=False,
    )
    calls = 0

    async def worker_probe() -> object:
        nonlocal calls
        calls += 1
        return decision.model_dump(mode="json", by_alias=True)

    preflight = OcrComputePreflight(
        contract_sha256=CONTRACT_SHA256,
        worker_probe=worker_probe,
    )
    assert asyncio.run(preflight.decide_async()) == decision
    assert calls == 1

    async def wrong_worker_probe() -> object:
        return decision.model_copy(update={"contract_sha256": "b" * 64})

    unavailable = OcrComputePreflight(
        contract_sha256=CONTRACT_SHA256,
        worker_probe=wrong_worker_probe,
    )
    assert asyncio.run(unavailable.decide_async()) is None
