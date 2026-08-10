"""Binary framed server used by the progressive Whisper worker entrypoint."""

from __future__ import annotations

import sys
from typing import BinaryIO

from capture_runtime.whisper_session import (
    SessionFrameDecoder,
    WhisperSessionBackend,
    WhisperSessionProtocol,
    WhisperSessionProtocolError,
    encode_error,
)

READ_CHUNK_BYTES = 64 * 1024


def serve_session(
    backend: WhisperSessionBackend,
    *,
    stdin: BinaryIO | None = None,
    stdout: BinaryIO | None = None,
) -> None:
    """Serve framed session messages with bounded reads and sanitized errors."""

    input_stream = stdin or sys.stdin.buffer
    output_stream = stdout or sys.stdout.buffer
    decoder = SessionFrameDecoder()
    protocol = WhisperSessionProtocol(backend)
    while True:
        data = input_stream.read(READ_CHUNK_BYTES)
        if not data:
            return
        try:
            frames = decoder.feed(data)
            for frame in frames:
                for response in protocol.handle(frame):
                    output_stream.write(response)
                    output_stream.flush()
        except WhisperSessionProtocolError as error:
            output_stream.write(encode_error(error.code, str(error), retryable=error.retryable))
            output_stream.flush()
            return


__all__ = ["READ_CHUNK_BYTES", "serve_session"]
