from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import platform
import subprocess
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--require-engines", action="store_true")
    arguments = parser.parse_args()
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("capture-runtime executable requires Python 3.12")
    if platform.system() != "Windows" or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise SystemExit("capture-runtime v1 executable is Windows x64 only")
    root = Path(__file__).resolve().parents[1]
    command = [
        sys.executable,
        "-m",
        "PyInstaller",
        "--noconfirm",
        "--clean",
        "--onefile",
        "--name",
        "capture-runtime",
        "--distpath",
        str(root / "dist" / "executable"),
        "--workpath",
        str(root / ".build" / "pyinstaller"),
        "--specpath",
        str(root / ".build" / "pyinstaller"),
        "--collect-submodules",
        "uvicorn",
        "--collect-all",
        "PIL",
        "--collect-all",
        "pypdfium2",
        "--collect-all",
        "pypdf",
    ]
    optional_modules = (
        "onnxruntime",
        "paddleocr",
        "paddlex",
        "faster_whisper",
        "ctranslate2",
        "av",
        "huggingface_hub",
    )
    missing = [module for module in optional_modules if importlib.util.find_spec(module) is None]
    if arguments.require_engines and missing:
        raise SystemExit("Production engine dependencies are missing: " + ", ".join(missing))
    for module in optional_modules:
        if module not in missing:
            command.extend(("--collect-all", module))
    # PaddleX decides whether its OCR pipeline is usable from distribution
    # metadata at runtime. PyInstaller does not include that metadata when it
    # collects a package, so the frozen executable would incorrectly report
    # that paddlex[ocr-core] is unavailable even though its modules are there.
    metadata_packages = (
        "paddlex",
        "paddleocr",
        "imagesize",
        "opencv-contrib-python",
        "pyclipper",
        "pypdfium2",
        "pypdf",
        "python-bidi",
        "shapely",
    )
    for package in metadata_packages:
        try:
            importlib.metadata.version(package)
        except importlib.metadata.PackageNotFoundError:
            continue
        command.extend(("--copy-metadata", package))
    command.append(str(root / "src" / "capture_runtime" / "__main__.py"))
    subprocess.run(
        command,
        cwd=root,
        stdin=subprocess.DEVNULL,
        shell=False,
        check=True,
    )


if __name__ == "__main__":
    main()
