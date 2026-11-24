"""Read the machine's native Windows GPU inventory."""

from __future__ import annotations

import ctypes
import sys
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

_DXGI_ADAPTER_FLAG_SOFTWARE = 0x2
_DXGI_ERROR_NOT_FOUND = 0x887A0002
_DXGI_FACTORY1_VTABLE_ENUM_ADAPTERS1 = 12
_DXGI_FACTORY1_VTABLE_IS_CURRENT = 13
_DXGI_FACTORY_VTABLE_QUERY_INTERFACE = 0
_DXGI_FACTORY6_VTABLE_ENUM_ADAPTER_BY_GPU_PREFERENCE = 29
_DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE = 2
_DXGI_ADAPTER_VTABLE_GET_DESC1 = 10
_D3D12_FEATURE_ARCHITECTURE = 1
_D3D12_FEATURE_LEVEL_11_0 = 0xB000
_D3D12_DEVICE_VTABLE_CHECK_FEATURE_SUPPORT = 13
_COM_VTABLE_RELEASE = 2
_ADAPTER_ENUMERATION_LIMIT = 256


class GpuAdapterClass(StrEnum):
    INTEGRATED = "integrated"
    DEDICATED = "dedicated"
    SOFTWARE = "software"
    UNKNOWN = "unknown"


@dataclass(frozen=True, slots=True)
class GpuAdapter:
    description: str
    vendor_id: int
    device_id: int
    luid: str
    adapter_class: GpuAdapterClass
    subsystem_id: int
    revision: int
    dedicated_memory_bytes: int = 0


@dataclass(frozen=True, slots=True)
class GpuInventory:
    """An ordinary DXGI observation, including any software adapter records."""

    complete: bool
    adapters: tuple[GpuAdapter, ...] = ()


class _Guid(ctypes.Structure):
    _fields_ = [
        ("data1", ctypes.c_uint32),
        ("data2", ctypes.c_uint16),
        ("data3", ctypes.c_uint16),
        ("data4", ctypes.c_ubyte * 8),
    ]


class _Luid(ctypes.Structure):
    _fields_ = [("low_part", ctypes.c_uint32), ("high_part", ctypes.c_int32)]


class _DxgiAdapterDesc1(ctypes.Structure):
    _fields_ = [
        ("description", ctypes.c_wchar * 128),
        ("vendor_id", ctypes.c_uint32),
        ("device_id", ctypes.c_uint32),
        ("subsystem_id", ctypes.c_uint32),
        ("revision", ctypes.c_uint32),
        ("dedicated_video_memory", ctypes.c_size_t),
        ("dedicated_system_memory", ctypes.c_size_t),
        ("shared_system_memory", ctypes.c_size_t),
        ("adapter_luid", _Luid),
        ("flags", ctypes.c_uint32),
        ("graphics_preemption_granularity", ctypes.c_uint32),
    ]


class _D3d12FeatureDataArchitecture(ctypes.Structure):
    _fields_ = [
        ("node_index", ctypes.c_uint32),
        ("tile_based_renderer", ctypes.c_int32),
        ("uma", ctypes.c_int32),
        ("cache_coherent_uma", ctypes.c_int32),
    ]


_IID_IDXGIFACTORY1 = _Guid(
    0x770AAE78,
    0xF26F,
    0x4DBA,
    (0xA8, 0x29, 0x25, 0x3C, 0x83, 0xD1, 0xB3, 0x87),
)


_IID_IDXGIFACTORY6 = _Guid(
    0xC1B6694F,
    0xFF09,
    0x44A9,
    (0xB0, 0x3C, 0x77, 0x90, 0x0A, 0x0A, 0x1D, 0x17),
)


_IID_IDXGIADAPTER1 = _Guid(
    0x29038F61,
    0x3839,
    0x4626,
    (0x91, 0xFD, 0x08, 0x68, 0x79, 0x01, 0x1A, 0x05),
)


_IID_ID3D12DEVICE = _Guid(
    0x189819F1,
    0x1DB6,
    0x4B57,
    (0xBE, 0x54, 0x18, 0x21, 0x33, 0x9B, 0x85, 0xF7),
)


def _com_method(
    pointer: ctypes.c_void_p,
    index: int,
    result_type: Any,
    *argument_types: Any,
) -> Any:
    vtable = ctypes.cast(
        pointer,
        ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p)),
    ).contents
    return ctypes.CFUNCTYPE(result_type, ctypes.c_void_p, *argument_types)(vtable[index])


