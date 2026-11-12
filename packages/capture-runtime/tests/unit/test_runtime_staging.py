from __future__ import annotations

from pathlib import Path

from capture_runtime.config import RuntimeSettings
from capture_runtime.dependencies import build_runtime_dependencies


def _settings(app_data_dir: Path) -> RuntimeSettings:
    return RuntimeSettings.from_env(
        {
            "CAPTURE_API_TOKEN": "a" * 32,
            "CAPTURE_APP_DATA_DIR": str(app_data_dir),
            "CAPTURE_EXTRACTION_PROVIDER": "runtime",
            "CAPTURE_STRUCTURING_PROVIDER": "fake",
        }
    )


def test_run_staging_defaults_under_app_data(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "app-data"

    settings = _settings(app_data_dir)

    assert settings.staging_root == app_data_dir / "jobs" / "staging"


def test_runtime_dependencies_keep_the_app_data_staging_root(tmp_path: Path) -> None:
    app_data_dir = tmp_path / "app-data"
    staging_root = app_data_dir / "jobs" / "staging"

    dependencies = build_runtime_dependencies(_settings(app_data_dir))

    assert dependencies.staging_root == staging_root
