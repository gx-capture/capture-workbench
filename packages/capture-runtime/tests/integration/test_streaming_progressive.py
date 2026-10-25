from __future__ import annotations

import asyncio
import hashlib
import json
import struct
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureSource,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCapture,
    RawCaptureSegment,
    StartCaptureV2,
    StreamingEventType,
    StructuringMode,
    TimeLocator,
)
from capture_runtime.extractors import DeterministicCaptureExtractor
from capture_runtime.progressive_audio import DecodedAudioWindow, ProgressiveSessionEvent
from capture_runtime.progressive_capture import (
    ProgressiveCaptureProcessor,
    _ProgressiveState,
    _session_worker_launch,
    _SessionWorker,
    _with_progress,
    _worker_key,
)
from capture_runtime.progressive_decoder import ProgressiveDecoderError
from capture_runtime.services import StreamingCaptureService
from capture_runtime.storage import StreamingRepository
from capture_runtime.structuring import StructuringValidationError
from capture_runtime.structuring_provider import FakeCaptureStructuringProvider
from capture_runtime.whisper_session import SessionFrameType
from capture_runtime.worker_client import InstalledEngine


def test_progressive_worker_launch_strips_windows_extended_path_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("capture_runtime.worker_process.os.name", "nt")
    command, cwd = _session_worker_launch(Path(r"\\?\C:\capture-workbench\runtime\worker.exe"))

    assert command == [r"C:\capture-workbench\runtime\worker.exe", "session"]
    assert cwd == r"C:\capture-workbench\runtime"


def test_streaming_progress_follows_the_covered_time() -> None:
    # 0.7.1 left a streaming capture's progress unchanged until it ended.
    checkpoint = ProgressiveSessionEvent(
        StreamingEventType.CHECKPOINT, "checkpoint", covered_until_ms=60_000
    )

    assert _with_progress(checkpoint, 120_000).progress == 0.475
    assert _with_progress(checkpoint, 30_000).progress == 0.9
    assert _with_progress(checkpoint, None).progress is None
    heartbeat = ProgressiveSessionEvent(StreamingEventType.HEARTBEAT, "transcribing")
    assert _with_progress(heartbeat, 120_000).progress is None


def test_runtime_heartbeats_repeat_the_workers_last_stage() -> None:
    async def scenario() -> None:
        process_stdout = asyncio.StreamReader()

        def heartbeat(stage: bytes) -> bytes:
            return struct.pack(">BI", ord(SessionFrameType.HEARTBEAT.value), len(stage)) + stage

        process_stdout.feed_data(
            heartbeat(json.dumps({"stage": "loading-model"}).encode())
            + heartbeat(json.dumps({"stage": "input_ack"}).encode())
        )
        process_stdout.feed_eof()

        class Stdin:
            def write(self, _value: bytes) -> None:
                return None

            async def drain(self) -> None:
                return None

        class Process:
            stdin = Stdin()
            stdout = process_stdout
            returncode = 0

            async def wait(self) -> int:
                return 0

        worker = _SessionWorker(Process(), asyncio.create_task(asyncio.sleep(0)))
        seen: list[ProgressiveSessionEvent] = []

        async def on_event(event: ProgressiveSessionEvent) -> None:
            seen.append(event)

        await worker.input(DecodedAudioWindow(0, 1_000, b"pcm"), asyncio.Event(), on_event)
        assert [event.stage for event in seen] == ["loading-model"]
        assert worker._stage == "loading-model"
        await worker.close()

    asyncio.run(scenario())


class _FakeSessionWorker:
    def __init__(self) -> None:
        self.alive = True
        self.closed = False

    async def close(self) -> None:
        self.alive = False
        self.closed = True


def _warm_processor(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, *, idle: float
) -> tuple[ProgressiveCaptureProcessor, list[_FakeSessionWorker]]:
    spawned: list[_FakeSessionWorker] = []

    async def start(*, engine, config):
        spawned.append(_FakeSessionWorker())
        return spawned[-1]

    monkeypatch.setattr(_SessionWorker, "start", start)
    config = ExtractionRuntimeConfig(
        windowsml_model_dir=tmp_path / "windowsml",
        whisper_models_dir=tmp_path / "whisper",
        temp_dir=tmp_path / "temp",
        max_pdf_pages=10,
        max_image_pixels=100_000,
        ocr_render_scale=2,
        max_audio_duration_ms=60_000,
        whisper_primary_model="tea-asr-1.1",
        whisper_fallback_model="tea-asr-1.1-mini",
        whisper_prefer_gpu=True,
        speech_worker_idle_seconds=idle,
    )
    processor = ProgressiveCaptureProcessor(
        clock=FixedClock(),
        config=config,
        engine_manager=None,  # type: ignore[arg-type]
        staging_root=tmp_path,
    )
    return processor, spawned


