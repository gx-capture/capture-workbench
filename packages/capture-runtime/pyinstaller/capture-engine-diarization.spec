# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

root = Path(SPEC).resolve().parents[1]
# pyannote resolves pipeline, model and clustering classes by name at run time.
hiddenimports = (
    collect_submodules("pyannote")
    + collect_submodules("asteroid_filterbanks")
    + collect_submodules("lightning")
    + collect_submodules("lightning_fabric")
    + collect_submodules("pytorch_lightning")
)
datas = (
    collect_data_files("pyannote")
    + collect_data_files("lightning")
    + collect_data_files("lightning_fabric")
    + collect_data_files("pytorch_lightning")
    + collect_data_files("torchaudio")
)
# These packages read their own installed metadata or entry points on import.
for distribution in (
    "lightning",
    "opentelemetry-api",
    "opentelemetry-sdk",
    "pyannote.audio",
    "pytorch-lightning",
    "torch",
    "torchaudio",
    "torchmetrics",
):
    datas += copy_metadata(distribution)
binaries = collect_dynamic_libs("av")

a = Analysis(
    [str(root / "src" / "capture_runtime" / "workers" / "diarization_main.py")],
    pathex=[str(root / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[str(root / "pyinstaller" / "hooks")],
    excludes=[
        # Pulled in by matplotlib and the build environment; the worker never
        # opens a window, and they add about a thousand files.
        "IPython",
        "_tkinter",
        "mypy",
        "tkinter",
        "capture_runtime._vendor",
        "capture_runtime.ocr_vertical_reader",
        "ctranslate2",
        "cv2",
        "faster_whisper",
        "onnxruntime",
        "paddle",
        "paddleocr",
        "paddlex",
        "pypdfium2",
    ],
    noarchive=False,
    optimize=1,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="capture-engine-diarization",
    debug=False,
    strip=False,
    upx=True,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=True,
    name="capture-engine-diarization",
)
