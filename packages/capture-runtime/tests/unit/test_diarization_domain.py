"""Unit tests for the diarization domain model and use cases."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from capture_runtime.diarization.application.use_cases import (
    AlignSpeakerTurns,
    DiarizeAudio,
    ExtractSpeakerSamples,
)
from capture_runtime.diarization.domain.turn import (
    SpeakerSample,
    SpeakerTurn,
    TimedWord,
    TurnTimeline,
)


def test_speaker_turn_invariants() -> None:
    turn = SpeakerTurn(start_ms=100, end_ms=500, speaker="speaker_1")
    assert turn.start_ms == 100
    assert turn.end_ms == 500
    assert turn.speaker == "speaker_1"

    # Reject invalid times
    with pytest.raises(ValueError, match="non-negative and ordered"):
        SpeakerTurn(start_ms=-1, end_ms=100, speaker="spk")

    with pytest.raises(ValueError, match="non-negative and ordered"):
        SpeakerTurn(start_ms=200, end_ms=100, speaker="spk")

    # Reject invalid speaker label
    with pytest.raises(ValueError, match="Invalid speaker label"):
        SpeakerTurn(start_ms=0, end_ms=100, speaker="invalid label with spaces!")


def test_turn_timeline_invariants_and_operations() -> None:
    t1 = SpeakerTurn(0, 1000, "alice")
    t2 = SpeakerTurn(1000, 2000, "bob")
    timeline = TurnTimeline(turns=(t1, t2), exclusive_turns=(t1, t2), duration_ms=2000)

    assert timeline.duration_ms == 2000

    # Overlapping exclusive turns must raise
    overlap = SpeakerTurn(500, 1500, "charlie")
    with pytest.raises(ValueError, match="exclusive_turns must not overlap"):
        TurnTimeline(turns=(t1, overlap), exclusive_turns=(t1, overlap), duration_ms=2000)

    # Word alignment through timeline
    words = [
        TimedWord(start_ms=100, end_ms=400, text="hello ", segment=0),
        TimedWord(start_ms=450, end_ms=900, text="world", segment=0),
        TimedWord(start_ms=1100, end_ms=1500, text="reply", segment=1),
    ]
    segments = timeline.align_words(words)
    assert len(segments) == 2
    assert segments[0].speaker == "alice"
    assert segments[0].text == "hello world"
    assert segments[1].speaker == "bob"
    assert segments[1].text == "reply"


def test_align_and_extract_use_cases() -> None:
    align_uc = AlignSpeakerTurns()
    extract_uc = ExtractSpeakerSamples()

    t1 = SpeakerTurn(0, 1000, "speaker_0")
    words = [TimedWord(start_ms=100, end_ms=800, text="speech", segment=0)]

    segments = align_uc.execute(words, exclusive_turns=[t1], turns=[t1])
    assert len(segments) == 1
    assert segments[0].speaker == "speaker_0"

    samples = extract_uc.execute(segments)
    assert len(samples) == 1
    assert samples[0] == SpeakerSample("speaker_0", 100, 800, "speech")


@pytest.mark.anyio
async def test_diarize_audio_use_case() -> None:
    mock_client = MagicMock()
    mock_result = MagicMock()
    mock_client.diarize = AsyncMock(return_value=mock_result)

    mock_engine = MagicMock()
    use_case = DiarizeAudio(mock_client)
    result = await use_case.execute(
        mock_engine,
        source_path=MagicMock(),
        media_type="audio/wav",
        options={},
        cancel_event=MagicMock(),
    )

    assert result is mock_result
    mock_client.diarize.assert_awaited_once()
