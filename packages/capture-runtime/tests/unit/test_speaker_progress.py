from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

from capture_runtime.worker_client import InstalledEngine, WorkerClient
from capture_runtime.worker_contracts import WorkerResponse
from capture_runtime.workers.server import permille_reporter
from tests.speech_model_fakes import FakeModels, adapter


def test_progress_frames_are_sent_at_most_once_per_percent_and_end_at_one_thousand() -> None:
    frames: list[dict[str, Any]] = []
    report = permille_reporter(frames.append)

    for completed in (0, 1, 5, 10, 14, 500, 995, 999, 1000, 1000):
        report(completed, 1000)

    assert [frame["permille"] for frame in frames] == [10, 500, 995, 1000]


def test_speech_reports_recognition_and_alignment_progress(tmp_path: Path, monkeypatch) -> None:
    reported: list[tuple[int, int]] = []
    fake = FakeModels(monkeypatch, cuda=False)
    recognizer = adapter(
        tmp_path,
        fake,
        prefer_gpu=False,
        progress_reporter=lambda done, total: reported.append((done, total)),
    )
    recognizer.transcribe(tmp_path / "source.wav", should_cancel=lambda: False)
    assert reported == [(500, 1000), (1000, 1000)]


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
            "model": "nvidia-nemotron-3-diarization",
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
