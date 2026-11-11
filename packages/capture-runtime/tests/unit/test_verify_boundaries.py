from __future__ import annotations

import importlib.util
import sys
import zipfile
from pathlib import Path
from types import ModuleType

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "verify_boundaries.py"


def _load_verify_boundaries() -> ModuleType:
    spec = importlib.util.spec_from_file_location("verify_boundaries", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


verify_boundaries = _load_verify_boundaries()


def _zip(tmp_path: Path, names: tuple[str, ...]) -> Path:
    archive = tmp_path / "worker.zip"
    with zipfile.ZipFile(archive, "w") as destination:
        for name in names:
            destination.writestr(name, b"x")
    return archive


def _check(monkeypatch: pytest.MonkeyPatch, flag: str, archive: Path, *arguments: str) -> None:
    monkeypatch.setattr(sys, "argv", ["verify_boundaries.py", flag, str(archive), *arguments])
    verify_boundaries.main()


@pytest.mark.parametrize(
    ("filename", "stem"),
    [
        ("cublas64_12.dll", "cublas"),
        ("cublasLt64_12.dll", "cublas"),
        ("cudnn64_9.dll", "cudnn"),
        ("cudart64_12.dll", "cudart"),
        ("nvrtc64_120_0.dll", "nvrtc"),
        ("nvrtc-builtins64_128.dll", "nvrtc"),
        ("cufft64_11.dll", "cufft"),
        ("cusparse64_12.dll", "cusparse"),
        ("cusolver64_11.dll", "cusolver"),
        ("cusolverMg64_11.dll", "cusolver"),
        ("nvJitLink_120_0.dll", "nvjitlink"),
    ],
)
def test_cpu_speech_archive_rejects_cuda_runtime_library(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, filename: str, stem: str
) -> None:
    archive = _zip(tmp_path, (f"torch/lib/{filename}",))

    with pytest.raises(SystemExit, match=rf"cuda-runtime=\['{stem}'\]"):
        _check(monkeypatch, "--speech-recognition-cpu-worker", archive)


def test_cpu_speech_archive_accepts_cpu_torch_without_cuda_runtime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = _zip(
        tmp_path,
        (
            "capture-engine-speech-recognition-cpu.exe",
            "torch/lib/torch_cpu.dll",
            "torch/lib/c10.dll",
            "torch/cuda/__init__.py",
            "torch/lib/cublas64_12.py",
            "capture_runtime/japanese_kanji/LICENSE",
        ),
    )
    inventory = tmp_path / "inventory.txt"

    _check(
        monkeypatch,
        "--speech-recognition-cpu-worker",
        archive,
        "--speech-recognition-cpu-inventory",
        str(inventory),
    )

    text = inventory.read_text(encoding="utf-8")
    assert "torch/lib/torch_cpu.dll" in text
    assert "torch/lib/cublas64_12.py" in text


@pytest.mark.parametrize("token", ["paddleocr", "paddlex", "pypdfium2", "cv2"])
def test_cpu_speech_archive_rejects_modules_forbidden_for_speech_workers(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, token: str
) -> None:
    archive = _zip(tmp_path, (f"vendor/{token}/__init__.py",))

    with pytest.raises(SystemExit, match="forbidden="):
        _check(monkeypatch, "--speech-recognition-cpu-worker", archive)


def test_cuda_speech_archive_still_allows_cuda_runtime_libraries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = _zip(
        tmp_path,
        ("torch/lib/cublas64_12.dll", "torch/lib/cudnn64_9.dll", "torch/lib/cudart64_12.dll"),
    )

    _check(monkeypatch, "--speech-recognition-worker", archive)


def test_cuda_speech_archive_still_rejects_forbidden_worker_modules(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = _zip(tmp_path, ("vendor/paddleocr/__init__.py",))

    with pytest.raises(SystemExit, match="Speech recognition worker"):
        _check(monkeypatch, "--speech-recognition-worker", archive)
