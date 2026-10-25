from __future__ import annotations

import json
import struct
from typing import Any

import pytest

from capture_runtime.contracts import StreamingEventType
from capture_runtime.progressive_audio import DecodedAudioWindow, ProgressiveSessionEvent
from capture_runtime.whisper_session import (
    MAX_SESSION_FRAME_PAYLOAD,
    SessionFrameDecoder,
    SessionFrameType,
    WhisperSessionProtocol,
    WhisperSessionProtocolError,
    encode_audio_input,
    encode_control,
    encode_credit,
)


class FakeBackend:
    def __init__(self) -> None:
        self.started: dict[str, Any] | None = None
        self.windows: list[DecodedAudioWindow] = []
        self.cancelled = False

    def start(self, metadata: dict[str, Any]) -> None:
        self.started = metadata

    def input(self, window: DecodedAudioWindow) -> list[ProgressiveSessionEvent]:
        self.windows.append(window)
        return []

    def finish(self) -> list[ProgressiveSessionEvent]:
        return [ProgressiveSessionEvent(StreamingEventType.COMPLETED, "completed")]

    def cancel(self) -> None:
        self.cancelled = True


def _start(session_id: str = "session-1", *, version: str = "3") -> bytes:
    return encode_control(
        SessionFrameType.START,
        {
            "protocolVersion": version,
            "sessionId": session_id,
            "sampleRate": 16_000,
            "channels": 1,
            "windowMs": 120_000,
            "overlapMs": 30_000,
            "source": {
                "sha256": "a" * 64,
                "fileName": "sample.wav",
                "mediaType": "audio/wav",
                "bytes": 1_000,
            },
        },
    )


def test_session_protocol_requires_credit_and_accepts_fragmented_binary_input() -> None:
    backend = FakeBackend()
    protocol = WhisperSessionProtocol(backend)
    decoder = SessionFrameDecoder()
    wire = _start() + encode_credit(1) + encode_audio_input(DecodedAudioWindow(0, 1_000, b"pcm"))
    outputs: list[bytes] = []
    for byte in wire:
        for frame in decoder.feed(bytes([byte])):
            outputs.extend(protocol.handle(frame))

    assert len(outputs) == 1
    assert outputs[0][0] == ord(SessionFrameType.HEARTBEAT.value)
    assert backend.started is not None
    assert backend.windows == [DecodedAudioWindow(0, 1_000, b"pcm")]

    no_credit = WhisperSessionProtocol(FakeBackend())
    no_credit.handle(next(iter(SessionFrameDecoder().feed(_start()))))
    input_frame = next(
        iter(SessionFrameDecoder().feed(encode_audio_input(DecodedAudioWindow(0, 1, b"x"))))
    )
    error = no_credit.handle(input_frame)
    assert error[0][0] == ord(SessionFrameType.ERROR.value)


def test_a_completed_session_accepts_the_next_start_and_cancel_is_terminal() -> None:
    # A warm worker serves one capture after another with its models loaded.
    backend = FakeBackend()
    protocol = WhisperSessionProtocol(backend)
    decoder = SessionFrameDecoder()
    for frame in decoder.feed(_start() + encode_credit(1)):
        protocol.handle(frame)
    finished = protocol.handle(next(iter(decoder.feed(encode_control(SessionFrameType.FINISH)))))
    assert finished[-1][0] == ord(SessionFrameType.COMPLETED.value)

    assert protocol.handle(next(iter(decoder.feed(_start("session-2"))))) == []
    assert backend.started is not None and backend.started["sessionId"] == "session-2"
    assert backend.started["source"]["fileName"] == "sample.wav"

    closed = protocol.handle(next(iter(decoder.feed(encode_control(SessionFrameType.CANCEL)))))
    assert closed[0][0] == ord(SessionFrameType.ERROR.value)
    after_cancel = protocol.handle(next(iter(decoder.feed(_start("session-3")))))
    assert after_cancel[0][0] == ord(SessionFrameType.ERROR.value)
    assert backend.started["sessionId"] == "session-2"


def test_session_protocol_rejects_a_previous_version_or_a_missing_source() -> None:
    for wire in (
        _start(version="2"),
        encode_control(
            SessionFrameType.START,
            {
                "protocolVersion": "3",
                "sessionId": "session-1",
                "sampleRate": 16_000,
                "channels": 1,
                "windowMs": 120_000,
                "overlapMs": 30_000,
                "source": {
                    "sha256": "a" * 64,
                    "fileName": "",
                    "mediaType": "audio/wav",
                    "bytes": 1,
                },
            },
        ),
    ):
        backend = FakeBackend()
        error = WhisperSessionProtocol(backend).handle(next(iter(SessionFrameDecoder().feed(wire))))
        assert error[0][0] == ord(SessionFrameType.ERROR.value)
        assert backend.started is None


def test_session_protocol_adds_only_allowlisted_failure_context() -> None:
    class FailingBackend(FakeBackend):
        def input(self, _window: DecodedAudioWindow) -> list[ProgressiveSessionEvent]:
            raise ValueError("private backend detail")

    protocol = WhisperSessionProtocol(
        FailingBackend(),
        failure_context=lambda: "speech-transcription-call-complete",
    )
    decoder = SessionFrameDecoder()
    for frame in decoder.feed(_start() + encode_credit(1)):
        protocol.handle(frame)

    output = protocol.handle(
        next(iter(decoder.feed(encode_audio_input(DecodedAudioWindow(0, 1, b"x")))))
    )
    payload = json.loads(output[0][5:].decode("utf-8"))
    assert payload["code"] == "session_failed"
    assert payload["message"] == (
        "Speech recognition session failed at ValueError "
        "after stage speech-transcription-call-complete."
    )
    assert "private backend detail" not in payload["message"]


def test_session_protocol_rejects_oversized_declared_frame_before_buffering() -> None:
    decoder = SessionFrameDecoder()
    with pytest.raises(WhisperSessionProtocolError, match="exceeds"):
        decoder.feed(
            struct.pack(">BI", ord(SessionFrameType.INPUT.value), MAX_SESSION_FRAME_PAYLOAD + 1)
        )
