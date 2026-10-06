from __future__ import annotations

import hashlib
import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

import capture_runtime.engine_adapters as engine_adapters
from capture_runtime.engine_adapters import (
    EngineRuntimeUnavailableError,
    PaddleResultNormalizationError,
    WindowsMLOcrAdapter,
    normalize_paddle_results,
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


def test_raw_source_slots_survive_empty_regions_and_empty_results() -> None:
    polygon = [[10, 10], [70, 10], [68, 30], [8, 30]]
    normalized = normalize_paddle_results(
        [
            {"res": payload}
            for payload in (
                {
                    "rec_texts": ["第一", "", "第三"],
                    "rec_scores": [0.91, 0.0, 0.92],
                    "rec_polys": [polygon, polygon, polygon],
                },
                {"rec_texts": []},
                {
                    "rec_texts": ["第一"],
                    "rec_scores": [0.91],
                    "rec_polys": [polygon],
                },
            )
        ],
        raster_width=120,
        raster_height=80,
    )
    assert [region.text for region in normalized.regions] == ["第一", "第三", "第一"]
    assert normalized.source_slots == ((0, 0), (0, 2), (2, 0))


def test_adapter_passes_original_slots_to_reading_plan(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed = []
    original = engine_adapters.plan_reading_order

    def observe(regions, **kwargs):
        observed.append(kwargs.get("raw_source_slots"))
        return original(regions, **kwargs)

    monkeypatch.setattr(engine_adapters, "plan_reading_order", observe)
    result = _extract(
        tmp_path,
        {
            "res": {
                "rec_texts": ["同一文字", "", "同一文字"],
                "rec_scores": [0.9, 0.0, 0.9],
                "rec_boxes": [[0, 0, 80, 20], [0, 25, 80, 45], [0, 50, 80, 70]],
            }
        },
    )
    assert result.text == "同一文字\n同一文字"
    assert observed == [((0, 0), (0, 2))]


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


@pytest.mark.parametrize("polygon_field", ["rec_polys", "dt_polys", "rec_boxes"])
def test_paddle_normalizer_skips_blank_regions_without_losing_alignment(
    tmp_path: Path, polygon_field: str
) -> None:
    result = _extract(
        tmp_path,
        {
            "res": {
                "rec_texts": [" first ", "", " \t\n\u3000", "last"],
                "rec_scores": [0.91, 0.0, 0.5, 0.0],
                polygon_field: [[1, 1, 11, 11], [20, 1, 30, 11], [40, 1, 50, 11], [60, 1, 70, 11]],
            }
        },
    )

    assert result.text == "first\nlast"
    assert [region.text for region in result.regions] == ["first", "last"]
    assert [region.box for region in result.regions] == [(1, 1, 10, 10), (60, 1, 10, 10)]
    assert result.region_confidences == (0.91, 0.0)
    assert result.raster_width == 120
    assert result.raster_height == 80
    assert result.provenance is not None
    assert result.provenance.status == "resolved"


def test_paddle_normalizer_treats_all_blank_regions_as_no_text(tmp_path: Path) -> None:
    result = _extract(
        tmp_path,
        {
            "res": {
                "rec_texts": ["", " \t\n\u3000"],
                "rec_scores": [0.0, 0.5],
                "rec_boxes": [[1, 1, 11, 11], [20, 1, 30, 11]],
            }
        },
    )

    assert result.text == ""
    assert result.regions == ()
    assert result.region_confidences == ()


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
@pytest.mark.parametrize("text", ["合法文字", "", " \t\u3000"])
def test_paddle_normalizer_rejects_non_numeric_or_invalid_scores(
    tmp_path: Path,
    score: object,
    text: str,
) -> None:
    with pytest.raises(PaddleResultNormalizationError):
        _extract(tmp_path, _valid_payload(text=text, score=score))


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
@pytest.mark.parametrize("second_text", ["two", ""])
def test_paddle_normalizer_rejects_parallel_cardinality_mismatch(
    tmp_path: Path,
    field: str,
    values: list[object],
    second_text: str,
) -> None:
    payload = {
        "res": {
            "rec_texts": ["one", second_text],
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
@pytest.mark.parametrize("text", ["文字", "", " \t\u3000"])
def test_paddle_normalizer_rejects_malformed_polygon(
    tmp_path: Path,
    polygon: list[list[object]],
    text: str,
) -> None:
    payload = {
        "res": {
            "rec_texts": [text],
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


def test_normalization_failure_reports_its_worker_stage(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    stages: list[str] = []

    class Result:
        json = _valid_payload(score=2)

    class Pipeline:
        def predict(self, _source: str) -> object:
            return [Result()]

    adapter = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["CPUExecutionProvider"],
        stage_reporter=stages.append,
    )

    with pytest.raises(PaddleResultNormalizationError):
        adapter.extract_png(_image())

    # Worker failure evidence keeps the tail, so the rejected step is visible.
    assert stages[-2:] == [
        "ocr-predict-complete",
        "ocr-normalize-failed-paddleresultnormalizationerror",
    ]
