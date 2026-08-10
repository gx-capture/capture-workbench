"""Bounded progressive audio extraction and checkpoint orchestration."""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureEngineV1,
    CaptureFailureV2,
    CaptureSourceV1,
    PartialCaptureV2,
    RawCaptureSegmentV1,
    StreamingEventType,
    TimeLocatorV1,
    project_source_text,
)

MAX_PROGRESSIVE_WINDOW_BYTES = 4 * 1024 * 1024
DEFAULT_WINDOW_MS = 120_000
DEFAULT_OVERLAP_MS = 30_000
DEFAULT_CHECKPOINT_MS = 300_000
DEFAULT_HEARTBEAT_MS = 5_000
DEFAULT_STALL_TIMEOUT_MS = 90_000


class ProgressiveAudioError(RuntimeError):
    """Base class for safe progressive-session failures."""


class ProgressiveBackpressureError(ProgressiveAudioError):
    pass


class ProgressiveSessionClosedError(ProgressiveAudioError):
    pass


@dataclass(frozen=True, slots=True)
class DecodedAudioWindow:
    start_ms: int
    end_ms: int
    payload: bytes

    def __post_init__(self) -> None:
        if self.start_ms < 0 or self.end_ms <= self.start_ms:
            raise ValueError("audio window interval is invalid")
        if not self.payload:
            raise ValueError("audio window payload must not be empty")
        if len(self.payload) > MAX_PROGRESSIVE_WINDOW_BYTES:
            raise ValueError("audio window exceeds the bounded payload limit")


@dataclass(frozen=True, slots=True)
class WhisperWindowSegment:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class WhisperWindowResult:
    segments: tuple[WhisperWindowSegment, ...]
    extraction_engine: CaptureEngineV1
    warnings: tuple[str, ...] = ()


class IncrementalAudioDecoder(Protocol):
    def push(self, data: bytes) -> Iterable[DecodedAudioWindow]: ...

    def finish(self) -> Iterable[DecodedAudioWindow]: ...


class WhisperWindowTranscriber(Protocol):
    def transcribe(self, window: DecodedAudioWindow) -> WhisperWindowResult: ...


@dataclass(frozen=True, slots=True)
class ProgressiveSessionEvent:
    event_type: StreamingEventType
    stage: str
    partial_revision: int | None = None
    covered_until_ms: int | None = None
    segments: tuple[RawCaptureSegmentV1, ...] = ()
    error: CaptureFailureV2 | None = None
    extraction_engine: CaptureEngineV1 | None = None


