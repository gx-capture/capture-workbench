from __future__ import annotations

import asyncio
import hashlib
import zipfile
from pathlib import Path

import httpx
import pytest

import capture_runtime.ollama.system_installer as system_installer_module
from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig, OllamaRuntimeConfig
from capture_runtime.engine_adapters import WINDOWSML_REQUIRED_MODEL_FILES, EngineProbe
from capture_runtime.ollama import (
    IsolatedOllamaLifecycle,
    SystemRuntimeInstaller,
    _extract_safe_zip,
)


class ProbeAdapter:
    def probe(self) -> EngineProbe:
        return EngineProbe(True, True, True, "ready")


class ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes], *, fail_after: int | None = None) -> None:
        self.chunks = chunks
        self.fail_after = fail_after

    async def __aiter__(self):
        for index, chunk in enumerate(self.chunks):
            if self.fail_after == index:
                raise httpx.ReadError("interrupted")
            yield chunk

    async def aclose(self) -> None:
        return None


def _installer(
    tmp_path: Path,
    handler,
    monkeypatch: pytest.MonkeyPatch,
    *,
    expected_bytes: int = 3,
) -> SystemRuntimeInstaller:
    payload = b"abc"[:expected_bytes]
    monkeypatch.setattr(
        system_installer_module,
        "WINDOWSML_BUNDLE_URL",
        "https://downloads.example.org/windowsml.zip",
    )
    monkeypatch.setattr(system_installer_module, "WINDOWSML_BUNDLE_BYTES", expected_bytes)
    monkeypatch.setattr(
        system_installer_module,
        "WINDOWSML_BUNDLE_SHA256",
        hashlib.sha256(payload).hexdigest(),
    )
    ollama_root = tmp_path / "ollama"
    lifecycle = IsolatedOllamaLifecycle(
        OllamaRuntimeConfig(
            host_url="http://127.0.0.1:12439",
            app_data_dir=ollama_root,
            pid_file=ollama_root / "pid.json",
            models_dir=ollama_root / "models",
        ),
        executable_resolver=lambda: None,
        clock=SystemClock(),
    )
    extraction = ExtractionRuntimeConfig(
        windowsml_model_dir=tmp_path / "models",
        whisper_models_dir=tmp_path / "whisper",
        temp_dir=tmp_path / "temp",
        windowsml_device_id=0,
        max_pdf_pages=10,
        max_image_pixels=100_000,
        ocr_render_scale=2,
        max_audio_duration_ms=60_000,
        whisper_primary_model="large-v3-turbo",
        whisper_fallback_model="small",
        whisper_prefer_gpu=False,
    )
    transport = httpx.MockTransport(handler)
    return SystemRuntimeInstaller(
        lifecycle,
        winget_resolver=lambda: None,
        extraction_config=extraction,
        ocr_adapter=ProbeAdapter(),  # type: ignore[arg-type]
        whisper_adapter=ProbeAdapter(),  # type: ignore[arg-type]
        clock=SystemClock(),
        http_client_factory=lambda: httpx.AsyncClient(
            transport=transport,
            follow_redirects=True,
        ),
    )


def _write_zip(
    path: Path,
    entries: list[tuple[str, bytes, int | None]],
    *,
    compression: int = zipfile.ZIP_STORED,
) -> None:
    with zipfile.ZipFile(path, "w", compression=compression) as archive:
        for name, content, external_attr in entries:
            info = zipfile.ZipInfo(name)
            info.compress_type = compression
            if external_attr is not None:
                info.create_system = 3
                info.external_attr = external_attr
            archive.writestr(info, content)


def _valid_entries() -> list[tuple[str, bytes, int | None]]:
    return [(name, f"content:{name}".encode(), None) for name in WINDOWSML_REQUIRED_MODEL_FILES]


def test_exact_six_entry_windowsml_zip_is_accepted(tmp_path: Path) -> None:
    archive = tmp_path / "valid.zip"
    destination = tmp_path / "output"
    _write_zip(archive, _valid_entries())
    _extract_safe_zip(archive, destination, asyncio.Event())
    assert sorted(
        path.relative_to(destination).as_posix()
        for path in destination.rglob("*")
        if path.is_file()
    ) == sorted(WINDOWSML_REQUIRED_MODEL_FILES)