def _release_com(pointer: ctypes.c_void_p) -> None:
    if pointer.value:
        release = _com_method(pointer, _COM_VTABLE_RELEASE, ctypes.c_ulong)
        release(pointer)


def _classify_native_adapter(*, is_software: bool, uma: bool | None) -> GpuAdapterClass:
    """Classify hardware only from the native D3D12 architecture property."""

    if is_software:
        return GpuAdapterClass.SOFTWARE
    if uma is None:
        return GpuAdapterClass.UNKNOWN
    return GpuAdapterClass.INTEGRATED if uma else GpuAdapterClass.DEDICATED


def _native_adapter_uma(adapter: ctypes.c_void_p) -> bool | None:
    """Read the adapter's native D3D12 UMA architecture flag."""

    if sys.platform != "win32":
        return None
    device = ctypes.c_void_p()
    try:
        d3d12 = ctypes.WinDLL("d3d12.dll")
        create_device = d3d12.D3D12CreateDevice
        create_device.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
            ctypes.POINTER(_Guid),
            ctypes.POINTER(ctypes.c_void_p),
        ]
        create_device.restype = ctypes.c_long
        if (
            create_device(
                adapter,
                _D3D12_FEATURE_LEVEL_11_0,
                ctypes.byref(_IID_ID3D12DEVICE),
                ctypes.byref(device),
            )
            != 0
            or not device.value
        ):
            return None

        architecture = _D3d12FeatureDataArchitecture(node_index=0)
        check_feature_support = _com_method(
            device,
            _D3D12_DEVICE_VTABLE_CHECK_FEATURE_SUPPORT,
            ctypes.c_long,
            ctypes.c_uint32,
            ctypes.c_void_p,
            ctypes.c_uint32,
        )
        if (
            check_feature_support(
                device,
                _D3D12_FEATURE_ARCHITECTURE,
                ctypes.byref(architecture),
                ctypes.sizeof(architecture),
            )
            != 0
        ):
            return None
        return bool(architecture.uma)
    except (AttributeError, OSError, TypeError, ValueError):
        return None
    finally:
        _release_com(device)


def _native_adapter_luid(description: _DxgiAdapterDesc1) -> str:
    """Canonicalize a DXGI LUID as the high DWORD followed by the low DWORD."""

    high = description.adapter_luid.high_part & 0xFFFFFFFF
    low = description.adapter_luid.low_part
    return f"{high:08x}{low:08x}"


def _native_adapter_record(adapter: ctypes.c_void_p) -> GpuAdapter | None:
    description = _DxgiAdapterDesc1()
    get_desc = _com_method(
        adapter,
        _DXGI_ADAPTER_VTABLE_GET_DESC1,
        ctypes.c_long,
        ctypes.POINTER(_DxgiAdapterDesc1),
    )
    if get_desc(adapter, ctypes.byref(description)) != 0:
        return None
    software = bool(description.flags & _DXGI_ADAPTER_FLAG_SOFTWARE)
    adapter_class = _classify_native_adapter(
        is_software=software,
        uma=None if software else _native_adapter_uma(adapter),
    )
    return GpuAdapter(
        adapter_class=adapter_class,
        luid=_native_adapter_luid(description),
        vendor_id=description.vendor_id,
        device_id=description.device_id,
        subsystem_id=description.subsystem_id,
        revision=description.revision,
        description=description.description,
        dedicated_memory_bytes=description.dedicated_video_memory,
    )


def _native_create_factory() -> ctypes.c_void_p:
    """Create one DXGI factory for a complete, bracketed adapter observation."""

    if sys.platform != "win32":
        raise RuntimeError("DXGI factory is unavailable")
    try:
        dxgi = ctypes.WinDLL("dxgi.dll")
        create_factory = dxgi.CreateDXGIFactory1
        create_factory.argtypes = [ctypes.POINTER(_Guid), ctypes.POINTER(ctypes.c_void_p)]
        create_factory.restype = ctypes.c_long
        factory = ctypes.c_void_p()
        result = create_factory(ctypes.byref(_IID_IDXGIFACTORY1), ctypes.byref(factory))
        if result != 0 or not factory.value:
            raise RuntimeError("CreateDXGIFactory1 failed")
        return factory
    except (AttributeError, OSError):
        raise RuntimeError("DXGI factory is unavailable") from None