class ProgressiveAudioSession:
    """Deep module for bounded decode, merge, checkpoint, and watchdog policy."""

    def __init__(
        self,
        source: CaptureSourceV1,
        *,
        capture_id: str,
        decoder: IncrementalAudioDecoder,
        transcriber: WhisperWindowTranscriber,
        clock: Clock,
        window_ms: int = DEFAULT_WINDOW_MS,
        overlap_ms: int = DEFAULT_OVERLAP_MS,
        checkpoint_ms: int = DEFAULT_CHECKPOINT_MS,
        heartbeat_ms: int = DEFAULT_HEARTBEAT_MS,
        stall_timeout_ms: int = DEFAULT_STALL_TIMEOUT_MS,
        max_buffer_bytes: int = MAX_PROGRESSIVE_WINDOW_BYTES,
    ) -> None:
        if not 0 < overlap_ms < window_ms:
            raise ValueError("overlap must be positive and smaller than the window")
        if min(window_ms, checkpoint_ms, heartbeat_ms, stall_timeout_ms, max_buffer_bytes) <= 0:
            raise ValueError("progressive timing and buffer limits must be positive")
        if max_buffer_bytes > MAX_PROGRESSIVE_WINDOW_BYTES:
            raise ValueError("progressive buffer exceeds the runtime safety limit")
        self.source = source
        self.capture_id = capture_id
        self.decoder = decoder
        self.transcriber = transcriber
        self.clock = clock
        self.window_ms = window_ms
        self.overlap_ms = overlap_ms
        self.checkpoint_ms = checkpoint_ms
        self.heartbeat_ms = heartbeat_ms
        self.stall_timeout_ms = stall_timeout_ms
        self.max_buffer_bytes = max_buffer_bytes
        self._buffered_bytes = 0
        self._covered_until_ms = 0
        self._next_checkpoint_ms = checkpoint_ms
        self._partial_revision = 0
        self._segments: list[RawCaptureSegmentV1] = []
        self._engine: CaptureEngineV1 | None = None
        self._warnings: list[str] = []
        self._pending_events: list[ProgressiveSessionEvent] = []
        self._last_progress_at = clock.now()
        self._last_heartbeat_at = self._last_progress_at
        self._terminal = False
        self._finished = False

    @property
    def terminal(self) -> bool:
        return self._terminal

    @property
    def completed(self) -> bool:
        return self._terminal and self._finished and bool(self._segments)

    @property
    def partial_available(self) -> bool:
        return self._engine is not None and bool(self._segments)

    @property
    def extraction_engine(self) -> CaptureEngineV1 | None:
        return self._engine

    @property
    def covered_until_ms(self) -> int:
        return self._covered_until_ms

    @property
    def partial(self) -> PartialCaptureV2:
        if self._engine is None:
            raise ProgressiveAudioError("partial capture is not available before transcription")
        return PartialCaptureV2(
            capture_id=self.capture_id,
            source=self.source,
            revision=self._partial_revision,
            covered_until_ms=self._covered_until_ms,
            segments=list(self._segments),
            source_text=project_source_text(self._segments),
            extraction_engine=self._engine,
            updated_at=self.clock.now(),
        )

    def feed(self, data: bytes) -> list[ProgressiveSessionEvent]:
        self._ensure_open()
        if not data:
            return self.drain_events()
        if self._buffered_bytes + len(data) > self.max_buffer_bytes:
            raise ProgressiveBackpressureError("progressive decoder input buffer is full")
        self._buffered_bytes += len(data)
        try:
            windows = tuple(self.decoder.push(data))
        finally:
            self._buffered_bytes = 0
        for window in windows:
            self._consume(window)
        return self.drain_events()

    def tick(self) -> list[ProgressiveSessionEvent]:
        if self._terminal:
            return self.drain_events()
        now = self.clock.now()
        elapsed_heartbeat = _elapsed_ms(self._last_heartbeat_at, now)
        if elapsed_heartbeat >= self.heartbeat_ms:
            self._pending_events.append(
                ProgressiveSessionEvent(StreamingEventType.HEARTBEAT, "extracting")
            )
            self._last_heartbeat_at = now
        if _elapsed_ms(self._last_progress_at, now) >= self.stall_timeout_ms:
            self._fail(
                code="progressive_stall",
                message="Progressive audio extraction stopped producing observable progress.",
                retryable=True,
                stage="watchdog",
            )
        return self.drain_events()

    def consume_window(self, window: DecodedAudioWindow) -> list[ProgressiveSessionEvent]:
        """Consume an already decoded bounded window from the worker seam."""

        self._ensure_open()
        result = self.transcriber.transcribe(window)
        self.consume_window_result(window, result)
        return self.drain_events()

    def consume_window_result(
        self,
        window: DecodedAudioWindow,
        result: WhisperWindowResult,
    ) -> None:
        """Merge a bounded worker result without exposing session internals."""

        self._ensure_open()
        self._consume_result(window, result)

    def finish(self) -> list[ProgressiveSessionEvent]:
        self._ensure_open()
        self._finished = True
        for window in tuple(self.decoder.finish()):
            self._consume(window)
        if self._terminal:
            return self.drain_events()
        if not self._segments:
            self._fail(
                code="progressive_no_text_at_sample",
                message="No non-empty text was produced by the final progressive sample.",
                retryable=True,
                stage="checkpoint",
            )
            return self.drain_events()
        if self._covered_until_ms > 0 and self._covered_until_ms < self._next_checkpoint_ms:
            self._emit_checkpoint(self._covered_until_ms)
        self._terminal = True
        self._pending_events.append(
            ProgressiveSessionEvent(StreamingEventType.COMPLETED, "completed")
        )
        return self.drain_events()

    def cancel(self) -> list[ProgressiveSessionEvent]:
        if not self._terminal:
            self._terminal = True
            self._pending_events.append(
                ProgressiveSessionEvent(StreamingEventType.CANCELLED, "cancelled")
            )
        return self.drain_events()

    def drain_events(self) -> list[ProgressiveSessionEvent]:
        events = self._pending_events
        self._pending_events = []
        return events

    def _consume(self, window: DecodedAudioWindow) -> None:
        if window.end_ms <= self._covered_until_ms:
            return
        if window.start_ms > self._covered_until_ms + self.overlap_ms:
            raise ProgressiveAudioError("decoded audio windows have a gap")
        result = self.transcriber.transcribe(window)
        self._consume_result(window, result)

    def _consume_result(self, window: DecodedAudioWindow, result: WhisperWindowResult) -> None:
        self._engine = result.extraction_engine
        for warning in result.warnings:
            if warning not in self._warnings:
                self._warnings.append(warning)
        self._merge_segments(window, result.segments)
        self._covered_until_ms = max(self._covered_until_ms, window.end_ms)
        self._last_progress_at = self.clock.now()
        self._emit_due_checkpoints()

    def _merge_segments(
        self,
        window: DecodedAudioWindow,
        segments: Iterable[WhisperWindowSegment],
    ) -> None:
        newly_sealed: list[RawCaptureSegmentV1] = []
        for segment in segments:
            if not segment.text.strip():
                continue
            start_ms = window.start_ms + max(0, segment.start_ms)
            end_ms = min(window.end_ms, window.start_ms + segment.end_ms)
            if end_ms <= start_ms:
                continue
            normalized = _normalize_text(segment.text)
            duplicate = next(
                (
                    current
                    for current in reversed(self._segments)
                    if _normalize_text(current.text) == normalized
                    and _segment_overlaps(current, start_ms, end_ms)
                ),
                None,
            )
            if duplicate is not None:
                locator = duplicate.locator
                assert isinstance(locator, TimeLocatorV1)
                duplicate.locator = TimeLocatorV1(
                    start_ms=min(locator.start_ms, start_ms),
                    end_ms=max(locator.end_ms, end_ms),
                )
                continue
            sealed = RawCaptureSegmentV1(
                segment_id=f"segment-{len(self._segments) + 1}",
                order=len(self._segments),
                locator=TimeLocatorV1(start_ms=start_ms, end_ms=end_ms),
                text=segment.text.strip(),
            )
            self._segments.append(sealed)
            newly_sealed.append(sealed)
        self._canonicalize_segments()
        if newly_sealed:
            self._partial_revision += 1
            self._pending_events.append(
                ProgressiveSessionEvent(
                    StreamingEventType.SEGMENT,
                    "extracting",
                    partial_revision=self._partial_revision,
                    covered_until_ms=self._covered_until_ms,
                    segments=tuple(sorted(newly_sealed, key=lambda segment: segment.order)),
                )
            )

    def _canonicalize_segments(self) -> None:
        """Keep durable raw segments ordered when overlap windows arrive out of order."""

        self._segments.sort(
            key=lambda segment: (
                _segment_start(segment),
                _segment_end(segment),
                segment.segment_id,
            )
        )
        for order, segment in enumerate(self._segments):
            segment.order = order

    def _emit_due_checkpoints(self) -> None:
        while self._covered_until_ms >= self._next_checkpoint_ms:
            if not self._segments:
                self._fail(
                    code="progressive_no_text_at_sample",
                    message="No non-empty text was produced at the 5 minute audio sample.",
                    retryable=True,
                    stage="checkpoint",
                )
                return
            self._emit_checkpoint(self._next_checkpoint_ms)
            self._next_checkpoint_ms += self.checkpoint_ms

    def _emit_checkpoint(self, covered_until_ms: int) -> None:
        self._pending_events.append(
            ProgressiveSessionEvent(
                StreamingEventType.CHECKPOINT,
                "checkpoint",
                partial_revision=self._partial_revision,
                covered_until_ms=covered_until_ms,
            )
        )

    def _fail(self, *, code: str, message: str, retryable: bool, stage: str) -> None:
        if self._terminal:
            return
        self._terminal = True
        self._pending_events.append(
            ProgressiveSessionEvent(
                StreamingEventType.FAILED,
                stage,
                error=CaptureFailureV2(
                    code=code,
                    message=message,
                    stage=stage,
                    retryable=retryable,
                ),
            )
        )

    def _ensure_open(self) -> None:
        if self._terminal or self._finished:
            raise ProgressiveSessionClosedError("progressive audio session is closed")


