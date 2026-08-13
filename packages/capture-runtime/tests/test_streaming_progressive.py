from __future__ import annotations

import asyncio
import hashlib
import json
import struct
from datetime import UTC, datetime
from pathlib import Path

import pytest
from capture_structuring import StructuringValidationError

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureEngineV1,
    CaptureSourceV1,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StartCaptureV2,
    StreamingEventType,
    StructuringMode,
    TimeLocatorV1,
)
from capture_runtime.progressive_audio import DecodedAudioWindow, ProgressiveSessionEvent
from capture_runtime.progressive_capture import (
    _ProgressiveState,
    _session_worker_launch,
    _SessionWorker,
)
from capture_runtime.progressive_decoder import ProgressiveDecoderError
from capture_runtime.extractors import DeterministicCaptureExtractor
from capture_runtime.services import StreamingCaptureService
from capture_runtime.storage import StreamingRepository
from capture_runtime.structuring_provider import FakeCaptureStructuringProvider
from capture_runtime.whisper_session import SessionFrameType


def test_progressive_worker_launch_strips_windows_extended_path_prefix(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("capture_runtime.worker_process.os.name", "nt")
    command, cwd = _session_worker_launch(Path(r"\\?\C:\capture-workbench\runtime\worker.exe"))

    assert command == [r"C:\capture-workbench\runtime\worker.exe", "session"]
    assert cwd == r"C:\capture-workbench\runtime"


def test_progressive_state_reorders_segments_from_overlapping_worker_events() -> None:
    source = CaptureSourceV1(
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
    engine = CaptureEngineV1(
        engine="whisper-primary",
        model="small",
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
                RawCaptureSegmentV1(
                    segment_id="segment-later",
                    order=0,
                    locator=TimeLocatorV1(start_ms=110_000, end_ms=120_000),
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
                RawCaptureSegmentV1(
                    segment_id="segment-earlier",
                    order=0,
                    locator=TimeLocatorV1(start_ms=90_000, end_ms=100_000),
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
        self.engine = CaptureEngineV1(
            engine="whisper-primary",
            model="small",
            digest=f"sha256:{'a' * 64}",
            device="cpu",
        )

    async def process(self, *, capture_id, source, source_path, cancellation, sink):
        assert source_path.is_file()
        assert not cancellation.is_set()
        segment = RawCaptureSegmentV1(
            segment_id="segment-1",
            order=0,
            locator=TimeLocatorV1(start_ms=0, end_ms=1_000),
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
        return RawCaptureV1(
            source=source,
            segments=[segment],
            source_text=segment.text,
            extraction_engine=self.engine,
            created_at=self.clock.now(),
        )


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
        assert terminal["raw"]["sourceText"] == "hello streaming"
        assert terminal["result"]["targetText"] == "hello streaming"
        event_types = [
            event.event_type
            for event in repository.read_events(operation.capture_id, after_sequence=-1)
        ]
        assert StreamingEventType.SEGMENT in event_types
        assert StreamingEventType.COMPLETED in event_types
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
