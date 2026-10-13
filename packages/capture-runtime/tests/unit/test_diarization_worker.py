from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from threading import Event
from typing import Any

import pytest

import capture_runtime.workers.diarization_main as diarization_main
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.speaker_diarization import (
    DIARIZATION_REQUIRED_FILES,
    SpeakerDiarizationResult,
)
from capture_runtime.speaker_turns import SpeakerTurn
from capture_runtime.worker_contracts import WorkerRequest, WorkerResponse
from capture_runtime.worker_stage_policy import WORKER_STAGE_PATTERN, sanitize_worker_stage


def _request(tmp_path: Path, operation: Any = "run", **overrides: Any) -> WorkerRequest:
    model = tmp_path / "model"
    for relative in DIARIZATION_REQUIRED_FILES:
        (model / relative).parent.mkdir(parents=True, exist_ok=True)
        (model / relative).write_bytes(b"fixture")
    source = tmp_path / "source.wav"
    source.write_bytes(b"fixture")
    payload: dict[str, Any] = {
        "requirementId": "speaker-diarization",
        "artifactVersion": RUNTIME_VERSION,
        "modelPath": str(model),
        "options": {"preferGpu": False},
    }
    if operation == "run":
        payload |= {
            "sourcePath": str(source),
            "mediaType": "audio/wav",
            "options": {"maxDurationMs": 60_000, "preferGpu": False},
        }
    payload |= overrides
    return WorkerRequest(request_id="diarization-test", operation=operation, payload=payload)


def test_run_returns_both_timelines_with_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    created: list[dict[str, Any]] = []

    class Adapter:
        def __init__(self, model_dir: Path, **options: Any) -> None:
            created.append({"model_dir": model_dir, **options})

        def diarize(self, source: Path, *, should_cancel: Any) -> SpeakerDiarizationResult:
            assert source == tmp_path / "source.wav"
            assert should_cancel() is False
            return SpeakerDiarizationResult(
                turns=(SpeakerTurn(0, 900, "SPEAKER_00"), SpeakerTurn(700, 1_500, "SPEAKER_01")),
                exclusive_turns=(SpeakerTurn(0, 700, "SPEAKER_00"),),
                duration_ms=1_500,
                device="cpu",
                model="pyannote-speaker-diarization-community-1",
                digest="sha256:" + "0" * 64,
                warning="Diarization GPU fallback: cuda_out_of_memory",
            )

    monkeypatch.setattr(diarization_main, "PyannoteDiarizationAdapter", Adapter)
    request = _request(
        tmp_path,
        options={
            "maxDurationMs": 60_000,
            "preferGpu": True,
            "allowCpuFallback": False,
            "numSpeakers": 2,
        },
    )

    result = diarization_main.handle(request, Event(), None)

    assert result == {
        "turns": [
            {"startMs": 0, "endMs": 900, "speaker": "SPEAKER_00"},
            {"startMs": 700, "endMs": 1_500, "speaker": "SPEAKER_01"},
        ],
        "exclusiveTurns": [{"startMs": 0, "endMs": 700, "speaker": "SPEAKER_00"}],
        "durationMs": 1_500,
        "provenance": {
            "engine": "speaker-diarization",
            "model": "pyannote-speaker-diarization-community-1",
            "digest": "sha256:" + "0" * 64,
            "device": "cpu",
        },
        "warnings": ["Diarization GPU fallback: cuda_out_of_memory"],
    }
    assert created[0]["prefer_gpu"] is True
    assert created[0]["allow_cpu_fallback"] is False
    assert created[0]["num_speakers"] == 2
    assert created[0]["max_duration_ms"] == 60_000


@pytest.mark.parametrize(
    "overrides",
    [
        {"requirementId": "whisper-primary"},
        {"modelPath": "relative/model"},
        {"sourcePath": "relative/source.wav"},
        {"options": {"preferGpu": False}},
        {"options": {"maxDurationMs": 0, "preferGpu": False}},
        {"options": {"maxDurationMs": 1, "preferGpu": 1}},
        {"options": {"maxDurationMs": 1, "preferGpu": False, "numSpeakers": 0}},
        {"options": {"maxDurationMs": 1, "preferGpu": False, "numSpeakers": True}},
        {"options": {"maxDurationMs": 1, "preferGpu": False, "unexpected": 1}},
        {"unexpected": True},
    ],
)
def test_run_rejects_invalid_requests_before_loading_a_model(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, overrides: dict[str, Any]
) -> None:
    def refuse(*_args: Any, **_kwargs: Any) -> None:
        raise AssertionError("adapter must not be created")

    monkeypatch.setattr(diarization_main, "PyannoteDiarizationAdapter", refuse)

    with pytest.raises(ValueError, match="Diarization"):
        diarization_main.handle(_request(tmp_path, **overrides), Event(), None)


def test_probe_reports_model_readiness_and_the_device_it_would_use(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        diarization_main.PyannoteDiarizationAdapter, "cuda_available", lambda self: True
    )
    monkeypatch.setattr(
        "capture_runtime.speaker_diarization.importlib.util.find_spec", lambda _name: object()
    )
    request = _request(tmp_path, "probe", options={"preferGpu": True})

    ready = diarization_main.handle(request, Event(), None)
    (tmp_path / "model" / "config.yaml").unlink()
    missing = diarization_main.handle(request, Event(), None)

    assert (ready["ready"], ready["device"]) == (True, "cuda")
    assert (missing["ready"], missing["codeReady"], missing["assetsReady"]) == (False, True, False)


def test_unknown_operation_is_rejected(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="unsupported"):
        diarization_main.handle(_request(tmp_path, "preflight"), Event(), None)


def test_worker_process_answers_a_probe_over_the_json_lines_protocol(tmp_path: Path) -> None:
    request = _request(tmp_path, "probe")

    completed = subprocess.run(
        [sys.executable, "-m", "capture_runtime.workers.diarization_main"],
        input=(json.dumps(request.to_dict()) + "\n").encode(),
        capture_output=True,
        shell=False,
        check=False,
    )

    response = WorkerResponse.from_dict(json.loads(completed.stdout.decode("utf-8")))
    assert completed.returncode == 0
    assert response.ok and response.result is not None
    assert response.result["assetsReady"] is True
    assert response.result["ready"] is response.result["codeReady"]
    stages = WORKER_STAGE_PATTERN.findall(completed.stderr.decode("utf-8"))
    assert stages[0] == "worker-entry-start"
    assert all(sanitize_worker_stage(stage) == stage for stage in stages)