def _elapsed_ms(start: datetime, end: datetime) -> int:
    return max(0, round((end - start).total_seconds() * 1000))


def _normalize_text(value: str) -> str:
    return " ".join(value.split()).casefold()


def _overlaps(first_start: int, first_end: int, second_start: int, second_end: int) -> bool:
    return max(first_start, second_start) < min(first_end, second_end)


def _segment_overlaps(segment: RawCaptureSegmentV1, start_ms: int, end_ms: int) -> bool:
    locator = segment.locator
    return isinstance(locator, TimeLocatorV1) and _overlaps(
        locator.start_ms, locator.end_ms, start_ms, end_ms
    )


def _segment_start(segment: RawCaptureSegmentV1) -> int:
    locator = segment.locator
    if not isinstance(locator, TimeLocatorV1):
        raise ProgressiveAudioError("progressive audio segment locator is not time-based")
    return locator.start_ms


def _segment_end(segment: RawCaptureSegmentV1) -> int:
    locator = segment.locator
    if not isinstance(locator, TimeLocatorV1):
        raise ProgressiveAudioError("progressive audio segment locator is not time-based")
    return locator.end_ms


__all__ = [
    "DEFAULT_CHECKPOINT_MS",
    "DEFAULT_HEARTBEAT_MS",
    "DEFAULT_OVERLAP_MS",
    "DEFAULT_STALL_TIMEOUT_MS",
    "DEFAULT_WINDOW_MS",
    "DecodedAudioWindow",
    "IncrementalAudioDecoder",
    "MAX_PROGRESSIVE_WINDOW_BYTES",
    "ProgressiveAudioError",
    "ProgressiveAudioSession",
    "ProgressiveBackpressureError",
    "ProgressiveSessionClosedError",
    "ProgressiveSessionEvent",
    "WhisperWindowResult",
    "WhisperWindowSegment",
    "WhisperWindowTranscriber",
]
