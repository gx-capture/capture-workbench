"""Partial engine downloads resume from the bytes already on disk."""

from __future__ import annotations

import asyncio
import errno
import hashlib
import json
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from itertools import pairwise
from pathlib import Path
from typing import BinaryIO

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
    # One attempt, so a test can observe the interrupted partial. Production
    # uses the default outage wait; tests that exercise it pass `retry`.
    kwargs.setdefault("retry", download_module.NetworkOutageRetry(()))
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


def test_a_ranged_download_retries_each_segment_from_its_first_missing_byte(
    tmp_path: Path,
) -> None:
    payload = bytes(range(200))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str] = []
    arrived = [0]

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers["range"]
        ranges.append(byte_range)
        start_text, end_text = byte_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        headers = {"content-range": f"bytes {start}-{end}/{len(payload)}"}
        if arrived[0] < 2 and end - start + 1 > 40:
            return httpx.Response(
                206,
                headers=headers,
                stream=_Barrier(payload[start : start + 40], arrived, 2),
                request=request,
            )
        return httpx.Response(
            206, headers=headers, content=payload[start : end + 1], request=request
        )

    downloader = _artifact_downloader(
        handler, parallel_min_bytes=1, parallel_segments=2, retry=_outage(0)
    )
    _run(downloader, descriptor, destination)

    assert ranges[0] == "bytes=0-0"
    assert sorted(ranges[1:3]) == ["bytes=0-99", "bytes=100-199"]
    # One download call: the retry continues both segments without probing again.
    assert sorted(ranges[3:]) == ["bytes=140-199", "bytes=40-99"]
    assert destination.read_bytes() == payload
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


@pytest.mark.parametrize("status", [404, 503])
def test_a_failed_range_probe_is_not_taken_for_a_server_without_ranges(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, status: int
) -> None:
    """A 404 fails at once; a 503 waits, probes again, and then uses ranges."""

    payload = bytes(range(200))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    events: list[str] = []
    original_pause = download_module._pause_for_network_outage

    async def pause(seconds: float, cancel_event: asyncio.Event) -> None:
        events.append("wait")
        await original_pause(seconds, cancel_event)

    monkeypatch.setattr(download_module, "_pause_for_network_outage", pause)

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        events.append(f"GET {byte_range}")
        if byte_range == "bytes=0-0" and events.count("GET bytes=0-0") == 1:
            return httpx.Response(status, request=request)
        assert byte_range is not None, "a failed probe must not select the single stream"
        start_text, end_text = byte_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        return httpx.Response(
            206,
            headers={"content-range": f"bytes {start}-{end}/{len(payload)}"},
            content=payload[start : end + 1],
            request=request,
        )

    downloader = _artifact_downloader(
        handler, parallel_min_bytes=1, parallel_segments=2, retry=_outage(0, 0, 0)
    )
    if status == 404:
        with pytest.raises(httpx.HTTPStatusError):
            _run(downloader, descriptor, destination)
        assert events == ["GET bytes=0-0"]
        assert not destination.exists()
        return
    _run(downloader, descriptor, destination)

    assert events[:3] == ["GET bytes=0-0", "wait", "GET bytes=0-0"]
    assert sorted(events[3:]) == ["GET bytes=0-99", "GET bytes=100-199"]
    assert destination.read_bytes() == payload


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
        retry=download_module.NetworkOutageRetry((0,)),
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


class _HeldFlushWriter:
    """The partial's writer, with a hook run before each flush."""

    def __init__(self, handle: BinaryIO, before_flush: Callable[[], None]) -> None:
        self._handle = handle
        self._before_flush = before_flush

    def write(self, data: bytes) -> int:
        return self._handle.write(data)

    def flush(self) -> None:
        self._before_flush()
        self._handle.flush()

    def fileno(self) -> int:
        return self._handle.fileno()


_FlushHold = Callable[[int, "asyncio.Task[object] | None"], Callable[[], None] | None]


def _hold_partial_flushes(monkeypatch: pytest.MonkeyPatch, hold: _FlushHold) -> None:
    """Wrap each partial writer; `hold(position, opening_task)` may return a flush hook."""

    original = download_module._open_part

    @contextmanager
    def open_part(plan: object, position: int) -> Iterator[object]:
        with original(plan, position) as handle:  # type: ignore[arg-type]
            hook = hold(position, asyncio.current_task())
            yield handle if hook is None else _HeldFlushWriter(handle, hook)

    monkeypatch.setattr(download_module, "_open_part", open_part)


