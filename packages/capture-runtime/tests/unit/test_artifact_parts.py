"""Worker archives published as ordered parts: split, read back, catalog and download."""

from __future__ import annotations

import asyncio
import hashlib
import io
import zipfile
from pathlib import Path

import httpx
import pytest

from capture_runtime.artifact_parts import (
    JoinedParts,
    archive_parts,
    part_file_name,
    split_archive,
)
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.engine_catalog import EngineArtifactDescriptor, EngineCatalogError
from capture_runtime.engine_installation import EngineInstallationError, HttpArtifactDownloader
from capture_runtime.worker_contracts import WORKER_PROTOCOL_VERSION

NAME = f"capture-engine-speech-recognition-{RUNTIME_VERSION}-windows-x64.zip"
BASE = "https://example.test/releases"


def _zip(path: Path, size: int = 50_000) -> bytes:
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_STORED) as archive:
        archive.writestr("worker.exe", bytes(range(256)) * (size // 256))
        archive.writestr("files-manifest.json", b"{}")
    return path.read_bytes()


def _payload(parts: list[bytes] | None, whole: bytes) -> dict[str, object]:
    source: dict[str, object] = (
        {"url": f"{BASE}/{NAME}"}
        if parts is None
        else {
            "parts": [
                {
                    "fileName": part_file_name(NAME, index),
                    "bytes": len(part),
                    "sha256": hashlib.sha256(part).hexdigest(),
                    "url": f"{BASE}/{part_file_name(NAME, index)}",
                }
                for index, part in enumerate(parts, start=1)
            ]
        }
    )
    return {
        "role": "worker",
        "requirementId": "speech-recognition",
        "artifactVersion": RUNTIME_VERSION,
        "workerProtocolVersion": WORKER_PROTOCOL_VERSION,
        "platform": "windows",
        "arch": "x86_64",
        "fileName": NAME,
        "bytes": len(whole),
        "sha256": hashlib.sha256(whole).hexdigest(),
        "extractedBytes": 1,
        "entryPoint": "worker.exe",
        "filesManifestSha256": "0" * 64,
        **source,
    }


def test_small_archives_stay_whole_and_large_ones_split_into_exact_parts(tmp_path: Path) -> None:
    small = tmp_path / "small.zip"
    small.write_bytes(b"x" * 10)
    assert split_archive(small, part_bytes=10) == [small]

    archive = tmp_path / NAME
    whole = _zip(archive)
    parts = split_archive(archive, part_bytes=20_000)

    assert not archive.exists()
    assert [part.name for part in parts] == [part_file_name(NAME, i) for i in (1, 2, 3)]
    assert [part.stat().st_size for part in parts] == [20_000, 20_000, len(whole) - 40_000]
    assert b"".join(part.read_bytes() for part in parts) == whole
    assert archive_parts(tmp_path, NAME) == parts


def test_joined_parts_read_a_split_zip_and_seek_across_boundaries(tmp_path: Path) -> None:
    whole = _zip(tmp_path / NAME)
    parts = split_archive(tmp_path / NAME, part_bytes=7_777)

    with JoinedParts(parts) as joined:
        assert joined.read() == whole
        joined.seek(7_770)
        assert joined.read(20) == whole[7_770:7_790]
        joined.seek(-5, io.SEEK_END)
        assert joined.read() == whole[-5:]
    with JoinedParts(parts) as joined, zipfile.ZipFile(joined) as source:
        assert source.read("files-manifest.json") == b"{}"


def test_archive_parts_rejects_missing_gaps_and_whole_plus_parts(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        archive_parts(tmp_path, NAME)
    (tmp_path / part_file_name(NAME, 1)).write_bytes(b"a")
    (tmp_path / part_file_name(NAME, 3)).write_bytes(b"c")
    with pytest.raises(FileNotFoundError):
        archive_parts(tmp_path, NAME)
    (tmp_path / part_file_name(NAME, 2)).write_bytes(b"b")
    (tmp_path / NAME).write_bytes(b"abc")
    with pytest.raises(ValueError, match="both whole and as parts"):
        archive_parts(tmp_path, NAME)


def test_catalog_descriptor_round_trips_parts_and_keeps_single_urls() -> None:
    whole = b"0123456789"
    parted = EngineArtifactDescriptor.from_dict(_payload([whole[:6], whole[6:]], whole))
    assert parted.url is None
    assert [part.bytes for part in parted.parts] == [6, 4]
    assert parted.to_dict() == _payload([whole[:6], whole[6:]], whole)

    single = EngineArtifactDescriptor.from_dict(_payload(None, whole))
    assert single.parts == () and single.url == f"{BASE}/{NAME}"
    assert single.to_dict() == _payload(None, whole)


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (lambda payload: payload.update(url=f"{BASE}/{NAME}"), "fields must be"),
        (lambda payload: payload["parts"].pop(), "at least two parts"),
        (lambda payload: payload["parts"][1].update(fileName=f"{NAME}.009"), "named"),
        (lambda payload: payload.update(bytes=11), "add up"),
        (lambda payload: payload["parts"][0].update(bytes=2_000_000_001), "part bytes"),
    ],
)
def test_catalog_descriptor_rejects_inconsistent_parts(change, message) -> None:
    whole = b"0123456789"
    payload = _payload([whole[:6], whole[6:]], whole)
    change(payload)
    with pytest.raises(EngineCatalogError, match=message):
        EngineArtifactDescriptor.from_dict(payload)


def _transport(files: dict[str, bytes], *, ranges: bool, requested: list[str]):
    def handler(request: httpx.Request) -> httpx.Response:
        content = files[request.url.path.rsplit("/", 1)[-1]]
        byte_range = request.headers.get("range")
        requested.append(f"{request.url.path.rsplit('/', 1)[-1]} {byte_range}")
        if not byte_range or not ranges:
            return httpx.Response(200, content=content, request=request)
        start, end = (int(value) for value in byte_range.removeprefix("bytes=").split("-"))
        return httpx.Response(
            206,
            headers={"content-range": f"bytes {start}-{end}/{len(content)}"},
            content=content[start : end + 1],
            request=request,
        )

    return httpx.MockTransport(handler)


@pytest.mark.parametrize("ranges", [True, False])
def test_downloader_joins_parts_in_order_with_cumulative_progress(
    tmp_path: Path, ranges: bool
) -> None:
    whole = bytes(range(256)) * 40
    pieces = [whole[:4_000], whole[4_000:8_000], whole[8_000:]]
    descriptor = EngineArtifactDescriptor.from_dict(_payload(pieces, whole))
    files = {part.file_name: piece for part, piece in zip(descriptor.parts, pieces, strict=True)}
    requested: list[str] = []
    reported: list[int] = []
    downloader = HttpArtifactDownloader(
        lambda: httpx.AsyncClient(transport=_transport(files, ranges=ranges, requested=requested)),
        parallel_min_bytes=1,
        parallel_segments=2,
    )

    asyncio.run(
        downloader.download(
            descriptor,
            tmp_path / "download.zip",
            cancel_event=asyncio.Event(),
            progress=reported.append,
        )
    )

    assert (tmp_path / "download.zip").read_bytes() == whole
    assert [entry.split()[0] for entry in requested] == sorted(
        entry.split()[0] for entry in requested
    )
    assert reported == sorted(reported) and reported[-1] == len(whole)


def test_downloader_rejects_a_corrupted_part_and_removes_the_download(tmp_path: Path) -> None:
    whole = bytes(range(256)) * 40
    pieces = [whole[:5_000], whole[5_000:]]
    descriptor = EngineArtifactDescriptor.from_dict(_payload(pieces, whole))
    files = {
        descriptor.parts[0].file_name: pieces[0],
        descriptor.parts[1].file_name: b"\x00" * len(pieces[1]),
    }
    downloader = HttpArtifactDownloader(
        lambda: httpx.AsyncClient(transport=_transport(files, ranges=False, requested=[])),
    )

    with pytest.raises(EngineInstallationError, match="part checksum"):
        asyncio.run(
            downloader.download(
                descriptor,
                tmp_path / "download.zip",
                cancel_event=asyncio.Event(),
                progress=lambda _copied: None,
            )
        )
    assert not (tmp_path / "download.zip").exists()
