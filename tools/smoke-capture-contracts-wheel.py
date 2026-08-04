"""Install the built capture-contracts wheel into a fresh environment and probe it."""

from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WHEEL_DIRECTORY = ROOT / "packages" / "capture-contracts" / "python" / "dist"


def main() -> None:
    wheels = sorted(WHEEL_DIRECTORY.glob("capture_contracts-*.whl"))
    if not wheels:
        raise SystemExit(f"No capture-contracts wheel found in {WHEEL_DIRECTORY}")
    wheel = wheels[-1]
    with tempfile.TemporaryDirectory(prefix="capture-contracts-wheel-smoke-") as directory:
        venv = Path(directory) / "venv"
        subprocess.run(["uv", "venv", str(venv)], cwd=ROOT, check=True)
        python = venv / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        subprocess.run(
            ["uv", "pip", "install", "--python", str(python), str(wheel)],
            cwd=ROOT,
            check=True,
        )
        probe = (
            "import capture_contracts; "
            "manifest = capture_contracts.load_contract_manifest(); "
            "assert capture_contracts.CAPTURE_RUNTIME_VERSION == manifest['runtimeVersion']; "
            "schema = capture_contracts.load_contract_schema('RawCaptureV1'); "
            "assert schema['title'] == 'RawCaptureV1'; "
            "assert manifest['generator']['schemaGenerator'] == 'pydantic.model_json_schema'"
        )
        subprocess.run([str(python), "-c", probe], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
