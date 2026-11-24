"""Runtime orchestration for bounded progressive audio capture."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import time
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from uuid import uuid4

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig, worker_child_environment
from capture_runtime.constants import (
    SPEECH_RECOGNITION_REQUIREMENT_ID,
    SPEECH_SESSION_TEMP_DIR_PREFIX,
)
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureEventType,
    CaptureSource,
    OperationFailure,
    PartialCapture,
    RawCapture,
    RawCaptureSegment,
    TimeLocator,
    project_source_text,
)
from capture_runtime.processing_error import CaptureProcessingError
from capture_runtime.provisioning.infrastructure.engine_content_selection import (
    speech_model_not_installed_message,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineInstallationManager,
    ExtractionRuntimeUnavailableError,
    RequirementResolutionTimeoutError,
    SpeechModelNotInstalledError,
)
from capture_runtime.speech.infrastructure.progressive_audio import (
    DEFAULT_HEARTBEAT_MS,
    DEFAULT_OVERLAP_MS,
    DEFAULT_STALL_TIMEOUT_MS,
    DEFAULT_WINDOW_MS,
    DecodedAudioWindow,
    ProgressiveSessionEvent,
)
from capture_runtime.speech.infrastructure.progressive_decoder import (
    AudioDurationExceededError,
    ProgressiveDecoderError,
    PyAVFileDecoder,
)
from capture_runtime.speech.infrastructure.speech_session import (
    SESSION_PROTOCOL_VERSION,
    SessionFrameType,
    encode_audio_input,
    encode_control,
    encode_credit,
)
from capture_runtime.worker_client import InstalledEngine
from capture_runtime.worker_process import (
    WorkerFailureClass,
    WorkerFailureDiagnostics,
    subprocess_path,
)
from capture_runtime.worker_stage_policy import (
    MAX_WORKER_DIAGNOSTIC_STAGES,
    WORKER_STAGE_PATTERN,
    sanitize_worker_stage_sequence,
)

EventSink = Callable[[tuple[ProgressiveSessionEvent, ...], PartialCapture | None], Awaitable[None]]

_WORKER_FAILURE_CLASSES: dict[str, WorkerFailureClass] = {
    "progressive_stall": "timeout",
    "progressive_worker_event_invalid": "protocol",
    "progressive_worker_exit": "exit-before-response",
    "progressive_worker_finish_failed": "worker",
    "progressive_worker_frame_read_failed": "protocol",
    "progressive_worker_input_failed": "worker",
    "progressive_worker_start_failed": "worker",
    "session_failed": "worker",
}


class ProgressiveWorkerFailure(CaptureProcessingError):
    """A capture failure with private diagnostics from its progressive worker."""

    def __init__(
        self, failure: CaptureProcessingError, diagnostics: WorkerFailureDiagnostics
    ) -> None:
        super().__init__(
            failure.args[0],
            code=failure.code,
            retryable=failure.retryable,
            stage=failure.stage,
        )
        self.diagnostics = diagnostics


@dataclass(slots=True)
class _ProgressiveState:
    source: CaptureSource
    capture_id: str
    clock: Clock
    revision: int = 0
    covered_until_ms: int = 0
    extraction_engine: CaptureEngine | None = None
    segments: list[RawCaptureSegment] = field(default_factory=list)

    @property
    def partial(self) -> PartialCapture | None:
        if self.extraction_engine is None:
            return None
        return PartialCapture(
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
            self.segments.sort(
                key=lambda segment: (
                    _state_segment_start(segment),
                    _state_segment_end(segment),
                    segment.segment_id,
                )
            )
            for order, segment in enumerate(self.segments):
                segment.order = order

    def raw(self) -> RawCapture:
        partial = self.partial
        if partial is None or not partial.segments:
            raise CaptureProcessingError(
                "Progressive audio produced no non-empty content.",
                code="extraction_no_text",
                stage="checkpoint",
            )
        assert partial.extraction_engine is not None
        return RawCapture(
            source=partial.source,
            segments=partial.segments,
            source_text=partial.source_text,
            extraction_engine=partial.extraction_engine,
            warnings=[],
            created_at=partial.updated_at,
        )


def _state_segment_start(segment: RawCaptureSegment) -> int:
    locator = segment.locator
    if not isinstance(locator, TimeLocator):
        raise CaptureProcessingError("progressive audio segment locator is not time-based")
    return locator.start_ms


def _state_segment_end(segment: RawCaptureSegment) -> int:
    locator = segment.locator
    if not isinstance(locator, TimeLocator):
        raise CaptureProcessingError("progressive audio segment locator is not time-based")
    return locator.end_ms


@dataclass(slots=True)
class _WarmWorker:
    key: tuple[str, ...]
    worker: _SessionWorker
    expiry: asyncio.Task[None]


def _with_progress(
    event: ProgressiveSessionEvent, duration_ms: int | None
) -> ProgressiveSessionEvent:
    """Progress from covered time: 5-90%, the last 10% left for structuring as for OCR.

    The event also carries the recording's length, so a host can show covered
    time against it.
    """

    if duration_ms is None or event.covered_until_ms is None:
        return event
    covered = min(1.0, event.covered_until_ms / duration_ms)
    return replace(event, progress=round(0.05 + 0.85 * covered, 4), duration_ms=duration_ms)


def _worker_key(engine: InstalledEngine, config: ExtractionRuntimeConfig) -> tuple[str, ...]:
    return (
        str(engine.executable),
        str(engine.model_dir),
        str(engine.worker_sha256),
        str(config.speech_prefer_gpu),
        str(config.speech_recognition_allow_cpu_fallback),
        config.speech_recognition_model,
        engine.content_id or "",
    )


class ProgressiveCaptureProcessor:
    """Decode bounded windows and drive the framed speech recognition session worker.

    A worker that completes a capture stays warm, with its models loaded, for
    `speech_worker_idle_seconds`: loading TEA-ASR and its aligner takes about
    12 s, and a fresh worker spends about as long again on first use.
    """

    def __init__(
        self,
        *,
        clock: Clock,
        config: ExtractionRuntimeConfig,
        engine_manager: EngineInstallationManager,
    ) -> None:
        self.clock = clock
        self.config = config
        self.engine_manager = engine_manager
        self._warm: _WarmWorker | None = None

    async def _acquire(self, engine: InstalledEngine) -> _SessionWorker:
        key = _worker_key(engine, self.config)
        warm, self._warm = self._warm, None
        if warm is not None:
            warm.expiry.cancel()
            if warm.key == key and warm.worker.alive:
                return warm.worker
            await warm.worker.close()
        return await _SessionWorker.start(engine=engine, config=self.config)

    async def _park(self, key: tuple[str, ...], worker: _SessionWorker) -> None:
        idle = self.config.speech_worker_idle_seconds
        if idle <= 0 or not worker.alive:
            await worker.close()
            return
        await self.release_warm_worker()
        self._warm = _WarmWorker(key, worker, asyncio.create_task(self._expire(worker, idle)))

    async def _expire(self, worker: _SessionWorker, idle: float) -> None:
        await asyncio.sleep(idle)
        if self._warm is not None and self._warm.worker is worker:
            self._warm = None
            await worker.close()

    async def release_warm_worker(self) -> None:
        """Close the warm worker, freeing its GPU memory for another engine."""

        warm, self._warm = self._warm, None
        if warm is not None:
            warm.expiry.cancel()
            await warm.worker.close()

    async def shutdown(self) -> None:
        await self.release_warm_worker()

    async def process(
        self,
        *,
        capture_id: str,
        source: CaptureSource,
        source_path: Path,
        cancellation: asyncio.Event,
        sink: EventSink,
        spoken_language: str | None = None,
    ) -> RawCapture:
        try:
            engine = await self._resolve_engine()
        except ExtractionRuntimeUnavailableError:
            raise
        except TimeoutError as error:
            # The same report as the buffered path gives for a slow engine check.
            raise RequirementResolutionTimeoutError(SPEECH_RECOGNITION_REQUIREMENT_ID) from error
        except Exception as error:
            raise CaptureProcessingError(
                "Progressive speech recognition engine could not be prepared.",
                code="progressive_engine_resolution_failed",
            ) from error
        try:
            decoder = PyAVFileDecoder(
                source_path,
                max_duration_ms=self.config.max_audio_duration_ms,
                should_cancel=cancellation.is_set,
                sample_rate=16_000,
                window_ms=DEFAULT_WINDOW_MS,
                overlap_ms=DEFAULT_OVERLAP_MS,
            )
        except (ProgressiveDecoderError, ValueError) as error:
            raise CaptureProcessingError(
                "Progressive audio decoder could not be prepared.",
                code="progressive_decoder_init_failed",
            ) from error
        state = _ProgressiveState(source, capture_id, self.clock)
        events: list[ProgressiveSessionEvent] = []

        async def emit_event(event: ProgressiveSessionEvent) -> None:
            event = _with_progress(event, decoder.duration_ms)
            state.apply(event)
            try:
                partial = (
                    state.partial
                    if event.event_type in {CaptureEventType.SEGMENT, CaptureEventType.CHECKPOINT}
                    else None
                )
            except Exception as error:
                raise CaptureProcessingError(
                    "Progressive partial output failed strict schema validation.",
                    code="progressive_partial_invalid",
                ) from error
            try:
                await sink((event,), partial)
            except CaptureProcessingError:
                raise
            except Exception as error:
                raise CaptureProcessingError(
                    "Progressive event could not be persisted.",
                    code="progressive_event_persist_failed",
                ) from error

        try:
            worker = await self._acquire(engine)
        except CaptureProcessingError:
            raise
        except Exception as error:
            startup_failure = CaptureProcessingError(
                "Progressive speech recognition worker could not be started.",
                code="progressive_worker_start_failed",
            )
            raise ProgressiveWorkerFailure(
                startup_failure, WorkerFailureDiagnostics(stage_sequence=(), failure_class="worker")
            ) from error
        reusable = False
        try:
            try:
                await worker.begin(
                    capture_id=capture_id, source=source, spoken_language=spoken_language
                )
            except Exception as error:
                raise CaptureProcessingError(
                    "Progressive speech recognition worker could not be started.",
                    code="progressive_worker_start_failed",
                ) from error
            windows = decoder.windows()
            try:
                while not _terminal_event(events):
                    self._check_cancel(cancellation)
                    # Pull only after the previous window is acknowledged. Shield the
                    # thread so cancellation can join it before closing its container.
                    pending = asyncio.create_task(asyncio.to_thread(next, windows, None))
                    try:
                        window = await asyncio.shield(pending)
                    except asyncio.CancelledError:
                        cancellation.set()
                        with suppress(Exception, asyncio.CancelledError):
                            await _complete_cleanup(pending)
                        raise
                    except InterruptedError:
                        if cancellation.is_set():
                            raise asyncio.CancelledError from None
                        raise
                    except AudioDurationExceededError as error:
                        raise CaptureProcessingError(
                            "Worker operation failed.",
                            code="worker_failed",
                            stage="extraction",
                            retryable=True,
                        ) from error
                    if window is None:
                        break
                    self._check_cancel(cancellation)
                    try:
                        events = await worker.input(window, cancellation, emit_event)
                    except CaptureProcessingError:
                        raise
                    except Exception as error:
                        raise CaptureProcessingError(
                            "Progressive speech recognition worker failed while processing a "
                            "window.",
                            code="progressive_worker_input_failed",
                        ) from error
            finally:
                windows.close()
            if not _terminal_event(events):
                try:
                    events = await worker.finish(cancellation, emit_event)
                except CaptureProcessingError:
                    raise
                except Exception as error:
                    raise CaptureProcessingError(
                        "Progressive speech recognition worker failed while finishing the session.",
                        code="progressive_worker_finish_failed",
                    ) from error
            failure = next(
                (event.error for event in events if event.error),
                None,
            )
            if failure is not None:
                raise CaptureProcessingError(
                    failure.message,
                    code=failure.code,
                    retryable=failure.retryable,
                    stage=failure.stage or "extraction",
                )
            if not any(event.event_type is CaptureEventType.COMPLETED for event in events):
                raise CaptureProcessingError("Progressive audio worker ended without completion.")
            raw = state.raw()
            reusable = not cancellation.is_set()
            return raw
        except CaptureProcessingError as failure:
            cause = failure.__cause__
            worker_error = cause if isinstance(cause, CaptureProcessingError) else failure
            failure_class = _WORKER_FAILURE_CLASSES.get(
                worker_error.code, _WORKER_FAILURE_CLASSES.get(failure.code)
            )
            if failure_class is None:
                raise
            if isinstance(cause, asyncio.IncompleteReadError):
                failure_class = "exit-before-response"
            diagnostics = await worker.failure_diagnostics(failure_class)
            raise ProgressiveWorkerFailure(failure, diagnostics) from cause
        finally:
            if reusable:
                await self._park(_worker_key(engine, self.config), worker)
            else:
                await _complete_cleanup(asyncio.create_task(worker.close()))

    async def _resolve_engine(self) -> InstalledEngine:
        engine = await self.engine_manager.resolve_active_engine(SPEECH_RECOGNITION_REQUIREMENT_ID)
        if engine is None:
            raise ExtractionRuntimeUnavailableError(
                "Runtime requirement speech-recognition is not installed and ready."
            )
        # Before a session worker is started or a warm one is reused. The worker's
        # own "model not installed" check remains, but that failure never reaches
        # the host as this sentence.
        missing = speech_model_not_installed_message(
            engine.content_id, self.config.speech_recognition_model
        )
        if missing is not None:
            raise SpeechModelNotInstalledError(missing)
        return engine

    @staticmethod
    def _check_cancel(cancellation: asyncio.Event) -> None:
        if cancellation.is_set():
            raise asyncio.CancelledError


async def _complete_cleanup[T](pending: asyncio.Task[T]) -> T:
    """Join cleanup despite repeated caller cancellation, then propagate it."""

    cancelled = False
    while not pending.done():
        try:
            await asyncio.shield(pending)
        except asyncio.CancelledError:
            cancelled = True
    result = pending.result()
    if cancelled:
        raise asyncio.CancelledError
    return result


def _session_worker_launch(executable: Path) -> tuple[list[str], str]:
    """Build a native-child command from a Windows-safe canonical path."""

    subprocess_executable = subprocess_path(executable)
    command = (
        [sys.executable, subprocess_executable, "session"]
        if executable.suffix.casefold() in {".py", ".pyw"}
        else [subprocess_executable, "session"]
    )
    return command, subprocess_path(executable.parent)


def _remove_session_temp_dir(directory: Path) -> None:
    """Remove a session worker's own directory; never follow a link or junction."""

    with suppress(OSError):
        metadata = directory.lstat()
        if stat.S_ISDIR(metadata.st_mode) and not (
            getattr(metadata, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT
        ):
            shutil.rmtree(directory)


class _SessionWorker:
    def __init__(
        self,
        process: asyncio.subprocess.Process,
        stderr_task: asyncio.Task[tuple[str, ...]],
        *,
        temp_dir: Path | None = None,
        stderr_tail: bytearray | None = None,
    ) -> None:
        self.process = process
        assert process.stdin is not None
        assert process.stdout is not None
        self.stdin = process.stdin
        self.stdout = process.stdout
        self._stderr_task = stderr_task
        self._stderr_tail = stderr_tail
        self._temp_dir = temp_dir
        self._closed = False
        # The worker's last stage; the runtime's own heartbeats repeat it.
        self._stage = "transcribing"

    @property
    def alive(self) -> bool:
        return self.process.returncode is None

    @classmethod
    async def start(
        cls,
        *,
        engine: InstalledEngine,
        config: ExtractionRuntimeConfig,
    ) -> _SessionWorker:
        executable = engine.executable
        command, cwd = _session_worker_launch(executable)
        environment = dict(worker_child_environment())
        environment.update(
            {
                "CAPTURE_SESSION_MODEL_PATH": subprocess_path(engine.model_dir),
                "CAPTURE_SESSION_PREFER_GPU": "1" if config.speech_prefer_gpu else "0",
                "CAPTURE_SESSION_ALLOW_CPU_FALLBACK": (
                    "1" if config.speech_recognition_allow_cpu_fallback else "0"
                ),
                **(
                    {"CAPTURE_SESSION_SPEECH_MODEL": config.speech_recognition_model}
                    if config.speech_recognition_model != "auto"
                    else {}
                ),
            }
        )
        # Sibling of the model setting. Only a state "2" engine has one,
        # and it is the id recorded at install, not a fresh detection.
        content_id = engine.content_id
        if content_id is not None:
            environment["CAPTURE_SESSION_SPEECH_CONTENT"] = content_id
        config.temp_dir.mkdir(parents=True, exist_ok=True)
        temp_dir = config.temp_dir.absolute() / f"{SPEECH_SESSION_TEMP_DIR_PREFIX}{uuid4().hex}"
        temp_dir.mkdir(exist_ok=False)
        try:
            environment["CAPTURE_SESSION_TEMP_DIR"] = subprocess_path(temp_dir)
            process = await asyncio.create_subprocess_exec(
                *command,
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=environment,
                cwd=cwd,
                limit=4 * 1024 * 1024 + 5,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
        except (Exception, asyncio.CancelledError):
            await asyncio.to_thread(_remove_session_temp_dir, temp_dir)
            raise
        assert process.stderr is not None
        stderr_tail = bytearray()
        return cls(
            process,
            asyncio.create_task(_drain_stderr(process.stderr, stderr_tail)),
            temp_dir=temp_dir,
            stderr_tail=stderr_tail,
        )

    async def begin(
        self, *, capture_id: str, source: CaptureSource, spoken_language: str | None = None
    ) -> None:
        """Start one capture's session; a warm worker serves one after another."""

        # Same buffer `_drain_stderr` parses when the pipe closes, so a warm
        # worker does not report the previous capture's stages.
        if self._stderr_tail is not None:
            self._stderr_tail.clear()
        await self._send(
            encode_control(
                SessionFrameType.START,
                {
                    "protocolVersion": SESSION_PROTOCOL_VERSION,
                    "sessionId": capture_id,
                    "sampleRate": 16_000,
                    "channels": 1,
                    "windowMs": DEFAULT_WINDOW_MS,
                    "overlapMs": DEFAULT_OVERLAP_MS,
                    "source": {
                        "sha256": source.sha256,
                        "fileName": source.file_name,
                        "mediaType": source.media_type,
                        "bytes": source.bytes,
                    },
                    **({"spokenLanguage": spoken_language} if spoken_language else {}),
                },
            )
        )

    async def input(
        self,
        window: DecodedAudioWindow,
        cancellation: asyncio.Event,
        on_event: Callable[[ProgressiveSessionEvent], Awaitable[None]],
    ) -> list[ProgressiveSessionEvent]:
        await self._send(encode_credit(1))
        await self._send(encode_audio_input(window))
        return await self._read_batch(cancellation, until_ack=True, on_event=on_event)

    async def finish(
        self,
        cancellation: asyncio.Event,
        on_event: Callable[[ProgressiveSessionEvent], Awaitable[None]],
    ) -> list[ProgressiveSessionEvent]:
        await self._send(encode_control(SessionFrameType.FINISH))
        return await self._read_batch(cancellation, until_ack=False, on_event=on_event)

    async def _read_batch(
        self,
        cancellation: asyncio.Event,
        *,
        until_ack: bool,
        on_event: Callable[[ProgressiveSessionEvent], Awaitable[None]],
    ) -> list[ProgressiveSessionEvent]:
        events: list[ProgressiveSessionEvent] = []
        last_observable = time.monotonic()
        read_task = asyncio.create_task(self._read_frame())
        try:
            while True:
                if cancellation.is_set():
                    await self._send(encode_control(SessionFrameType.CANCEL))
                    raise asyncio.CancelledError
                done, _ = await asyncio.wait({read_task}, timeout=DEFAULT_HEARTBEAT_MS / 1000)
                if not done:
                    if time.monotonic() - last_observable >= DEFAULT_STALL_TIMEOUT_MS / 1000:
                        raise CaptureProcessingError(
                            "Progressive audio extraction stopped producing observable progress.",
                            code="progressive_stall",
                            stage="watchdog",
                        )
                    heartbeat = ProgressiveSessionEvent(CaptureEventType.HEARTBEAT, self._stage)
                    events.append(heartbeat)
                    await on_event(heartbeat)
                    continue
                try:
                    frame_type, payload = read_task.result()
                except asyncio.IncompleteReadError as error:
                    raise CaptureProcessingError(
                        "Progressive audio worker exited before completing the session.",
                        code="progressive_worker_exit",
                        stage="extraction",
                    ) from error
                except CaptureProcessingError:
                    raise
                except Exception as error:
                    raise CaptureProcessingError(
                        "Progressive audio worker frame could not be read.",
                        code="progressive_worker_frame_read_failed",
                        stage="extraction",
                    ) from error
                read_task = asyncio.create_task(self._read_frame())
                if frame_type is SessionFrameType.HEARTBEAT:
                    last_observable = time.monotonic()
                    payload_object = _json_object(payload)
                    if until_ack and payload_object.get("stage") == "input_ack":
                        return events
                    if payload_object.get("stage") not in (None, "", "input_ack"):
                        self._stage = str(payload_object["stage"])
                    heartbeat = ProgressiveSessionEvent(CaptureEventType.HEARTBEAT, self._stage)
                    events.append(heartbeat)
                    await on_event(heartbeat)
                    continue
                last_observable = time.monotonic()
                if frame_type is SessionFrameType.SEALED_SEGMENT:
                    try:
                        event = _segment_event(payload)
                    except CaptureProcessingError:
                        raise
                    except Exception as error:
                        raise CaptureProcessingError(
                            "Progressive worker returned an invalid segment event.",
                            code="progressive_worker_event_invalid",
                        ) from error
                    events.append(event)
                    await on_event(event)
                    continue
                if frame_type is SessionFrameType.CHECKPOINT:
                    try:
                        event = _checkpoint_event(payload)
                    except CaptureProcessingError:
                        raise
                    except Exception as error:
                        raise CaptureProcessingError(
                            "Progressive worker returned an invalid checkpoint event.",
                            code="progressive_worker_event_invalid",
                        ) from error
                    events.append(event)
                    await on_event(event)
                    continue
                if frame_type is SessionFrameType.ERROR:
                    try:
                        event = _failure_event(payload)
                        if event.error is not None and event.error.code == "session_failed":
                            stage_sequence = ">".join(await self._worker_stage_sequence())
                            if stage_sequence:
                                event = ProgressiveSessionEvent(
                                    event.event_type,
                                    event.stage,
                                    error=event.error.model_copy(
                                        update={
                                            "message": (
                                                "Speech recognition session failed at stages "
                                                f"{stage_sequence}."
                                            )
                                        }
                                    ),
                                )
                    except CaptureProcessingError:
                        raise
                    except Exception as error:
                        raise CaptureProcessingError(
                            "Progressive worker returned an invalid failure event.",
                            code="progressive_worker_event_invalid",
                        ) from error
                    events.append(event)
                    await on_event(event)
                    return events
                if frame_type is SessionFrameType.COMPLETED:
                    event = ProgressiveSessionEvent(CaptureEventType.COMPLETED, "completed")
                    events.append(event)
                    await on_event(event)
                    return events
                raise CaptureProcessingError("Progressive worker returned an invalid frame.")
        finally:
            if not read_task.done():
                read_task.cancel()
            with suppress(asyncio.CancelledError):
                await read_task

    async def _read_frame(self) -> tuple[SessionFrameType, bytes]:
        header = await self.stdout.readexactly(5)
        raw_type, payload_size = struct.unpack(">BI", header)
        if payload_size > 4 * 1024 * 1024:
            raise CaptureProcessingError("Progressive worker frame exceeded the safety limit.")
        payload = await self.stdout.readexactly(payload_size)
        try:
            return SessionFrameType(chr(raw_type)), payload
        except ValueError as error:
            raise CaptureProcessingError("Progressive worker frame type was invalid.") from error

    async def _send(self, payload: bytes) -> None:
        try:
            self.stdin.write(payload)
            await self.stdin.drain()
        except (BrokenPipeError, ConnectionError, OSError) as error:
            stage_sequence = ">".join(await self._worker_stage_sequence())
            message = (
                "Source extraction worker failed."
                if not stage_sequence
                else f"Source extraction worker failed at stages {stage_sequence}."
            )
            raise CaptureProcessingError(
                message,
                code="progressive_worker_exit",
                stage="extraction",
            ) from error

    async def failure_diagnostics(
        self, failure_class: WorkerFailureClass
    ) -> WorkerFailureDiagnostics:
        # Callers that already collected stages leave them in the tail. Wait for
        # the drain only when the worker exited before answering.
        if failure_class == "exit-before-response":
            stages = await self._worker_stage_sequence()
            if not stages and self._stderr_tail:
                stages = _stderr_stages(self._stderr_tail)
        else:
            stages = _stderr_stages(self._stderr_tail) if self._stderr_tail else ()
        if failure_class == "exit-before-response" and self.process.returncode is None:
            # Pipe EOF may arrive before the subprocess transport reports exit.
            with suppress(TimeoutError):
                await asyncio.wait_for(self.process.wait(), timeout=0.2)
        return WorkerFailureDiagnostics(
            stage_sequence=stages,
            failure_class=failure_class,
            exit_code=self.process.returncode,
        )

    async def _worker_stage_sequence(self) -> tuple[str, ...]:
        if not self._stderr_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._stderr_task), timeout=0.2)
            except TimeoutError:
                pass
            except asyncio.CancelledError:
                # The capture task's own cancellation must propagate. shield()
                # leaves the stderr task running in that case; a cancelled
                # stderr task is the only CancelledError that stops here.
                if not self._stderr_task.cancelled():
                    raise
        if not self._stderr_task.done() or self._stderr_task.cancelled():
            return ()
        with suppress(Exception):
            return self._stderr_task.result()
        return ()

    async def close(self) -> None:
        if self._closed:
            return
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
        self._closed = True
        if self.process.returncode is not None and self._temp_dir is not None:
            await asyncio.to_thread(_remove_session_temp_dir, self._temp_dir)


