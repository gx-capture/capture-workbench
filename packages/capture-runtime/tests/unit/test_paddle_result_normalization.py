from __future__ import annotations

import hashlib
import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from capture_runtime.engine_adapters import (
    EngineRuntimeUnavailableError,
    PaddleResultNormalizationError,
    WindowsMLOcrAdapter,
)
from capture_runtime.ocr_preflight import OcrComputePlan, OcrGpuCapabilitySnapshot
from capture_runtime.ocr_profile import CANONICAL_PROFILE_PATH, canonical_json_bytes


def _write_windowsml_models(root: Path) -> None:
    for relative in (
        "det/inference.onnx",
        "det/inference.yml",
        "rec/inference.onnx",
        "rec/inference.yml",
        "rec/ppocrv6_dict.txt",
        "pipeline.json",
    ):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative != "pipeline.json":
            path.write_bytes(relative.encode())
    profile = json.loads(CANONICAL_PROFILE_PATH.read_text(encoding="utf-8"))
    for artifact in profile["artifacts"]:
        data = (root / artifact["path"]).read_bytes()
        artifact["bytes"] = len(data)
        artifact["sha256"] = hashlib.sha256(data).hexdigest()
        if artifact["path"] == "rec/ppocrv6_dict.txt":
            profile["dictionary"]["sha256"] = artifact["sha256"]
    (root / "pipeline.json").write_bytes(canonical_json_bytes(profile))


def _image() -> bytes:
    image = BytesIO()
    Image.new("RGB", (120, 80), "white").save(image, format="PNG")
    return image.getvalue()


class _EmptyProbe:
    def probe(self) -> OcrGpuCapabilitySnapshot:
        return OcrGpuCapabilitySnapshot()


def _cpu_plan():
    selection = OcrComputePlan(
        contract_sha256="a" * 64,
        worker_sha256="b" * 64,
        capability_probe=_EmptyProbe(),
    ).select()
    assert selection is not None
    return selection.execution_plan


def _extract(tmp_path: Path, payload: object, *, results: object | None = None):
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = payload

    class Pipeline:
        def predict(self, _source: str) -> object:
            return [Result()] if results is None else results

    adapter = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["CPUExecutionProvider"],
    )
    return adapter.extract_png(_image())


def _valid_payload(*, text: object = "合法文字", score: object = 0.91) -> dict[str, object]:
    return {
        "res": {
            "rec_texts": [text],
            "rec_scores": [score],
            "rec_polys": [[[10, 10], [70, 10], [68, 30], [8, 30]]],
            "unknown_diagnostic": {"ignored": True},
        }
    }


def test_paddle_normalizer_accepts_valid_regions_and_ignores_unknown_keys(
    tmp_path: Path,
) -> None:
    payload = {
        "res": {
            "rec_texts": ["繁中", "English"],
            "rec_scores": [0.91, 0.82],
            "rec_polys": [
                [[11.25, 20.5], [91.75, 18.0], [104.0, 61.25], [4.5, 64.0]],
                [[1, 1], [20, 1], [20, 20], [1, 20]],
            ],
            "unknown_key": "must not change canonical regions",
        },
        "unknown_top_level_key": True,
    }

    result = _extract(tmp_path, payload)

    assert result.text == "繁中\nEnglish"
    assert [region.text for region in result.regions] == ["繁中", "English"]
    assert [region.confidence for region in result.regions] == [0.91, 0.82]
    assert result.regions[0].polygon == (
        (11.25, 20.5),
        (91.75, 18.0),
        (104.0, 61.25),
        (4.5, 64.0),
    )


def test_paddle_normalizer_reads_json_wrapper_from_mapping_result_subclass(
    tmp_path: Path,
) -> None:
    valid = _valid_payload()["res"]

    class PaddleResult(dict):
        @property
        def json(self) -> dict[str, object]:
            return {"res": self}

    result = _extract(tmp_path, _valid_payload(), results=[PaddleResult(valid)])

    assert result.text == str(valid["rec_texts"][0])
    assert len(result.regions) == 1


def test_paddle_normalizer_accepts_a_truly_empty_result(tmp_path: Path) -> None:
    result = _extract(
        tmp_path,
        {
            "res": {
                "rec_texts": [],
                "rec_scores": [],
                "rec_polys": [],
            }
        },
    )

    assert result.text == ""
    assert result.regions == ()


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {"res": None},
        {"res": {"rec_texts": None}},
        {"res": {"rec_texts": [["nested"]], "rec_scores": [0.9], "rec_polys": []}},
        {"res": {"rec_texts": ["文字"], "rec_scores": None, "rec_polys": []}},
        {"res": {"rec_texts": ["文字"], "rec_scores": [0.9], "rec_polys": None}},
    ],
    ids=[
        "missing-res-payload",
        "none-res",
        "none-texts",
        "nested-texts",
        "none-scores",
        "none-polys",
    ],
)
def test_paddle_normalizer_rejects_none_and_nested_shapes(
    tmp_path: Path,
    payload: object,
) -> None:
    with pytest.raises(PaddleResultNormalizationError):
        _extract(tmp_path, payload)


