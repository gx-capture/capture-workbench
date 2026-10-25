from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureSource,
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


def _source() -> CaptureSource:
    return CaptureSource(
        sha256="a" * 64,
        file_name="sample.mp3",
        media_type="audio/mpeg",
        bytes=100,
    )


def _engine(device: str = "cuda") -> CaptureEngine:
    return CaptureEngine(
        engine="speech-recognition",
        model="tea-asr-1.1" if device == "cuda" else "tea-asr-1.1-mini",
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


def test_progressive_session_keeps_each_moment_of_an_overlap_from_one_window() -> None:
    # Both windows hear 90-120 s, and Whisper writes the same speech in a
    # different script in each; the first window keeps up to the middle of
    # the overlap (105 s), the second from there.
    clock = MutableClock()
    windows = [
        DecodedAudioWindow(0, 120_000, b"first"),
        DecodedAudioWindow(90_000, 210_000, b"second"),
    ]
    transcriber = FakeTranscriber(
        {
            0: WhisperWindowResult(
                (
                    WhisperWindowSegment(95_000, 100_000, "有一個本於事實的陳述"),
                    WhisperWindowSegment(110_000, 115_000, "對對對 那如果都是讀字的話"),
                ),
                _engine(),
            ),
            90_000: WhisperWindowResult(
                (
                    WhisperWindowSegment(5_000, 10_000, "有一个本于事实的陈述"),
                    WhisperWindowSegment(20_000, 25_000, "对对对那如果都是读字的话"),
                    WhisperWindowSegment(40_000, 45_000, "下一句"),
                ),
                _engine(),
            ),
        }
    )
    session = ProgressiveAudioSession(
        _source(),
        capture_id="capture-overlap",
        decoder=ScheduledDecoder(windows),
        transcriber=transcriber,
        clock=clock,
    )

    first = session.feed(b"first")
    # The first window's text past 105 s waits for the second window.
    assert [segment.text for event in first for segment in event.segments] == [
        "有一個本於事實的陳述"
    ]
    session.feed(b"second")
    session.finish()

    assert [segment.text for segment in session.partial.segments] == [
        "有一個本於事實的陳述",
        "对对对那如果都是读字的话",
        "下一句",
    ]
    assert [segment.order for segment in session.partial.segments] == [0, 1, 2]
    assert [segment.locator.start_ms for segment in session.partial.segments] == [
        95_000,
        110_000,
        130_000,
    ]


def test_progressive_session_keeps_the_last_window_text_at_the_end() -> None:
    clock = MutableClock()
    windows = [DecodedAudioWindow(0, 120_000, b"only")]
    transcriber = FakeTranscriber(
        {0: WhisperWindowResult((WhisperWindowSegment(115_000, 119_000, "goodbye"),), _engine())}
    )
    session = ProgressiveAudioSession(
        _source(),
        capture_id="capture-tail",
        decoder=ScheduledDecoder(windows),
        transcriber=transcriber,
        clock=clock,
    )

    session.feed(b"only")
    events = session.finish()

    assert events[-1].event_type is StreamingEventType.COMPLETED
    assert [segment.text for segment in session.partial.segments] == ["goodbye"]


def test_progressive_session_keeps_listening_past_a_silent_opening() -> None:
    clock = MutableClock()
    windows = [
        DecodedAudioWindow(0, 300_000, b"waiting room"),
        DecodedAudioWindow(270_000, 400_000, b"interview"),
    ]
    transcriber = FakeTranscriber(
        {
            0: WhisperWindowResult((), _engine()),
            270_000: WhisperWindowResult(
                (WhisperWindowSegment(40_000, 45_000, "Please state your name."),), _engine()
            ),
        }
    )
    session = ProgressiveAudioSession(
        _source(),
        capture_id="capture-late-speech",
        decoder=ScheduledDecoder(windows),
        transcriber=transcriber,
        clock=clock,
    )

    events = [*session.feed(b"waiting room"), *session.feed(b"interview"), *session.finish()]

    assert events[0].event_type is StreamingEventType.CHECKPOINT
    assert events[0].covered_until_ms == 300_000
    assert events[-1].event_type is StreamingEventType.COMPLETED
    assert [segment.text for segment in session.partial.segments] == ["Please state your name."]
    assert session.partial.segments[0].locator.start_ms == 310_000


def test_progressive_session_fails_audio_without_speech_once_it_is_all_heard() -> None:
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

    assert session.feed(b"audio")[-1].event_type is StreamingEventType.CHECKPOINT
    assert session.terminal is False
    events = session.finish()

    assert session.terminal is True
    assert events[-1].event_type is StreamingEventType.FAILED
    assert events[-1].error is not None
    assert events[-1].error.code == "progressive_no_text_at_sample"
    assert events[-1].error.retryable is False


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
