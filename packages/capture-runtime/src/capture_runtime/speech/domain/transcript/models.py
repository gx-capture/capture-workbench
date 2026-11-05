"""Transcript aggregate and repetition loop stopping policy."""

from __future__ import annotations

from dataclasses import dataclass

LOOP_REPEATS = 32
LOOP_MAX_PERIOD = 16


@dataclass(frozen=True, slots=True)
class SpeechWord:
    """A single word or subword token with timestamps."""

    start_ms: int
    end_ms: int
    text: str

    def __post_init__(self) -> None:
        if self.start_ms < 0 or self.end_ms < self.start_ms:
            raise ValueError("word time interval is invalid")
        if not self.text:
            raise ValueError("word text must not be empty")

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True, slots=True)
class SpeechTranscriptSegment:
    """A segment of transcribed text with optional word alignments."""

    start_ms: int
    end_ms: int
    text: str
    words: tuple[SpeechWord, ...] = ()

    def __post_init__(self) -> None:
        if self.start_ms < 0 or self.end_ms < self.start_ms:
            raise ValueError("segment time interval is invalid")

    @property
    def duration_ms(self) -> int:
        return self.end_ms - self.start_ms


@dataclass(frozen=True, slots=True)
class SpeechTranscript:
    """Aggregate root representing a complete transcribed speech result."""

    segments: tuple[SpeechTranscriptSegment, ...]
    duration_ms: int
    model: str
    device: str
    digest: str
    warning: str | None = None
    elapsed_ms: int | None = None
    stage_ms: dict[str, int] | None = None

    def __post_init__(self) -> None:
        if self.duration_ms < 0:
            raise ValueError("transcript duration must be non-negative")
        prev_start = -1
        for segment in self.segments:
            if segment.start_ms < prev_start:
                raise ValueError("segments must be ordered by start_ms")
            prev_start = segment.start_ms
            if segment.end_ms > self.duration_ms:
                raise ValueError("segment end_ms exceeds transcript duration")

    @property
    def text(self) -> str:
        return "".join(segment.text for segment in self.segments)


@dataclass(frozen=True, slots=True)
class RepetitionLoopPolicy:
    """Detection and collapsing policy for greedy decoding repetition loops."""

    repeats: int = LOOP_REPEATS
    max_period: int = LOOP_MAX_PERIOD

    def __post_init__(self) -> None:
        if self.repeats < 2:
            raise ValueError("repeats must be at least 2")
        if self.max_period < 1:
            raise ValueError("max_period must be at least 1")

    def is_repeating_sequence(self, tokens: list[int]) -> bool:
        for period in range(1, self.max_period + 1):
            span = period * self.repeats
            if len(tokens) < span:
                break
            if (
                tokens[-1] == tokens[-1 - period]
                and tokens[-span:] == tokens[-period:] * self.repeats
            ):
                return True
        return False


@dataclass(frozen=True, slots=True)
class SpeechRecognitionResult:
    segments: tuple[SpeechTranscriptSegment, ...]
    duration_ms: int
    device: str
    model: str
    digest: str
    warning: str | None = None
    elapsed_ms: int | None = None
    stage_ms: dict[str, int] | None = None
