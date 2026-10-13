"""Ask a packaged worker executable whether its code is ready.

This is the probe the installer sends before any model exists; it fails the
build when the packaged worker cannot start or misses a dependency.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.worker_contracts import WorkerRequest, WorkerResponse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("executable", type=Path)
    parser.add_argument("requirement_id")
    arguments = parser.parse_args()
    request = WorkerRequest(
        request_id="packaged-code-probe",
        operation="probe",
        payload={
            "requirementId": arguments.requirement_id,
            "artifactVersion": RUNTIME_VERSION,
            "modelPath": None,
        },
    )
    completed = subprocess.run(
        [str(arguments.executable.resolve())],
        input=(json.dumps(request.to_dict()) + "\n").encode(),
        stdin=None,
        capture_output=True,
        shell=False,
        check=False,
        timeout=300,
    )
    lines = completed.stdout.decode("utf-8", "replace").strip().splitlines()
    if completed.returncode != 0 or not lines:
        raise SystemExit(f"{arguments.executable.name} did not answer the code probe")
    response = WorkerResponse.from_dict(json.loads(lines[-1]))
    if not response.ok or response.result is None or response.result.get("codeReady") is not True:
        raise SystemExit(f"{arguments.executable.name} code probe is not ready: {lines[-1]}")
    print(f"{arguments.executable.name}: code probe ready")


if __name__ == "__main__":
    main()
