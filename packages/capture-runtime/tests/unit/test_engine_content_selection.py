"""NVIDIA driver file check and the speech content id it selects."""

from __future__ import annotations

from pathlib import Path

import pytest

from capture_runtime.provisioning.infrastructure.engine_content_selection import (
    content_id_for_variant,
    detect_nvidia_driver,
)


def _windows(tmp_path: Path, *, as_file: bool) -> dict[str, str]:
    system = tmp_path / "Windows"
    dll = system / "System32" / "nvcuda.dll"
    dll.parent.mkdir(parents=True)
    if as_file:
        dll.write_bytes(b"driver")
    else:
        dll.mkdir()
    return {"SystemRoot": str(system)}


def test_a_system32_nvcuda_file_selects_cuda(tmp_path: Path) -> None:
    present = detect_nvidia_driver(_windows(tmp_path, as_file=True), platform_name="win32")

    assert present is True
    assert content_id_for_variant("auto", driver_present=True) == "cuda"


def test_systemroot_matches_regardless_of_case(tmp_path: Path) -> None:
    environ = {key.upper(): value for key, value in _windows(tmp_path, as_file=True).items()}

    assert detect_nvidia_driver(environ, platform_name="win32") is True


def test_a_missing_dll_selects_cpu(tmp_path: Path) -> None:
    system = tmp_path / "Windows"
    (system / "System32").mkdir(parents=True)

    assert detect_nvidia_driver({"SystemRoot": str(system)}, platform_name="win32") is False
    assert content_id_for_variant("auto", driver_present=False) == "cpu"


def test_a_directory_named_nvcuda_is_not_a_driver(tmp_path: Path) -> None:
    assert detect_nvidia_driver(_windows(tmp_path, as_file=False), platform_name="win32") is False


@pytest.mark.parametrize("environ", [{}, {"SystemRoot": "   "}])
def test_a_missing_or_empty_systemroot_selects_no_driver(environ: dict[str, str]) -> None:
    assert detect_nvidia_driver(environ, platform_name="win32") is False


def test_a_non_windows_platform_has_no_driver_even_when_the_file_exists(tmp_path: Path) -> None:
    assert detect_nvidia_driver(_windows(tmp_path, as_file=True), platform_name="linux") is False


def test_a_forced_variant_is_the_content_id_even_when_the_driver_disagrees() -> None:
    assert content_id_for_variant("cuda", driver_present=False) == "cuda"
    assert content_id_for_variant("cpu", driver_present=True) == "cpu"