async def _drain_stderr(
    stream: asyncio.StreamReader, captured: bytearray | None = None
) -> tuple[str, ...]:
    if captured is None:
        captured = bytearray()
    while chunk := await stream.read(16 * 1024):
        captured.extend(chunk)
        if len(captured) > 64 * 1024:
            del captured[: -64 * 1024]
    return _stderr_stages(captured)


def _stderr_stages(captured: bytearray) -> tuple[str, ...]:
    stages = sanitize_worker_stage_sequence(
        WORKER_STAGE_PATTERN.findall(captured.decode("utf-8", errors="replace")),
        reject_unknown=False,
    )
    return stages[-MAX_WORKER_DIAGNOSTIC_STAGES:]


def _segment_event(payload: bytes) -> ProgressiveSessionEvent:
    value = _json_object(payload)
    return ProgressiveSessionEvent(
        CaptureEventType.SEGMENT,
        "extracting",
        partial_revision=int(value["partialRevision"]),
        covered_until_ms=int(value["coveredUntilMs"]),
        segments=tuple(RawCaptureSegment.model_validate(item) for item in value["segments"]),
        extraction_engine=(
            None
            if value.get("extractionEngine") is None
            else CaptureEngine.model_validate(value["extractionEngine"])
        ),
    )


def _checkpoint_event(payload: bytes) -> ProgressiveSessionEvent:
    value = _json_object(payload)
    return ProgressiveSessionEvent(
        CaptureEventType.CHECKPOINT,
        "checkpoint",
        partial_revision=int(value["partialRevision"]),
        covered_until_ms=int(value["coveredUntilMs"]),
    )


def _failure_event(payload: bytes) -> ProgressiveSessionEvent:
    value = _json_object(payload)
    return ProgressiveSessionEvent(
        CaptureEventType.FAILED,
        str(value.get("stage") or "extraction"),
        error=OperationFailure.model_validate(value),
    )


def _terminal_event(
    events: list[ProgressiveSessionEvent] | tuple[ProgressiveSessionEvent, ...],
) -> bool:
    return any(
        event.event_type
        in {
            CaptureEventType.FAILED,
            CaptureEventType.CANCELLED,
            CaptureEventType.COMPLETED,
        }
        for event in events
    )


def _json_object(payload: bytes) -> dict[str, Any]:
    try:
        value = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CaptureProcessingError("Progressive worker event was invalid.") from error
    if not isinstance(value, dict):
        raise CaptureProcessingError("Progressive worker event was not an object.")
    return value


__all__ = ["ProgressiveCaptureProcessor", "ProgressiveWorkerFailure"]
