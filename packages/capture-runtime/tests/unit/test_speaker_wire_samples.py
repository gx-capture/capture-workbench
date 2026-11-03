"""Keep the shared wire samples equal to what the runtime models serialize.

The client SDKs decode `tests/fixtures/speaker-wire-samples.json` in their own
tests, so a field the runtime adds must be accepted by every SDK.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from capture_runtime.contracts import (
    CaptureBlock,
    CaptureDocument,
    CaptureEngine,
    CaptureEventV2,
    CaptureOperationV2,
    CaptureSource,
    CaptureSourceKind,
    CaptureSpeaker,
    RawCapture,
    RawCaptureSegment,
    RuntimeInstallationStatus,
    RuntimeInstallationV2,
    RuntimeRequirementStatus,
    RuntimeRequirementsV2,
    RuntimeRequirementV2,
    StreamingCaptureStatus,
    StreamingEventType,
    TimeLocator,
    project_source_text,
)

SAMPLES = Path(__file__).parents[1] / "fixtures" / "speaker-wire-samples.json"
CREATED = datetime(2026, 10, 13, 8, 0, tzinfo=UTC)


def _engine(name: str, model: str, digit: str, device: str) -> CaptureEngine:
    return CaptureEngine(engine=name, model=model, digest=f"sha256:{digit * 64}", device=device)


def _raw(*, speakers: bool) -> RawCapture:
    labels = ("SPEAKER_00", None) if speakers else (None, None)
    segments = [
        RawCaptureSegment(
            segment_id=f"segment-{index + 1}",
            order=index,
            locator=TimeLocator(start_ms=index * 1_000, end_ms=(index + 1) * 1_000),
            text=text,
            speaker=labels[index],
            speaker_overlap=speakers and index == 1,
        )
        for index, text in enumerate(("Good morning", "Hello there"))
    ]
    return RawCapture(
        source=CaptureSource(
            sha256="a" * 64, file_name="meeting.wav", media_type="audio/wav", bytes=32_000
        ),
        segments=segments,
        source_text=project_source_text(segments),
        extraction_engine=_engine("speech-recognition", "tea-asr-1.1", "b", "cuda"),
        diarization_engine=(
            _engine("speaker-diarization", "nvidia-nemotron-3-diarization", "c", "cpu")
            if speakers
            else None
        ),
        speakers=(
            [
                CaptureSpeaker(
                    speaker_id="SPEAKER_00", sample=TimeLocator(start_ms=0, end_ms=1_000)
                ),
                CaptureSpeaker(speaker_id="SPEAKER_01", display_name="王小明"),
            ]
            if speakers
            else []
        ),
        suggested_units=[] if speakers else ["vertical-japanese-reader"],
        created_at=CREATED,
    )


def wire_samples() -> dict[str, Any]:
    raw = _raw(speakers=True)
    blocks = [
        CaptureBlock(
            block_id=f"block-{segment.order + 1}",
            order=segment.order,
            type="transcript",
            source_segment_id=segment.segment_id,
            locator=segment.locator,
            source_text=segment.text,
            target_text=segment.text,
        )
        for segment in raw.segments
    ]
    document = CaptureDocument(
        source=raw.source,
        raw_segments=raw.segments,
        blocks=blocks,
        source_text=raw.source_text,
        target_text="\n".join(block.target_text for block in blocks),
        extraction_engine=raw.extraction_engine,
        diarization_engine=raw.diarization_engine,
        speakers=raw.speakers,
        suggested_units=raw.suggested_units,
        structuring_engine=_engine("host", "deterministic", "d", "cpu"),
        created_at=CREATED,
        completed_at=CREATED,
    )
    requirements = RuntimeRequirementsV2(
        items=[
            RuntimeRequirementV2(
                requirement_id="speaker-diarization",
                kind="speaker-identification",
                display_name="Speaker identification",
                status=RuntimeRequirementStatus.UNAVAILABLE,
                required_for=["audio"],
                install_strategy="runtime-catalog",
                optional=True,
                detail="No downloadable model is published for this runtime release.",
            ),
            RuntimeRequirementV2(
                requirement_id="speech-recognition",
                kind="transcription",
                display_name="Speech recognition",
                status=RuntimeRequirementStatus.INSTALLABLE,
                required_for=["audio"],
                install_strategy="runtime-catalog",
                optional=True,
                download_bytes=10_480_000_000,
            ),
        ]
    )
    installation = RuntimeInstallationV2(
        installation_id="installation-1",
        requirement_id="speech-recognition",
        status=RuntimeInstallationStatus.RUNNING,
        progress=0.3,
        created_at=CREATED,
        updated_at=CREATED,
        download_bytes=10_480_000_000,
        downloaded_bytes=2_950_000_000,
    )
    document_operation = CaptureOperationV2(
        capture_id="capture-document",
        ingestion_id="ingestion-document",
        kind=CaptureSourceKind.PDF,
        status=StreamingCaptureStatus.EXTRACTING,
        progress=0.675,
        partial_revision=0,
        last_event_sequence=11,
        created_at=CREATED,
        updated_at=CREATED,
        pages_total=12,
        pages_done=9,
    )
    audio_operation = CaptureOperationV2(
        capture_id="capture-audio",
        ingestion_id="ingestion-audio",
        kind=CaptureSourceKind.AUDIO,
        status=StreamingCaptureStatus.EXTRACTING,
        progress=0.3,
        partial_revision=3,
        last_event_sequence=8,
        created_at=CREATED,
        updated_at=CREATED,
        duration_ms=2_490_000,
        covered_until_ms=724_000,
    )
    page_event = CaptureEventV2(
        event_id="capture-document/11",
        sequence=11,
        capture_id="capture-document",
        kind=CaptureSourceKind.PDF,
        event_type=StreamingEventType.CHECKPOINT,
        stage="extracting",
        progress=0.675,
        created_at=CREATED,
        pages_done=9,
        pages_total=12,
    )
    return {
        name: model.model_dump(mode="json", by_alias=True)
        for name, model in (
            ("rawCapture", raw),
            ("rawCaptureWithoutSpeakers", _raw(speakers=False)),
            ("captureDocument", document),
            ("runtimeRequirements", requirements),
            ("runtimeInstallation", installation),
            ("documentCaptureOperation", document_operation),
            ("audioCaptureOperation", audio_operation),
            ("documentCaptureEvent", page_event),
        )
    }


def test_shared_wire_samples_match_the_runtime_models() -> None:
    assert json.loads(SAMPLES.read_text(encoding="utf-8")) == wire_samples()


if __name__ == "__main__":
    SAMPLES.write_text(
        json.dumps(wire_samples(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
