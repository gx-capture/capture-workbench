from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureEngineV1,
    CaptureSourceV1,
    StreamingEventType,
)
from capture_runtime.progressive_audio import (
    DecodedAudioWindow,
    ProgressiveAudioSession,
    ProgressiveBackpressureError,
    WhisperWindowResult,
    WhisperWindowSegment,
)


class MutableClock(Clock):
    def __init__(self) -> None:
        self.current = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


class ScheduledDecoder:
    def __init__(self, windows: list[DecodedAudioWindow]) -> None:
        self.windows = windows

    def push(self, _data: bytes) -> list[DecodedAudioWindow]:
        return [self.windows.pop(0)] if self.windows else []

    def finish(self) -> list[DecodedAudioWindow]:
        windows, self.windows = self.windows, []
        return windows


class FakeTranscriber:
    def __init__(self, results: dict[int, WhisperWindowResult]) -> None:
        self.results = results

    def transcribe(self, window: DecodedAudioWindow) -> WhisperWindowResult:
        return self.results[window.start_ms]


def _source() -> CaptureSourceV1:
    return CaptureSourceV1(
        sha256="a" * 64,
        file_name="sample.mp3",
        media_type="audio/mpeg",
        bytes=100,
    )


def _engine(device: str = "cuda") -> CaptureEngineV1:
    return CaptureEngineV1(
        engine="whisper-primary",
        model="large-v3-turbo" if device == "cuda" else "small",
        digest=f"sha256:{'b' * 64}",
        device=device,
    )


def test_progressive_session_merges_overlap_and_emits_checkpoint() -> None:
    clock = MutableClock()
    windows = [
        DecodedAudioWindow(0, 120_000, b"one"),
        DecodedAudioWindow(90_000, 210_000, b"two"),
        DecodedAudioWindow(210_000, 330_000, b"gap-one"),
        DecodedAudioWindow(330_000, 450_000, b"gap-two"),
        DecodedAudioWindow(450_000, 510_000, b"gap-three"),
        DecodedAudioWindow(510_000, 630_000, b"three"),
    ]
    transcriber = FakeTranscriber(
        {
            0: WhisperWindowResult(
                (WhisperWindowSegment(80_000, 120_000, "same words"),), _engine()
            ),
            90_000: WhisperWindowResult(
                (
                    WhisperWindowSegment(0, 40_000, "SAME   WORDS"),
                    WhisperWindowSegment(45_000, 65_000, "later words"),
                ),
                _engine(),
            ),
            210_000: WhisperWindowResult((), _engine()),
            330_000: WhisperWindowResult((), _engine()),
            450_000: WhisperWindowResult((), _engine()),
            510_000: WhisperWindowResult(
                (WhisperWindowSegment(90_000, 110_000, "five minute words"),), _engine()
            ),
        }
    )
    session = ProgressiveAudioSession(
        _source(),
        capture_id="capture-1",
        decoder=ScheduledDecoder(windows),
        transcriber=transcriber,
        clock=clock,
    )

    events: list[object] = []
    for marker in b"abcdef":
        events.extend(session.feed(bytes([marker])))

    assert [event.event_type for event in events] == [
        StreamingEventType.SEGMENT,
        StreamingEventType.SEGMENT,
        StreamingEventType.CHECKPOINT,
        StreamingEventType.SEGMENT,
        StreamingEventType.CHECKPOINT,
    ]
    assert session.partial.source_text == "same words\nlater words\nfive minute words"
    assert session.partial.revision == 3
    assert session.partial.covered_until_ms == 630_000


def test_progressive_session_fails_first_five_minute_sample_without_text() -> None:
    clock = MutableClock()
    windows = [DecodedAudioWindow(0, 300_000, b"silence")]
    transcriber = FakeTranscriber({0: WhisperWindowResult((), _engine())})
    session = ProgressiveAudioSession(
        _source(),
        capture_id="capture-empty",
        decoder=ScheduledDecoder(windows),
        transcriber=transcriber,
        clock=clock,
    )

    events = session.feed(b"audio")

    assert session.terminal is True
    assert events[-1].event_type is StreamingEventType.FAILED
    assert events[-1].error is not None
    assert events[-1].error.code == "progressive_no_text_at_sample"
    assert events[-1].error.retryable is True


def test_progressive_session_emits_heartbeat_then_stall_failure() -> None:
    clock = MutableClock()
    decoder = ScheduledDecoder([])
    transcriber = FakeTranscriber({})
    session = ProgressiveAudioSession(
        _source(),
        capture_id="capture-watchdog",
        decoder=decoder,
        transcriber=transcriber,
        clock=clock,
    )

    clock.current += timedelta(seconds=5)
    heartbeat = session.tick()
    assert heartbeat[0].event_type is StreamingEventType.HEARTBEAT
    clock.current += timedelta(seconds=86)
    failure = session.tick()
    assert failure[-1].event_type is StreamingEventType.FAILED
    assert failure[-1].error is not None
    assert failure[-1].error.code == "progressive_stall"


def test_progressive_session_rejects_unbounded_input() -> None:
    clock = MutableClock()
    session = ProgressiveAudioSession(
        _source(),
        capture_id="capture-bounded",
        decoder=ScheduledDecoder([]),
        transcriber=FakeTranscriber({}),
        clock=clock,
        max_buffer_bytes=4,
    )

    with pytest.raises(ProgressiveBackpressureError):
        session.feed(b"12345")
