from __future__ import annotations

import pytest

from capture_runtime.speaker_alignment import (
    SpeakerSample,
    SpeakerSegment,
    TimedWord,
    assign_speakers,
    speaker_samples,
    speaker_segments,
)
from capture_runtime.speaker_turns import SpeakerTurn


def test_span_takes_the_speaker_who_talks_longest_in_it() -> None:
    turns = [SpeakerTurn(0, 1_000, "SPEAKER_00"), SpeakerTurn(1_000, 4_000, "SPEAKER_01")]

    assigned = assign_speakers([(0, 900), (800, 2_000), (5_000, 6_000)], turns, turns)

    assert [item.speaker for item in assigned] == ["SPEAKER_00", "SPEAKER_01", None]
    assert assigned[1].candidates == ("SPEAKER_00", "SPEAKER_01")
    assert [item.overlap for item in assigned] == [False, False, False]


def test_equal_shares_leave_the_speaker_undecided() -> None:
    turns = [SpeakerTurn(0, 500, "SPEAKER_00"), SpeakerTurn(500, 1_000, "SPEAKER_01")]

    (assigned,) = assign_speakers([(0, 1_000)], turns, turns)

    assert assigned.speaker is None
    assert assigned.candidates == ("SPEAKER_00", "SPEAKER_01")


def test_simultaneous_speech_is_flagged_from_the_overlapping_timeline() -> None:
    exclusive = [SpeakerTurn(0, 2_000, "SPEAKER_00")]
    overlapping = [SpeakerTurn(0, 2_000, "SPEAKER_00"), SpeakerTurn(1_000, 1_500, "SPEAKER_01")]

    assigned = assign_speakers([(0, 900), (1_100, 1_400)], exclusive, overlapping)

    assert [item.speaker for item in assigned] == ["SPEAKER_00", "SPEAKER_00"]
    assert [item.overlap for item in assigned] == [False, True]


def test_zero_length_span_gets_no_speaker() -> None:
    turns = [SpeakerTurn(0, 2_000, "SPEAKER_00")]

    (assigned,) = assign_speakers([(1_000, 1_000)], turns, turns)

    assert assigned.speaker is None
    assert assigned.candidates == ()


@pytest.mark.parametrize("spans", [[(2_000, 3_000), (0, 1_000)], [(500, 100)], [(-1, 100)]])
def test_unordered_or_invalid_spans_are_rejected(spans: list[tuple[int, int]]) -> None:
    with pytest.raises(ValueError, match="Transcript spans"):
        assign_speakers(spans, [], [])


def test_words_join_into_segments_that_break_on_speaker_segment_and_pause() -> None:
    turns = [SpeakerTurn(0, 2_000, "SPEAKER_00"), SpeakerTurn(2_000, 9_000, "SPEAKER_01")]
    words = [
        TimedWord(0, 500, " Good", 0),
        TimedWord(500, 1_000, " morning", 0),
        TimedWord(2_100, 2_600, " Hello", 0),
        TimedWord(2_600, 3_000, " there", 1),
        TimedWord(5_000, 5_400, " again", 1),
    ]

    segments = speaker_segments(words, turns, turns)

    assert [(item.start_ms, item.end_ms, item.text, item.speaker) for item in segments] == [
        (0, 1_000, "Good morning", "SPEAKER_00"),
        (2_100, 2_600, "Hello", "SPEAKER_01"),
        (2_600, 3_000, "there", "SPEAKER_01"),
        (5_000, 5_400, "again", "SPEAKER_01"),
    ]


def test_sample_is_each_speakers_longest_short_segment_spoken_alone() -> None:
    segments = [
        SpeakerSegment(0, 3_000, "short", "SPEAKER_00", False),
        SpeakerSegment(3_000, 9_000, "longer", "SPEAKER_00", False),
        SpeakerSegment(9_000, 30_000, "too long", "SPEAKER_00", False),
        SpeakerSegment(30_000, 38_000, "talked over", "SPEAKER_01", True),
        SpeakerSegment(38_000, 40_000, "alone", "SPEAKER_01", False),
        SpeakerSegment(40_000, 45_000, "only overlapping", "SPEAKER_02", True),
        SpeakerSegment(45_000, 47_000, "nobody", None, False),
    ]

    assert speaker_samples(segments) == [
        SpeakerSample("SPEAKER_00", 3_000, 9_000, "longer"),
        SpeakerSample("SPEAKER_01", 38_000, 40_000, "alone"),
    ]
