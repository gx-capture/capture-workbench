from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from capture_runtime.engine_adapters import WINDOWSML_REQUIRED_MODEL_FILES
from capture_runtime.release import build_windowsml_bundle


def model_source(root: Path) -> Path:
    source = root / "models"
    for index, relative in enumerate(WINDOWSML_REQUIRED_MODEL_FILES):
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"fixture-{index}-{relative}".encode())
    return source


def test_windowsml_bundle_is_reproducible_and_allowlisted(tmp_path: Path) -> None:
    source = model_source(tmp_path)
    first = tmp_path / "first" / "capture-windowsml-ocr-windows-x64.zip"
    second = tmp_path / "second" / "capture-windowsml-ocr-windows-x64.zip"
    url = "https://downloads.example.org/releases/capture-windowsml-ocr-windows-x64.zip"

    first_report = build_windowsml_bundle(
        source_dir=source,
        output=first,
        artifact_url=url,
    )
    second_report = build_windowsml_bundle(
        source_dir=source,
        output=second,
        artifact_url=url,
    )

    assert first.read_bytes() == second.read_bytes()
    assert first_report == second_report
    assert first_report["files"] == list(WINDOWSML_REQUIRED_MODEL_FILES)
    assert first_report["artifact"]["sha256"]
    with zipfile.ZipFile(first) as archive:
        assert archive.namelist() == list(WINDOWSML_REQUIRED_MODEL_FILES)
        assert archive.testzip() is None


def test_windowsml_bundle_rejects_missing_files_and_filename_drift(tmp_path: Path) -> None:
    source = model_source(tmp_path)
    (source / WINDOWSML_REQUIRED_MODEL_FILES[0]).unlink()
    with pytest.raises(ValueError, match="missing a safe regular file"):
        build_windowsml_bundle(
            source_dir=source,
            output=tmp_path / "capture-windowsml-ocr-windows-x64.zip",
            artifact_url=("https://downloads.example.org/capture-windowsml-ocr-windows-x64.zip"),
        )

    source = model_source(tmp_path / "restored")
    output = tmp_path / "capture-windowsml-ocr-windows-x64.zip"
    with pytest.raises(ValueError, match="file name must match"):
        build_windowsml_bundle(
            source_dir=source,
            output=output,
            artifact_url="https://downloads.example.org/different.zip",
        )
    assert not output.exists()
