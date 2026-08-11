"""Binary framed server used by the progressive Whisper worker entrypoint."""

from __future__ import annotations

import sys
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures import TimeoutError as FutureTimeoutError
from typing import BinaryIO, cast

from capture_runtime.whisper_session import (
    SessionFrame,
    SessionFrameDecoder,
    WhisperSessionBackend,
    WhisperSessionProtocol,
    WhisperSessionProtocolError,
    encode_error,
    encode_heartbeat,
)

READ_CHUNK_BYTES = 64 * 1024
HEARTBEAT_INTERVAL_SECONDS = 5.0


def serve_session(
    backend: WhisperSessionBackend,
    *,
    stdin: BinaryIO | None = None,
    stdout: BinaryIO | None = None,
    heartbeat_interval_seconds: float = HEARTBEAT_INTERVAL_SECONDS,
    failure_context: Callable[[], str] | None = None,
) -> None:
    """Serve framed session messages with bounded reads and sanitized errors."""

    if heartbeat_interval_seconds <= 0:
        raise ValueError("session heartbeat interval must be positive")
    input_stream = stdin or sys.stdin.buffer
    output_stream = stdout or sys.stdout.buffer
    decoder = SessionFrameDecoder()
    protocol = WhisperSessionProtocol(backend, failure_context=failure_context)
    executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="capture-session")
    try:
        while True:
            data = _read_available(input_stream)
            if not data:
                return
            try:
                frames = decoder.feed(data)
                for frame in frames:
                    responses = _handle_with_heartbeats(
                        executor,
                        protocol,
                        frame,
                        output_stream,
                        heartbeat_interval_seconds,
                    )
                    for response in responses:
                        output_stream.write(response)
                        output_stream.flush()
            except WhisperSessionProtocolError as error:
                output_stream.write(encode_error(error.code, str(error), retryable=error.retryable))
                output_stream.flush()
                return
    finally:
        executor.shutdown(wait=True, cancel_futures=True)


def _read_available(input_stream: BinaryIO) -> bytes:
    """Read available pipe data without waiting for the bounded read to fill."""

    read1 = getattr(input_stream, "read1", None)
    if callable(read1):
        return cast(bytes, read1(READ_CHUNK_BYTES))
    return input_stream.read(READ_CHUNK_BYTES)


def _handle_with_heartbeats(
    executor: ThreadPoolExecutor,
    protocol: WhisperSessionProtocol,
    frame: SessionFrame,
    output_stream: BinaryIO,
    heartbeat_interval_seconds: float,
) -> list[bytes]:
    future: Future[list[bytes]] = executor.submit(protocol.handle, frame)
    while True:
        try:
            return future.result(timeout=heartbeat_interval_seconds)
        except FutureTimeoutError:
            output_stream.write(encode_heartbeat("transcribing"))
            output_stream.flush()


__all__ = ["HEARTBEAT_INTERVAL_SECONDS", "READ_CHUNK_BYTES", "serve_session"]
