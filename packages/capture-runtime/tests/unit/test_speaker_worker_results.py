from __future__ import annotations

from pathlib import Path
from threading import Event
from types import SimpleNamespace
from typing import Any

import pytest

import capture_runtime.workers.whisper_main as whisper_main
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.engine_adapters import FasterWhisperAdapter
from capture_runtime.speaker_turns import SpeakerTurn
from capture_runtime.worker_client import (
    WorkerResultError,
    WorkerWord,
    parse_diarization_result,
    parse_run_result,
)
from capture_runtime.worker_contracts import WorkerRequest

DIGEST = "sha256:" + "a" * 64


def _whisper_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, options: dict[str, Any], words: Any
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    for name in ("primary", "fallback"):
        (tmp_path / "models" / name).mkdir(parents=True, exist_ok=True)
        for filename in ("config.json", "model.bin", "tokenizer.json", "vocabulary.json"):
            (tmp_path / "models" / name / filename).write_bytes(b"fixture")
    source = tmp_path / "fixture.wav"
    source.write_bytes(b"fixture")
    transcribe_options: list[dict[str, Any]] = []

    class Model:
        def transcribe(self, _path: str, **kwargs: Any) -> Any:
            transcribe_options.append(kwargs)
            segment = SimpleNamespace(start=0.0, end=1.0, text=" worker words", words=words)
            return [segment], SimpleNamespace(duration=1.0)

    class TestAdapter(FasterWhisperAdapter):
        def __init__(self, model_path: Path, **kwargs: Any) -> None:
            super().__init__(
                model_path, model_factory=lambda *_a, **_k: Model(), cuda_count=lambda: 0, **kwargs
            )

    monkeypatch.setattr(whisper_main, "FasterWhisperAdapter", TestAdapter)
    monkeypatch.setattr(whisper_main, "_import_whisper_runtime", lambda: None)
    request = WorkerRequest(
        request_id="whisper-words-test",
        operation="run",
        payload={
            "requirementId": "whisper-primary",
            "artifactVersion": RUNTIME_VERSION,
            "modelPath": str(tmp_path / "models"),
            "sourcePath": str(source),
            "mediaType": "audio/wav",
            "options": {"maxDurationMs": 60_000, "preferGpu": False, **options},
        },
    )
    return whisper_main._run(request, Event()), transcribe_options


def test_whisper_worker_returns_word_times_only_when_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    words = [
        SimpleNamespace(start=0.0, end=0.4, word=" worker"),
        SimpleNamespace(start=0.4, end=1.3, word=" words"),
    ]

    result, options = _whisper_run(tmp_path, monkeypatch, {"wordTimestamps": True}, words)

    assert options[0]["word_timestamps"] is True
    assert result["segments"][0]["words"] == [
        {"startMs": 0, "endMs": 400, "text": " worker"},
        {"startMs": 400, "endMs": 1_000, "text": " words"},
    ]
    assert parse_run_result(result).segments[0].words == (
        WorkerWord(0, 400, " worker"),
        WorkerWord(400, 1_000, " words"),
    )


def test_whisper_worker_omits_words_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result, options = _whisper_run(tmp_path, monkeypatch, {}, None)

    assert options[0]["word_timestamps"] is False
    assert "words" not in result["segments"][0]
    assert parse_run_result(result).segments[0].words == ()


