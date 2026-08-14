# -*- mode: python ; coding: utf-8 -*-

import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files

root = Path(SPEC).resolve().parents[1]
layout = os.environ.get("CAPTURE_PYINSTALLER_LAYOUT", "onefile")
if layout not in {"onefile", "onedir"}:
    raise ValueError("CAPTURE_PYINSTALLER_LAYOUT must be onefile or onedir")
catalog = Path(os.environ["CAPTURE_ENGINE_CATALOG_BUILD_PATH"])
contract_assets = root / "src" / "capture_runtime" / "assets"
runtime_client_assets = collect_data_files(
    "capture_runtime_client",
    includes=["private/assets/*", "private/schemas/*"],
)

a = Analysis(
    [str(root / "src" / "capture_runtime" / "__main__.py")],
    pathex=[str(root / "src")],
    binaries=[],
    datas=runtime_client_assets + [
        (str(catalog), "."),
        (str(contract_assets / "contract-set.json"), "capture_runtime/assets"),
        (str(contract_assets / "contract-set.sha256"), "capture_runtime/assets"),
    ],
    hiddenimports=[
        "capture_runtime_client.private.assets",
        "capture_runtime_client.private.schemas",
        "uvicorn.logging",
        "uvicorn.loops.asyncio",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.http.h11_impl",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.lifespan.on",
    ],
    hookspath=[str(root / "pyinstaller" / "hooks")],
    excludes=[
        "PIL",
        "ctranslate2",
        "cv2",
        "faster_whisper",
        "httptools",
        "huggingface_hub",
        "onnxruntime",
        "paddle",
        "paddleocr",
        "paddlex",
        "pypdfium2",
        "pytest",
        "tkinter",
        "uvloop",
        "watchfiles",
        "websockets",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    a.binaries if layout == "onefile" else [],
    a.datas if layout == "onefile" else [],
    [],
    name="capture-runtime",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,
    exclude_binaries=layout == "onedir",
)
if layout == "onedir":
    coll = COLLECT(
        exe,
        a.binaries,
        a.datas,
        strip=False,
        upx=True,
        name="capture-runtime",
    )
