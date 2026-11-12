from __future__ import annotations

from capture_runtime.contracts import (
    CaptureEngine,
    StreamingEventType,
)
from capture_runtime.speech.infrastructure.progressive_audio import (
    DecodedAudioWindow,
    ProgressiveAudioSession,
    ProgressiveSessionEvent,
    WhisperWindowResult,
    WhisperWindowSegment,
)


class FakeTranscriber:
    def __init__(self, results: dict[int, WhisperWindowResult]) -> None:
        self.results = results

    def transcribe(self, window: DecodedAudioWindow) -> WhisperWindowResult:
        return self.results[window.start_ms]


def _engine(device: str = "cuda") -> CaptureEngine:
    return CaptureEngine(
        engine="speech-recognition",
        model="tea-asr-1.1" if device == "cuda" else "tea-asr-1.1-mini",
        digest=f"sha256:{'b' * 64}",
        device=device,
    )


def test_progressive_session_merges_overlap_and_emits_checkpoint() -> None:
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
        transcriber=transcriber,
    )

    events: list[ProgressiveSessionEvent] = []
    for window in windows:
        events.extend(session.consume_window(window))

    assert [event.event_type for event in events] == [
        StreamingEventType.SEGMENT,
        StreamingEventType.SEGMENT,
        StreamingEventType.CHECKPOINT,
        StreamingEventType.SEGMENT,
        StreamingEventType.CHECKPOINT,
    ]
    assert [segment.text for event in events for segment in event.segments] == [
        "same words",
        "later words",
        "five minute words",
    ]
    assert events[-1].partial_revision == 3
    assert events[-1].covered_until_ms == 600_000
    assert session.finish()[-2].covered_until_ms == 630_000


def test_progressive_session_keeps_each_moment_of_an_overlap_from_one_window() -> None:
    # Both windows hear 90-120 s, and Whisper writes the same speech in a
    # different script in each; the first window keeps up to the middle of
    # the overlap (105 s), the second from there.
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
        transcriber=transcriber,
    )

    first = session.consume_window(windows[0])
    # The first window's text past 105 s waits for the second window.
    assert [segment.text for event in first for segment in event.segments] == [
        "有一個本於事實的陳述"
    ]
    events = [*first, *session.consume_window(windows[1]), *session.finish()]
    segments = [segment for event in events for segment in event.segments]

    assert [segment.text for segment in segments] == [
        "有一個本於事實的陳述",
        "对对对那如果都是读字的话",
        "下一句",
    ]
    assert [segment.order for segment in segments] == [0, 1, 2]
    assert [segment.locator.start_ms for segment in segments] == [
        95_000,
        110_000,
        130_000,
    ]


def test_progressive_session_keeps_the_last_window_text_at_the_end() -> None:
    windows = [DecodedAudioWindow(0, 120_000, b"only")]
    transcriber = FakeTranscriber(
        {0: WhisperWindowResult((WhisperWindowSegment(115_000, 119_000, "goodbye"),), _engine())}
    )
    session = ProgressiveAudioSession(
        transcriber=transcriber,
    )

    session.consume_window(windows[0])
    events = session.finish()

    assert events[-1].event_type is StreamingEventType.COMPLETED
    assert [segment.text for event in events for segment in event.segments] == ["goodbye"]


def test_progressive_session_keeps_listening_past_a_silent_opening() -> None:
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
        transcriber=transcriber,
    )

    events = [
        *session.consume_window(windows[0]),
        *session.consume_window(windows[1]),
        *session.finish(),
    ]

    assert events[0].event_type is StreamingEventType.CHECKPOINT
    assert events[0].covered_until_ms == 300_000
    assert events[-1].event_type is StreamingEventType.COMPLETED
    segments = [segment for event in events for segment in event.segments]
    assert [segment.text for segment in segments] == ["Please state your name."]
    assert segments[0].locator.start_ms == 310_000


def test_progressive_session_fails_audio_without_speech_once_it_is_all_heard() -> None:
    windows = [DecodedAudioWindow(0, 300_000, b"silence")]
    transcriber = FakeTranscriber({0: WhisperWindowResult((), _engine())})
    session = ProgressiveAudioSession(
        transcriber=transcriber,
    )

    assert session.consume_window(windows[0])[-1].event_type is StreamingEventType.CHECKPOINT
    events = session.finish()

    assert events[-1].event_type is StreamingEventType.FAILED
    assert events[-1].error is not None
    assert events[-1].error.code == "progressive_no_text_at_sample"
    assert events[-1].error.retryable is False