@pytest.mark.parametrize(
    "score",
    [True, False, "0.9", float("nan"), float("inf"), -0.01, 1.01],
    ids=["bool-true", "bool-false", "string", "nan", "infinity", "negative", "above-one"],
)
def test_paddle_normalizer_rejects_non_numeric_or_invalid_scores(
    tmp_path: Path,
    score: object,
) -> None:
    with pytest.raises(PaddleResultNormalizationError):
        _extract(tmp_path, _valid_payload(score=score))


@pytest.mark.parametrize("text", [None, 42, True, ["nested"]])
def test_paddle_normalizer_rejects_non_string_text_without_coercion(
    tmp_path: Path,
    text: object,
) -> None:
    with pytest.raises(PaddleResultNormalizationError):
        _extract(tmp_path, _valid_payload(text=text))


@pytest.mark.parametrize(
    "field, values",
    [
        ("rec_scores", [0.9]),
        ("rec_polys", [[[10, 10], [70, 10], [68, 30], [8, 30]]]),
    ],
    ids=["score-cardinality", "polygon-cardinality"],
)
def test_paddle_normalizer_rejects_parallel_cardinality_mismatch(
    tmp_path: Path,
    field: str,
    values: list[object],
) -> None:
    payload = {
        "res": {
            "rec_texts": ["one", "two"],
            "rec_scores": [0.9, 0.8],
            "rec_polys": [
                [[10, 10], [70, 10], [68, 30], [8, 30]],
                [[10, 40], [70, 40], [68, 60], [8, 60]],
            ],
        }
    }
    payload["res"][field] = values  # type: ignore[index]

    with pytest.raises(PaddleResultNormalizationError):
        _extract(tmp_path, payload)


@pytest.mark.parametrize(
    "score",
    ["malformed", None],
    ids=["malformed-score", "missing-score"],
)
def test_paddle_normalizer_fails_atomically_when_one_region_is_malformed(
    tmp_path: Path,
    score: object,
) -> None:
    payload = {
        "res": {
            "rec_texts": [f"region-{index}" for index in range(10)],
            "rec_scores": [0.9] * 9 + [score],
            "rec_polys": [[[10, 10], [70, 10], [68, 30], [8, 30]] for _ in range(10)],
        }
    }

    with pytest.raises(PaddleResultNormalizationError):
        _extract(tmp_path, payload)


@pytest.mark.parametrize(
    "polygon",
    [
        [[0, 0], [10, 0], [10, 10]],
        [[0, 0], [10, 0], [10, 10], [0, 10], [float("nan"), 0]],
        [[0, 0], [10, 0], [10, 10], [-1, 10]],
        [[0, 0], [10, 0], [121, 10], [0, 10]],
        [[0, 0], [10, 0], [10, "bad"], [0, 10]],
    ],
    ids=["too-few-points", "nan", "negative", "out-of-raster", "non-numeric"],
)
def test_paddle_normalizer_rejects_malformed_polygon(
    tmp_path: Path,
    polygon: list[list[object]],
) -> None:
    payload = {
        "res": {
            "rec_texts": ["文字"],
            "rec_scores": [0.9],
            "rec_polys": [polygon],
        }
    }

    with pytest.raises(PaddleResultNormalizationError):
        _extract(tmp_path, payload)


def test_paddle_normalizer_rejects_missing_score_for_non_empty_page(tmp_path: Path) -> None:
    with pytest.raises(PaddleResultNormalizationError):
        _extract(
            tmp_path,
            {
                "res": {
                    "rec_texts": ["score required"],
                    "rec_polys": [[[10, 10], [70, 10], [68, 30], [8, 30]]],
                }
            },
        )


def test_paddle_normalizer_rejects_top_level_nested_results(tmp_path: Path) -> None:
    with pytest.raises(PaddleResultNormalizationError):
        _extract(
            tmp_path,
            [[SimpleNamespace(json=_valid_payload())]],
            results=[[SimpleNamespace(json=_valid_payload())]],
        )


def test_paddle_normalizer_converts_xyxy_rectangle_without_losing_cardinality(
    tmp_path: Path,
) -> None:
    result = _extract(
        tmp_path,
        {
            "res": {
                "rec_texts": ["rectangle"],
                "rec_scores": [0.8],
                "rec_boxes": [[10, 20, 50, 70]],
            }
        },
    )

    assert result.regions[0].polygon == (
        (10.0, 20.0),
        (50.0, 20.0),
        (50.0, 70.0),
        (10.0, 70.0),
    )


def test_paddle_normalizer_does_not_fallback_past_a_malformed_non_empty_polygon(
    tmp_path: Path,
) -> None:
    with pytest.raises(PaddleResultNormalizationError):
        _extract(
            tmp_path,
            {
                "res": {
                    "rec_texts": ["malformed polygon"],
                    "rec_scores": [0.8],
                    "rec_polys": [None],
                    "dt_polys": [[[10, 10], [70, 10], [68, 30], [8, 30]]],
                }
            },
        )


def test_paddle_normalizer_error_is_an_engine_failure_type(tmp_path: Path) -> None:
    with pytest.raises(EngineRuntimeUnavailableError) as raised:
        _extract(tmp_path, _valid_payload(text=object()))

    assert isinstance(raised.value, PaddleResultNormalizationError)
