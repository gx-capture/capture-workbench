from __future__ import annotations

import asyncio
import hashlib
import json
import stat
import zipfile
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from capture_runtime.engine_catalog import EngineArtifactDescriptor
from capture_runtime.engine_installation import (
    MAX_FILES_MANIFEST_BYTES,
    EngineInstallationError,
    HttpArtifactDownloader,
    safe_extract_artifact,
)


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


def _manifest(files: dict[str, bytes]) -> bytes:
    return (
        json.dumps(
            {
                "manifestVersion": "1",
                "files": [
                    {
                        "path": name,
                        "bytes": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                    for name, content in sorted(files.items())
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode()


def _archive(
    path: Path,
    files: dict[str, bytes],
    *,
    extra: list[tuple[str, bytes, int]] | None = None,
    compression: int = zipfile.ZIP_STORED,
    manifest_override: bytes | None = None,
) -> tuple[EngineArtifactDescriptor, bytes]:
    manifest = manifest_override if manifest_override is not None else _manifest(files)
    with zipfile.ZipFile(path, "w", compression=compression) as destination:
        for name, content in files.items():
            destination.writestr(name, content)
        destination.writestr("files-manifest.json", manifest)
        for name, content, external_attr in extra or []:
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = external_attr
            info.compress_type = compression
            destination.writestr(info, content)
    with zipfile.ZipFile(path) as source:
        extracted_bytes = sum(item.file_size for item in source.infolist())
    descriptor = EngineArtifactDescriptor.from_dict(
        {
            "role": "worker",
            "requirementId": "windowsml-ocr",
            "artifactVersion": "0.3.2",
            "workerProtocolVersion": "1",
            "platform": "windows",
            "arch": "x86_64",
            "fileName": path.name,
            "bytes": path.stat().st_size,
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            "extractedBytes": extracted_bytes,
            "entryPoint": next(iter(files)),
            "filesManifestSha256": hashlib.sha256(manifest).hexdigest(),
            "url": f"https://downloads.example.test/{path.name}",
        }
    )
    return descriptor, manifest


def test_safe_engine_zip_accepts_only_manifested_regular_files(tmp_path: Path) -> None:
    archive = tmp_path / "worker.zip"
    descriptor, _manifest_bytes = _archive(
        archive, {"capture-engine-ocr.exe": b"worker", "data/model.txt": b"model"}
    )
    destination = tmp_path / "output"
    safe_extract_artifact(archive, destination, descriptor, cancel_event=asyncio.Event())
    assert (destination / "capture-engine-ocr.exe").read_bytes() == b"worker"
    assert (destination / "data" / "model.txt").read_bytes() == b"model"


@pytest.mark.parametrize(
    "name",
    [
        "../escape.exe",
        "/absolute.exe",
        "C:/drive.exe",
        "//server/share.exe",
        "folder/../../escape.exe",
    ],
)
def test_safe_engine_zip_rejects_rooted_and_traversal_paths(tmp_path: Path, name: str) -> None:
    archive = tmp_path / "unsafe.zip"
    descriptor, _ = _archive(
        archive,
        {"capture-engine-ocr.exe": b"worker"},
        extra=[(name, b"escape", stat.S_IFREG << 16)],
    )
    with pytest.raises(EngineInstallationError, match="path|rooted|drive|manifest"):
        safe_extract_artifact(
            archive, tmp_path / "output", descriptor, cancel_event=asyncio.Event()
        )


@pytest.mark.parametrize(
    "name",
    [
        "data/model.bin:stream",
        "control\u0001name.bin",
        "trailing-dot./model.bin",
        "trailing-space /model.bin",
        "CON",
        "prn.txt",
        "directory/AuX.bin",
        "nul.json",
        "COM1",
        "com9.log",
        "LPT1",
        "lpt9.txt",
        "Con/",
    ],
)
def test_safe_engine_zip_rejects_windows_unsafe_components(
    tmp_path: Path,
    name: str,
) -> None:
    archive = tmp_path / "windows-unsafe.zip"
    descriptor, _ = _archive(
        archive,
        {"capture-engine-ocr.exe": b"worker"},
        extra=[(name, b"unsafe", stat.S_IFREG << 16)],
    )
    with pytest.raises(EngineInstallationError, match="Windows-unsafe"):
        safe_extract_artifact(
            archive,
            tmp_path / "output",
            descriptor,
            cancel_event=asyncio.Event(),
        )


def test_safe_engine_zip_rejects_oversized_manifest_before_read(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    archive = tmp_path / "oversized-manifest.zip"
    descriptor, _ = _archive(
        archive,
        {"capture-engine-ocr.exe": b"worker"},
        manifest_override=b" " * (MAX_FILES_MANIFEST_BYTES + 1),
    )

    def reject_read(*_args: object, **_kwargs: object) -> bytes:
        raise AssertionError("oversized files manifest must not be read")

    monkeypatch.setattr(zipfile.ZipFile, "read", reject_read)
    with pytest.raises(EngineInstallationError, match="manifest exceeds size limit"):
        safe_extract_artifact(
            archive,
            tmp_path / "output",
            descriptor,
            cancel_event=asyncio.Event(),
        )


def test_safe_engine_zip_rejects_symlink_case_collision_and_unlisted_file(
    tmp_path: Path,
) -> None:
    cases = [
        [("link", b"target", (stat.S_IFLNK | 0o777) << 16)],
        [("CAPTURE-ENGINE-OCR.EXE", b"other", stat.S_IFREG << 16)],
        [("unlisted.bin", b"other", stat.S_IFREG << 16)],
    ]
    for index, extra in enumerate(cases):
        archive = tmp_path / f"unsafe-{index}.zip"
        descriptor, _ = _archive(archive, {"capture-engine-ocr.exe": b"worker"}, extra=extra)
        with pytest.raises(EngineInstallationError):
            safe_extract_artifact(
                archive,
                tmp_path / f"output-{index}",
                descriptor,
                cancel_event=asyncio.Event(),
            )


def test_safe_engine_zip_rejects_checksum_and_cancellation(tmp_path: Path) -> None:
    archive = tmp_path / "worker.zip"
    descriptor, _ = _archive(archive, {"capture-engine-ocr.exe": b"worker"})
    bad = replace(descriptor, sha256="0" * 64)
    with pytest.raises(EngineInstallationError, match="catalog descriptor"):
        safe_extract_artifact(archive, tmp_path / "bad", bad, cancel_event=asyncio.Event())
    cancelled = asyncio.Event()
    cancelled.set()
    with pytest.raises(asyncio.CancelledError):
        safe_extract_artifact(archive, tmp_path / "cancelled", descriptor, cancel_event=cancelled)


@pytest.mark.parametrize(
    ("response_bytes", "declared", "message"),
    [
        (b"abcd", "4", "Content-Length"),
        (b"abcd", None, "byte count"),
    ],
)
def test_http_downloader_rejects_size_drift(
    tmp_path: Path,
    response_bytes: bytes,
    declared: str | None,
    message: str,
) -> None:
    archive = tmp_path / "expected.zip"
    descriptor, _ = _archive(archive, {"capture-engine-ocr.exe": b"x"})
    headers = {"content-length": declared} if declared else {}
    downloader = HttpArtifactDownloader(
        lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    headers=headers,
                    stream=ChunkStream([response_bytes]),
                    request=request,
                )
            )
        )
    )
    with pytest.raises(EngineInstallationError, match=message):
        asyncio.run(
            downloader.download(
                descriptor,
                tmp_path / "download.zip",
                cancel_event=asyncio.Event(),
                progress=lambda _copied: None,
            )
        )
    assert not (tmp_path / "download.zip").exists()
