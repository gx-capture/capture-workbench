from __future__ import annotations

import asyncio
import hashlib
from pathlib import Path
from typing import Any

import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.contracts import CaptureSource, CaptureSpeaker, RawCapture, TimeLocator
from capture_runtime.engine_catalog import EngineCatalogError
from capture_runtime.extractors import (
    ExtractionRuntimeUnavailableError,
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.speaker_turns import SpeakerTurn
from capture_runtime.worker_client import (
    InstalledEngine,
    WorkerDiarizationResult,
    WorkerRunResult,
    WorkerSegment,
    WorkerWord,
)

AUDIO = b"RIFF\x00\x00\x00\x00WAVEpayload"


def _report(kwargs: dict[str, Any]) -> None:
    if kwargs.get("on_permille") is not None:
        kwargs["on_permille"](500)
        kwargs["on_permille"](1000)


class _WorkerClient:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.sources: list[Path] = []

    async def run(self, engine: InstalledEngine, **kwargs: Any) -> WorkerRunResult:
        self.calls.append((engine.requirement_id, kwargs["options"]))
        words = (
            WorkerWord(0, 400, " Good"),
            WorkerWord(400, 900, " morning"),
            WorkerWord(1_100, 1_500, " Hello"),
            WorkerWord(1_500, 1_900, " there"),
        )
        with_words = kwargs["options"].get("wordTimestamps") is True
        _report(kwargs)
        return WorkerRunResult(
            segments=(
                WorkerSegment(
                    0,
                    "Good morning Hello there",
                    start_ms=0,
                    end_ms=1_900,
                    words=words if with_words else (),
                ),
            ),
            engine="whisper-primary",
            model="large-v3-turbo",
            digest=f"sha256:{'2' * 64}",
            device="cuda",
            warnings=(),
        )

    async def diarize(self, engine: InstalledEngine, **kwargs: Any) -> WorkerDiarizationResult:
        self.calls.append((engine.requirement_id, kwargs["options"]))
        self.sources.append(kwargs["source_path"])
        _report(kwargs)
        assert kwargs["source_path"].read_bytes() == AUDIO
        turns = (SpeakerTurn(0, 1_000, "SPEAKER_00"), SpeakerTurn(1_000, 2_000, "SPEAKER_01"))
        return WorkerDiarizationResult(
            turns=turns,
            exclusive_turns=turns,
            duration_ms=2_000,
            engine="speaker-diarization",
            model="pyannote-speaker-diarization-community-1",
            digest=f"sha256:{'3' * 64}",
            device="cpu",
            warnings=("Diarization GPU fallback: cuda_out_of_memory",),
        )


def _extract(
    tmp_path: Path,
    *,
    installed: set[str],
    identify_speakers: bool,
    in_catalog: bool = True,
    speaker_progress: Any = None,
) -> tuple[RawCapture, _WorkerClient]:
    worker_client = _WorkerClient()

    class EngineManager:
        async def resolve_active_engine(self, requirement_id: str) -> InstalledEngine | None:
            if requirement_id == "speaker-diarization" and not in_catalog:
                raise EngineCatalogError("unknown requirement")
            if requirement_id not in installed:
                return None
            return InstalledEngine(
                requirement_id=requirement_id,
                artifact_version=RUNTIME_VERSION,
                executable=tmp_path / f"{requirement_id}.exe",
                model_dir=tmp_path / "models",
            )

    manager = EngineManager()
    manager.worker_client = worker_client  # type: ignore[attr-defined]
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        ExtractionRuntimeConfig(
            windowsml_model_dir=tmp_path / "windowsml",
            whisper_models_dir=tmp_path / "whisper",
            temp_dir=tmp_path / "temp",
            max_pdf_pages=10,
            max_image_pixels=100_000,
            ocr_render_scale=2,
            max_audio_duration_ms=60_000,
            whisper_primary_model="large-v3-turbo",
            whisper_fallback_model="small",
            whisper_prefer_gpu=True,
        ),
        engine_manager=manager,  # type: ignore[arg-type]
    )
    source = CaptureSource(
        sha256=hashlib.sha256(AUDIO).hexdigest(),
        file_name="source.wav",
        media_type="audio/wav",
        bytes=len(AUDIO),
    )
    outcome = asyncio.run(
        extractor.extract(
            AUDIO,
            source,
            asyncio.Event(),
            identify_speakers=identify_speakers,
            speaker_progress=speaker_progress,
        )
    )
    return outcome.raw, worker_client


def test_identified_speakers_split_the_transcript_and_get_a_listening_sample(
    tmp_path: Path,
) -> None:
    raw, worker_client = _extract(
        tmp_path, installed={"whisper-primary", "speaker-diarization"}, identify_speakers=True
    )

    assert [
        (item.segment_id, item.locator.start_ms, item.locator.end_ms, item.text, item.speaker)  # type: ignore[union-attr]
        for item in raw.segments
    ] == [
        ("segment-1", 0, 900, "Good morning", "SPEAKER_00"),
        ("segment-2", 1_100, 1_900, "Hello there", "SPEAKER_01"),
    ]
    assert raw.speakers == [
        CaptureSpeaker(speaker_id="SPEAKER_00", sample=TimeLocator(start_ms=0, end_ms=900)),
        CaptureSpeaker(speaker_id="SPEAKER_01", sample=TimeLocator(start_ms=1_100, end_ms=1_900)),
    ]
    assert raw.source_text == "Good morning\nHello there"
    assert raw.diarization_engine is not None
    assert raw.diarization_engine.engine == "speaker-diarization"
    assert raw.extraction_engine.engine == "whisper-primary"
    assert raw.warnings == ["Diarization GPU fallback: cuda_out_of_memory"]
    assert [name for name, _ in worker_client.calls] == ["whisper-primary", "speaker-diarization"]
    assert worker_client.calls[0][1]["wordTimestamps"] is True
    assert not any(path.exists() for path in worker_client.sources)


def test_without_the_request_the_transcript_has_no_speakers(tmp_path: Path) -> None:
    raw, worker_client = _extract(
        tmp_path, installed={"whisper-primary", "speaker-diarization"}, identify_speakers=False
    )

    assert [(item.text, item.speaker) for item in raw.segments] == [
        ("Good morning Hello there", None)
    ]
    assert raw.speakers == []
    assert raw.diarization_engine is None
    assert worker_client.calls == [
        ("whisper-primary", {"maxDurationMs": 60_000, "preferGpu": True, "allowCpuFallback": True})
    ]


@pytest.mark.parametrize("in_catalog", [True, False])
def test_requesting_speakers_without_the_unit_installed_fails_and_names_it(
    tmp_path: Path, in_catalog: bool
) -> None:
    with pytest.raises(ExtractionRuntimeUnavailableError, match="speaker-diarization"):
        _extract(
            tmp_path,
            installed={"whisper-primary"},
            identify_speakers=True,
            in_catalog=in_catalog,
        )


def test_progress_covers_transcription_then_speaker_identification(tmp_path: Path) -> None:
    reported: list[tuple[str, int]] = []

    _extract(
        tmp_path,
        installed={"whisper-primary", "speaker-diarization"},
        identify_speakers=True,
        speaker_progress=lambda stage, permille: reported.append((stage, permille)),
    )

    assert reported == [
        ("transcribing", 225),
        ("transcribing", 450),
        ("identifying-speakers", 725),
        ("identifying-speakers", 1000),
    ]
