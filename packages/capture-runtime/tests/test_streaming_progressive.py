from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime
from pathlib import Path

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureEngineV1,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCaptureSegmentV1,
    RawCaptureV1,
    StartCaptureV2,
    StreamingEventType,
    StructuringMode,
    TimeLocatorV1,
)
from capture_runtime.progressive_audio import ProgressiveSessionEvent
from capture_runtime.services import StreamingCaptureService
from capture_runtime.storage import StreamingRepository
from capture_runtime.structuring_provider import FakeCaptureStructuringProvider


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
