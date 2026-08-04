"""Install the built host SDK wheel beside local contracts and probe its public seam."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STRUCTURING_WHEEL_DIRECTORY = ROOT / "packages" / "capture-structuring-python" / "dist"
CONTRACTS_WHEEL_DIRECTORY = ROOT / "packages" / "capture-contracts" / "python" / "dist"


def latest_wheel(directory: Path, prefix: str) -> Path:
    wheels = sorted(directory.glob(f"{prefix}-*.whl"))
    if not wheels:
        raise SystemExit(f"No {prefix} wheel found in {directory}")
    return wheels[-1]


def main() -> None:
    structuring_wheel = latest_wheel(STRUCTURING_WHEEL_DIRECTORY, "capture_structuring")
    contracts_wheel = latest_wheel(CONTRACTS_WHEEL_DIRECTORY, "capture_contracts")
    with tempfile.TemporaryDirectory(prefix="capture-structuring-wheel-smoke-") as directory:
        venv = Path(directory) / "venv"
        subprocess.run(["uv", "venv", str(venv)], cwd=ROOT, check=True)
        python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run(
            [
                "uv",
                "pip",
                "install",
                "--python",
                str(python),
                str(contracts_wheel),
                str(structuring_wheel),
            ],
            cwd=ROOT,
            check=True,
        )
        probe = (
            "from capture_structuring import CAPTURE_BLOCK_BATCH_SCHEMA, structure_capture; "
            "assert CAPTURE_BLOCK_BATCH_SCHEMA['title'] == 'CaptureBlockBatchV1'; "
            "assert callable(structure_capture)"
        )
        subprocess.run([str(python), "-c", probe], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
