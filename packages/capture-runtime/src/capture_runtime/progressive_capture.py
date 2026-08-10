"""Runtime orchestration for bounded progressive audio capture."""

from __future__ import annotations

import asyncio
import json
import os
import struct
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig, sanitized_child_environment
from capture_runtime.constants import WHISPER_REQUIREMENT_ID
from capture_runtime.contracts import (
    CaptureEngineV1,
    CaptureFailureV2,
    CaptureSourceV1,
    PartialCaptureV2,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StreamingEventType,
    project_source_text,
)
from capture_runtime.engine_installation import EngineInstallationManager
from capture_runtime.extractors import ExtractionRuntimeUnavailableError
from capture_runtime.progressive_audio import (
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_OVERLAP_MS,
    DEFAULT_STALL_TIMEOUT_MS,
    DEFAULT_WINDOW_MS,
    DecodedAudioWindow,
    ProgressiveSessionEvent,
)
from capture_runtime.progressive_decoder import PyAVIncrementalDecoder
from capture_runtime.whisper_session import (
    SessionFrameType,
    encode_audio_input,
    encode_control,
    encode_credit,
)
from capture_runtime.worker_client import InstalledEngine

STREAM_READ_BYTES = 1024 * 1024


class ProgressiveCaptureError(RuntimeError):
    """A safe runtime-side progressive processing failure."""

    def __init__(
        self,
        message: str,
        *,
        code: str = "progressive_failed",
        retryable: bool = True,
        stage: str = "extraction",
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.stage = stage


EventSink = Callable[
    [tuple[ProgressiveSessionEvent, ...], PartialCaptureV2 | None], Awaitable[None]
]


@dataclass(slots=True)
class _ProgressiveState:
    source: CaptureSourceV1
    capture_id: str
    clock: Clock
    revision: int = 0
    covered_until_ms: int = 0
    extraction_engine: CaptureEngineV1 | None = None
    segments: list[RawCaptureSegmentV1] = field(default_factory=list)

    @property
    def partial(self) -> PartialCaptureV2 | None:
        if self.extraction_engine is None:
            return None
        return PartialCaptureV2(
            capture_id=self.capture_id,
            source=self.source,
            revision=self.revision,
            covered_until_ms=self.covered_until_ms,
            segments=list(self.segments),
            source_text=project_source_text(self.segments),
            extraction_engine=self.extraction_engine,
            updated_at=self.clock.now(),
        )

    def apply(self, event: ProgressiveSessionEvent) -> None:
        if event.extraction_engine is not None:
            self.extraction_engine = event.extraction_engine
        if event.partial_revision is not None:
            self.revision = max(self.revision, event.partial_revision)
        if event.covered_until_ms is not None:
            self.covered_until_ms = max(self.covered_until_ms, event.covered_until_ms)
        if event.segments:
            known = {segment.segment_id for segment in self.segments}
            self.segments.extend(
                segment for segment in event.segments if segment.segment_id not in known
            )
            self.segments.sort(key=lambda segment: segment.order)

    def raw(self) -> RawCaptureV1:
        partial = self.partial
        if partial is None or not partial.segments:
            raise ProgressiveCaptureError(
                "Progressive audio produced no non-empty content.",
                code="progressive_no_text_at_sample",
                stage="checkpoint",
            )
        assert partial.extraction_engine is not None
        return RawCaptureV1(
            source=partial.source,
            segments=partial.segments,
            source_text=partial.source_text,
            extraction_engine=partial.extraction_engine,
            warnings=[],
            created_at=partial.updated_at,
        )


class ProgressiveCaptureProcessor:
    """Decode bounded windows and drive the framed Whisper session worker."""

    def __init__(
        self,
        *,
        clock: Clock,
        config: ExtractionRuntimeConfig,
        engine_manager: EngineInstallationManager,
        staging_root: Path,
    ) -> None:
        self.clock = clock
        self.config = config
        self.engine_manager = engine_manager
        self.staging_root = staging_root

    async def process(
        self,
        *,
        capture_id: str,
        source: CaptureSourceV1,
        source_path: Path,
        cancellation: asyncio.Event,
        sink: EventSink,
    ) -> RawCaptureV1:
        engine = await self._resolve_engine()
        spool_path = self.staging_root / f"progressive-{capture_id}.spool"
        decoder = PyAVIncrementalDecoder(
            spool_path,
            sample_rate=16_000,
            window_ms=DEFAULT_WINDOW_MS,
            overlap_ms=DEFAULT_OVERLAP_MS,
            max_spool_bytes=source.bytes,
        )
        state = _ProgressiveState(source, capture_id, self.clock)
        events: list[ProgressiveSessionEvent] = []
        worker = await _SessionWorker.start(
            engine=engine,
            source=source,
            capture_id=capture_id,
            config=self.config,
        )
        try:
            with source_path.open("rb") as source_file:
                while chunk := source_file.read(STREAM_READ_BYTES):
                    self._check_cancel(cancellation)
                    for window in decoder.push(chunk):
                        events = await worker.input(window, cancellation)
                        await self._emit(events, state, sink)
                        if _terminal_event(events):
                            break
                    if _terminal_event(events):
                        break
            if not _terminal_event(events):
                for window in decoder.finish():
                    events = await worker.input(window, cancellation)
                    await self._emit(events, state, sink)
                    if _terminal_event(events):
                        break
            if not _terminal_event(events):
                events = await worker.finish(cancellation)
                await self._emit(events, state, sink)
            failure = next(
                (event.error for event in events if event.error),
                None,
            )
            if failure is not None:
                raise ProgressiveCaptureError(
                    failure.message,
                    code=failure.code,
                    retryable=failure.retryable,
                    stage=failure.stage or "extraction",
                )
            if not any(event.event_type is StreamingEventType.COMPLETED for event in events):
                raise ProgressiveCaptureError("Progressive audio worker ended without completion.")
            return state.raw()
        finally:
            await worker.close()
            spool_path.unlink(missing_ok=True)

    async def _resolve_engine(self) -> InstalledEngine:
        engine = await self.engine_manager.resolve_active_engine(WHISPER_REQUIREMENT_ID)
        if engine is None:
            raise ExtractionRuntimeUnavailableError(
                "Runtime requirement whisper-primary is not installed and ready."
            )
        return engine

    @staticmethod
    def _check_cancel(cancellation: asyncio.Event) -> None:
        if cancellation.is_set():
            raise asyncio.CancelledError

    @staticmethod
    async def _emit(
        events: list[ProgressiveSessionEvent],
        state: _ProgressiveState,
        sink: EventSink,
    ) -> None:
        for event in events:
            state.apply(event)
        if events:
            await sink(tuple(events), state.partial)


class _SessionWorker:
    def __init__(
        self,
        process: asyncio.subprocess.Process,
        stderr_task: asyncio.Task[None],
    ) -> None:
        self.process = process
        assert process.stdin is not None
        assert process.stdout is not None
        self.stdin = process.stdin
        self.stdout = process.stdout
        self._stderr_task = stderr_task

    @classmethod
    async def start(
        cls,
        *,
        engine: InstalledEngine,
        source: CaptureSourceV1,
        capture_id: str,
        config: ExtractionRuntimeConfig,
    ) -> _SessionWorker:
        executable = engine.executable
        command = (
            [sys.executable, str(executable), "session"]
            if executable.suffix.casefold() in {".py", ".pyw"}
            else [str(executable), "session"]
        )
        environment = dict(sanitized_child_environment())
        environment.update(
            {
                "CAPTURE_SESSION_ID": capture_id,
                "CAPTURE_SESSION_MODEL_PATH": str(engine.model_dir),
                "CAPTURE_SESSION_TEMP_DIR": str(config.temp_dir),
                "CAPTURE_SESSION_SOURCE_SHA256": source.sha256,
                "CAPTURE_SESSION_FILE_NAME": source.file_name,
                "CAPTURE_SESSION_MEDIA_TYPE": source.media_type,
                "CAPTURE_SESSION_SOURCE_BYTES": str(source.bytes),
                "CAPTURE_SESSION_PREFER_GPU": "1" if config.whisper_prefer_gpu else "0",
                "CAPTURE_SESSION_ALLOW_CPU_FALLBACK": (
                    "1" if config.whisper_allow_cpu_fallback else "0"
                ),
            }
        )
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=environment,
            cwd=str(executable.parent),
            limit=4 * 1024 * 1024 + 5,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
        assert process.stderr is not None
        worker = cls(process, asyncio.create_task(_drain_stderr(process.stderr)))
        try:
            await worker._send(
                encode_control(
                    SessionFrameType.START,
                    {
                        "protocolVersion": "2",
                        "sessionId": capture_id,
                        "sampleRate": 16_000,
                        "channels": 1,
                        "windowMs": DEFAULT_WINDOW_MS,
                        "overlapMs": DEFAULT_OVERLAP_MS,
                    },
                )
            )
        except BaseException:
            await worker.close()
            raise
        return worker

    async def input(
        self,
        window: DecodedAudioWindow,
        cancellation: asyncio.Event,
    ) -> list[ProgressiveSessionEvent]:
        await self._send(encode_credit(1))
        await self._send(encode_audio_input(window))
        return await self._read_batch(cancellation, until_ack=True)

    async def finish(
        self,
        cancellation: asyncio.Event,
    ) -> list[ProgressiveSessionEvent]:
        await self._send(encode_control(SessionFrameType.FINISH))
        return await self._read_batch(cancellation, until_ack=False)

    async def _read_batch(
        self,
        cancellation: asyncio.Event,
        *,
        until_ack: bool,
    ) -> list[ProgressiveSessionEvent]:
        events: list[ProgressiveSessionEvent] = []
        last_observable = time.monotonic()
        while True:
            if cancellation.is_set():
                await self._send(encode_control(SessionFrameType.CANCEL))
                raise asyncio.CancelledError
            try:
                frame_type, payload = await asyncio.wait_for(
                    self._read_frame(), timeout=DEFAULT_HEARTBEAT_MS / 1000
                )
            except TimeoutError as error:
                if time.monotonic() - last_observable >= DEFAULT_STALL_TIMEOUT_MS / 1000:
                    raise ProgressiveCaptureError(
                        "Progressive audio extraction stopped producing observable progress.",
                        code="progressive_stall",
                        stage="watchdog",
                    ) from error
                events.append(ProgressiveSessionEvent(StreamingEventType.HEARTBEAT, "extracting"))
                continue
            except asyncio.IncompleteReadError as error:
                raise ProgressiveCaptureError(
                    "Progressive audio worker exited before completing the session.",
                    code="progressive_worker_exit",
                    stage="extraction",
                ) from error
            if frame_type is SessionFrameType.HEARTBEAT:
                payload_object = _json_object(payload)
                if until_ack and payload_object.get("stage") == "input_ack":
                    return events
                events.append(ProgressiveSessionEvent(StreamingEventType.HEARTBEAT, "extracting"))
                continue
            last_observable = time.monotonic()
            if frame_type is SessionFrameType.SEALED_SEGMENT:
                events.append(_segment_event(payload))
                continue
            if frame_type is SessionFrameType.CHECKPOINT:
                events.append(_checkpoint_event(payload))
                continue
            if frame_type is SessionFrameType.ERROR:
                events.append(_failure_event(payload))
                return events
            if frame_type is SessionFrameType.COMPLETED:
                events.append(ProgressiveSessionEvent(StreamingEventType.COMPLETED, "completed"))
                return events
            raise ProgressiveCaptureError("Progressive worker returned an invalid frame.")

    async def _read_frame(self) -> tuple[SessionFrameType, bytes]:
        header = await self.stdout.readexactly(5)
        raw_type, payload_size = struct.unpack(">BI", header)
        if payload_size > 4 * 1024 * 1024:
            raise ProgressiveCaptureError("Progressive worker frame exceeded the safety limit.")
        payload = await self.stdout.readexactly(payload_size)
        try:
            return SessionFrameType(chr(raw_type)), payload
        except ValueError as error:
            raise ProgressiveCaptureError("Progressive worker frame type was invalid.") from error

    async def _send(self, payload: bytes) -> None:
        self.stdin.write(payload)
        await self.stdin.drain()

    async def close(self) -> None:
        if self.process.returncode is None:
            with suppress(ProcessLookupError):
                self.process.terminate()
        try:
            await asyncio.wait_for(self.process.wait(), timeout=3)
        except TimeoutError:
            with suppress(ProcessLookupError):
                self.process.kill()
            with suppress(TimeoutError):
                await asyncio.wait_for(self.process.wait(), timeout=3)
        if not self._stderr_task.done():
            self._stderr_task.cancel()
        with suppress(asyncio.CancelledError):
            await self._stderr_task


async def _drain_stderr(stream: asyncio.StreamReader) -> None:
    while await stream.read(16 * 1024):
        pass


def _segment_event(payload: bytes) -> ProgressiveSessionEvent:
    value = _json_object(payload)
    return ProgressiveSessionEvent(
        StreamingEventType.SEGMENT,
        "extracting",
        partial_revision=int(value["partialRevision"]),
        covered_until_ms=int(value["coveredUntilMs"]),
        segments=tuple(RawCaptureSegmentV1.model_validate(item) for item in value["segments"]),
        extraction_engine=(
            None
            if value.get("extractionEngine") is None
            else CaptureEngineV1.model_validate(value["extractionEngine"])
        ),
    )


def _checkpoint_event(payload: bytes) -> ProgressiveSessionEvent:
    value = _json_object(payload)
    return ProgressiveSessionEvent(
        StreamingEventType.CHECKPOINT,
        "checkpoint",
        partial_revision=int(value["partialRevision"]),
        covered_until_ms=int(value["coveredUntilMs"]),
    )


def _failure_event(payload: bytes) -> ProgressiveSessionEvent:
    value = _json_object(payload)
    return ProgressiveSessionEvent(
        StreamingEventType.FAILED,
        str(value.get("stage") or "extraction"),
        error=CaptureFailureV2.model_validate(value),
    )


def _terminal_event(
    events: list[ProgressiveSessionEvent] | tuple[ProgressiveSessionEvent, ...],
) -> bool:
    return any(
        event.event_type
        in {
            StreamingEventType.FAILED,
            StreamingEventType.CANCELLED,
            StreamingEventType.COMPLETED,
        }
        for event in events
    )


def _json_object(payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ProgressiveCaptureError("Progressive worker event was invalid.") from error
    if not isinstance(value, dict):
        raise ProgressiveCaptureError("Progressive worker event was not an object.")
    return value


__all__ = ["ProgressiveCaptureError", "ProgressiveCaptureProcessor", "STREAM_READ_BYTES"]
