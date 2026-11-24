"""Engine downloads ride out a short network interruption and resume where they stopped."""

from __future__ import annotations

import asyncio
import dataclasses
import json
from contextlib import suppress
from pathlib import Path

import httpx
import pytest

from capture_runtime.provisioning.application.installation_service import (
    installation_failure_code,
)
from capture_runtime.provisioning.infrastructure import (
    _engine_installation_download as download_module,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineInstallationError,
    HttpArtifactDownloader,
    HttpModelFileDownloader,
)
from tests.unit.test_resumable_downloads import _artifact, _Interrupt, _model, _partial, _run

PAYLOAD = bytes(range(100))


def _resume_headers(start: int, data: bytes) -> dict[str, str]:
    return {"content-range": f"bytes {start}-{len(data) - 1}/{len(data)}"}


def _start_of(request: httpx.Request) -> int:
    byte_range = request.headers.get("range")
    return 0 if byte_range is None else int(byte_range.removeprefix("bytes=").split("-")[0])


def _downloader(handler, **kwargs: object) -> HttpArtifactDownloader:
    return HttpArtifactDownloader(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        **kwargs,  # type: ignore[arg-type]
    )


def test_an_artifact_download_survives_a_dropped_connection_and_an_outage(
    tmp_path: Path,
) -> None:
    """A real socket: the body stops after 40 bytes, then two connections drop unanswered."""

    destination = tmp_path / "download.zip"
    ranges: list[str | None] = []

    async def scenario() -> None:
        async def serve(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
            head = await reader.readuntil(b"\r\n\r\n")
            lines = head.decode("ascii").split("\r\n")
            headers = dict(line.split(": ", 1) for line in lines[1:] if line and ": " in line)
            byte_range = next(
                (value for name, value in headers.items() if name.lower() == "range"), None
            )
            ranges.append(byte_range)
            attempt = len(ranges)
            if attempt == 1:
                writer.write(
                    f"HTTP/1.1 200 OK\r\nContent-Length: {len(PAYLOAD)}\r\n\r\n".encode("ascii")
                    + PAYLOAD[:40]
                )
                await writer.drain()
            elif attempt == 4:
                tail = PAYLOAD[40:]
                writer.write(
                    (
                        "HTTP/1.1 206 Partial Content\r\n"
                        f"Content-Range: bytes 40-{len(PAYLOAD) - 1}/{len(PAYLOAD)}\r\n"
                        f"Content-Length: {len(tail)}\r\n\r\n"
                    ).encode("ascii")
                    + tail
                )
                await writer.drain()
            # Every other attempt finds the network gone: the connection closes unanswered.
            writer.close()
            with suppress(ConnectionError):
                await writer.wait_closed()

        server = await asyncio.start_server(serve, "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        descriptor = dataclasses.replace(
            _artifact(PAYLOAD), url=f"http://127.0.0.1:{port}/worker.zip"
        )
        downloader = HttpArtifactDownloader(
            lambda: httpx.AsyncClient(trust_env=False), retry_delays=(0, 0, 0)
        )
        async with server:
            await asyncio.wait_for(
                downloader.download(
                    descriptor,
                    destination,
                    cancel_event=asyncio.Event(),
                    progress=lambda _copied: None,
                ),
                10,
            )

    asyncio.run(scenario())

    assert ranges == [None, "bytes=40-", "bytes=40-", "bytes=40-"]
    assert destination.read_bytes() == PAYLOAD
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()


def test_a_ranged_artifact_download_resumes_each_segment_after_an_outage(
    tmp_path: Path,
) -> None:
    payload = bytes(index % 256 for index in range(200))
    destination = tmp_path / "download.zip"
    outage = [0]

    def handler(request: httpx.Request) -> httpx.Response:
        byte_range = request.headers["range"]
        start_text, end_text = byte_range.removeprefix("bytes=").split("-")
        start, end = int(start_text), int(end_text)
        headers = {"content-range": f"bytes {start}-{end}/{len(payload)}"}
        if byte_range == "bytes=0-0":
            return httpx.Response(206, headers=headers, content=payload[:1], request=request)
        if start == 0 and outage[0] == 0:
            outage[0] = 1
            return httpx.Response(
                206, headers=headers, stream=_Interrupt(payload[:30]), request=request
            )
        if 0 < outage[0] < 3:
            outage[0] += 1
            raise httpx.ConnectError("network unreachable", request=request)
        return httpx.Response(
            206, headers=headers, content=payload[start : end + 1], request=request
        )

    downloader = _downloader(
        handler, parallel_min_bytes=1, parallel_segments=2, retry_delays=(0, 0, 0)
    )
    _run(downloader, _artifact(payload), destination)

    assert destination.read_bytes() == payload
    assert outage == [3]


def test_a_model_download_survives_an_outage(tmp_path: Path) -> None:
    content = b"m" * 100
    descriptor = _model(content)
    destination = tmp_path / "model.bin"
    requests: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.headers.get("range"))
        if len(requests) == 1:
            return httpx.Response(200, stream=_Interrupt(content[:40]), request=request)
        if len(requests) <= 4:
            raise httpx.ConnectError("network unreachable", request=request)
        return httpx.Response(
            206, headers=_resume_headers(40, content), content=content[40:], request=request
        )

    # One wait follows the interrupted attempt, three follow the outage.
    downloader = HttpModelFileDownloader(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        retry_delays=(0, 0, 0, 0),
    )
    _run(downloader, descriptor, destination)

    assert requests == [None, "bytes=40-", "bytes=40-", "bytes=40-", "bytes=40-"]
    assert destination.read_bytes() == content


