"""The release preflight must work before the runtime package is installed."""

import subprocess
import sys
from pathlib import Path


def test_source_lock_cli_runs_without_site_packages_or_pythonpath(tmp_path: Path) -> None:
    script = Path(__file__).resolve().parents[2] / "scripts" / "model_source_lock.py"
    completed = subprocess.run(
        [sys.executable, "-I", "-S", "-B", str(script), "--help"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )
    assert completed.returncode == 0, completed.stderr
    assert "validate" in completed.stdout
    assert not list(tmp_path.iterdir())
