"""Engine downloads resume after a real loopback server ends the connection mid-body.

The server sends the headers and part of the body, waits until the downloader
has stored those bytes, then either closes the connection or resets it. The
transport is httpx's own socket transport; only the host is rewritten to the
loopback server, so catalog HTTPS URLs stay valid.
"""

from __future__ import annotations

import asyncio
import hashlib
import socket
import struct
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager, suppress
from pathlib import Path

import httpx
import pytest

from capture_runtime.provisioning.infrastructure.engine_installation import (
    HttpArtifactDownloader,
    HttpModelFileDownloader,
    NetworkOutageRetry,
)
from tests.unit.test_resumable_downloads import NAME, _artifact, _model, _partial

PARTIAL = 1000


def _payload(size: int) -> bytes:
    return bytes(index % 251 for index in range(size))


class _StoredBytes:
    """The downloader's progress callback; the server waits on it before dropping."""

    def __init__(self) -> None:
        self._value = 0
        self._aborted = False
        self._changed = threading.Condition()

    def __call__(self, copied: int) -> None:
        with self._changed:
            self._value = max(self._value, copied)
            self._changed.notify_all()

    @property
    def value(self) -> int:
        with self._changed:
            return self._value

    def abort(self) -> None:
        """End every wait at once, so a failed test does not hold the server thread."""

        with self._changed:
            self._aborted = True
            self._changed.notify_all()

    def wait_for(self, target: int) -> bool:
        with self._changed:
            self._changed.wait_for(lambda: self._aborted or self._value >= target, timeout=5)
            return not self._aborted and self._value >= target


class _DroppingServer:
    """HTTP/1.1 on 127.0.0.1 that ends the first responses of a path after `PARTIAL` bytes."""

    def __init__(
        self,
        files: dict[str, bytes],
        drops: dict[str, int],
        ending: str,
        stored: _StoredBytes,
    ) -> None:
        self._files = files
        self._drops = dict(drops)
        self._ending = ending
        self._stored = stored
        self.requests: list[tuple[str, str | None]] = []
        self.failures: list[BaseException] = []
        self._stop = threading.Event()
        self._listener = socket.create_server(("127.0.0.1", 0))
        self._listener.settimeout(0.05)
        self.port: int = self._listener.getsockname()[1]
        self._thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self) -> None:
        while not self._stop.is_set():
            try:
                connection, _address = self._listener.accept()
            except TimeoutError:
                continue
            except OSError:
                return
            try:
                self._answer(connection)
            except BaseException as error:  # noqa: BLE001 - reported to the test
                self.failures.append(error)
            finally:
                connection.close()

    def _answer(self, connection: socket.socket) -> None:
        connection.settimeout(5)
        request = b""
        while b"\r\n\r\n" not in request:
            chunk = connection.recv(4096)
            if not chunk:
                return
            request += chunk
        lines = request.split(b"\r\n\r\n", 1)[0].decode("ascii").split("\r\n")
        path = lines[0].split(" ")[1].rsplit("/", 1)[-1]
        headers = {
            name.strip().lower(): value.strip()
            for name, value in (line.split(":", 1) for line in lines[1:])
        }
        byte_range = headers.get("range")
        self.requests.append((path, byte_range))
        body = self._files[path]
        start = int(byte_range.removeprefix("bytes=").split("-", 1)[0]) if byte_range else 0
        status = "206 Partial Content" if start else "200 OK"
        head = [
            f"HTTP/1.1 {status}",
            f"Content-Length: {len(body) - start}",
            "Content-Type: application/octet-stream",
            "Connection: close",
        ]
        if start:
            head.append(f"Content-Range: bytes {start}-{len(body) - 1}/{len(body)}")
        connection.sendall(("\r\n".join(head) + "\r\n\r\n").encode("ascii"))
        if not self._drops.get(path):
            connection.sendall(body[start:])
            return
        self._drops[path] -= 1
        stored_before = self._stored.value
        connection.sendall(body[start : start + PARTIAL])
        if not self._stored.wait_for(stored_before + PARTIAL):
            raise AssertionError("the downloader did not store the partial body")
        if self._ending == "reset":
            # A zero linger makes close() send RST instead of FIN.
            linger = struct.pack("HH" if sys.platform == "win32" else "ii", 1, 0)
            connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, linger)
        else:
            connection.shutdown(socket.SHUT_WR)

    def _shut_down(self) -> None:
        self._stop.set()
        self._stored.abort()
        self._listener.close()
        self._thread.join(5)

    @contextmanager
    def running(self) -> Iterator[_DroppingServer]:
        self._thread.start()
        try:
            yield self
        except BaseException:
            # The test's own failure is the one to report, not a teardown problem.
            with suppress(Exception):
                self._shut_down()
            raise
        self._shut_down()
        assert not self._thread.is_alive(), "the loopback server thread did not stop"