def _engine(tmp_path: Path, name: str = "speech") -> InstalledEngine:
    return InstalledEngine(
        requirement_id="speech-recognition",
        artifact_version="0.7.2",
        executable=tmp_path / name / "capture-engine-speech-recognition.exe",
        model_dir=tmp_path / name / "model",
        worker_sha256="b" * 64,
    )


def test_a_completed_capture_leaves_its_worker_warm_for_the_next(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        processor, spawned = _warm_processor(tmp_path, monkeypatch, idle=60)
        engine = _engine(tmp_path)
        first = await processor._acquire(engine)
        await processor._park(_worker_key(engine, processor.config), first)  # type: ignore[arg-type]

        assert await processor._acquire(engine) is first
        assert len(spawned) == 1 and not first.closed  # type: ignore[union-attr]

        await processor._park(_worker_key(engine, processor.config), first)  # type: ignore[arg-type]
        other = await processor._acquire(_engine(tmp_path, "upgraded"))
        assert first.closed  # type: ignore[union-attr]
        assert other is spawned[1]
        await processor.shutdown()

    asyncio.run(scenario())


def test_a_warm_worker_closes_when_idle_released_or_disabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        processor, spawned = _warm_processor(tmp_path, monkeypatch, idle=0.01)
        engine = _engine(tmp_path)
        key = _worker_key(engine, processor.config)
        await processor._park(key, await processor._acquire(engine))  # type: ignore[arg-type]
        await asyncio.sleep(0.1)
        assert spawned[0].closed and processor._warm is None

        processor.config = replace(processor.config, speech_worker_idle_seconds=60)
        await processor._park(key, await processor._acquire(engine))  # type: ignore[arg-type]
        await processor.release_warm_worker()
        assert spawned[1].closed and processor._warm is None

        processor.config = replace(processor.config, speech_worker_idle_seconds=0)
        await processor._park(key, await processor._acquire(engine))  # type: ignore[arg-type]
        assert spawned[2].closed and processor._warm is None

    asyncio.run(scenario())


def test_progressive_state_reorders_segments_from_overlapping_worker_events() -> None:
    source = CaptureSource(
        sha256="a" * 64,
        file_name="sample.wav",
        media_type="audio/wav",
        bytes=10,
    )
    state = _ProgressiveState(
        source=source,
        capture_id="capture-state-order",
        clock=FixedClock(),
    )
    engine = CaptureEngine(
        engine="speech-recognition",
        model="tea-asr-1.1-mini",
        digest=f"sha256:{'b' * 64}",
        device="cpu",
    )
    state.apply(
        ProgressiveSessionEvent(
            StreamingEventType.SEGMENT,
            "extracting",
            partial_revision=1,
            covered_until_ms=120_000,
            segments=(
                RawCaptureSegment(
                    segment_id="segment-later",
                    order=0,
                    locator=TimeLocator(start_ms=110_000, end_ms=120_000),
                    text="later",
                ),
            ),
            extraction_engine=engine,
        )
    )
    state.apply(
        ProgressiveSessionEvent(
            StreamingEventType.SEGMENT,
            "extracting",
            partial_revision=2,
            covered_until_ms=210_000,
            segments=(
                RawCaptureSegment(
                    segment_id="segment-earlier",
                    order=0,
                    locator=TimeLocator(start_ms=90_000, end_ms=100_000),
                    text="earlier",
                ),
            ),
            extraction_engine=engine,
        )
    )

    assert [segment.order for segment in state.segments] == [0, 1]
    assert [segment.text for segment in state.segments] == ["earlier", "later"]


class FixedClock(Clock):
    def __init__(self) -> None:
        self.current = datetime(2026, 8, 10, 12, 0, tzinfo=UTC)

    def now(self) -> datetime:
        return self.current


class FakeProgressiveProcessor:
    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.engine = CaptureEngine(
            engine="speech-recognition",
            model="tea-asr-1.1-mini",
            digest=f"sha256:{'a' * 64}",
            device="cpu",
        )

    async def process(self, *, capture_id, source, source_path, cancellation, sink):
        assert source_path.is_file()
        assert not cancellation.is_set()
        segment = RawCaptureSegment(
            segment_id="segment-1",
            order=0,
            locator=TimeLocator(start_ms=0, end_ms=1_000),
            text="hello streaming",
        )
        partial = PartialCaptureV2(
            capture_id=capture_id,
            source=source,
            revision=1,
            covered_until_ms=1_000,
            segments=[segment],
            source_text=segment.text,
            extraction_engine=self.engine,
            updated_at=self.clock.now(),
        )
        await sink(
            (
                ProgressiveSessionEvent(
                    StreamingEventType.SEGMENT,
                    "extracting",
                    partial_revision=1,
                    covered_until_ms=1_000,
                    segments=(segment,),
                    extraction_engine=self.engine,
                ),
            ),
            partial,
        )
        return RawCapture(
            source=source,
            segments=[segment],
            source_text=segment.text,
            extraction_engine=self.engine,
            created_at=self.clock.now(),
        )


class SessionEndingProcessor(FakeProgressiveProcessor):
    """Ends its session with `completed`, as the speech recognition worker does."""

    async def process(self, *, capture_id, source, source_path, cancellation, sink):
        raw = await super().process(
            capture_id=capture_id,
            source=source,
            source_path=source_path,
            cancellation=cancellation,
            sink=sink,
        )
        await sink((ProgressiveSessionEvent(StreamingEventType.COMPLETED, "completed"),), None)
        return raw


class FailingStructurer:
    engine_identity = None

    async def structure(self, raw, *, target_language, cancel_event):
        raise StructuringValidationError("invalid generated structure", issues=[])


class FailingDecoderProcessor:
    async def process(self, *, capture_id, source, source_path, cancellation, sink):
        raise ProgressiveDecoderError("decoder failed")


def _open(repository: StreamingRepository) -> tuple[str, str]:
    source = b"audio-fixture"
    digest = hashlib.sha256(source).hexdigest()
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="progressive-ingestion",
            file_name="sample.mp3",
            media_type="audio/mpeg",
            total_bytes=len(source),
            source_sha256=digest,
        )
    )
    repository.append_chunk(
        ingestion.ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=source,
        sha256=digest,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(source),
    )
    repository.finalize_ingestion(ingestion.ingestion_id, total_bytes=len(source), sha256=digest)
    return ingestion.ingestion_id, digest


