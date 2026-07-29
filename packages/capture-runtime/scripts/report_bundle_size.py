from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import platform
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from collections.abc import Iterable
from pathlib import Path
from typing import Any

REPORT_VERSION = "1"
STARTUP_TIMEOUT_SECONDS = 120.0


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def directory_bytes(path: Path | None) -> int | None:
    if path is None or not path.is_dir():
        return None
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def artifact(path: Path | None) -> dict[str, Any] | None:
    if path is None or not path.is_file():
        return None
    return {
        "path": path.as_posix(),
        "bytes": path.stat().st_size,
        "sha256": sha256_file(path),
    }


def installed_bytes_evidence(
    path: Path | None,
    *,
    installer: dict[str, Any] | None,
) -> tuple[int | None, str | None]:
    if path is None or not path.is_file():
        return None, "Installed directory or installed-size evidence was not supplied."
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        return None, f"Installed-size evidence is unreadable: {error}"
    if not isinstance(payload, dict) or set(payload) != {
        "arch",
        "bundle",
        "cleanup",
        "disclaimer",
        "evidenceKind",
        "installedBytes",
        "installer",
        "platform",
        "releaseGateSatisfied",
    }:
        return None, "Installed-size evidence fields are invalid."
    evidence_installer = payload["installer"]
    cleanup = payload["cleanup"]
    if (
        payload["evidenceKind"] != "release-installed-size"
        or payload["releaseGateSatisfied"] is not False
        or payload["platform"] != "windows"
        or payload["arch"] != "x86_64"
        or payload["bundle"] != "nsis"
        or not isinstance(payload["installedBytes"], int)
        or payload["installedBytes"] < 1
        or not isinstance(evidence_installer, dict)
        or installer is None
        or evidence_installer.get("bytes") != installer["bytes"]
        or evidence_installer.get("sha256") != installer["sha256"]
        or not isinstance(cleanup, dict)
        or cleanup.get("uninstallerCompleted") is not True
        or cleanup.get("installDirectoryRemoved") is not True
        or cleanup.get("nativeUninstallKeyRemoved") is not True
        or not isinstance(
            cleanup.get("productRegistryKeyRetainedAfterNativeUninstall"),
            bool,
        )
        or cleanup.get("registryResidueRemoved") is not True
        or cleanup.get("isolatedRunDataRemoved") is not True
    ):
        return None, "Installed-size evidence did not prove the exact installer and cleanup."
    return payload["installedBytes"], None


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _wait_ready(port: int, token: str, process: subprocess.Popen[bytes]) -> None:
    deadline = time.monotonic() + STARTUP_TIMEOUT_SECONDS
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/health/ready",
        headers={"Authorization": f"Bearer {token}"},
    )
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"runtime exited during startup with code {process.returncode}")
        try:
            with urllib.request.urlopen(request, timeout=0.25) as response:
                if response.status == 200:
                    return
        except (OSError, urllib.error.URLError):
            time.sleep(0.025)
    raise TimeoutError(f"runtime did not become ready within {STARTUP_TIMEOUT_SECONDS:g}s")


def terminate_owned_process_tree(process: subprocess.Popen[bytes]) -> None:
    """Stop only the process tree rooted at the Popen PID."""

    if process.poll() is not None:
        return
    if sys.platform == "win32":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            shell=False,
            check=False,
            timeout=10,
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def measure_startup(executable: Path, *, samples: int) -> dict[str, Any]:
    values: list[float] = []
    blocker: str | None = None
    with tempfile.TemporaryDirectory(prefix="capture-runtime-size-") as temporary:
        for index in range(samples):
            port = _free_loopback_port()
            token = secrets.token_urlsafe(48)
            app_data = Path(temporary) / f"run-{index}"
            environment = dict(os.environ)
            environment.update(
                {
                    "CAPTURE_API_TOKEN": token,
                    "CAPTURE_PORT": str(port),
                    "CAPTURE_ALLOWED_HOSTS": f"127.0.0.1:{port}",
                    "CAPTURE_APP_DATA_DIR": str(app_data),
                    "CAPTURE_EXTRACTION_PROVIDER": "runtime",
                    "CAPTURE_STRUCTURING_PROVIDER": "host",
                }
            )
            started = time.perf_counter()
            process = subprocess.Popen(
                [str(executable), "serve"],
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=(
                    subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
                ),
            )
            try:
                _wait_ready(port, token, process)
                values.append(round((time.perf_counter() - started) * 1000, 3))
            except (OSError, RuntimeError, TimeoutError) as error:
                blocker = f"{type(error).__name__}: {error}"
                break
            finally:
                terminate_owned_process_tree(process)
    return {
        "coldMilliseconds": values[0] if values else None,
        "warmMilliseconds": values[1] if len(values) > 1 else None,
        "samplesMilliseconds": values,
        "blocker": blocker,
    }


