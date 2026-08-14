# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path
from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_dynamic_libs,
    collect_submodules,
    copy_metadata,
)

root = Path(SPEC).resolve().parents[1]

hiddenimports = (
    collect_submodules("paddleocr")
    + collect_submodules("paddlex")
    + collect_submodules("onnxruntime")
    + ["PIL.BmpImagePlugin", "PIL.JpegImagePlugin", "PIL.PngImagePlugin", "PIL.WebPImagePlugin"]
)
datas = (
    collect_data_files("paddleocr")
    + collect_data_files("paddlex")
    + collect_data_files("pypdfium2")
)
for distribution in (
    "imagesize",
    "opencv-contrib-python",
    "pyclipper",
    "pypdfium2",
    "python-bidi",
    "shapely",
):
    datas += copy_metadata(distribution)
binaries = (
    collect_dynamic_libs("onnxruntime")
    + collect_dynamic_libs("pypdfium2")
    + collect_dynamic_libs("cv2")
)

a = Analysis(
    [str(root / "src" / "capture_runtime" / "workers" / "ocr_main.py")],
    pathex=[str(root / "src")],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[str(root / "pyinstaller" / "hooks")],
    excludes=[
        "av",
        "ctranslate2",
        "faster_whisper",
        "huggingface_hub",
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
    name="capture-engine-ocr",
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
    name="capture-engine-ocr",
)