def test_attempts_that_receive_new_bytes_do_not_use_up_the_schedule(tmp_path: Path) -> None:
    destination = tmp_path / "download.zip"
    requests: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        start = _start_of(request)
        requests.append(start)
        status = 206 if start else 200
        headers = _resume_headers(start, PAYLOAD) if start else {}
        if start + 10 < len(PAYLOAD):
            stream = _Interrupt(PAYLOAD[start : start + 10])
            return httpx.Response(status, headers=headers, stream=stream, request=request)
        return httpx.Response(status, headers=headers, content=PAYLOAD[start:], request=request)

    _run(_downloader(handler, retry_delays=(0,)), _artifact(PAYLOAD), destination)

    assert requests == list(range(0, 100, 10))
    assert destination.read_bytes() == PAYLOAD


def test_attempts_without_progress_exhaust_the_schedule_and_keep_the_partial(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "download.zip"
    requests: list[str | None] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.headers.get("range"))
        if len(requests) == 1:
            return httpx.Response(200, stream=_Interrupt(PAYLOAD[:40]), request=request)
        raise httpx.ConnectError("network unreachable", request=request)

    with pytest.raises(EngineInstallationError, match="exhausted bounded retries") as failure:
        _run(_downloader(handler, retry_delays=(0, 0)), _artifact(PAYLOAD), destination)

    # The first attempt received bytes, so both waits follow it.
    assert requests == [None, "bytes=40-", "bytes=40-"]
    assert isinstance(failure.value.__cause__, httpx.ConnectError)
    assert installation_failure_code(failure.value) == "installation_failed"
    part_path, sidecar_path = _partial(destination)
    assert part_path.read_bytes() == PAYLOAD[:40]
    assert json.loads(sidecar_path.read_text())["parts"][0]["segments"][0]["received"] == 40


