from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from capture_runtime.engine_adapters import FasterWhisperAdapter
from capture_runtime.speaker_diarization import (
    DIARIZATION_REQUIRED_FILES,
    PyannoteDiarizationAdapter,
)
from capture_runtime.worker_client import InstalledEngine, WorkerClient
from capture_runtime.worker_contracts import WorkerResponse
from capture_runtime.workers.server import permille_reporter


def test_progress_frames_are_sent_at_most_once_per_percent_and_end_at_one_thousand() -> None:
    frames: list[dict[str, Any]] = []
    report = permille_reporter(frames.append)

    for completed in (0, 1, 5, 10, 14, 500, 995, 999, 1000, 1000):
        report(completed, 1000)

    assert [frame["permille"] for frame in frames] == [10, 500, 995, 1000]


def test_diarization_reports_segmentation_then_embeddings_as_one_scale(tmp_path: Path) -> None:
    for relative in DIARIZATION_REQUIRED_FILES:
        (tmp_path / relative).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / relative).write_bytes(b"fixture")
    reported: list[int] = []
    empty = SimpleNamespace(itertracks=lambda yield_label: iter(()))

    class Pipeline:
        @classmethod
        def from_pretrained(cls, _model: str) -> Pipeline:
            return cls()

        def to(self, _device: str) -> None:
            return None

        def __call__(self, _audio: Any, *, hook: Any) -> Any:
            hook("segmentation", None, total=4, completed=2)
            hook("segmentation", None, total=4, completed=4)
            hook("speaker_counting", None)
            hook("embeddings", None, total=10, completed=5)
            hook("embeddings", None, total=10, completed=10)
            return SimpleNamespace(speaker_diarization=empty, exclusive_speaker_diarization=empty)

    waveform = SimpleNamespace(unsqueeze=lambda axis: "waveform")
    waveform.to = lambda dtype: waveform
    waveform.div = lambda scale: waveform
    torch = SimpleNamespace(
        cuda=SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None),
        device=lambda name: name,
        int16="int16",
        float32="float32",
        frombuffer=lambda pcm, dtype: waveform,
    )
    adapter = PyannoteDiarizationAdapter(
        tmp_path,
        prefer_gpu=False,
        max_duration_ms=60_000,
        pipeline_factory=Pipeline,
        torch_module=torch,
        decoder=lambda path, **_: bytearray(32_000),
        progress_reporter=lambda completed, total: reported.append(completed * 1000 // total),
    )

    adapter.diarize(tmp_path / "source.wav", should_cancel=lambda: False)

    assert reported == [100, 200, 600, 1000]


def test_whisper_reports_how_far_into_the_recording_it_is(tmp_path: Path) -> None:
    for name in ("primary", "fallback"):
        (tmp_path / name).mkdir()
        for filename in ("config.json", "model.bin", "tokenizer.json", "vocabulary.json"):
            (tmp_path / name / filename).write_bytes(b"fixture")
    reported: list[tuple[int, int]] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: Any) -> Any:
            segments = [
                SimpleNamespace(start=0.0, end=4.0, text="first"),
                SimpleNamespace(start=4.0, end=10.0, text="second"),
            ]
            return segments, SimpleNamespace(duration=10.0)

    adapter = FasterWhisperAdapter(
        tmp_path,
        primary_model="primary",
        fallback_model="fallback",
        prefer_gpu=False,
        max_duration_ms=60_000,
        model_factory=lambda *_a, **_k: Model(),
        cuda_count=lambda: 0,
        progress_reporter=lambda done, total: reported.append((done, total)),
    )

    adapter.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)

    assert reported == [(4_000, 10_000), (10_000, 10_000)]


def test_worker_client_passes_on_valid_progress_and_ignores_malformed_frames(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.wav"
    source.write_bytes(b"fixture")
    received: list[int] = []
    result = {
        "turns": [],
        "exclusiveTurns": [],
        "durationMs": 1_000,
        "provenance": {
            "engine": "speaker-diarization",
            "model": "pyannote-speaker-diarization-community-1",
            "digest": "sha256:" + "a" * 64,
            "device": "cpu",
        },
        "warnings": [],
    }

    class Process:
        async def request(self, _executable: Path, _operation: str, _payload: Any, **kwargs: Any):
            handler = kwargs["progress_handler"]
            for frame in (
                {"permille": 250},
                {"permille": 1001},
                {"permille": True},
                {"permille": 300, "path": "C:\\private"},
                {"other": 1},
                {"permille": 1000},
            ):
                handler(json.loads(json.dumps(frame)))
            return WorkerResponse("request", True, result, None)

    client = WorkerClient.__new__(WorkerClient)
    client.process = Process()  # type: ignore[assignment]
    engine = InstalledEngine(
        requirement_id="speaker-diarization",
        artifact_version="0.0.0",
        executable=tmp_path / "worker.exe",
        model_dir=tmp_path,
    )

    asyncio.run(
        client.diarize(
            engine,
            source_path=source,
            media_type="audio/wav",
            options={},
            cancel_event=asyncio.Event(),
            on_permille=received.append,
        )
    )

    assert received == [250, 1000]