def test_progressive_runtime_materializes_partial_raw_result_and_terminal_events(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        clock = FixedClock()
        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        ingestion_id, _ = _open(repository)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            processor=FakeProgressiveProcessor(clock),  # type: ignore[arg-type]
            structurer=FakeCaptureStructuringProvider(clock),
        )
        operation = service.start_capture(
            StartCaptureV2(
                client_request_id="progressive-capture",
                ingestion_id=ingestion_id,
                structuring_mode=StructuringMode.RUNTIME,
            )
        )
        for _ in range(100):
            if service.get_capture(operation.capture_id).status.value == "completed":
                break
            await asyncio.sleep(0.01)
        completed = service.get_capture(operation.capture_id)
        assert completed.status.value == "completed"
        terminal = service.terminal_result(operation.capture_id)
        assert terminal.raw.source_text == "hello streaming"
        assert terminal.result.target_text == "hello streaming"
        event_types = [
            event.event_type
            for event in repository.read_events(operation.capture_id, after_sequence=-1)
        ]
        assert StreamingEventType.SEGMENT in event_types
        assert StreamingEventType.COMPLETED in event_types
        await service.shutdown()

    asyncio.run(scenario())


def test_progressive_runtime_does_not_publish_the_session_end_as_the_capture_end(
    tmp_path: Path,
) -> None:
    # 0.7.1 streamed the session's `completed` while the capture was still
    # extracting, so hosts that stop at `completed` read a stale snapshot.
    async def scenario() -> None:
        clock = FixedClock()
        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        ingestion_id, _ = _open(repository)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            processor=SessionEndingProcessor(clock),  # type: ignore[arg-type]
            structurer=FakeCaptureStructuringProvider(clock),
        )
        operation = service.start_capture(
            StartCaptureV2(
                client_request_id="progressive-host-capture",
                ingestion_id=ingestion_id,
                structuring_mode=StructuringMode.HOST,
            )
        )
        for _ in range(100):
            if service.get_capture(operation.capture_id).status.value == "awaiting_structuring":
                break
            await asyncio.sleep(0.01)
        assert service.get_capture(operation.capture_id).status.value == "awaiting_structuring"
        events = repository.read_events(operation.capture_id, after_sequence=-1)
        assert StreamingEventType.COMPLETED not in [event.event_type for event in events]
        assert (events[-1].event_type, events[-1].stage) == (
            StreamingEventType.CHECKPOINT,
            "awaiting_structuring",
        )
        await service.shutdown()

    asyncio.run(scenario())