def _wait_until_cancelled(task: asyncio.Task[object] | None) -> bool:
    """From a worker thread, wait for a cancel request to reach the task."""

    assert task is not None
    for _ in range(500):
        if task.cancelling():
            return True
        threading.Event().wait(0.01)
    return False


@pytest.mark.parametrize("step", ["allocate", "flush"])
def test_the_event_loop_keeps_answering_while_a_download_preallocates_or_checkpoints(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    """Preallocating a multi-GB archive or fsyncing it must leave the event loop free.

    A published-parts worker is preallocated in full before its first byte
    arrives; on the event loop that held a readiness query for 31 s.
    """

    whole = bytes(index % 256 for index in range(300))
    pieces = [whole[:150], whole[150:]]
    descriptor = _artifact(whole, parts=pieces)
    destination = tmp_path / "download.zip"

    def handler(request: httpx.Request) -> httpx.Response:
        name = request.url.path.rsplit("/", 1)[-1]
        return httpx.Response(
            200, content=pieces[0] if name.endswith(".001") else pieces[1], request=request
        )

    release = threading.Event()
    held: list[bool] = []
    loop_blocked: list[str] = []

    async def scenario() -> None:
        started = asyncio.Event()
        loop = asyncio.get_running_loop()

        def hold_first_time() -> None:
            if not held:
                held.append(True)
                loop.call_soon_threadsafe(started.set)
                # On the event loop nothing can release it: record that and go on.
                if not release.wait(timeout=5):
                    loop_blocked.append(f"the {step} held the event loop")

        if step == "allocate":
            original = download_module._allocate

            def allocate(path: Path, size: int) -> None:
                hold_first_time()
                original(path, size)

            monkeypatch.setattr(download_module, "_allocate", allocate)
        else:
            _hold_partial_flushes(monkeypatch, lambda _position, _task: hold_first_time)
        download = asyncio.create_task(
            _artifact_downloader(handler).download(
                descriptor,
                destination,
                cancel_event=asyncio.Event(),
                progress=lambda _copied: None,
            )
        )
        try:
            await asyncio.wait_for(started.wait(), 10)
            assert not loop_blocked, loop_blocked[0]
            assert not download.done()
            release.set()
            await asyncio.wait_for(download, 5)
        finally:
            release.set()

    asyncio.run(scenario())
    assert destination.read_bytes() == whole


def test_a_cancel_during_the_final_flush_records_the_flushed_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The retry resumes after every byte the cancelled attempt flushed."""

    payload = bytes(range(100))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers.get("range")
        ranges.append(byte_range)
        if byte_range is None and len(ranges) == 1:
            # Ends after 40 bytes: the final checkpoint of the attempt follows.
            return httpx.Response(200, stream=_Once(payload[:40]), request=request)
        if byte_range is None:
            return httpx.Response(200, content=payload, request=request)
        start = int(byte_range.removeprefix("bytes=").split("-", 1)[0])
        return httpx.Response(
            206,
            headers={"content-range": f"bytes {start}-{len(payload) - 1}/{len(payload)}"},
            content=payload[start:],
            request=request,
        )

    async def cancelled_attempt() -> None:
        flushing = asyncio.Event()
        loop = asyncio.get_running_loop()
        cancel_seen: list[bool] = []

        def hold(_position: int, task: asyncio.Task[object] | None) -> Callable[[], None]:
            def wait_for_cancel() -> None:
                if not cancel_seen:
                    loop.call_soon_threadsafe(flushing.set)
                    cancel_seen.append(_wait_until_cancelled(task))

            return wait_for_cancel

        _hold_partial_flushes(monkeypatch, hold)
        download = asyncio.create_task(
            _artifact_downloader(handler).download(
                descriptor,
                destination,
                cancel_event=asyncio.Event(),
                progress=lambda _copied: None,
            )
        )
        await asyncio.wait_for(flushing.wait(), 5)
        download.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(download, 10)
        assert cancel_seen == [True], "the flush held the event loop"

    asyncio.run(cancelled_attempt())
    monkeypatch.undo()
    _run(_artifact_downloader(handler), descriptor, destination)

    assert ranges == [None, "bytes=40-"]
    assert destination.read_bytes() == payload


def test_a_failed_range_cancelling_a_sibling_mid_flush_keeps_the_sibling_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A sibling cancelled during its final checkpoint is not fetched again."""

    payload = bytes(index % 256 for index in range(200))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    ranges: list[str] = []

    def served(byte_range: str, stream: httpx.AsyncByteStream | None = None) -> httpx.Response:
        start_text, end_text = byte_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        headers = {"content-range": f"bytes {start}-{end}/{len(payload)}"}
        if stream is not None:
            return httpx.Response(206, headers=headers, stream=stream)
        return httpx.Response(206, headers=headers, content=payload[start : end + 1])

    async def failed_attempt() -> None:
        loop = asyncio.get_running_loop()
        sibling_flushing = asyncio.Event()
        cancel_seen: list[bool] = []

        class _FailAfterSibling(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield payload[:40]
                await asyncio.wait_for(sibling_flushing.wait(), 5)
                raise httpx.ReadError("interrupted")

            async def aclose(self) -> None:
                return None

        def handler(request: httpx.Request) -> httpx.Response:
            byte_range = request.headers["range"]
            if byte_range == "bytes=0-0":
                return served(byte_range)
            ranges.append(byte_range)
            if byte_range.startswith("bytes=0-"):
                return served(byte_range, _FailAfterSibling())
            return served(byte_range)

        def hold(position: int, task: asyncio.Task[object] | None) -> Callable[[], None] | None:
            if position != 100:
                return None

            def wait_for_cancel() -> None:
                if not cancel_seen:
                    loop.call_soon_threadsafe(sibling_flushing.set)
                    cancel_seen.append(_wait_until_cancelled(task))

            return wait_for_cancel

        _hold_partial_flushes(monkeypatch, hold)
        downloader = _artifact_downloader(handler, parallel_min_bytes=1, parallel_segments=2)
        with pytest.raises(httpx.ReadError):
            await asyncio.wait_for(
                downloader.download(
                    descriptor,
                    destination,
                    cancel_event=asyncio.Event(),
                    progress=lambda _copied: None,
                ),
                10,
            )
        assert cancel_seen == [True], "the sibling's flush held the event loop"

    asyncio.run(failed_attempt())
    monkeypatch.undo()
    resumed = len(ranges)

    def retry_handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers["range"]
        if byte_range != "bytes=0-0":
            ranges.append(byte_range)
        return served(byte_range)

    _run(
        _artifact_downloader(retry_handler, parallel_min_bytes=1, parallel_segments=2),
        descriptor,
        destination,
    )

    assert ranges[resumed:] == ["bytes=40-99"]
    assert destination.read_bytes() == payload


@pytest.mark.parametrize("failures", [1, 100])
def test_progress_write_failure_does_not_fail_verified_download(tmp_path, monkeypatch, failures):
    payload = b"verified bytes" * 10
    destination = tmp_path / "download.zip"
    original = download_module._atomic_write
    writes = []
    successful = []

    def write(path, data):
        writes.append(data)
        if len(writes) <= failures:
            raise PermissionError("progress unavailable")
        original(path, data)
        successful.append(json.loads(data))

    monkeypatch.setattr(download_module, "_atomic_write", write)
    monkeypatch.setattr(download_module, "_CHECKPOINT_BYTES", 1)
    downloader = _artifact_downloader(
        lambda request: httpx.Response(200, stream=_Chunks(payload, 10))
    )
    _run(downloader, _artifact(payload), destination)
    assert destination.read_bytes() == payload
    assert len(writes) > 1
    if failures == 1:
        assert successful[0]["parts"][0]["segments"][0]["received"] == 20


def test_stale_progress_redownloads_unrecorded_bytes(tmp_path, monkeypatch):
    payload = b"abcdefghijklmnopqrst"
    destination = tmp_path / "download.zip"
    original = download_module._atomic_write
    writes = []
    ranges = []

    def write(path, data):
        writes.append(data)
        if len(writes) > 1:
            raise PermissionError("stale progress")
        original(path, data)

    monkeypatch.setattr(download_module, "_atomic_write", write)
    monkeypatch.setattr(download_module, "_CHECKPOINT_BYTES", 1)

    class Interrupted(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield payload[:5]
            yield payload[5:10]
            raise httpx.ReadError("interrupted")

    _downloader = _artifact_downloader(lambda request: httpx.Response(200, stream=Interrupted()))
    with pytest.raises(httpx.ReadError):
        _run(_downloader, _artifact(payload), destination)
    partial, sidecar = _partial(destination)
    assert partial.read_bytes() == payload[:10]
    assert json.loads(sidecar.read_bytes())["parts"][0]["segments"][0]["received"] == 5
    # Corrupt the unrecorded tail: resume must overwrite it rather than trust it.
    partial.write_bytes(payload[:5] + b"WRONG")
    monkeypatch.setattr(download_module, "_atomic_write", original)

    def handler(request):
        ranges.append(request.headers.get("range"))
        return httpx.Response(206, headers={"content-range": "bytes 5-19/20"}, content=payload[5:])

    _run(_artifact_downloader(handler), _artifact(payload), destination)
    assert ranges == ["bytes=5-"]
    assert destination.read_bytes() == payload


@pytest.mark.parametrize("persistent", [False, True])
def test_finished_partial_replacement_retries(tmp_path, monkeypatch, persistent):
    from capture_runtime import file_lock
    from capture_runtime.provisioning.application.installation_service import (
        installation_failure_code,
    )

    payload = b"verified"
    destination = tmp_path / "download.zip"
    original = file_lock.os.replace
    calls = []
    error = PermissionError(5, "sharing violation")
    error.winerror = 32

    def replace(source, target):
        if target == destination:
            calls.append(target)
            if persistent or len(calls) == 1:
                raise error
        original(source, target)

    monkeypatch.setattr(file_lock.sys, "platform", "win32")
    monkeypatch.setattr(file_lock.os, "replace", replace)
    downloader = _artifact_downloader(lambda request: httpx.Response(200, content=payload))
    if persistent:
        with pytest.raises(PermissionError) as caught:
            _run(downloader, _artifact(payload), destination)
        assert caught.value is error
        assert installation_failure_code(caught.value) == "installation_io_failed"
        assert len(calls) == 8
    else:
        _run(downloader, _artifact(payload), destination)
        assert destination.read_bytes() == payload
        assert len(calls) == 2


def test_stale_ranged_progress_overwrites_unrecorded_preallocated_bytes(tmp_path, monkeypatch):
    payload = bytes(range(200))
    descriptor = _artifact(payload)
    destination = tmp_path / "download.zip"
    original = download_module._atomic_write
    retained = []
    ranges = []
    arrived = [0]
    interrupt = True

    def write(path, data):
        if retained:
            raise PermissionError("progress locked")
        original(path, data)
        parsed = json.loads(data)
        if any(segment["received"] for segment in parsed["parts"][0]["segments"]):
            retained.append(parsed)

    def handler(request):
        byte_range = request.headers["range"]
        ranges.append(byte_range)
        start_text, end_text = byte_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        headers = {"content-range": f"bytes {start}-{end}/{len(payload)}"}
        if interrupt and end - start + 1 > 40:
            return httpx.Response(
                206, headers=headers, stream=_Barrier(payload[start : start + 40], arrived, 2)
            )
        return httpx.Response(206, headers=headers, content=payload[start : end + 1])

    monkeypatch.setattr(download_module, "_atomic_write", write)
    downloader = _artifact_downloader(handler, parallel_min_bytes=1, parallel_segments=2)
    with pytest.raises(httpx.ReadError):
        _run(downloader, descriptor, destination)
    partial, sidecar = _partial(destination)
    assert partial.stat().st_size == len(payload)
    recorded = json.loads(sidecar.read_bytes())["parts"][0]["segments"]
    assert sum(segment["received"] for segment in recorded) < 80
    with partial.open("r+b") as writer:
        for segment in recorded:
            start = segment["start"] + segment["received"]
            writer.seek(start)
            writer.write(b"?" * (segment["end"] - start + 1))
    expected = [
        f"bytes={segment['start'] + segment['received']}-{segment['end']}" for segment in recorded
    ]
    interrupt = False
    resumed = len(ranges)
    monkeypatch.setattr(download_module, "_atomic_write", original)
    _run(downloader, descriptor, destination)
    assert sorted(ranges[resumed:]) == sorted(expected)
    assert destination.read_bytes() == payload


def test_progress_atomic_write_removes_temporary_on_failure(tmp_path, monkeypatch):
    path = tmp_path / "progress.json"
    path.write_bytes(b"old")

    def replace(source, target):
        raise OSError("persistent failure")

    monkeypatch.setattr(download_module, "replace_with_retry", replace)
    with pytest.raises(OSError, match="persistent failure"):
        download_module._atomic_write(path, b"new")
    assert path.read_bytes() == b"old"
    assert list(tmp_path.iterdir()) == [path]


@pytest.mark.parametrize("removal_fails", [False, True])
def test_rewind_invalidates_stale_progress_or_fails_before_rewriting(
    tmp_path, monkeypatch, removal_fails
):
    payload = b"abcdefghijklmnopqrst"
    destination = tmp_path / "download.zip"
    descriptor = _artifact(payload)
    first = _artifact_downloader(
        lambda request: httpx.Response(200, stream=_Interrupt(payload[:5]))
    )
    with pytest.raises(httpx.ReadError):
        _run(first, descriptor, destination)
    partial, sidecar = _partial(destination)
    old_progress = sidecar.read_bytes()
    original_write = download_module._atomic_write
    original_unlink = Path.unlink

    def write(path, data):
        raise OSError("progress write failed")

    def unlink(path, *args, **kwargs):
        if path == sidecar and removal_fails:
            raise PermissionError("progress removal failed")
        original_unlink(path, *args, **kwargs)

    requested = []

    def ignore_range(request):
        requested.append(request.headers.get("range"))
        assert request.headers["range"] == "bytes=5-"
        return httpx.Response(200, stream=_Interrupt(payload[:3]))

    monkeypatch.setattr(download_module, "_atomic_write", write)
    monkeypatch.setattr(Path, "unlink", unlink)
    if removal_fails:
        # With the outage wait on: a local failure ends the download at once,
        # before a retry could write over bytes the old record still names.
        downloader = _artifact_downloader(ignore_range, retry=_outage(0, 0, 0))
        with pytest.raises(PermissionError, match="progress removal failed"):
            _run(downloader, descriptor, destination)
        assert requested == ["bytes=5-"]
        assert sidecar.read_bytes() == old_progress
        assert partial.read_bytes() == payload[:5]
    else:
        with pytest.raises(httpx.ReadError):
            _run(_artifact_downloader(ignore_range), descriptor, destination)
        assert not sidecar.exists()
        assert partial.read_bytes() == payload[:3]
        monkeypatch.setattr(download_module, "_atomic_write", original_write)
        requests = []

        def restart(request):
            requests.append(request.headers.get("range"))
            return httpx.Response(200, content=payload)

        _run(_artifact_downloader(restart), descriptor, destination)
        assert requests == [None]
        assert destination.read_bytes() == payload


def _range_start(request: httpx.Request) -> int:
    byte_range = request.headers.get("range")
    if byte_range is None:
        return 0
    return int(byte_range.removeprefix("bytes=").split("-", 1)[0])


def _served(payload: bytes, request: httpx.Request, *, deliver: int | None) -> httpx.Response:
    """Serve `payload` from the request's Range, or `deliver` bytes and then drop."""

    start = _range_start(request)
    if deliver is None:
        body = payload[start:]
        if start == 0:
            return httpx.Response(200, content=body, request=request)
        return httpx.Response(
            206,
            headers={
                "content-range": f"bytes {start}-{len(payload) - 1}/{len(payload)}",
                "content-length": str(len(body)),
            },
            content=body,
            request=request,
        )
    chunk = payload[start : start + deliver]
    if start == 0:
        return httpx.Response(200, stream=_Interrupt(chunk), request=request)
    return httpx.Response(
        206,
        headers={"content-range": f"bytes {start}-{len(payload) - 1}/{len(payload)}"},
        stream=_Interrupt(chunk),
        request=request,
    )


def _outage(*waits: float) -> download_module.NetworkOutageRetry:
    return download_module.NetworkOutageRetry(waits)


def _kind_downloader(kind: str, handler, retry: download_module.NetworkOutageRetry):
    if kind == "archive":
        return _artifact_downloader(handler, retry=retry)
    return HttpModelFileDownloader(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        retry=retry,
    )


def _kind_descriptor(kind: str, payload: bytes):
    if kind == "archive":
        return _artifact(payload)
    return _model(payload)


def test_the_default_network_outage_wait_is_about_a_minute() -> None:
    waits = download_module.NetworkOutageRetry().backoff_seconds
    assert 60 <= sum(waits) <= 90
    assert all(later == earlier * 2 for earlier, later in pairwise(waits))


def test_a_worker_archive_resumes_after_the_connection_drops(tmp_path: Path) -> None:
    payload = bytes(range(80))
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []
    drops_remaining = 3

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal drops_remaining
        ranges.append(request.headers.get("range"))
        if drops_remaining:
            drops_remaining -= 1
            return _served(payload, request, deliver=10)
        return _served(payload, request, deliver=None)

    _run(
        _artifact_downloader(handler, retry=_outage(0, 0, 0)),
        _artifact(payload),
        destination,
    )

    assert destination.read_bytes() == payload
    assert ranges == [None, "bytes=10-", "bytes=20-", "bytes=30-"]
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_a_parted_worker_archive_resumes_after_the_connection_drops(tmp_path: Path) -> None:
    whole = bytes(range(90))
    pieces = [whole[:40], whole[40:]]
    destination = tmp_path / "download.zip"
    requested: list[tuple[str, str | None]] = []
    drops_remaining = 2

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal drops_remaining
        name = request.url.path.rsplit("/", 1)[-1]
        requested.append((name, request.headers.get("range")))
        content = pieces[0] if name.endswith(".001") else pieces[1]
        if name.endswith(".002") and drops_remaining:
            drops_remaining -= 1
            return _served(content, request, deliver=12)
        return _served(content, request, deliver=None)

    _run(
        _artifact_downloader(handler, retry=_outage(0, 0)),
        _artifact(whole, parts=pieces),
        destination,
    )

    assert destination.read_bytes() == whole
    assert [item for item in requested if item[0].endswith(".001")] == [(f"{NAME}.001", None)]
    second = [item for item in requested if item[0].endswith(".002")]
    assert second == [
        (f"{NAME}.002", None),
        (f"{NAME}.002", "bytes=12-"),
        (f"{NAME}.002", "bytes=24-"),
    ]
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_a_model_file_resumes_after_the_connection_drops(tmp_path: Path) -> None:
    content = b"m" * 70
    destination = tmp_path / "model.bin"
    ranges: list[str | None] = []
    drops_remaining = 3

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal drops_remaining
        ranges.append(request.headers.get("range"))
        if drops_remaining:
            drops_remaining -= 1
            return _served(content, request, deliver=10)
        return _served(content, request, deliver=None)

    _run(
        HttpModelFileDownloader(
            lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
            retry=_outage(0, 0, 0),
        ),
        _model(content),
        destination,
    )

    assert destination.read_bytes() == content
    assert ranges == [None, "bytes=10-", "bytes=20-", "bytes=30-"]
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_bytes_already_received_restart_the_outage_wait(tmp_path: Path) -> None:
    """One wait is the whole budget for a stretch that stores nothing.

    Each dropped attempt stores new bytes, so the download still finishes.
    """

    payload = bytes(range(50))
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []
    drops_remaining = 4

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal drops_remaining
        ranges.append(request.headers.get("range"))
        if drops_remaining:
            drops_remaining -= 1
            return _served(payload, request, deliver=10)
        return _served(payload, request, deliver=None)

    _run(
        _artifact_downloader(handler, retry=_outage(0)),
        _artifact(payload),
        destination,
    )

    # Each attempt continues where the last one stopped; a restart from byte 0
    # would store nothing new and use up the single wait.
    assert ranges == [None, "bytes=10-", "bytes=20-", "bytes=30-", "bytes=40-"]
    assert destination.read_bytes() == payload


def test_a_server_that_rewinds_to_shorter_bodies_does_not_restart_the_outage_wait(
    tmp_path: Path,
) -> None:
    """Refilling bytes held before is not progress, so the wait still runs out.

    The server ignores Range and answers each attempt from byte 0, alternating
    10 and 2 bytes before it drops. Every 10-byte attempt grows the partial
    from 2 to 10, but never past the 10 bytes it already held once.
    """

    payload = bytes(range(60))
    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ranges.append(request.headers.get("range"))
        deliver = 10 if len(ranges) % 2 else 2
        return httpx.Response(200, stream=_Interrupt(payload[:deliver]), request=request)

    with pytest.raises(download_module.NetworkOutageExceeded):
        _run(
            _artifact_downloader(handler, retry=_outage(0, 0, 0)),
            _artifact(payload),
            destination,
        )

    # The first attempt stores bytes; three waits and the attempt that finds
    # the budget used up are four more.
    assert ranges == [None, "bytes=10-", "bytes=2-", "bytes=10-", "bytes=2-"]


@pytest.mark.parametrize("kind", ["archive", "model"])
def test_a_network_outage_that_does_not_recover_is_installation_io_failed(
    tmp_path: Path, kind: str
) -> None:
    from capture_runtime.provisioning.application.installation_service import (
        installation_failure_code,
    )

    payload = bytes(range(60))
    destination = tmp_path / ("download.zip" if kind == "archive" else "model.bin")
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ranges.append(request.headers.get("range"))
        if request.headers.get("range") is None:
            return _served(payload, request, deliver=20)
        return _served(payload, request, deliver=0)

    downloader = _kind_downloader(kind, handler, _outage(0, 0, 0))
    descriptor = _kind_descriptor(kind, payload)
    with pytest.raises(OSError) as caught:
        _run(downloader, descriptor, destination)

    assert installation_failure_code(caught.value) == "installation_io_failed"
    assert not isinstance(caught.value, TimeoutError)
    # The first attempt stores bytes and restarts the wait. Three waits and the
    # attempt that finds the budget used up are four more requests.
    assert ranges == [None, "bytes=20-", "bytes=20-", "bytes=20-", "bytes=20-"]
    part_path, sidecar_path = _partial(destination)
    assert part_path.read_bytes() == payload[:20]
    saved = json.loads(sidecar_path.read_text(encoding="utf-8"))
    assert saved["parts"][0]["segments"][0]["received"] == 20

    resumed: list[str | None] = []

    def finish(request: httpx.Request) -> httpx.Response:
        resumed.append(request.headers.get("range"))
        return _served(payload, request, deliver=None)

    _run(_kind_downloader(kind, finish, _outage()), descriptor, destination)
    assert resumed == ["bytes=20-"]
    assert destination.read_bytes() == payload


@pytest.mark.parametrize("kind", ["archive", "model"])
def test_a_missing_download_is_not_retried(tmp_path: Path, kind: str) -> None:
    payload = b"missing"
    destination = tmp_path / ("download.zip" if kind == "archive" else "model.bin")
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(404, request=request)

    downloader = _kind_downloader(kind, handler, _outage(0, 0, 0))
    if kind == "model":
        with pytest.raises(EngineInstallationError, match="non-retryable"):
            _run(downloader, _kind_descriptor(kind, payload), destination)
    else:
        with pytest.raises(httpx.HTTPStatusError):
            _run(downloader, _kind_descriptor(kind, payload), destination)
    assert calls == 1
    part_path, sidecar_path = _partial(destination)
    assert not destination.exists()
    assert not part_path.exists()
    assert not sidecar_path.exists()


@pytest.mark.parametrize("kind", ["archive", "model"])
@pytest.mark.parametrize("status", [408, 429, 503])
def test_a_transient_http_status_is_retried_until_the_bytes_match(
    tmp_path: Path, kind: str, status: int
) -> None:
    payload = b"recovered-after-status"
    destination = tmp_path / ("download.zip" if kind == "archive" else "model.bin")
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(status, request=request)
        return httpx.Response(200, content=payload, request=request)

    _run(
        _kind_downloader(kind, handler, _outage(0)),
        _kind_descriptor(kind, payload),
        destination,
    )
    assert calls == 2
    assert destination.read_bytes() == payload


def test_a_checksum_mismatch_is_not_retried(tmp_path: Path) -> None:
    payload = b"abcdefghijklmnopqrstuvwxyz"
    destination = tmp_path / "download.zip"
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, content=b"x" * len(payload), request=request)

    with pytest.raises(EngineInstallationError, match="checksum"):
        _run(
            _artifact_downloader(handler, retry=_outage(0, 0, 0)),
            _artifact(payload),
            destination,
        )
    assert calls == 1
    assert not destination.exists()


class _FailingWriter:
    """The partial's writer, failing every write with the given local error."""

    def __init__(self, handle: BinaryIO, error: OSError) -> None:
        self._handle = handle
        self._error = error

    def write(self, data: bytes) -> int:
        raise self._error

    def flush(self) -> None:
        self._handle.flush()

    def fileno(self) -> int:
        return self._handle.fileno()


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (OSError(errno.ENOSPC, "No space left on device"), "installation_io_failed"),
        (PermissionError(errno.EACCES, "Access is denied"), "installation_io_failed"),
        (TimeoutError("local disk timed out"), "installation_timeout"),
    ],
)
@pytest.mark.parametrize("kind", ["archive", "model"])
def test_a_local_file_failure_ends_the_download_at_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str, error: OSError, code: str
) -> None:
    from capture_runtime.provisioning.application.installation_service import (
        installation_failure_code,
    )

    payload = bytes(range(40))
    destination = tmp_path / ("download.zip" if kind == "archive" else "model.bin")
    calls = 0
    original = download_module._open_part

    @contextmanager
    def open_part(plan: object, position: int) -> Iterator[object]:
        with original(plan, position) as handle:  # type: ignore[arg-type]
            yield _FailingWriter(handle, error)

    monkeypatch.setattr(download_module, "_open_part", open_part)

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, content=payload, request=request)

    with pytest.raises(OSError) as caught:
        _run(
            _kind_downloader(kind, handler, _outage(0, 0, 0)),
            _kind_descriptor(kind, payload),
            destination,
        )

    assert caught.value is error
    assert installation_failure_code(caught.value) == code
    assert calls == 1