def _walk_strings(value: object) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _walk_strings(item)
    elif isinstance(value, list | tuple):
        for item in value:
            yield from _walk_strings(item)


def pyinstaller_inventory(work_dir: Path | None) -> dict[str, Any]:
    if work_dir is None or not work_dir.is_dir():
        return {
            "files": [],
            "topFiles": [],
            "categories": {},
            "blocker": "PyInstaller work directory is unavailable.",
        }
    files = [
        {
            "path": item.relative_to(work_dir).as_posix(),
            "bytes": item.stat().st_size,
        }
        for item in work_dir.rglob("*")
        if item.is_file()
    ]
    files.sort(key=lambda item: (-int(item["bytes"]), str(item["path"])))
    categories = {"core": 0, "pdf": 0, "ocr": 0, "whisper": 0, "other": 0}
    toc = next(iter(work_dir.rglob("PKG-00.toc")), None)
    if toc is not None:
        try:
            payload = ast.literal_eval(toc.read_text(encoding="utf-8"))
            seen: set[str] = set()
            for candidate in _walk_strings(payload):
                path = Path(candidate)
                if candidate in seen or not path.is_file():
                    continue
                seen.add(candidate)
                lowered = candidate.lower().replace("\\", "/")
                size = path.stat().st_size
                if any(
                    token in lowered
                    for token in (
                        "paddle",
                        "onnxruntime",
                        "opencv",
                        "cv2",
                        "pypdfium2",
                        "/pil/",
                        "pillow",
                    )
                ):
                    categories["ocr"] += size
                elif any(
                    token in lowered
                    for token in (
                        "faster_whisper",
                        "ctranslate2",
                        "huggingface",
                        "/av/",
                        "av.libs",
                    )
                ):
                    categories["whisper"] += size
                elif "pypdf" in lowered:
                    categories["pdf"] += size
                elif any(
                    token in lowered
                    for token in (
                        "capture_runtime",
                        "fastapi",
                        "pydantic",
                        "starlette",
                        "uvicorn",
                    )
                ):
                    categories["core"] += size
                else:
                    categories["other"] += size
        except (OSError, SyntaxError, ValueError) as error:
            return {
                "files": files,
                "topFiles": files[:25],
                "categories": categories,
                "blocker": f"Could not parse PyInstaller TOC: {error}",
            }
    return {
        "files": files,
        "topFiles": files[:25],
        "categories": categories,
        "blocker": None if toc is not None else "PKG-00.toc is unavailable.",
    }


def build_report(arguments: argparse.Namespace) -> dict[str, Any]:
    executable = arguments.executable.resolve() if arguments.executable else None
    installer = arguments.installer.resolve() if arguments.installer else None
    installed_dir = arguments.installed_dir.resolve() if arguments.installed_dir else None
    installed_evidence = (
        arguments.installed_size_evidence.resolve() if arguments.installed_size_evidence else None
    )
    work_dir = arguments.pyinstaller_work.resolve() if arguments.pyinstaller_work else None
    installer_artifact = artifact(installer)
    if installed_dir is not None and installed_dir.is_dir():
        installed_bytes = directory_bytes(installed_dir)
        installed_blocker = None
    else:
        installed_bytes, installed_blocker = installed_bytes_evidence(
            installed_evidence,
            installer=installer_artifact,
        )
    startup = (
        measure_startup(executable, samples=arguments.startup_samples)
        if executable is not None and executable.is_file() and arguments.startup_samples > 0
        else {
            "coldMilliseconds": None,
            "warmMilliseconds": None,
            "samplesMilliseconds": [],
            "blocker": "Startup measurement was not requested or executable is unavailable.",
        }
    )
    return {
        "reportVersion": REPORT_VERSION,
        "platform": "windows" if platform.system() == "Windows" else platform.system().lower(),
        "arch": platform.machine().lower(),
        "pythonVersion": platform.python_version(),
        "runtimeExecutable": artifact(executable),
        "nsisInstaller": installer_artifact,
        "installedBytes": installed_bytes,
        "installedBytesBlocker": installed_blocker,
        "startup": startup,
        "pyinstaller": pyinstaller_inventory(work_dir),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--executable", type=Path)
    parser.add_argument("--installer", type=Path)
    parser.add_argument("--installed-dir", type=Path)
    parser.add_argument("--installed-size-evidence", type=Path)
    parser.add_argument("--pyinstaller-work", type=Path)
    parser.add_argument("--startup-samples", type=int, default=2)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    if arguments.startup_samples < 0 or arguments.startup_samples > 10:
        raise SystemExit("--startup-samples must be between 0 and 10")
    report = build_report(arguments)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