def test_progressive_runtime_preserves_structuring_phase_failure_after_raw_materialization(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        clock = FixedClock()
        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        ingestion_id, _ = _open(repository)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            processor=FakeProgressiveProcessor(clock),  # type: ignore[arg-type]
            structurer=FailingStructurer(),  # type: ignore[arg-type]
        )
        operation = service.start_capture(
            StartCaptureV2(
                client_request_id="progressive-structuring-failure",
                ingestion_id=ingestion_id,
                structuring_mode=StructuringMode.RUNTIME,
            )
        )
        for _ in range(100):
            if service.get_capture(operation.capture_id).status.value == "failed":
                break
            await asyncio.sleep(0.01)
        failed = service.get_capture(operation.capture_id)
        assert failed.status.value == "failed"
        assert failed.error is not None
        assert failed.error.code == "structuring_invalid_output"
        assert failed.error.stage == "structuring"
        assert repository.read_raw(operation.capture_id).source_text == "hello streaming"
        await service.shutdown()

    asyncio.run(scenario())


def test_progressive_runtime_exposes_bounded_decoder_failure(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        clock = FixedClock()
        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        ingestion_id, _ = _open(repository)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            processor=FailingDecoderProcessor(),  # type: ignore[arg-type]
            structurer=FakeCaptureStructuringProvider(clock),
        )
        operation = service.start_capture(
            StartCaptureV2(
                client_request_id="progressive-decoder-failure",
                ingestion_id=ingestion_id,
                structuring_mode=StructuringMode.RUNTIME,
            )
        )
        for _ in range(100):
            if service.get_capture(operation.capture_id).status.value == "failed":
                break
            await asyncio.sleep(0.01)
        failed = service.get_capture(operation.capture_id)
        assert failed.status.value == "failed"
        assert failed.error is not None
        assert failed.error.code == "progressive_decode_failed"
        assert failed.error.stage == "extraction"
        await service.shutdown()

    asyncio.run(scenario())


def test_streaming_runtime_fails_when_audio_processor_is_unavailable(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        clock = FixedClock()
        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        ingestion_id, _ = _open(repository)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            processor=None,
            extractor=DeterministicCaptureExtractor(clock),
            structurer=FakeCaptureStructuringProvider(clock),
        )
        operation = service.start_capture(
            StartCaptureV2(
                client_request_id="missing-audio-processor",
                ingestion_id=ingestion_id,
                structuring_mode=StructuringMode.RUNTIME,
            )
        )
        for _ in range(100):
            if service.get_capture(operation.capture_id).status.value == "failed":
                break
            await asyncio.sleep(0.01)
        failed = service.get_capture(operation.capture_id)
        assert failed.status.value == "failed"
        assert failed.error is not None
        assert failed.error.code == "requirement_unavailable"
        assert failed.error.stage == "extraction"
        await service.shutdown()

    asyncio.run(scenario())


def test_deterministic_audio_extractor_does_not_leak_pdf_page_scope() -> None:
    async def scenario() -> None:
        clock = FixedClock()
        content = b"ID3CAPTURE_TEXT:deterministic audio"
        source = CaptureSource(
            sha256=hashlib.sha256(content).hexdigest(),
            file_name="sample.mp3",
            media_type="audio/mpeg",
            bytes=len(content),
        )
        extraction = await DeterministicCaptureExtractor(clock).extract(
            content,
            source,
            asyncio.Event(),
        )
        assert extraction.raw.ocr_page_scope is None

    asyncio.run(scenario())


def test_session_worker_sinks_worker_heartbeat_before_input_ack() -> None:
    async def scenario() -> None:
        process_stdout = asyncio.StreamReader()

        def heartbeat(stage: bytes) -> bytes:
            return struct.pack(">BI", ord(SessionFrameType.HEARTBEAT.value), len(stage)) + stage

        process_stdout.feed_data(
            heartbeat(json.dumps({"stage": "transcribing"}).encode())
            + heartbeat(json.dumps({"stage": "input_ack"}).encode())
        )
        process_stdout.feed_eof()

        class Stdin:
            def write(self, _value: bytes) -> None:
                return None

            async def drain(self) -> None:
                return None

        class Process:
            stdin = Stdin()
            stdout = process_stdout
            returncode = 0

            async def wait(self) -> int:
                return 0

        worker = _SessionWorker(Process(), asyncio.create_task(asyncio.sleep(0)))
        seen: list[ProgressiveSessionEvent] = []

        async def on_event(event: ProgressiveSessionEvent) -> None:
            seen.append(event)

        events = await worker.input(
            DecodedAudioWindow(0, 1_000, b"pcm"),
            asyncio.Event(),
            on_event,
        )
        assert [event.stage for event in seen] == ["transcribing"]
        assert events == [seen[0]]
        await worker.close()

    asyncio.run(scenario())