def test_the_default_schedule_waits_about_a_minute_before_giving_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    waits: list[float] = []

    async def record(delay: float, cancel_event: asyncio.Event) -> None:
        waits.append(delay)

    monkeypatch.setattr(download_module, "_pause", record)

    def unreachable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("network unreachable", request=request)

    artifact = HttpArtifactDownloader(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(unreachable))
    )
    with pytest.raises(EngineInstallationError, match="exhausted bounded retries"):
        _run(artifact, _artifact(PAYLOAD), tmp_path / "download.zip")
    artifact_waits = list(waits)
    waits.clear()
    model = HttpModelFileDownloader(
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(unreachable))
    )
    with pytest.raises(EngineInstallationError, match="exhausted bounded retries") as failure:
        _run(model, _model(PAYLOAD), tmp_path / "model.bin")

    assert artifact_waits == waits
    assert 60 <= sum(waits) <= 120
    assert waits == sorted(waits)
    assert installation_failure_code(failure.value) == "direct_model_retries_exhausted"


@pytest.mark.parametrize(("status", "retried"), [(503, True), (429, True), (404, False)])
def test_a_status_the_source_may_answer_differently_is_retried(
    tmp_path: Path, status: int, retried: bool
) -> None:
    destination = tmp_path / "download.zip"
    requests: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(1)
        if len(requests) == 1:
            return httpx.Response(status, request=request)
        return httpx.Response(200, content=PAYLOAD, request=request)

    downloader = _downloader(handler, retry_delays=(0,))
    if retried:
        _run(downloader, _artifact(PAYLOAD), destination)
        assert destination.read_bytes() == PAYLOAD
        assert len(requests) == 2
    else:
        with pytest.raises(EngineInstallationError, match="non-retryable") as failure:
            _run(downloader, _artifact(PAYLOAD), destination)
        assert len(requests) == 1
        assert installation_failure_code(failure.value) == "installation_failed"


def test_an_integrity_failure_is_not_retried(tmp_path: Path) -> None:
    destination = tmp_path / "download.zip"
    requests: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(1)
        return httpx.Response(200, content=b"\x00" * len(PAYLOAD), request=request)

    with pytest.raises(EngineInstallationError, match="checksum"):
        _run(_downloader(handler, retry_delays=(0, 0)), _artifact(PAYLOAD), destination)
    assert len(requests) == 1


def test_a_file_error_is_not_retried(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    destination = tmp_path / "download.zip"
    requests: list[int] = []

    def full_disk(*_args: object) -> None:
        raise OSError(28, "No space left on device")

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(1)
        return httpx.Response(200, content=PAYLOAD, request=request)

    monkeypatch.setattr(download_module, "_open_part", full_disk)
    with pytest.raises(OSError, match="No space left") as failure:
        _run(_downloader(handler, retry_delays=(0, 0)), _artifact(PAYLOAD), destination)
    assert len(requests) == 1
    assert installation_failure_code(failure.value) == "installation_io_failed"


def test_a_connection_abort_read_as_a_bare_oserror_is_retried(tmp_path: Path) -> None:
    destination = tmp_path / "download.zip"
    requests: list[str | None] = []

    class _Aborted(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield PAYLOAD[:40]
            raise OSError("injected Windows transport abort")

        async def aclose(self) -> None:
            return None

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request.headers.get("range"))
        if len(requests) == 1:
            return httpx.Response(200, stream=_Aborted(), request=request)
        return httpx.Response(
            206, headers=_resume_headers(40, PAYLOAD), content=PAYLOAD[40:], request=request
        )

    _run(_downloader(handler, retry_delays=(0,)), _artifact(PAYLOAD), destination)

    assert requests == [None, "bytes=40-"]
    assert destination.read_bytes() == PAYLOAD


def test_a_cancel_ends_the_wait_between_attempts(tmp_path: Path) -> None:
    destination = tmp_path / "download.zip"
    cancel = asyncio.Event()
    requests: list[int] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(1)
        asyncio.get_running_loop().call_later(0.05, cancel.set)
        raise httpx.ConnectError("network unreachable", request=request)

    # The wait is 30 seconds; the run's own limit is 5.
    with pytest.raises(asyncio.CancelledError):
        _run(
            _downloader(handler, retry_delays=(30,)),
            _artifact(PAYLOAD),
            destination,
            cancel_event=cancel,
        )
    assert len(requests) == 1
