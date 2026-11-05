"""Application use cases for speaker diarization."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from capture_runtime.diarization.domain.turn import (
    SpeakerSample,
    SpeakerSegment,
    SpeakerTurn,
    TimedWord,
    TurnTimeline,
    speaker_samples,
)
from capture_runtime.diarization.domain.turn.models import DiarizationResult
from capture_runtime.worker_process import DEFAULT_RUN_TIMEOUT_SECONDS

if TYPE_CHECKING:
    from capture_runtime.worker_client import InstalledEngine


class DiarizationClient(Protocol):
    """Protocol for worker clients providing speaker diarization capability."""

    async def diarize(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
        on_permille: Callable[[int], None] | None = None,
    ) -> DiarizationResult: ...


class AlignSpeakerTurns:
    """Align transcription words with diarization turns to produce speaker segments."""

    def execute(
        self,
        words: Sequence[TimedWord],
        exclusive_turns: Sequence[SpeakerTurn],
        turns: Sequence[SpeakerTurn],
    ) -> list[SpeakerSegment]:
        duration_ms = max([t.end_ms for t in turns] + [t.end_ms for t in exclusive_turns] + [0])
        timeline = TurnTimeline(
            turns=tuple(turns),
            exclusive_turns=tuple(exclusive_turns),
            duration_ms=duration_ms,
        )
        return timeline.align_words(words)


class ExtractSpeakerSamples:
    """Extract solo speaker audio samples for user verification and naming."""

    def execute(self, segments: Sequence[SpeakerSegment]) -> list[SpeakerSample]:
        return speaker_samples(segments)


class DiarizeAudio:
    """Execute speaker diarization on audio through worker process."""

    def __init__(self, client: DiarizationClient) -> None:
        self._client = client

    async def execute(
        self,
        engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float = DEFAULT_RUN_TIMEOUT_SECONDS,
        on_permille: Callable[[int], None] | None = None,
    ) -> DiarizationResult:
        return await self._client.diarize(
            engine,
            source_path=source_path,
            media_type=media_type,
            options=options,
            cancel_event=cancel_event,
            timeout_seconds=timeout_seconds,
            on_permille=on_permille,
        )


__all__ = [
    "AlignSpeakerTurns",
    "DiarizeAudio",
    "ExtractSpeakerSamples",
]
