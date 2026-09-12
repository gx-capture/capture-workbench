from __future__ import annotations

from pathlib import Path

import pytest

from capture_runtime.config import RuntimeSettings
from capture_runtime.dependencies import build_runtime_dependencies


def _settings(app_data_dir: Path, **overrides: str) -> RuntimeSettings:
    environment = {
        "CAPTURE_API_TOKEN": "a" * 32,
        "CAPTURE_APP_DATA_DIR": str(app_data_dir),
        "CAPTURE_EXTRACTION_PROVIDER": "runtime",
        "CAPTURE_STRUCTURING_PROVIDER": "fake",
    }
    environment.update(overrides)
    return RuntimeSettings.from_env(environment)


def test_run_staging_defaults_under_app_data(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "app-data"

    settings = _settings(app_data_dir)

    assert settings.staging_root == app_data_dir / "jobs" / "staging"


def test_run_staging_override_isolated_from_model_and_repository_paths(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "app-data"
    staging_root = tmp_path / "producer-run" / "staging"

    settings = _settings(app_data_dir, CAPTURE_RUN_STAGING_DIR=str(staging_root))

    assert settings.staging_root == staging_root
    assert settings.ollama.app_data_dir == app_data_dir / "ollama"
    assert settings.ollama.models_dir == app_data_dir / "ollama" / "models"
    assert settings.extraction.windowsml_model_dir == (
        app_data_dir / "runtime-assets" / "windowsml-ocr" / "models"
    )
    assert settings.extraction.whisper_models_dir == app_data_dir / "runtime-assets" / "whisper"
    assert settings.extraction.temp_dir == app_data_dir / "temp"


def test_runtime_dependencies_use_override_without_creating_parallel_staging_root(
    tmp_path: Path,
) -> None:
    app_data_dir = tmp_path / "app-data"
    staging_root = tmp_path / "producer-run" / "staging"
    settings = _settings(app_data_dir, CAPTURE_RUN_STAGING_DIR=str(staging_root))

    dependencies = build_runtime_dependencies(settings)

    assert dependencies.staging_root == staging_root
    processor = dependencies.streaming_capture_service._processor
    assert processor is not None
    assert processor.staging_root == staging_root
    assert not staging_root.exists()
    assert not (app_data_dir / "jobs" / "staging").exists()


@pytest.mark.parametrize("value", ["", "   ", "relative/staging"])
def test_run_staging_override_rejects_empty_or_relative_paths(
    tmp_path: Path,
    value: str,
) -> None:
    with pytest.raises(ValueError, match="CAPTURE_RUN_STAGING_DIR must be an absolute path"):
        _settings(tmp_path / "app-data", CAPTURE_RUN_STAGING_DIR=value)
