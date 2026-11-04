"""Unit tests for speech transcription domain models, invariants, and use cases."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import pytest

from capture_runtime.contracts import CaptureEngine
from capture_runtime.speech.application.use_cases import (
    DetectRepetitionLoop,
    SliceAudioStream,
    TranscribeAudio,
    TranscribeAudioWindow,
)
from capture_runtime.speech.domain import (
    DEFAULT_OVERLAP_MS,
    DEFAULT_WINDOW_MS,
    MAX_PROGRESSIVE_WINDOW_BYTES,
    AudioWindow,
    RepetitionLoopPolicy,
    SpeechTranscript,
    SpeechTranscriptSegment,
    SpeechWord,
    WindowSlicingPolicy,
)
from capture_runtime.speech.infrastructure.progressive_audio import (
    WhisperWindowResult,
    WhisperWindowSegment,
)
from capture_runtime.speech.infrastructure.speech_transcript import (
    WhisperTextSegment,
    WhisperTranscriptionResult,
    WhisperWord,
)


def test_audio_window_invariants() -> None:
    valid = AudioWindow(start_ms=0, end_ms=1000, payload=b"pcm_data")
    assert valid.duration_ms == 1000

    with pytest.raises(ValueError, match="audio window interval is invalid"):
        AudioWindow(start_ms=-1, end_ms=1000, payload=b"pcm")

    with pytest.raises(ValueError, match="audio window interval is invalid"):
        AudioWindow(start_ms=1000, end_ms=500, payload=b"pcm")

    with pytest.raises(ValueError, match="audio window interval is invalid"):
        AudioWindow(start_ms=1000, end_ms=1000, payload=b"pcm")

    with pytest.raises(ValueError, match="audio window payload must not be empty"):
        AudioWindow(start_ms=0, end_ms=1000, payload=b"")

    with pytest.raises(ValueError, match="audio window exceeds the bounded payload limit"):
        AudioWindow(start_ms=0, end_ms=1000, payload=b"x" * (MAX_PROGRESSIVE_WINDOW_BYTES + 1))


def test_window_slicing_policy_invariants_and_computation() -> None:
    policy = WindowSlicingPolicy()
    assert policy.window_ms == DEFAULT_WINDOW_MS
    assert policy.overlap_ms == DEFAULT_OVERLAP_MS
    assert policy.step_ms == DEFAULT_WINDOW_MS - DEFAULT_OVERLAP_MS

    with pytest.raises(ValueError, match="window_ms must be positive"):
        WindowSlicingPolicy(window_ms=0, overlap_ms=0)

    with pytest.raises(ValueError, match="overlap_ms must be non-negative"):
        WindowSlicingPolicy(window_ms=100, overlap_ms=-10)

    with pytest.raises(ValueError, match="overlap_ms must be non-negative"):
        WindowSlicingPolicy(window_ms=100, overlap_ms=100)

    # Empty duration
    assert policy.compute_windows(0) == ()
    assert policy.compute_windows(-100) == ()

    # Single window shorter than window_ms
    assert policy.compute_windows(50_000) == ((0, 50_000),)

    # Exactly one window
    assert policy.compute_windows(120_000) == ((0, 120_000),)

    # 2 windows (120s window, 30s overlap -> step is 90s)
    # Total duration 200s: [0, 120], [90, 200]
    windows = policy.compute_windows(200_000)
    assert windows == ((0, 120_000), (90_000, 200_000))


def test_speech_word_invariants() -> None:
    word = SpeechWord(start_ms=100, end_ms=250, text="hello")
    assert word.duration_ms == 150

    with pytest.raises(ValueError, match="word time interval is invalid"):
        SpeechWord(start_ms=-1, end_ms=100, text="hello")

    with pytest.raises(ValueError, match="word time interval is invalid"):
        SpeechWord(start_ms=200, end_ms=100, text="hello")

    with pytest.raises(ValueError, match="word text must not be empty"):
        SpeechWord(start_ms=100, end_ms=200, text="")


def test_speech_transcript_segment_invariants() -> None:
    word = SpeechWord(start_ms=100, end_ms=250, text="hello")
    segment = SpeechTranscriptSegment(start_ms=0, end_ms=500, text="hello", words=(word,))
    assert segment.duration_ms == 500

    with pytest.raises(ValueError, match="segment time interval is invalid"):
        SpeechTranscriptSegment(start_ms=-1, end_ms=500, text="hello")

    with pytest.raises(ValueError, match="segment time interval is invalid"):
        SpeechTranscriptSegment(start_ms=600, end_ms=500, text="hello")


def test_speech_transcript_invariants() -> None:
    seg1 = SpeechTranscriptSegment(start_ms=0, end_ms=500, text="Hello ")
    seg2 = SpeechTranscriptSegment(start_ms=600, end_ms=1200, text="World")
    transcript = SpeechTranscript(
        segments=(seg1, seg2),
        duration_ms=1500,
        model="tea-asr",
        device="cuda",
        digest="sha256-test",
    )
    assert transcript.text == "Hello World"

    with pytest.raises(ValueError, match="transcript duration must be non-negative"):
        SpeechTranscript(
            segments=(),
            duration_ms=-1,
            model="m",
            device="d",
            digest="h",
        )

    with pytest.raises(ValueError, match="segments must be ordered by start_ms"):
        SpeechTranscript(
            segments=(seg2, seg1),
            duration_ms=2000,
            model="m",
            device="d",
            digest="h",
        )

    with pytest.raises(ValueError, match="segment end_ms exceeds transcript duration"):
        SpeechTranscript(
            segments=(seg1, seg2),
            duration_ms=1000,
            model="m",
            device="d",
            digest="h",
        )


def test_repetition_loop_policy() -> None:
    policy = RepetitionLoopPolicy(repeats=32, max_period=16)

    with pytest.raises(ValueError, match="repeats must be at least 2"):
        RepetitionLoopPolicy(repeats=1)

    with pytest.raises(ValueError, match="max_period must be at least 1"):
        RepetitionLoopPolicy(max_period=0)

    # Not repeating
    assert not policy.is_repeating_sequence([1, 2, 3, 4, 5])

    # Period 1 repeated 32 times
    loop_tokens = [10] * 32
    assert policy.is_repeating_sequence(loop_tokens)

    # Period 2 repeated 32 times
    loop_tokens_period2 = [10, 20] * 32
    assert policy.is_repeating_sequence(loop_tokens_period2)


def test_use_cases() -> None:
    # 1. TranscribeAudio
    mock_transcriber = Mock()
    mock_transcriber.transcribe.return_value = WhisperTranscriptionResult(
        segments=(
            WhisperTextSegment(
                start_ms=0,
                end_ms=500,
                text="Hi",
                words=(WhisperWord(start_ms=0, end_ms=500, text="Hi"),),
            ),
        ),
        duration_ms=600,
        device="cuda",
        model="tea-asr",
        digest="sha256-test",
    )
    uc_transcribe = TranscribeAudio(mock_transcriber)
    transcript = uc_transcribe.execute(Path("dummy.wav"))
    assert transcript.text == "Hi"
    assert transcript.duration_ms == 600
    assert len(transcript.segments) == 1

    # 2. TranscribeAudioWindow
    mock_window_transcriber = Mock()
    digest = "sha256:" + "0" * 64
    engine = CaptureEngine(
        engine="speech-recognition", model="tea-asr", digest=digest, device="cuda"
    )
    mock_window_transcriber.transcribe.return_value = WhisperWindowResult(
        segments=(WhisperWindowSegment(start_ms=0, end_ms=1000, text="Window text"),),
        extraction_engine=engine,
    )
    uc_window = TranscribeAudioWindow(mock_window_transcriber)
    window = AudioWindow(start_ms=0, end_ms=1000, payload=b"pcm_bytes")
    window_result = uc_window.execute(window)
    assert len(window_result.segments) == 1
    assert window_result.segments[0].text == "Window text"

    # 3. SliceAudioStream
    uc_slice = SliceAudioStream(WindowSlicingPolicy(window_ms=100, overlap_ms=20))
    slices = uc_slice.execute(200)
    assert slices == ((0, 100), (80, 180), (160, 200))

    # 4. DetectRepetitionLoop
    uc_loop = DetectRepetitionLoop(RepetitionLoopPolicy(repeats=4, max_period=2))
    assert uc_loop.execute([1, 1, 1, 1])
