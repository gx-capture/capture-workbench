from __future__ import annotations

import argparse
import subprocess
import sys
import zipfile
from pathlib import Path

CORE_FORBIDDEN = (
    "PIL",
    "ctranslate2",
    "cv2",
    "faster_whisper",
    "huggingface_hub",
    "onnxruntime",
    "paddleocr",
    "paddlex",
    "pypdfium2",
    "capture_runtime.workers",
)
CORE_REQUIRED = (
    "av/_core.pyd",
    "av/audio/",
    "av/container/",
    "av.libs/avcodec-",
    "av.libs/avformat-",
    "av.libs/avutil-",
    "av.libs/swresample-",
    "capture_runtime_client/private/assets/contract-set.json",
    "capture_runtime_client/private/assets/contract-set.sha256",
    "capture_runtime_client/private/schemas/capture-document.schema.json",
    "capture_runtime_client/private/schemas/raw-capture.schema.json",
)
OCR_FORBIDDEN = ("faster_whisper", "ctranslate2", "huggingface_hub")
WHISPER_FORBIDDEN = ("paddleocr", "paddlex", "pypdfium2", "cv2", "PIL")
OTHER_PLATFORM = ("/linux", "/darwin", "aarch64", "arm64")


def executable_inventory(path: Path, *, recursive: bool = True) -> str:
    viewer_arguments = [
        sys.executable,
        "-m",
        "PyInstaller.utils.cliutils.archive_viewer",
    ]
    if recursive:
        viewer_arguments.append("-r")
    viewer_arguments.extend(("-b", str(path)))
    result = subprocess.run(
        viewer_arguments,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        shell=False,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"could not inspect PyInstaller executable:\n{result.stdout}")
    return result.stdout.replace("\\", "/")


def zip_inventory(path: Path) -> str:
    with zipfile.ZipFile(path) as source:
        return "\n".join(info.filename for info in source.infolist())


def write_inventory(path: Path | None, inventory: str) -> None:
    if path is None:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(inventory.rstrip() + "\n", encoding="utf-8")


def reject(inventory: str, forbidden: tuple[str, ...], label: str) -> None:
    lowered = inventory.casefold().replace("\\", "/")
    found = [
        token
        for token in forbidden
        if any(
            pattern in lowered
            for pattern in (
                f"\n{token.casefold()}\n",
                f"\n{token.casefold()}.",
                f"\n{token.casefold()}/",
                f"/{token.casefold()}/",
                f"\n{token.casefold()}-",
            )
        )
    ]
    names = [line.strip(" '") for line in lowered.splitlines()]
    binary_names = [
        name for name in names if name.endswith((".dll", ".exe", ".pyd", ".so", ".dylib"))
    ]
    binary_lines = "\n".join(binary_names)
    platform_found = [token for token in OTHER_PLATFORM if token.casefold() in binary_lines]
    platform_found.extend(
        suffix
        for suffix in (".so", ".dylib")
        if any(
            name.endswith(suffix) and ("/" in name or name.startswith("lib"))
            for name in binary_names
        )
    )
    if found or platform_found:
        raise SystemExit(
            f"{label} boundary violation; forbidden={found}, other-platform={platform_found}"
        )


def require(inventory: str, required: tuple[str, ...], label: str) -> None:
    lowered = inventory.casefold().replace("\\", "/")
    missing = [token for token in required if token.casefold() not in lowered]
    if missing:
        raise SystemExit(f"{label} artifact incomplete; missing={missing}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--core", type=Path)
    parser.add_argument("--ocr-worker", type=Path)
    parser.add_argument("--whisper-worker", type=Path)
    parser.add_argument("--core-inventory", type=Path)
    parser.add_argument("--core-recursive-inventory", type=Path)
    parser.add_argument("--ocr-inventory", type=Path)
    parser.add_argument("--whisper-inventory", type=Path)
    arguments = parser.parse_args()
    if arguments.core:
        recursive_inventory = executable_inventory(arguments.core)
        reject(recursive_inventory, CORE_FORBIDDEN, "core")
        require(recursive_inventory, CORE_REQUIRED, "core")
        write_inventory(arguments.core_recursive_inventory, recursive_inventory)
        if arguments.core_inventory is not None:
            write_inventory(
                arguments.core_inventory,
                executable_inventory(arguments.core, recursive=False),
            )
    if arguments.ocr_worker:
        inventory = zip_inventory(arguments.ocr_worker)
        reject(inventory, OCR_FORBIDDEN, "OCR worker")
        write_inventory(arguments.ocr_inventory, inventory)
    if arguments.whisper_worker:
        inventory = zip_inventory(arguments.whisper_worker)
        reject(inventory, WHISPER_FORBIDDEN, "Whisper worker")
        write_inventory(arguments.whisper_inventory, inventory)
    if not any((arguments.core, arguments.ocr_worker, arguments.whisper_worker)):
        raise SystemExit("at least one artifact must be supplied")


if __name__ == "__main__":
    main()