class _ToLoopback(httpx.AsyncBaseTransport):
    """httpx's socket transport, with every request sent to the loopback server."""

    def __init__(self, port: int) -> None:
        self._port = port
        self._inner = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        request.url = request.url.copy_with(scheme="http", host="127.0.0.1", port=self._port)
        return await self._inner.handle_async_request(request)

    async def aclose(self) -> None:
        await self._inner.aclose()


def _client_factory(port: int, clients: list[httpx.AsyncClient]) -> Callable[[], httpx.AsyncClient]:
    def create() -> httpx.AsyncClient:
        client = httpx.AsyncClient(transport=_ToLoopback(port), timeout=5)
        clients.append(client)
        return client

    return create


def _download(downloader, descriptor, destination: Path, stored: _StoredBytes) -> None:
    asyncio.run(
        asyncio.wait_for(
            downloader.download(
                descriptor,
                destination,
                cancel_event=asyncio.Event(),
                progress=stored,
            ),
            timeout=20,
        )
    )


@pytest.mark.parametrize("ending", ["close", "reset"])
@pytest.mark.parametrize("kind", ["archive", "parted-archive", "model"])
def test_a_download_resumes_from_the_stored_offset_after_the_connection_ends(
    tmp_path: Path, kind: str, ending: str
) -> None:
    whole = _payload(3 * PARTIAL + 500)
    stored = _StoredBytes()
    clients: list[httpx.AsyncClient] = []
    if kind == "parted-archive":
        pieces = [whole[:1200], whole[1200:]]
        files = {f"{NAME}.001": pieces[0], f"{NAME}.002": pieces[1]}
        dropped = f"{NAME}.002"
        descriptor = _artifact(whole, parts=pieces)
    elif kind == "archive":
        files = {NAME: whole}
        dropped = NAME
        descriptor = _artifact(whole)
    else:
        files = {"model.bin": whole}
        dropped = "model.bin"
        descriptor = _model(whole)
    destination = tmp_path / ("model.bin" if kind == "model" else "download.zip")
    server = _DroppingServer(files, {dropped: 2}, ending, stored)

    with server.running():
        factory = _client_factory(server.port, clients)
        retry = NetworkOutageRetry((0, 0, 0))
        downloader = (
            HttpModelFileDownloader(factory, retry=retry)
            if kind == "model"
            else HttpArtifactDownloader(factory, retry=retry)
        )
        _download(downloader, descriptor, destination, stored)

    assert server.failures == []
    assert [item for item in server.requests if item[0] == dropped] == [
        (dropped, None),
        (dropped, f"bytes={PARTIAL}-"),
        (dropped, f"bytes={2 * PARTIAL}-"),
    ]
    if kind == "parted-archive":
        assert [item for item in server.requests if item[0] != dropped] == [(f"{NAME}.001", None)]
    assert destination.read_bytes() == whole
    assert hashlib.sha256(destination.read_bytes()).hexdigest() == descriptor.sha256
    part_path, sidecar_path = _partial(destination)
    assert not part_path.exists()
    assert not sidecar_path.exists()
    assert len(clients) == 3
    assert all(client.is_closed for client in clients)


@pytest.mark.parametrize("ending", ["close", "reset"])
def test_an_ended_connection_reaches_the_retry_policy_as_a_transport_failure(
    tmp_path: Path, ending: str
) -> None:
    """Without retries the policy re-raises what it was given, so this is what it sees.

    The policy relies only on ``httpx.TransportError``. On Windows the close
    arrived as ``RemoteProtocolError`` and the reset as ``ReadError``.
    """

    whole = _payload(2 * PARTIAL)
    stored = _StoredBytes()
    clients: list[httpx.AsyncClient] = []
    destination = tmp_path / "download.zip"
    server = _DroppingServer({NAME: whole}, {NAME: 1}, ending, stored)

    with server.running(), pytest.raises(httpx.TransportError):
        _download(
            HttpArtifactDownloader(
                _client_factory(server.port, clients), retry=NetworkOutageRetry(())
            ),
            _artifact(whole),
            destination,
            stored,
        )

    assert server.failures == []
    part_path, sidecar_path = _partial(destination)
    assert part_path.read_bytes() == whole[:PARTIAL]
    assert sidecar_path.is_file()
    assert all(client.is_closed for client in clients)