class _BareOSErrorBody(httpx.AsyncByteStream):
    """A body that delivers some bytes, then fails as Windows can: a bare OSError."""

    def __init__(self, chunk: bytes, *, on_close: bool = False) -> None:
        self._chunk = chunk
        self._on_close = on_close

    async def __aiter__(self):
        yield self._chunk
        if not self._on_close:
            raise OSError("connection aborted by the operating system")

    async def aclose(self) -> None:
        if self._on_close:
            raise OSError("connection aborted while closing")


@pytest.mark.parametrize("where", ["request", "body", "close"])
@pytest.mark.parametrize("kind", ["archive", "model"])
def test_an_os_error_of_the_http_layer_is_retried_as_a_transport_failure(
    tmp_path: Path, kind: str, where: str
) -> None:
    payload = bytes(range(60))
    destination = tmp_path / ("download.zip" if kind == "archive" else "model.bin")
    ranges: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        ranges.append(request.headers.get("range"))
        if len(ranges) == 1:
            if where == "request":
                raise ConnectionAbortedError("connection aborted while sending")
            if where == "body":
                return httpx.Response(200, stream=_BareOSErrorBody(payload[:20]), request=request)
            return httpx.Response(200, stream=_BareOSErrorBody(payload, on_close=True))
        return _served(payload, request, deliver=None)

    _run(
        _kind_downloader(kind, handler, _outage(0)),
        _kind_descriptor(kind, payload),
        destination,
    )

    # A close that failed after the whole body needs no second request.
    expected = {"request": [None, None], "body": [None, "bytes=20-"], "close": [None]}
    assert ranges == expected[where]
    assert destination.read_bytes() == payload


