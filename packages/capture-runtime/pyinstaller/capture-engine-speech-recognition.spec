# -*- mode: python ; coding: utf-8 -*-

from importlib.metadata import PackageNotFoundError
from pathlib import Path
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

root = Path(SPEC).resolve().parents[1]
# Transformers and librosa resolve model classes and audio helpers lazily.
hiddenimports = (
    collect_submodules("transformers.models.qwen3_asr")
    + collect_submodules("transformers.models.auto")
    + collect_submodules("librosa")
    + ["_soundfile_data"]
)
# lazy_loader reads __init__.pyi stubs; librosa utilities also read bundled registries.
datas = collect_data_files("librosa", includes=["**/*"])
# Includes the mandatory checks in transformers/dependency_versions_check.py.
for distribution in (
    "transformers",
    "huggingface-hub",
    "safetensors",
    "tokenizers",
    "torch",
    "numpy",
    "librosa",
    "tqdm",
    "regex",
    "packaging",
    "filelock",
    "pyyaml",
):
    datas += copy_metadata(distribution)
# Transformers checks Accelerate only when that optional dependency is installed.
try:
    datas += copy_metadata("accelerate")
except PackageNotFoundError:
    pass
binaries = (
    collect_dynamic_libs("av")
    + collect_dynamic_libs("_soundfile_data")
    + collect_dynamic_libs("soxr")
)

a = Analysis(
    [str(root / "src" / "capture_runtime" / "workers" / "speech_recognition_main.py")],
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
        "cv2",
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
    name="capture-engine-speech-recognition",
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
    name="capture-engine-speech-recognition",
)
