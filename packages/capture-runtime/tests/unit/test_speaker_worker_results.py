from __future__ import annotations

from pathlib import Path
from threading import Event
from types import SimpleNamespace
from typing import Any

import pytest

import capture_runtime.workers.speech_recognition_main as whisper_main
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.speaker_turns import SpeakerTurn
from capture_runtime.speech_recognition import TeaAsrAdapter
from capture_runtime.worker_client import (
    WorkerResultError,
    WorkerWord,
    parse_diarization_result,
    parse_run_result,
)
from capture_runtime.worker_contracts import WorkerRequest
from tests.speech_model_fakes import FakeModels, model_tree

DIGEST = "sha256:" + "a" * 64


def _whisper_run(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, options: dict[str, Any], words: Any
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    model_tree(tmp_path / "models")
    source = tmp_path / "fixture.wav"
    source.write_bytes(b"fixture")
    transcribe_options: list[dict[str, Any]] = []
    fake = FakeModels(monkeypatch, cuda=False)
    fake.transcript = "worker words"
    fake.alignment = (
        []
        if words is None
        else [
            {"text": word.word.strip(), "start_time": word.start, "end_time": word.end}
            for word in words
        ]
    )

    class TestAdapter(TeaAsrAdapter):
        def __init__(self, model_path: Path, **kwargs: Any) -> None:
            transcribe_options.append({"word_timestamps": kwargs.get("word_timestamps", False)})
            if not kwargs.get("word_timestamps"):
                fake.alignment = None
            super().__init__(
                model_path,
                torch_module=fake._torch(),
                transformers_module=fake._transformers(),
                decoder=lambda *_a, **_k: [0.0] * 16_000,
                **kwargs,
            )

        def transcribe(self, source_path: Path, **kwargs: Any) -> Any:
            transcribe_options[-1]["language"] = kwargs.get("language")
            return super().transcribe(source_path, **kwargs)

    monkeypatch.setattr(whisper_main, "TeaAsrAdapter", TestAdapter)
    monkeypatch.setattr(whisper_main, "_import_speech_runtime", lambda: None)
    request = WorkerRequest(
        request_id="whisper-words-test",
        operation="run",
        payload={
            "requirementId": "speech-recognition",
            "artifactVersion": RUNTIME_VERSION,
            "modelPath": str(tmp_path / "models"),
            "sourcePath": str(source),
            "mediaType": "audio/wav",
            "options": {"maxDurationMs": 60_000, "preferGpu": False, **options},
        },
    )
    return whisper_main._run(request, Event()), transcribe_options


def test_speech_recognition_worker_returns_word_times_only_when_asked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    words = [
        SimpleNamespace(start=0.0, end=0.4, word=" worker"),
        SimpleNamespace(start=0.4, end=1.3, word=" words"),
    ]

    result, options = _whisper_run(tmp_path, monkeypatch, {"wordTimestamps": True}, words)

    assert options[0]["word_timestamps"] is True
    assert result["segments"][0]["words"] == [
        {"startMs": 0, "endMs": 400, "text": "worker "},
        {"startMs": 400, "endMs": 1_000, "text": "words"},
    ]
    assert parse_run_result(result).segments[0].words == (
        WorkerWord(0, 400, "worker "),
        WorkerWord(400, 1_000, "words"),
    )


def test_speech_recognition_worker_omits_words_by_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    result, options = _whisper_run(tmp_path, monkeypatch, {}, None)

    assert options[0]["word_timestamps"] is False
    assert "words" not in result["segments"][0]
    assert parse_run_result(result).segments[0].words == ()


def test_speech_worker_emits_processing_times(tmp_path, monkeypatch):
    clock = iter(range(0, 1000, 5))
    monkeypatch.setattr("capture_runtime.speech_recognition.time.perf_counter", lambda: next(clock))
    result, _ = _whisper_run(tmp_path, monkeypatch, {}, None)
    assert result["provenance"]["elapsedMs"] == 45000
    assert result["provenance"]["stageMs"] == {
        "modelLoad": 5000,
        "transcription": 5000,
        "alignerLoad": 5000,
        "alignment": 5000,
    }
    parsed = parse_run_result(result)
    assert parsed.elapsed_ms == 45000
    assert parsed.stage_ms == result["provenance"]["stageMs"]


@pytest.mark.parametrize("kind", ["speech", "diarization"])
@pytest.mark.parametrize(
    "timings",
    [
        {},
        {"elapsedMs": None, "stageMs": None},
        {"elapsedMs": 0, "stageMs": {}},
        {"elapsedMs": 1500, "stageMs": {"modelLoad": 200, "inference": 0}},
        {"elapsedMs": 1500},
        {"stageMs": {"modelLoad": 200}},
    ],
)
def test_worker_parsers_preserve_optional_processing_times(kind, timings):
    payload = _diarization_payload()
    parser = parse_diarization_result
    if kind == "speech":
        payload = {
            "segments": [],
            "provenance": dict(payload["provenance"], engine="speech-recognition"),
            "warnings": [],
        }
        parser = parse_run_result
    payload["provenance"].update(timings)
    result = parser(payload)
    assert result.elapsed_ms == timings.get("elapsedMs")
    assert result.stage_ms == timings.get("stageMs")


@pytest.mark.parametrize("kind", ["speech", "diarization"])
@pytest.mark.parametrize(
    "timings",
    [
        {"elapsedMs": -1},
        {"elapsedMs": True},
        {"elapsedMs": 1.5},
        {"elapsedMs": "1"},
        {"stageMs": []},
        {"stageMs": {"": 1}},
        {"stageMs": {" ": 1}},
        {"stageMs": {1: 1}},
        *({"stageMs": {"inference": value}} for value in [-1, True, 1.5, "1", None]),
        {"unexpected": 1},
    ],
)
def test_worker_parsers_reject_invalid_processing_times(kind, timings):
    payload = _diarization_payload()
    parser = parse_diarization_result
    if kind == "speech":
        payload = {
            "segments": [],
            "provenance": dict(payload["provenance"], engine="speech-recognition"),
            "warnings": [],
        }
        parser = parse_run_result
    payload["provenance"].update(timings)
    with pytest.raises(WorkerResultError):
        parser(payload)


@pytest.mark.parametrize(("options", "language"), [({}, None), ({"language": "ja"}, "ja")])
def test_speech_recognition_worker_recognizes_the_requested_language(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, options: dict[str, Any], language: str | None
) -> None:
    _, transcribe_options = _whisper_run(tmp_path, monkeypatch, options, None)

    assert transcribe_options[0]["language"] == language


@pytest.mark.parametrize("language", ["jp", "JA", None, 7])
def test_speech_recognition_worker_rejects_a_language_outside_the_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, language: object
) -> None:
    with pytest.raises(ValueError, match="options"):
        _whisper_run(tmp_path, monkeypatch, {"language": language}, None)


def test_speech_recognition_worker_rejects_speech_without_requested_word_times(
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
            "model": "nvidia-nemotron-3-diarization",
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
                "engine": "speech-recognition",
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
            "engine": "speech-recognition",
            "model": "tea-asr-1.1-mini",
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
            "engine": "speech-recognition",
            "model": "tea-asr-1.1-mini",
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
    [[], "vertical-japanese-reader", ["speech-recognition"], ["vertical-japanese-reader"] * 2, [7]],
)
def test_worker_result_rejects_malformed_or_unknown_unit_suggestions(value: Any) -> None:
    with pytest.raises(WorkerResultError):
        parse_run_result(_ocr_payload(suggestedUnits=value))