@pytest.mark.parametrize("kind", ["archive", "model"])
def test_a_cancelled_download_does_not_hash_a_present_partial(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, kind: str
) -> None:
    content = b"m" * 50
    descriptor = _kind_descriptor(kind, content)
    destination = tmp_path / ("download.zip" if kind == "archive" else "model.bin")
    first = asyncio.Event()

    def stop_when_complete(copied: int) -> None:
        if copied == len(content):
            first.set()

    downloader = _kind_downloader(
        kind, lambda request: httpx.Response(200, content=content), _outage()
    )
    with pytest.raises(asyncio.CancelledError):
        _run(downloader, descriptor, destination, progress=stop_when_complete, cancel_event=first)
    part_path, sidecar_path = _partial(destination)
    assert part_path.read_bytes() == content
    record = sidecar_path.read_bytes()
    hashed: list[Path] = []
    original = download_module._file_size_and_sha256

    def recording_hash(path: Path) -> tuple[int, str]:
        hashed.append(path)
        return original(path)

    monkeypatch.setattr(download_module, "_file_size_and_sha256", recording_hash)
    cancelled = asyncio.Event()
    cancelled.set()
    with pytest.raises(asyncio.CancelledError):
        _run(downloader, descriptor, destination, cancel_event=cancelled)

    assert hashed == []
    assert not destination.exists()
    assert part_path.read_bytes() == content
    assert sidecar_path.read_bytes() == record


