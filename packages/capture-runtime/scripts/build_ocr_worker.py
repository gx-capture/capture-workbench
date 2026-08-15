from __future__ import annotations

import platform
import subprocess
import sys
from pathlib import Path

from worker_archive import build_worker_archive

from capture_runtime.constants import RUNTIME_VERSION


def main() -> None:
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("OCR worker requires Python 3.12")
    if platform.system() != "Windows" or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise SystemExit("OCR worker v2 is Windows x64 only")
    root = Path(__file__).resolve().parents[1]
    dist = root / "dist" / "workers"
    work = root / ".build" / "pyinstaller" / "ocr-worker"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(dist),
            "--workpath",
            str(work),
            str(root / "pyinstaller" / "capture-engine-ocr.spec"),
        ],
        cwd=root,
        stdin=subprocess.DEVNULL,
        shell=False,
        check=True,
    )
    stem = f"capture-engine-ocr-{RUNTIME_VERSION}-windows-x64"
    build_worker_archive(
        dist / "capture-engine-ocr",
        root / "dist" / "engines" / f"{stem}.zip",
        root / "dist" / "engines" / f"{stem}-files.json",
    )


if __name__ == "__main__":
    main()