def _native_query_factory6(factory: ctypes.c_void_p) -> ctypes.c_void_p:
    factory6 = ctypes.c_void_p()
    query_interface = _com_method(
        factory,
        _DXGI_FACTORY_VTABLE_QUERY_INTERFACE,
        ctypes.c_long,
        ctypes.POINTER(_Guid),
        ctypes.POINTER(ctypes.c_void_p),
    )
    if (
        query_interface(
            factory,
            ctypes.byref(_IID_IDXGIFACTORY6),
            ctypes.byref(factory6),
        )
        != 0
        or not factory6.value
    ):
        raise RuntimeError("IDXGIFactory6 is unavailable")
    return factory6


def _native_enumerate_adapters(
    factory: ctypes.c_void_p,
    factory6: ctypes.c_void_p | None,
) -> tuple[GpuAdapter, ...]:
    """Enumerate one DXGI table in its native order."""

    adapters: list[GpuAdapter] = []
    try:
        if factory6 is not None:
            enumerate_adapter = _com_method(
                factory6,
                _DXGI_FACTORY6_VTABLE_ENUM_ADAPTER_BY_GPU_PREFERENCE,
                ctypes.c_long,
                ctypes.c_uint32,
                ctypes.c_uint32,
                ctypes.POINTER(_Guid),
                ctypes.POINTER(ctypes.c_void_p),
            )
        else:
            enumerate_adapter = _com_method(
                factory,
                _DXGI_FACTORY1_VTABLE_ENUM_ADAPTERS1,
                ctypes.c_long,
                ctypes.c_uint32,
                ctypes.POINTER(ctypes.c_void_p),
            )
        for index in range(_ADAPTER_ENUMERATION_LIMIT):
            adapter = ctypes.c_void_p()
            if factory6 is not None:
                result = enumerate_adapter(
                    factory6,
                    index,
                    _DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
                    ctypes.byref(_IID_IDXGIADAPTER1),
                    ctypes.byref(adapter),
                )
            else:
                result = enumerate_adapter(factory, index, ctypes.byref(adapter))
            if ctypes.c_ulong(result).value == _DXGI_ERROR_NOT_FOUND:
                break
            if result != 0 or not adapter.value:
                raise RuntimeError("DXGI adapter enumeration was incomplete")
            try:
                record = _native_adapter_record(adapter)
                if record is not None:
                    adapters.append(record)
                else:
                    raise RuntimeError("DXGI adapter description was unavailable")
            finally:
                _release_com(adapter)
    except (AttributeError, OSError, TypeError, ValueError):
        raise RuntimeError("DXGI adapter enumeration failed") from None
    return tuple(adapters)


class DxgiAdapterLease:
    """Own one DXGI factory across related adapter observations."""

    def __init__(self, *, include_high_performance: bool = False) -> None:
        self._factory = _native_create_factory()
        self._factory6: ctypes.c_void_p | None = None
        try:
            if include_high_performance:
                self._factory6 = _native_query_factory6(self._factory)
        except Exception:
            _release_com(self._factory)
            raise

    def is_current(self) -> bool:
        """Read ``IDXGIFactory1::IsCurrent``; failures are never treated as current."""

        if not self._factory.value:
            raise RuntimeError("DXGI factory lease is closed")
        try:
            is_current = _com_method(
                self._factory,
                _DXGI_FACTORY1_VTABLE_IS_CURRENT,
                ctypes.c_int,
            )
            return bool(is_current(self._factory))
        except Exception as error:
            raise RuntimeError("DXGI factory current-state query failed") from error

    def enumerate_adapters(self, *, high_performance: bool = False) -> tuple[GpuAdapter, ...]:
        if not self._factory.value:
            raise RuntimeError("DXGI factory lease is closed")
        if high_performance and (self._factory6 is None or not self._factory6.value):
            raise RuntimeError("DXGI high-performance enumeration is unavailable")
        return _native_enumerate_adapters(
            self._factory, self._factory6 if high_performance else None
        )

    def close(self) -> None:
        factory6, self._factory6 = self._factory6, None
        factory, self._factory = self._factory, ctypes.c_void_p()
        if factory6 is not None:
            _release_com(factory6)
        _release_com(factory)


def read_gpu_inventory() -> GpuInventory:
    """Return a complete inventory or a failed observation with no records."""

    try:
        lease = DxgiAdapterLease()
        try:
            if lease.is_current():
                adapters = lease.enumerate_adapters()
                if lease.is_current() and len(adapters) < _ADAPTER_ENUMERATION_LIMIT:
                    return GpuInventory(complete=True, adapters=adapters)
        finally:
            lease.close()
    except RuntimeError:
        pass
    return GpuInventory(complete=False)
