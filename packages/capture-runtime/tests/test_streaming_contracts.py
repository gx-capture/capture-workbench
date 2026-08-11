from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime

import pytest

from capture_runtime.contracts import (
    CaptureEngineV1,
    CaptureEventV2,
    CaptureSourceKind,
    CaptureSourceV1,
    OpenIngestionV2,
    PartialCaptureV2,
    RawCaptureSegmentV1,
    StreamingEventType,
)
from capture_runtime.streaming import (
    InMemoryStreamingIngestionAdapter,
    StreamingIngestionError,
)

SOURCE = CaptureSourceV1(
    sha256="0" * 64,
    file_name="sample.mp3",
    media_type="audio/mpeg",
    bytes=6,
)
NOW = datetime(2026, 1, 1, tzinfo=UTC)


def _request(kind: CaptureSourceKind = CaptureSourceKind.AUDIO) -> OpenIngestionV2:
    return OpenIngestionV2(
        client_request_id="stream-request-1",
        kind=kind,
        file_name=SOURCE.file_name,
        media_type=SOURCE.media_type,
        total_bytes=SOURCE.bytes,
        source_sha256=hashlib.sha256(b"abcdef").hexdigest(),
    )


def test_v2_contracts_use_camel_case_and_preserve_sealed_segment_projection() -> None:
    segment = RawCaptureSegmentV1(
        segment_id="segment-1",
        order=0,
        locator={"kind": "time", "startMs": 0, "endMs": 1000},
        text="first sentence",
    )
    partial = PartialCaptureV2(
        capture_id="capture-1",
        source=SOURCE,
        revision=1,
        covered_until_ms=600_000,
        segments=[segment],
        source_text="first sentence",
        extraction_engine=CaptureEngineV1(
            engine="whisper-primary",
            model="test-model",
            digest="sha256:" + "1" * 64,
            device="cuda",
        ),
        updated_at=NOW,
    )
    event = CaptureEventV2(
        event_id="capture-1/1",
        sequence=1,
        capture_id="capture-1",
        kind=CaptureSourceKind.AUDIO,
        event_type=StreamingEventType.SEGMENT,
        stage="extracting",
        partial_revision=1,
        covered_until_ms=600_000,
        segments=[segment],
        created_at=NOW,
    )

    assert partial.model_dump(by_alias=True)["coveredUntilMs"] == 600_000
    assert event.model_dump(by_alias=True)["eventType"] == "segment"
    assert event.model_dump(by_alias=True)["segments"][0]["locator"]["startMs"] == 0


@pytest.mark.parametrize("kind", list(CaptureSourceKind))
def test_v2_ingestion_contract_carries_every_capture_kind(kind: CaptureSourceKind) -> None:
    request = _request(kind)

    assert request.kind is kind
    assert request.model_dump(by_alias=True)["kind"] == kind.value


def test_partial_capture_rejects_non_projection_text() -> None:
    with pytest.raises(ValueError, match="exact partial segment projection"):
        PartialCaptureV2(
            capture_id="capture-1",
            source=SOURCE,
            revision=1,
            covered_until_ms=600_000,
            segments=[
                {
                    "segmentId": "segment-1",
                    "order": 0,
                    "locator": {"kind": "time", "startMs": 0, "endMs": 1000},
                    "text": "first sentence",
                }
            ],
            source_text="tampered",
            updated_at=NOW,
        )


def test_memory_ingestion_accepts_ordered_idempotent_chunks_and_finalizes() -> None:
    async def scenario() -> None:
        adapter = InMemoryStreamingIngestionAdapter(now=NOW)
        opened = await adapter.open(_request())

        first = b"abc"
        first_sha = hashlib.sha256(first).hexdigest()
        after_first = await adapter.append(
            opened.ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=first,
            sha256=first_sha,
        )
        duplicate = await adapter.append(
            opened.ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=first,
            sha256=first_sha,
        )
        assert after_first == duplicate

        second = b"def"
        await adapter.append(
            opened.ingestion_id,
            chunk_index=1,
            byte_offset=3,
            data=second,
            sha256=hashlib.sha256(second).hexdigest(),
        )
        finalized = await adapter.finalize(
            opened.ingestion_id,
            total_bytes=6,
            sha256=hashlib.sha256(b"abcdef").hexdigest(),
        )
        assert finalized.status.value == "ready"
        assert finalized.next_offset == 6
        assert finalized.finalized_sha256 == hashlib.sha256(b"abcdef").hexdigest()

    asyncio.run(scenario())


def test_memory_ingestion_rejects_gap_checksum_and_conflicting_retry() -> None:
    async def scenario() -> None:
        adapter = InMemoryStreamingIngestionAdapter(now=NOW)
        opened = await adapter.open(_request())

        with pytest.raises(StreamingIngestionError, match="Chunks must be appended") as gap:
            await adapter.append(
                opened.ingestion_id,
                chunk_index=1,
                byte_offset=0,
                data=b"abc",
                sha256=hashlib.sha256(b"abc").hexdigest(),
            )
        assert gap.value.code == "chunk_out_of_order"

        with pytest.raises(StreamingIngestionError) as checksum:
            await adapter.append(
                opened.ingestion_id,
                chunk_index=0,
                byte_offset=0,
                data=b"abc",
                sha256="0" * 64,
            )
        assert checksum.value.code == "chunk_checksum_mismatch"

        digest = hashlib.sha256(b"abc").hexdigest()
        await adapter.append(
            opened.ingestion_id,
            chunk_index=0,
            byte_offset=0,
            data=b"abc",
            sha256=digest,
        )
        with pytest.raises(StreamingIngestionError) as conflict:
            await adapter.append(
                opened.ingestion_id,
                chunk_index=0,
                byte_offset=0,
                data=b"xyz",
                sha256=hashlib.sha256(b"xyz").hexdigest(),
            )
        assert conflict.value.code == "chunk_conflict"

    asyncio.run(scenario())
