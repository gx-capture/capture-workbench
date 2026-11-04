"""Partial engine downloads resume from the bytes already on disk."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import httpx
import pytest

from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.provisioning.infrastructure import (
    _engine_installation_download as download_module,
)
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    EngineArtifactDescriptor,
    EngineModelFileDescriptor,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineInstallationError,
    HttpArtifactDownloader,
    HttpModelFileDownloader,
)
from capture_runtime.worker_contracts import WORKER_PROTOCOL_VERSION

NAME = "worker.zip"
BASE = "https://downloads.example.test"


class _Once(httpx.AsyncByteStream):
    def __init__(self, chunk: bytes) -> None:
        self._chunk = chunk

    async def __aiter__(self):
        yield self._chunk

    async def aclose(self) -> None:
        return None


class _Interrupt(httpx.AsyncByteStream):
    def __init__(self, chunk: bytes) -> None:
        self._chunk = chunk

    async def __aiter__(self):
        yield self._chunk
        raise httpx.ReadError("interrupted")

    async def aclose(self) -> None:
        return None


class _Chunks(httpx.AsyncByteStream):
    """Yield to the event loop between chunks so concurrent segments interleave."""

    def __init__(self, data: bytes, size: int) -> None:
        self._chunks = [data[index : index + size] for index in range(0, len(data), size)]

    async def __aiter__(self):
        for chunk in self._chunks:
            await asyncio.sleep(0)
            yield chunk

    async def aclose(self) -> None:
        return None


class _Barrier(httpx.AsyncByteStream):
    """Yield one chunk, then fail only after every sibling has done the same."""

    def __init__(self, chunk: bytes, arrived: list[int], needed: int) -> None:
        self._chunk = chunk
        self._arrived = arrived
        self._needed = needed

    async def __aiter__(self):
        yield self._chunk
        self._arrived[0] += 1
        while self._arrived[0] < self._needed:
            await asyncio.sleep(0)
        raise httpx.ReadError("interrupted")

    async def aclose(self) -> None:
        return None


def _artifact(payload: bytes, *, parts: list[bytes] | None = None) -> EngineArtifactDescriptor:
    if parts is None:
        source: dict[str, object] = {"url": f"{BASE}/{NAME}"}
    else:
        source = {
            "parts": [
                {
                    "fileName": f"{NAME}.{index:03d}",
                    "bytes": len(part),
                    "sha256": hashlib.sha256(part).hexdigest(),
                    "url": f"{BASE}/{NAME}.{index:03d}",
                }
                for index, part in enumerate(parts, start=1)
            ]
        }
    return EngineArtifactDescriptor.from_dict(
        {
            "role": "worker",
            "requirementId": "speech-recognition",
            "artifactVersion": RUNTIME_VERSION,
            "workerProtocolVersion": WORKER_PROTOCOL_VERSION,
            "platform": "windows",
            "arch": "x86_64",
            "fileName": NAME,
            "bytes": len(payload),
            "sha256": hashlib.sha256(payload).hexdigest(),
            "extractedBytes": 1,
            "entryPoint": "worker.exe",
            "filesManifestSha256": "0" * 64,
            **source,
        }
    )


def _model(content: bytes, redirect_hosts: list[str] | None = None) -> EngineModelFileDescriptor:
    revision = "a" * 40
    return EngineModelFileDescriptor.from_dict(
        {
            "bytes": len(content),
            "derivation": None,
            "kind": "source",
            "licensePath": "licenses/LICENSE.txt",
            "noticePath": "notices/NOTICE.txt",
            "owner": "test-owner",
            "path": "model/model.bin",
            "redirectHosts": redirect_hosts or [],
            "revision": revision,
            "sha256": hashlib.sha256(content).hexdigest(),
            "spdx": "MIT",
            "url": f"https://models.example.test/{revision}/model.bin",
        }
    )


def _partial(destination: Path) -> tuple[Path, Path]:
    return (
        destination.with_name(destination.name + ".part"),
        destination.with_name(destination.name + ".part.json"),
    )


def _run(downloader, descriptor, destination: Path, **kwargs: object) -> None:
    progress = kwargs.pop("progress", None)
    cancel_event = kwargs.pop("cancel_event", None)
    asyncio.run(
        asyncio.wait_for(
            downloader.download(
                descriptor,
                destination,
                cancel_event=cancel_event or asyncio.Event(),
                progress=progress or (lambda _copied: None),
            ),
            timeout=5,
        )
    )


def _artifact_downloader(handler, **kwargs: object) -> HttpArtifactDownloader:
    return HttpArtifactDownloader(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        **kwargs,  # type: ignore[arg-type]
    )


def test_a_ranged_download_resumes_each_segment_from_its_first_missing_byte(
    tmp_path: Path,
) -> None:
    payload = bytes(range(200))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str] = []
    arrived = [0]
    interrupt = True

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        if byte_range is None:
            raise AssertionError("range download must send Range")
        ranges.append(byte_range)
        start_text, end_text = byte_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        headers = {"content-range": f"bytes {start}-{end}/{len(payload)}"}
        if interrupt and end - start + 1 > 40:
            return httpx.Response(
                206,
                headers=headers,
                stream=_Barrier(payload[start : start + 40], arrived, 2),
                request=request,
            )
        return httpx.Response(
            206,
            headers=headers,
            content=payload[start : end + 1],
            request=request,
        )

    downloader = _artifact_downloader(handler, parallel_min_bytes=1, parallel_segments=2)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination)
    interrupt = False
    resumed = len(ranges)
    _run(downloader, descriptor, destination)

    assert sorted(ranges[resumed:]) == ["bytes=140-199", "bytes=40-99"]
    assert destination.read_bytes() == payload
    assert hashlib.sha256(destination.read_bytes()).hexdigest() == descriptor.sha256
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_a_stream_download_resumes_with_an_open_range(tmp_path: Path) -> None:
    payload = bytes(range(100))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        ranges.append(byte_range)
        if byte_range is None:
            return httpx.Response(200, stream=_Interrupt(payload[:40]), request=request)
        tail = payload[40:]
        return httpx.Response(
            206,
            headers={
                "content-range": f"bytes 40-{len(payload) - 1}/{len(payload)}",
                "content-length": str(len(tail)),
            },
            content=tail,
            request=request,
        )

    downloader = _artifact_downloader(handler)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination)
    _run(downloader, descriptor, destination)

    assert ranges == [None, "bytes=40-"]
    assert destination.read_bytes() == payload
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_a_stream_resume_restarts_when_the_server_ignores_range(tmp_path: Path) -> None:
    payload = bytes(range(100))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        ranges.append(byte_range)
        if byte_range is None:
            return httpx.Response(200, stream=_Interrupt(payload[:40]), request=request)
        if byte_range != "bytes=40-":
            return httpx.Response(400, request=request)
        return httpx.Response(
            200,
            headers={"content-length": str(len(payload))},
            content=payload,
            request=request,
        )

    downloader = _artifact_downloader(handler)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination)
    _run(downloader, descriptor, destination)

    assert ranges == [None, "bytes=40-"]
    assert destination.read_bytes() == payload


def test_a_stream_resume_restarts_when_the_server_answers_another_range(tmp_path: Path) -> None:
    payload = bytes(range(100))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        ranges.append(byte_range)
        if byte_range is not None:
            return httpx.Response(
                206,
                headers={"content-range": f"bytes 0-{len(payload) - 1}/{len(payload)}"},
                content=payload,
                request=request,
            )
        if len(ranges) == 1:
            return httpx.Response(200, stream=_Interrupt(payload[:40]), request=request)
        return httpx.Response(200, content=payload, request=request)

    downloader = _artifact_downloader(handler)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination)
    _run(downloader, descriptor, destination)

    assert ranges == [None, "bytes=40-", None]
    assert destination.read_bytes() == payload


def test_an_unreadable_sidecar_starts_fresh(tmp_path: Path) -> None:
    payload = b"abcdefghijklmnopqrstuvwxyz"
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    part_path, sidecar_path = _partial(destination)
    part_path.write_bytes(b"stale")
    sidecar_path.write_bytes(b"{not json")
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ranges.append(request.headers.get("range"))
        return httpx.Response(200, content=payload, request=request)

    _run(_artifact_downloader(handler), descriptor, destination)

    assert ranges == [None]
    assert destination.read_bytes() == payload
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_the_sidecar_never_names_bytes_that_are_not_on_disk(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = bytes(range(1, 201))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    part_path, _sidecar_path = _partial(destination)
    write_sidecar = download_module._atomic_write
    checked: list[int] = []

    def verified_write(path: Path, data: bytes) -> None:
        on_disk = part_path.read_bytes()
        for segment in json.loads(data)["parts"][0]["segments"]:
            start, received = segment["start"], segment["received"]
            assert on_disk[start : start + received] == payload[start : start + received]
            checked.append(received)
        write_sidecar(path, data)

    monkeypatch.setattr(download_module, "_CHECKPOINT_BYTES", 10)
    monkeypatch.setattr(download_module, "_atomic_write", verified_write)

    def handler(request: httpx.Request) -> httpx.Response:
        start_text, end_text = request.headers["range"].removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        # Segments arrive in different chunk sizes, so one checkpoints while
        # the other still holds bytes that are not flushed.
        return httpx.Response(
            206,
            headers={"content-range": f"bytes {start}-{end}/{len(payload)}"},
            stream=_Chunks(payload[start : end + 1], 10 if start == 0 else 3),
            request=request,
        )

    _run(
        _artifact_downloader(handler, parallel_min_bytes=1, parallel_segments=2),
        descriptor,
        destination,
    )

    assert destination.read_bytes() == payload
    assert max(checked) == 100


def test_a_sidecar_for_a_different_artifact_is_discarded(tmp_path: Path) -> None:
    payload = b"abcdefghijklmnopqrstuvwxyz"
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    part_path, sidecar_path = _partial(destination)
    part_path.write_bytes(b"not-the-download")
    wrong = "ab" * 32
    sidecar_path.write_text(
        json.dumps(
            {
                "bytes": len(payload),
                "parts": [
                    {
                        "bytes": len(payload),
                        "complete": False,
                        "offset": 0,
                        "ranged": False,
                        "segments": [{"end": len(payload) - 1, "received": 16, "start": 0}],
                        "sha256": wrong,
                    }
                ],
                "preallocated": False,
                "sha256": wrong,
                "version": 1,
            }
        ),
        encoding="utf-8",
    )
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        ranges.append(byte_range)
        if byte_range is not None:
            return httpx.Response(400, request=request)
        return httpx.Response(200, content=payload, request=request)

    _run(_artifact_downloader(handler), descriptor, destination)

    assert ranges == [None]
    assert destination.read_bytes() == payload
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_a_resumed_download_with_a_bad_checksum_removes_the_partial(tmp_path: Path) -> None:
    payload = bytes(range(100))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        ranges.append(byte_range)
        if byte_range is None:
            return httpx.Response(200, stream=_Interrupt(payload[:40]), request=request)
        tail = b"\x00" * (len(payload) - 40)
        return httpx.Response(
            206,
            headers={
                "content-range": f"bytes 40-{len(payload) - 1}/{len(payload)}",
                "content-length": str(len(tail)),
            },
            content=tail,
            request=request,
        )

    downloader = _artifact_downloader(handler)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination)
    with pytest.raises(EngineInstallationError, match="checksum"):
        _run(downloader, descriptor, destination)

    part_path, sidecar_path = _partial(destination)
    assert ranges == [None, "bytes=40-"]
    assert not destination.exists()
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_cancellation_keeps_the_partial_and_sidecar(tmp_path: Path) -> None:
    payload = b"partial-download-bytes"
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    cancel = asyncio.Event()

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=_Once(payload), request=request)

    def stop(_copied: int) -> None:
        cancel.set()

    with pytest.raises(asyncio.CancelledError):
        _run(
            _artifact_downloader(handler),
            descriptor,
            destination,
            progress=stop,
            cancel_event=cancel,
        )

    part_path, sidecar_path = _partial(destination)
    record = json.loads(sidecar_path.read_text(encoding="utf-8"))
    assert not destination.exists()
    assert part_path.is_file() and part_path.stat().st_size > 0
    assert record["sha256"] == descriptor.sha256
    assert record["bytes"] == descriptor.bytes
    assert record["parts"][0]["segments"][0]["received"] > 0


def test_progress_does_not_decrease_across_a_resume(tmp_path: Path) -> None:
    payload = bytes(range(100))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    reported: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.headers.get("range") is None:
            return httpx.Response(200, stream=_Interrupt(payload[:40]), request=request)
        tail = payload[40:]
        return httpx.Response(
            206,
            headers={"content-range": f"bytes 40-{len(payload) - 1}/{len(payload)}"},
            content=tail,
            request=request,
        )

    downloader = _artifact_downloader(handler)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination, progress=reported.append)
    _run(downloader, descriptor, destination, progress=reported.append)

    assert reported == sorted(reported)
    assert reported[0] < len(payload)
    assert reported[-1] == len(payload)


def test_a_direct_model_retry_resumes_the_partial_file(tmp_path: Path) -> None:
    content = b"m" * 100
    descriptor = _model(content, redirect_hosts=["cdn.example.test"])
    destination = tmp_path / "model.bin"
    seen: list[tuple[str, str | None, str | None]] = []
    reported: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(
            (
                request.url.host,
                request.headers.get("range"),
                request.headers.get("accept-encoding"),
            )
        )
        assert "authorization" not in request.headers
        if request.url.host == "models.example.test":
            return httpx.Response(
                302,
                headers={"location": "https://cdn.example.test/signed/model.bin?signature=locked"},
                request=request,
            )
        if request.headers.get("range") is None:
            return httpx.Response(200, stream=_Interrupt(content[:40]), request=request)
        if request.headers.get("range") != "bytes=40-":
            return httpx.Response(400, request=request)
        tail = content[40:]
        return httpx.Response(
            206,
            headers={
                "content-range": f"bytes 40-{len(content) - 1}/{len(content)}",
                "content-length": str(len(tail)),
            },
            content=tail,
            request=request,
        )

    downloader = HttpModelFileDownloader(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True),
        retry_delays=(0, 0),
    )
    _run(downloader, descriptor, destination, progress=reported.append)

    assert seen == [
        ("models.example.test", None, "identity"),
        ("cdn.example.test", None, "identity"),
        ("models.example.test", "bytes=40-", "identity"),
        ("cdn.example.test", "bytes=40-", "identity"),
    ]
    assert destination.read_bytes() == content
    assert reported == sorted(reported)
    assert reported[-1] == len(content)
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_a_finished_part_is_not_downloaded_again(tmp_path: Path) -> None:
    whole = bytes(index % 256 for index in range(300))
    pieces = [whole[:150], whole[150:]]
    descriptor = _artifact(whole, parts=pieces)
    destination = tmp_path / "download.zip"
    requested: list[tuple[str, str | None]] = []
    failed = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal failed
        name = request.url.path.rsplit("/", 1)[-1]
        byte_range = request.headers.get("range")
        requested.append((name, byte_range))
        content = pieces[0] if name.endswith(".001") else pieces[1]
        if name.endswith(".002") and byte_range is None and not failed:
            failed = True
            return httpx.Response(200, stream=_Interrupt(content[:30]), request=request)
        if byte_range is None:
            return httpx.Response(200, content=content, request=request)
        start = int(byte_range.removeprefix("bytes=").split("-", 1)[0])
        end = len(content) - 1
        return httpx.Response(
            206,
            headers={"content-range": f"bytes {start}-{end}/{len(content)}"},
            content=content[start:],
            request=request,
        )

    downloader = _artifact_downloader(handler)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination)
    started = len(requested)
    _run(downloader, descriptor, destination)

    assert requested[started:] == [(f"{NAME}.002", "bytes=30-")]
    assert destination.read_bytes() == whole