def test_whisper_worker_rejects_speech_without_requested_word_times(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    with pytest.raises(ValueError, match="word timestamps"):
        _whisper_run(tmp_path, monkeypatch, {"wordTimestamps": True}, None)
    with pytest.raises(ValueError, match="options"):
        _whisper_run(tmp_path, monkeypatch, {"wordTimestamps": 1}, None)


def _diarization_payload(**overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "turns": [
            {"startMs": 0, "endMs": 900, "speaker": "SPEAKER_00"},
            {"startMs": 700, "endMs": 1_500, "speaker": "SPEAKER_01"},
        ],
        "exclusiveTurns": [
            {"startMs": 0, "endMs": 700, "speaker": "SPEAKER_00"},
            {"startMs": 700, "endMs": 1_500, "speaker": "SPEAKER_01"},
        ],
        "durationMs": 1_500,
        "provenance": {
            "engine": "speaker-diarization",
            "model": "pyannote-speaker-diarization-community-1",
            "digest": DIGEST,
            "device": "cpu",
        },
        "warnings": ["Diarization GPU fallback: cuda_out_of_memory"],
    }
    return payload | overrides


def test_diarization_result_is_parsed_into_turns_and_provenance() -> None:
    result = parse_diarization_result(_diarization_payload())

    assert result.turns == (
        SpeakerTurn(0, 900, "SPEAKER_00"),
        SpeakerTurn(700, 1_500, "SPEAKER_01"),
    )
    assert result.exclusive_turns[1] == SpeakerTurn(700, 1_500, "SPEAKER_01")
    assert (result.duration_ms, result.engine, result.device) == (
        1_500,
        "speaker-diarization",
        "cpu",
    )
    assert result.digest == DIGEST
    assert result.warnings == ("Diarization GPU fallback: cuda_out_of_memory",)


@pytest.mark.parametrize(
    "overrides",
    [
        {"unexpected": True},
        {"durationMs": -1},
        {"turns": [{"startMs": 0, "endMs": 2_000, "speaker": "SPEAKER_00"}]},
        {"turns": [{"startMs": 500, "endMs": 500, "speaker": "SPEAKER_00"}]},
        {"turns": [{"startMs": 0, "endMs": 500, "speaker": "C:\\private\\path"}]},
        {"turns": [{"startMs": 0, "endMs": 500, "speaker": "SPEAKER_00", "extra": 1}]},
        {
            "exclusiveTurns": [
                {"startMs": 0, "endMs": 900, "speaker": "SPEAKER_00"},
                {"startMs": 700, "endMs": 1_500, "speaker": "SPEAKER_01"},
            ]
        },
        {
            "provenance": {
                "engine": "whisper-primary",
                "model": "m",
                "digest": DIGEST,
                "device": "cpu",
            }
        },
        {
            "provenance": {
                "engine": "speaker-diarization",
                "model": "m",
                "digest": "x",
                "device": "cpu",
            }
        },
        {"warnings": "not a list"},
    ],
)
def test_malformed_diarization_results_are_rejected(overrides: dict[str, Any]) -> None:
    with pytest.raises(WorkerResultError):
        parse_diarization_result(_diarization_payload(**overrides))


@pytest.mark.parametrize(
    "words",
    [
        "not a list",
        [{"startMs": 0, "endMs": 10}],
        [{"startMs": 20, "endMs": 10, "text": "x"}],
        [{"startMs": 0, "endMs": 10, "text": ""}],
    ],
)
def test_malformed_segment_words_are_rejected(words: Any) -> None:
    payload = {
        "segments": [
            {"order": 0, "text": "x", "page": None, "startMs": 0, "endMs": 10, "words": words}
        ],
        "provenance": {
            "engine": "whisper-primary",
            "model": "small",
            "digest": DIGEST,
            "device": "cpu",
        },
        "warnings": [],
    }

    with pytest.raises(WorkerResultError):
        parse_run_result(payload)


def _ocr_payload(**extra: Any) -> dict[str, Any]:
    return {
        "segments": [{"order": 0, "text": "x", "page": None, "startMs": 0, "endMs": 10}],
        "provenance": {
            "engine": "whisper-primary",
            "model": "small",
            "digest": DIGEST,
            "device": "cpu",
        },
        "warnings": [],
    } | extra


def test_worker_result_may_name_an_optional_unit_that_was_missed() -> None:
    assert parse_run_result(_ocr_payload()).suggested_units == ()
    assert parse_run_result(
        _ocr_payload(suggestedUnits=["vertical-japanese-reader"])
    ).suggested_units == ("vertical-japanese-reader",)


@pytest.mark.parametrize(
    "value",
    [[], "vertical-japanese-reader", ["whisper-primary"], ["vertical-japanese-reader"] * 2, [7]],
)
def test_worker_result_rejects_malformed_or_unknown_unit_suggestions(value: Any) -> None:
    with pytest.raises(WorkerResultError):
        parse_run_result(_ocr_payload(suggestedUnits=value))
