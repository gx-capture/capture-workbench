"""Bounded binary session protocol for progressive Whisper windows."""

from __future__ import annotations

import json
import struct
from collections.abc import Iterable
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from capture_runtime.contracts import StreamingEventType
from capture_runtime.progressive_audio import (
    DecodedAudioWindow,
    ProgressiveSessionEvent,
)

SESSION_PROTOCOL_VERSION = "2"
MAX_SESSION_FRAME_PAYLOAD = 4 * 1024 * 1024
MAX_SESSION_BUFFER_BYTES = MAX_SESSION_FRAME_PAYLOAD + 5
MAX_SESSION_CREDITS = 32
_HEADER = struct.Struct(">BI")
_AUDIO_HEADER = struct.Struct(">QQ")


class SessionFrameType(StrEnum):
    START = "S"
    INPUT = "I"
    CREDIT = "C"
    CANCEL = "X"
    FINISH = "F"
    HEARTBEAT = "h"
    SEALED_SEGMENT = "s"
    CHECKPOINT = "k"
    COMPLETED = "d"
    ERROR = "e"


class WhisperSessionProtocolError(ValueError):
    def __init__(self, code: str, message: str, *, retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


@dataclass(frozen=True, slots=True)
class SessionFrame:
    frame_type: SessionFrameType
    payload: bytes


class SessionFrameDecoder:
    """Incremental decoder that rejects oversized declarations before buffering."""

    def __init__(self, *, max_buffer_bytes: int = MAX_SESSION_BUFFER_BYTES) -> None:
        if max_buffer_bytes < 5 or max_buffer_bytes > MAX_SESSION_BUFFER_BYTES:
            raise ValueError("session frame buffer limit is invalid")
        self.max_buffer_bytes = max_buffer_bytes
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list[SessionFrame]:
        if len(self._buffer) + len(data) > self.max_buffer_bytes:
            raise WhisperSessionProtocolError(
                "session_backpressure",
                "Whisper session frame buffer is full.",
                retryable=True,
            )
        self._buffer.extend(data)
        frames: list[SessionFrame] = []
        while len(self._buffer) >= _HEADER.size:
            raw_type, payload_size = _HEADER.unpack(self._buffer[: _HEADER.size])
            if payload_size > MAX_SESSION_FRAME_PAYLOAD:
                raise WhisperSessionProtocolError(
                    "session_frame_too_large",
                    "Whisper session frame exceeds the bounded payload limit.",
                )
            frame_size = _HEADER.size + payload_size
            if len(self._buffer) < frame_size:
                break
            try:
                frame_type = SessionFrameType(chr(raw_type))
            except ValueError as error:
                raise WhisperSessionProtocolError(
                    "session_frame_invalid", "Whisper session frame type is invalid."
                ) from error
            payload = bytes(self._buffer[_HEADER.size : frame_size])
            del self._buffer[:frame_size]
            frames.append(SessionFrame(frame_type, payload))
        return frames

    @property
    def buffered_bytes(self) -> int:
        return len(self._buffer)


class WhisperSessionBackend(Protocol):
    def start(self, metadata: dict[str, Any]) -> None: ...

    def input(self, window: DecodedAudioWindow) -> Iterable[ProgressiveSessionEvent]: ...

    def finish(self) -> Iterable[ProgressiveSessionEvent]: ...

    def cancel(self) -> None: ...


class WhisperSessionProtocol:
    """State machine for start/input/credit/cancel/finish worker messages."""

    def __init__(
        self,
        backend: WhisperSessionBackend,
        *,
        max_credits: int = MAX_SESSION_CREDITS,
    ) -> None:
        self.backend = backend
        self.max_credits = max_credits
        self._started = False
        self._terminal = False
        self._credits = 0

    def handle(self, frame: SessionFrame) -> list[bytes]:
        if self._terminal:
            return [self._error("session_closed", "Whisper session is already closed.")]
        try:
            if frame.frame_type is SessionFrameType.START:
                self._start(frame.payload)
                return []
            if not self._started:
                raise WhisperSessionProtocolError(
                    "session_not_started", "Whisper session must start before input."
                )
            if frame.frame_type is SessionFrameType.CREDIT:
                self._credit(frame.payload)
                return []
            if frame.frame_type is SessionFrameType.INPUT:
                return self._input(frame.payload)
            if frame.frame_type is SessionFrameType.CANCEL:
                self.backend.cancel()
                self._terminal = True
                return [
                    self._error(
                        "session_cancelled",
                        "Whisper session was cancelled.",
                        retryable=True,
                    )
                ]
            if frame.frame_type is SessionFrameType.FINISH:
                return self._finish()
            raise WhisperSessionProtocolError(
                "session_frame_invalid", "Frame type is not valid for a client session."
            )
        except WhisperSessionProtocolError as error:
            self._terminal = error.code in {"session_cancelled", "session_failed"}
            return [self._error(error.code, str(error), retryable=error.retryable)]
        except Exception as error:
            self._terminal = True
            return [
                self._error(
                    "session_failed",
                    f"Whisper session failed at {type(error).__name__}.",
                    retryable=True,
                )
            ]

    def _start(self, payload: bytes) -> None:
        if self._started:
            raise WhisperSessionProtocolError(
                "session_conflict", "Whisper session already started."
            )
        metadata = _json_object(payload)
        expected = {
            "protocolVersion",
            "sessionId",
            "sampleRate",
            "channels",
            "windowMs",
            "overlapMs",
        }
        if set(metadata) != expected or metadata["protocolVersion"] != SESSION_PROTOCOL_VERSION:
            raise WhisperSessionProtocolError(
                "session_start_invalid", "Whisper session start is invalid."
            )
        if not isinstance(metadata["sessionId"], str) or not metadata["sessionId"]:
            raise WhisperSessionProtocolError(
                "session_start_invalid", "Whisper session id is invalid."
            )
        for field in ("sampleRate", "channels", "windowMs", "overlapMs"):
            value = metadata[field]
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise WhisperSessionProtocolError(
                    "session_start_invalid", "Whisper session timing is invalid."
                )
        if metadata["overlapMs"] >= metadata["windowMs"]:
            raise WhisperSessionProtocolError(
                "session_start_invalid", "Whisper session overlap is invalid."
            )
        self.backend.start(metadata)
        self._started = True

    def _credit(self, payload: bytes) -> None:
        if len(payload) != 4:
            raise WhisperSessionProtocolError(
                "session_credit_invalid", "Session credit is invalid."
            )
        amount = struct.unpack(">I", payload)[0]
        if amount <= 0 or amount > self.max_credits or self._credits + amount > self.max_credits:
            raise WhisperSessionProtocolError(
                "session_credit_invalid",
                "Session credit exceeds the bounded window limit.",
            )
        self._credits += amount

    def _input(self, payload: bytes) -> list[bytes]:
        if self._credits <= 0:
            raise WhisperSessionProtocolError(
                "session_credit_required",
                "Session input requires available credit.",
                retryable=True,
            )
        if len(payload) <= _AUDIO_HEADER.size:
            raise WhisperSessionProtocolError(
                "session_input_invalid", "Session audio input is empty."
            )
        start_ms, end_ms = _AUDIO_HEADER.unpack(payload[: _AUDIO_HEADER.size])
        window = DecodedAudioWindow(start_ms, end_ms, payload[_AUDIO_HEADER.size :])
        self._credits -= 1
        output = self._event_frames(self.backend.input(window))
        output.append(_frame(SessionFrameType.HEARTBEAT, _json_bytes({"stage": "input_ack"})))
        return output

    def _finish(self) -> list[bytes]:
        output = self._event_frames(self.backend.finish())
        self._terminal = True
        terminal_frames = {
            ord(SessionFrameType.COMPLETED.value),
            ord(SessionFrameType.ERROR.value),
        }
        if not output or not any(frame[0] in terminal_frames for frame in output):
            output.append(_frame(SessionFrameType.COMPLETED, b"{}"))
        return output

    @staticmethod
    def _event_frames(events: Iterable[ProgressiveSessionEvent]) -> list[bytes]:
        return [_event_frame(event) for event in events]

    @staticmethod
    def _error(code: str, message: str, *, retryable: bool = False) -> bytes:
        return encode_error(code, message, retryable=retryable)


def encode_audio_input(window: DecodedAudioWindow) -> bytes:
    return _frame(
        SessionFrameType.INPUT,
        _AUDIO_HEADER.pack(window.start_ms, window.end_ms) + window.payload,
    )


def encode_credit(amount: int) -> bytes:
    return _frame(SessionFrameType.CREDIT, struct.pack(">I", amount))


def encode_control(frame_type: SessionFrameType, payload: dict[str, Any] | None = None) -> bytes:
    if frame_type not in {
        SessionFrameType.START,
        SessionFrameType.CANCEL,
        SessionFrameType.FINISH,
    }:
        raise ValueError("frame type is not a control message")
    return _frame(frame_type, _json_bytes(payload or {}))


def encode_error(code: str, message: str, *, retryable: bool = False) -> bytes:
    return _frame(
        SessionFrameType.ERROR,
        _json_bytes({"code": code, "message": message[:500], "retryable": retryable}),
    )


def _frame(frame_type: SessionFrameType, payload: bytes) -> bytes:
    if len(payload) > MAX_SESSION_FRAME_PAYLOAD:
        raise ValueError("session frame payload exceeds the bounded limit")
    return _HEADER.pack(ord(frame_type.value), len(payload)) + payload


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _json_object(payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise WhisperSessionProtocolError(
            "session_json_invalid", "Session control payload is invalid."
        ) from error
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise WhisperSessionProtocolError(
            "session_json_invalid", "Session control payload must be an object."
        )
    return value


def _event_frame(event: ProgressiveSessionEvent) -> bytes:
    if event.event_type is StreamingEventType.HEARTBEAT:
        return _frame(SessionFrameType.HEARTBEAT, _json_bytes({"stage": event.stage}))
    if event.event_type is StreamingEventType.SEGMENT:
        payload: dict[str, Any] = {
            "partialRevision": event.partial_revision,
            "coveredUntilMs": event.covered_until_ms,
            "segments": [
                segment.model_dump(mode="json", by_alias=True) for segment in event.segments
            ],
        }
        if event.extraction_engine is not None:
            payload["extractionEngine"] = event.extraction_engine.model_dump(
                mode="json", by_alias=True
            )
        return _frame(SessionFrameType.SEALED_SEGMENT, _json_bytes(payload))
    if event.event_type is StreamingEventType.CHECKPOINT:
        return _frame(
            SessionFrameType.CHECKPOINT,
            _json_bytes(
                {
                    "partialRevision": event.partial_revision,
                    "coveredUntilMs": event.covered_until_ms,
                }
            ),
        )
    if event.event_type is StreamingEventType.COMPLETED:
        return _frame(SessionFrameType.COMPLETED, _json_bytes({"stage": event.stage}))
    if event.event_type is StreamingEventType.FAILED:
        assert event.error is not None
        return _frame(
            SessionFrameType.ERROR,
            _json_bytes(event.error.model_dump(mode="json", by_alias=True)),
        )
    return _frame(SessionFrameType.HEARTBEAT, _json_bytes({"stage": event.stage}))


__all__ = [
    "MAX_SESSION_BUFFER_BYTES",
    "MAX_SESSION_CREDITS",
    "MAX_SESSION_FRAME_PAYLOAD",
    "SESSION_PROTOCOL_VERSION",
    "SessionFrame",
    "SessionFrameDecoder",
    "SessionFrameType",
    "WhisperSessionBackend",
    "WhisperSessionProtocol",
    "WhisperSessionProtocolError",
    "encode_audio_input",
    "encode_control",
    "encode_credit",
    "encode_error",
]
