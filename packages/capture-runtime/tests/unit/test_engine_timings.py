from __future__ import annotations

import jsonschema
import pytest
from pydantic import ValidationError

from capture_runtime.contracts import CaptureEngine


@pytest.mark.parametrize(
    "timings",
    [
        {},
        {"elapsedMs": None, "stageMs": None},
        {"elapsedMs": 0, "stageMs": {}},
        {"elapsedMs": 2300, "stageMs": {"modelLoad": 200, "inference": 1200, "postprocessing": 0}},
        {"elapsedMs": 2300},
        {"stageMs": {"alignment": 123}},
    ],
)
def test_engine_timing_contract_round_trips_with_optional_fields(timings):
    payload = {
        "engine": "speaker-diarization",
        "model": "nemotron",
        "digest": "sha256:" + "a" * 64,
        "device": "cpu",
        **timings,
    }
    engine = CaptureEngine.model_validate(payload)
    assert engine.elapsed_ms == timings.get("elapsedMs")
    assert engine.stage_ms == timings.get("stageMs")
    wire = engine.model_dump(mode="json", by_alias=True)
    jsonschema.validate(wire, CaptureEngine.model_json_schema(by_alias=True))
    assert "elapsed_ms" not in wire and "stage_ms" not in wire
    assert CaptureEngine.model_validate_json(engine.model_dump_json(by_alias=True)) == engine


@pytest.mark.parametrize(
    "timings",
    [
        {"elapsedMs": -1},
        {"elapsedMs": 1.5},
        {"stageMs": {"inference": -1}},
        {"stageMs": {"inference": 1.5}},
        {"stageMs": {"": 1}},
        {"stageMs": {" ": 1}},
    ],
)
def test_engine_timing_contract_rejects_invalid_values(timings):
    with pytest.raises(ValidationError):
        CaptureEngine.model_validate(
            {
                "engine": "speech-recognition",
                "model": "tea",
                "digest": "sha256:" + "a" * 64,
                **timings,
            }
        )
