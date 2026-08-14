# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_dynamic_libs, collect_submodules

root = Path(SPEC).resolve().parents[1]
hiddenimports = collect_submodules("faster_whisper") + collect_submodules("huggingface_hub")
datas = (
    collect_data_files("faster_whisper")
    + collect_data_files("huggingface_hub")
)
binaries = collect_dynamic_libs("av")

a = Analysis(
    [str(root / "src" / "capture_runtime" / "workers" / "whisper_main.py")],
    pathex=[str(root / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[str(root / "pyinstaller" / "hooks")],
    excludes=[
        "PIL",
        "cv2",
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
    name="capture-engine-whisper",
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
    name="capture-engine-whisper",
)
