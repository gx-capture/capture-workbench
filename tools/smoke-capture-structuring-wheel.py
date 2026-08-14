"""Install the built host SDK wheels and probe their public seams."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STRUCTURING_WHEEL_DIRECTORY = ROOT / "packages" / "capture-structuring-python" / "dist"
RUNTIME_CLIENT_WHEEL_DIRECTORY = ROOT / "packages" / "capture-runtime-client-python" / "dist"


def latest_wheel(directory: Path, prefix: str) -> Path:
    wheels = sorted(directory.glob(f"{prefix}-*.whl"))
    if not wheels:
        raise SystemExit(f"No {prefix} wheel found in {directory}")
    return wheels[-1]


def main() -> None:
    structuring_wheel = latest_wheel(STRUCTURING_WHEEL_DIRECTORY, "capture_structuring")
    runtime_client_wheel = latest_wheel(RUNTIME_CLIENT_WHEEL_DIRECTORY, "capture_runtime_client")
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
                str(runtime_client_wheel),
                str(structuring_wheel),
            ],
            cwd=ROOT,
            check=True,
        )
        probe = (
            "from capture_runtime_client.contracts import _load_contract_schema; "
            "from capture_structuring import CAPTURE_BLOCK_BATCH_SCHEMA, structure_capture; "
            "assert _load_contract_schema('CaptureDocument')['title'] == 'CaptureDocument'; "
            "assert CAPTURE_BLOCK_BATCH_SCHEMA['title'] == 'CaptureBlockBatch'; "
            "assert callable(structure_capture)"
        )
        subprocess.run([str(python), "-c", probe], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