def test_cancelling_during_the_outage_wait_stops_the_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = b"partial-download-bytes-and-more"
    destination = tmp_path / "download.zip"
    descriptor = _artifact(payload)
    cancel = asyncio.Event()
    calls = 0
    clients: list[httpx.AsyncClient] = []
    original_pause = download_module._pause_for_network_outage

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, stream=_Interrupt(payload[:8]), request=request)

    def client() -> httpx.AsyncClient:
        created = httpx.AsyncClient(transport=httpx.MockTransport(handler))
        clients.append(created)
        return created

    downloader = HttpArtifactDownloader(client, retry=_outage(30))

    async def scenario() -> None:
        waiting = asyncio.Event()

        async def pause(seconds: float, cancel_event: asyncio.Event) -> None:
            # The download task runs on until the wait suspends it, past the
            # pause's own is_set() check, before the test can cancel.
            waiting.set()
            await original_pause(seconds, cancel_event)

        monkeypatch.setattr(download_module, "_pause_for_network_outage", pause)
        download = asyncio.create_task(
            downloader.download(
                descriptor,
                destination,
                cancel_event=cancel,
                progress=lambda _copied: None,
            )
        )
        await asyncio.wait_for(waiting.wait(), 5)
        assert not download.done()
        started = asyncio.get_running_loop().time()
        cancel.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(download, 1)
        assert asyncio.get_running_loop().time() - started < 1
        assert asyncio.all_tasks() == {asyncio.current_task()}

    asyncio.run(scenario())
    assert calls == 1
    assert len(clients) == 1 and clients[0].is_closed
    part_path, sidecar_path = _partial(destination)
    assert part_path.read_bytes() == payload[:8]
    assert json.loads(sidecar_path.read_text(encoding="utf-8"))["parts"][0]["segments"][0][
        "received"
    ] == len(payload[:8])
