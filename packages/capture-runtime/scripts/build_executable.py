from __future__ import annotations

import argparse
import os
import platform
import subprocess
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--layout", choices=("onefile", "onedir"), default="onefile")
    parser.add_argument("--catalog", type=Path, required=True)
    arguments = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("capture-runtime executable requires Python 3.12")
    if platform.system() != "Windows" or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise SystemExit("capture-runtime v1 executable is Windows x64 only")
    root = Path(__file__).resolve().parents[1]
    catalog = arguments.catalog
    if not catalog.is_absolute():
        catalog = root / catalog
    if not catalog.is_file():
        raise SystemExit(f"Capture Runtime engine catalog does not exist: {catalog}")
    embedded_catalog = root / ".build" / "catalog" / "capture-engine-catalog.json"
    embedded_catalog.parent.mkdir(parents=True, exist_ok=True)
    embedded_catalog.write_bytes(catalog.read_bytes())
    environment = dict(os.environ)
    environment["CAPTURE_ENGINE_CATALOG_BUILD_PATH"] = str(embedded_catalog.resolve())
    environment["CAPTURE_PYINSTALLER_LAYOUT"] = arguments.layout
    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(root / "dist" / f"core-{arguments.layout}"),
            "--workpath",
            str(root / ".build" / "pyinstaller" / f"core-{arguments.layout}"),
            str(root / "pyinstaller" / "capture-runtime.spec"),
        ],
        cwd=root,
        env=environment,
        stdin=subprocess.DEVNULL,
        shell=False,
        check=True,
    )
    executable = (
        root / "dist" / f"core-{arguments.layout}" / "capture-runtime.exe"
        if arguments.layout == "onefile"
        else root / "dist" / f"core-{arguments.layout}" / "capture-runtime" / "capture-runtime.exe"
    )
    if not executable.is_file():
        raise SystemExit(f"PyInstaller did not create {executable}")
    if arguments.layout == "onefile":
        canonical = root / "dist" / "executable"
        canonical.mkdir(parents=True, exist_ok=True)
        destination = canonical / "capture-runtime.exe"
        destination.write_bytes(executable.read_bytes())


if __name__ == "__main__":
    main()