@pytest.mark.parametrize(
    "entries",
    [
        _valid_entries() + [("extra.txt", b"extra", None)],
        [("../det/inference.onnx", b"escape", None)] + _valid_entries()[1:],
        [("det/inference.onnx:secret", b"ads", None)] + _valid_entries()[1:],
        [_valid_entries()[0], _valid_entries()[0], *_valid_entries()[1:]],
    ],
    ids=["extra", "traversal", "ads", "duplicate"],
)
def test_windowsml_zip_rejects_non_allowlisted_and_duplicate_entries(
    tmp_path: Path,
    entries: list[tuple[str, bytes, int | None]],
) -> None:
    archive = tmp_path / "malicious.zip"
    _write_zip(archive, entries)
    with pytest.raises(RuntimeError):
        _extract_safe_zip(archive, tmp_path / "output", asyncio.Event())


def test_windowsml_zip_rejects_symlinks_and_extreme_compression_ratio(tmp_path: Path) -> None:
    symlink_entries = _valid_entries()
    symlink_entries[0] = (symlink_entries[0][0], b"target", 0o120777 << 16)
    symlink = tmp_path / "symlink.zip"
    _write_zip(symlink, symlink_entries)
    with pytest.raises(RuntimeError, match="symbolic links"):
        _extract_safe_zip(symlink, tmp_path / "symlink-output", asyncio.Event())

    bomb_entries = _valid_entries()
    bomb_entries[0] = (bomb_entries[0][0], b"0" * (1024 * 1024), None)
    bomb = tmp_path / "bomb.zip"
    _write_zip(bomb, bomb_entries, compression=zipfile.ZIP_DEFLATED)
    with pytest.raises(RuntimeError, match="extraction size limit"):
        _extract_safe_zip(bomb, tmp_path / "bomb-output", asyncio.Event())


def test_windowsml_zip_honors_cancellation_before_extraction(tmp_path: Path) -> None:
    archive = tmp_path / "valid.zip"
    _write_zip(archive, _valid_entries())
    cancelled = asyncio.Event()
    cancelled.set()
    with pytest.raises(asyncio.CancelledError):
        _extract_safe_zip(archive, tmp_path / "output", cancelled)


@pytest.mark.parametrize(
    ("handler", "expected_bytes", "message"),
    [
        (
            lambda request: httpx.Response(
                200,
                headers={"content-length": "4"},
                stream=ChunkStream([b"abcd"]),
                request=request,
            ),
            3,
            "Content-Length verification failed",
        ),
        (
            lambda request: httpx.Response(
                200,
                stream=ChunkStream([b"ab", b"cd"]),
                request=request,
            ),
            3,
            "exceeded its declared bytes",
        ),
        (
            lambda request: httpx.Response(
                200,
                stream=ChunkStream([b"a", b"bc"], fail_after=1),
                request=request,
            ),
            3,
            "interrupted",
        ),
    ],
    ids=["content-length", "oversized-stream", "interrupted-stream"],
)
def test_windowsml_download_rejects_size_drift_and_interruption(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    handler,
    expected_bytes: int,
    message: str,
) -> None:
    installer = _installer(tmp_path, handler, monkeypatch, expected_bytes=expected_bytes)
    destination = tmp_path / "download.zip"
    with pytest.raises((httpx.HTTPError, RuntimeError), match=message):
        asyncio.run(
            installer._download_bundle(  # noqa: SLF001
                destination,
                asyncio.Event(),
                lambda _progress: None,
            )
        )
    assert not destination.exists()


def test_windowsml_download_accepts_only_exact_streamed_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-length": "3"},
            stream=ChunkStream([b"a", b"bc"]),
            request=request,
        )

    installer = _installer(tmp_path, handler, monkeypatch)
    destination = tmp_path / "download.zip"
    asyncio.run(
        installer._download_bundle(  # noqa: SLF001
            destination,
            asyncio.Event(),
            lambda _progress: None,
        )
    )
    assert destination.read_bytes() == b"abc"


def test_runtime_requirements_expose_runtime_owned_windowsml_installation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installer = _installer(
        tmp_path,
        lambda request: httpx.Response(500, request=request),
        monkeypatch,
    )
    requirement = next(
        item for item in installer.requirements() if item.requirement_id == "windowsml-ocr"
    )
    assert requirement.status == "ready"
    assert requirement.artifact is None
