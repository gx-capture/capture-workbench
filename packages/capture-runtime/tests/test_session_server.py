from __future__ import annotations

import threading
from typing import Any

from capture_runtime.progressive_audio import DecodedAudioWindow, ProgressiveSessionEvent
from capture_runtime.whisper_session import (
    SessionFrameDecoder,
    SessionFrameType,
    encode_audio_input,
    encode_control,
    encode_credit,
)
from capture_runtime.workers.session_server import serve_session


class _BlockingInput:
    def __init__(self, wire: bytes) -> None:
        self._wire = wire
        self._closed = threading.Event()

    def read(self, _size: int = -1) -> bytes:
        if self._wire:
            wire, self._wire = self._wire, b""
            return wire
        self._closed.wait(timeout=2)
        return b""

    def close(self) -> None:
        self._closed.set()


class _Read1OnlyInput:
    def __init__(self, wire: bytes) -> None:
        self._wire = wire

    def read1(self, size: int) -> bytes:
        if not self._wire:
            return b""
        chunk, self._wire = self._wire[:size], self._wire[size:]
        return chunk

    def read(self, _size: int = -1) -> bytes:
        raise AssertionError("session server must use read1 for buffered pipes")


class _RecordingOutput:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.writes: list[bytes] = []
        self.heartbeat = threading.Event()

    def write(self, value: bytes) -> int:
        with self._lock:
            self.writes.append(value)
        if value and value[0] == ord(SessionFrameType.HEARTBEAT.value):
            self.heartbeat.set()
        return len(value)

    def flush(self) -> None:
        return None


class _BlockingBackend:
    def __init__(self) -> None:
        self.release = threading.Event()

    def start(self, _metadata: dict[str, Any]) -> None:
        return None

    def input(self, _window: DecodedAudioWindow) -> list[ProgressiveSessionEvent]:
        assert self.release.wait(timeout=2)
        return []

    def finish(self) -> list[ProgressiveSessionEvent]:
        return []

    def cancel(self) -> None:
        self.release.set()


class _ImmediateBackend:
    def start(self, _metadata: dict[str, Any]) -> None:
        return None

    def input(self, _window: DecodedAudioWindow) -> list[ProgressiveSessionEvent]:
        return []

    def finish(self) -> list[ProgressiveSessionEvent]:
        return []

    def cancel(self) -> None:
        return None


def test_session_server_emits_heartbeat_while_window_transcription_is_running() -> None:
    wire = (
        encode_control(
            SessionFrameType.START,
            {
                "protocolVersion": "2",
                "sessionId": "session-1",
                "sampleRate": 16_000,
                "channels": 1,
                "windowMs": 120_000,
                "overlapMs": 30_000,
            },
        )
        + encode_credit(1)
        + encode_audio_input(DecodedAudioWindow(0, 1_000, b"pcm"))
        + encode_control(SessionFrameType.FINISH)
    )
    source = _BlockingInput(wire)
    output = _RecordingOutput()
    backend = _BlockingBackend()
    thread = threading.Thread(
        target=serve_session,
        args=(backend,),
        kwargs={
            "stdin": source,
            "stdout": output,
            "heartbeat_interval_seconds": 0.02,
        },
        daemon=True,
    )

    thread.start()
    assert output.heartbeat.wait(timeout=1), "a long window must remain observable"
    backend.release.set()
    source.close()
    thread.join(timeout=2)
    assert not thread.is_alive()

    decoder = SessionFrameDecoder()
    frames = [frame for payload in output.writes for frame in decoder.feed(payload)]
    assert any(frame.frame_type is SessionFrameType.HEARTBEAT for frame in frames)
    assert any(frame.frame_type is SessionFrameType.COMPLETED for frame in frames)


def test_session_server_reads_short_final_pipe_chunk_without_waiting_for_eof() -> None:
    wire = (
        encode_control(
            SessionFrameType.START,
            {
                "protocolVersion": "2",
                "sessionId": "session-read1",
                "sampleRate": 16_000,
                "channels": 1,
                "windowMs": 120_000,
                "overlapMs": 30_000,
            },
        )
        + encode_credit(1)
        + encode_audio_input(DecodedAudioWindow(0, 1_000, b"pcm"))
    )
    source = _Read1OnlyInput(wire)
    output = _RecordingOutput()
    thread = threading.Thread(
        target=serve_session,
        args=(_ImmediateBackend(),),
        kwargs={"stdin": source, "stdout": output},
        daemon=True,
    )

    thread.start()
    thread.join(timeout=2)
    assert not thread.is_alive()

    decoder = SessionFrameDecoder()
    frames = [frame for payload in output.writes for frame in decoder.feed(payload)]
    assert any(frame.frame_type is SessionFrameType.HEARTBEAT for frame in frames)
