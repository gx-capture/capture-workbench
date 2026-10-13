"""Give timed transcript items a speaker from diarization turns, without guessing.

Pure standard library: the core runtime joins Whisper output with the
diarization worker's turns here, so neither worker depends on the other.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from dataclasses import dataclass

from capture_runtime.speaker_turns import SpeakerTurn


@dataclass(frozen=True, slots=True)
class SpeakerAssignment:
    # ``speaker`` is None when no turn covers the item or two speakers tie.
    speaker: str | None
    candidates: tuple[str, ...]
    overlap: bool


def _covering(
    spans: Sequence[tuple[int, int]], turns: Sequence[SpeakerTurn]
) -> Iterator[list[SpeakerTurn]]:
    ordered = sorted(turns, key=lambda turn: (turn.start_ms, turn.end_ms, turn.speaker))
    cursor = 0
    active: list[SpeakerTurn] = []
    for start_ms, end_ms in spans:
        while cursor < len(ordered) and ordered[cursor].start_ms < end_ms:
            active.append(ordered[cursor])
            cursor += 1
        active = [turn for turn in active if turn.end_ms > start_ms]
        yield [turn for turn in active if turn.start_ms < end_ms and end_ms > start_ms]


def assign_speakers(
    spans: Sequence[tuple[int, int]],
    exclusive_turns: Sequence[SpeakerTurn],
    turns: Sequence[SpeakerTurn],
) -> list[SpeakerAssignment]:
    """Assign each ``(start_ms, end_ms)`` span the speaker who talks longest in it.

    ``exclusive_turns`` decide the speaker; ``turns`` (which may overlap) list
    everyone audible in the span and flag simultaneous speech.
    """

    if any(start_ms < 0 or end_ms < start_ms for start_ms, end_ms in spans):
        raise ValueError("Transcript spans must have non-negative, ordered times")
    if any(right[0] < left[0] for left, right in zip(spans, spans[1:], strict=False)):
        raise ValueError("Transcript spans must be ordered by start time")
    result: list[SpeakerAssignment] = []
    for (start_ms, end_ms), primary, audible in zip(
        spans, _covering(spans, exclusive_turns), _covering(spans, turns), strict=True
    ):
        scores: dict[str, int] = {}
        for turn in primary:
            shared = min(end_ms, turn.end_ms) - max(start_ms, turn.start_ms)
            scores[turn.speaker] = scores.get(turn.speaker, 0) + shared
        best = max(scores.values(), default=0)
        winners = [name for name, score in scores.items() if score == best]
        overlap = any(
            left.speaker != right.speaker
            and max(start_ms, left.start_ms, right.start_ms)
            < min(end_ms, left.end_ms, right.end_ms)
            for index, left in enumerate(audible)
            for right in audible[index + 1 :]
        )
        result.append(
            SpeakerAssignment(
                speaker=winners[0] if len(winners) == 1 else None,
                candidates=tuple(sorted({turn.speaker for turn in audible})),
                overlap=overlap,
            )
        )
    return result


@dataclass(frozen=True, slots=True)
class TimedWord:
    start_ms: int
    end_ms: int
    text: str
    # Index of the transcription segment the word came from.
    segment: int


@dataclass(frozen=True, slots=True)
class SpeakerSegment:
    start_ms: int
    end_ms: int
    text: str
    speaker: str | None
    overlap: bool


@dataclass(frozen=True, slots=True)
class SpeakerSample:
    """A stretch of one speaker's own speech for a person to listen to and name."""

    speaker: str
    start_ms: int
    end_ms: int
    text: str


MAX_PAUSE_MS = 1_000
MAX_SAMPLE_MS = 10_000


def speaker_segments(
    words: Sequence[TimedWord],
    exclusive_turns: Sequence[SpeakerTurn],
    turns: Sequence[SpeakerTurn],
) -> list[SpeakerSegment]:
    """Join words into segments that each have one speaker and one overlap state.

    A new segment also starts at every transcription segment boundary and
    after a pause longer than one second.
    """

    assigned = assign_speakers(
        [(word.start_ms, word.end_ms) for word in words], exclusive_turns, turns
    )
    groups: list[list[tuple[TimedWord, SpeakerAssignment]]] = []
    for word, assignment in zip(words, assigned, strict=True):
        previous = groups[-1][-1] if groups else None
        if (
            previous is None
            or assignment.speaker != previous[1].speaker
            or assignment.overlap != previous[1].overlap
            or word.segment != previous[0].segment
            or word.start_ms - previous[0].end_ms > MAX_PAUSE_MS
        ):
            groups.append([])
        groups[-1].append((word, assignment))
    return [
        SpeakerSegment(
            start_ms=group[0][0].start_ms,
            end_ms=max(word.end_ms for word, _ in group),
            text="".join(word.text for word, _ in group).strip(),
            speaker=group[0][1].speaker,
            overlap=group[0][1].overlap,
        )
        for group in groups
    ]


def speaker_samples(segments: Sequence[SpeakerSegment]) -> list[SpeakerSample]:
    """Pick, per speaker, the longest segment of at most ten seconds spoken alone.

    A speaker heard only while others talk, or only in longer segments, gets no
    sample rather than a misleading one.
    """

    best: dict[str, SpeakerSegment] = {}
    for segment in segments:
        duration = segment.end_ms - segment.start_ms
        if segment.speaker is None or segment.overlap or not 0 < duration <= MAX_SAMPLE_MS:
            continue
        current = best.get(segment.speaker)
        if current is None or duration > current.end_ms - current.start_ms:
            best[segment.speaker] = segment
    return [
        SpeakerSample(speaker, segment.start_ms, segment.end_ms, segment.text)
        for speaker, segment in sorted(best.items())
    ]


__all__ = [
    "SpeakerAssignment",
    "SpeakerSample",
    "SpeakerSegment",
    "TimedWord",
    "assign_speakers",
    "speaker_samples",
    "speaker_segments",
]
