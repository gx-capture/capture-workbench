from __future__ import annotations

import importlib.util
import json
import sys
from contextlib import closing
from copy import deepcopy
from pathlib import Path

import pytest

from capture_runtime.engine_adapters import PaddleResultNormalizationError

MODULE_PATH = Path(__file__).resolve().parents[2] / "scripts" / "ocr_benchmark.py"
spec = importlib.util.spec_from_file_location("ocr_benchmark", MODULE_PATH)
assert spec is not None and spec.loader is not None
benchmark = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = benchmark
spec.loader.exec_module(benchmark)


def synthetic_module():
    path = MODULE_PATH.with_name("ocr_benchmark_synthetic.py")
    synthetic_spec = importlib.util.spec_from_file_location("ocr_benchmark_synthetic", path)
    assert synthetic_spec is not None and synthetic_spec.loader is not None
    module = importlib.util.module_from_spec(synthetic_spec)
    synthetic_spec.loader.exec_module(module)
    return module


def atomic_order_case():
    source = [
        {
            "id": "A",
            "text": "甲乙",
            "confidence": 0.9,
            "polygon": [[1, 1], [9, 1], [9, 30], [1, 30]],
        },
        {
            "id": "B",
            "text": "間",
            "confidence": 0.8,
            "polygon": [[11, 1], [19, 1], [19, 10], [11, 10]],
        },
    ]
    first = {"sourceId": "A", "start": 0, "end": 1}
    last = {"sourceId": "A", "start": 1, "end": 2}
    between = {"sourceId": "B", "start": 0, "end": 1}
    return source, first, last, between


def test_atomic_order_reports_interleaved_parent_without_dropping_text() -> None:
    source, first, last, between = atomic_order_case()
    report = benchmark.analyze_atomic_order(source, [[first, between, last]])
    assert report["status"] == "infeasible"
    assert report["coverageComplete"] is True
    assert report["alternatives"][0]["conflicts"][0]["code"] == "interleaved-parent"
    assert report["phasePass"] is False


def test_atomic_order_rejects_reversed_spans_even_with_one_parent_run() -> None:
    source, first, last, between = atomic_order_case()
    report = benchmark.analyze_atomic_order(source, [[last, first, between]])
    assert report["status"] == "infeasible"
    assert [c["code"] for c in report["alternatives"][0]["conflicts"]] == ["reversed-parent-spans"]


def test_atomic_order_accepts_adjacent_parent_spans_without_splitting() -> None:
    source, first, last, between = atomic_order_case()
    report = benchmark.analyze_atomic_order(source, [[first, last, between]])
    assert report["status"] == "representable"
    assert report["alternatives"][0]["sourceOrder"] == ["A", "B"]
    assert report["phasePass"] is False


def test_atomic_order_never_unions_mutually_exclusive_allowed_orders() -> None:
    source, first, last, between = atomic_order_case()
    report = benchmark.analyze_atomic_order(
        source, [[first, between, last], [between, first, last]]
    )
    assert report["status"] == "representable"
    assert report["possibleAlternativeIndexes"] == [1]
    assert report["alternatives"][1]["sourceOrder"] == ["B", "A"]


def test_atomic_order_partial_mapping_is_incomplete_unless_it_proves_a_conflict() -> None:
    source, first, last, between = atomic_order_case()
    source[0]["text"] += "丙"
    assert benchmark.analyze_atomic_order(source, [[first, between]])["status"] == "incomplete"
    contradiction = benchmark.analyze_atomic_order(source, [[first, between, last]])
    assert contradiction["status"] == "infeasible"
    assert contradiction["coverageComplete"] is False


@pytest.mark.parametrize(
    "fault", ["overlap", "out-of-range", "unknown", "boolean", "different-alternative"]
)
def test_atomic_order_refuses_invalid_span_evidence(fault) -> None:
    source, first, last, between = atomic_order_case()
    orders = [[first, last, between]]
    if fault == "overlap":
        first["end"] = 2
    elif fault == "out-of-range":
        last["end"] = 3
    elif fault == "unknown":
        first["sourceId"] = "missing"
    elif fault == "boolean":
        first["start"] = False
    else:
        orders.append([first, between])
    with pytest.raises(ValueError, match="span"):
        benchmark.analyze_atomic_order(source, orders)


def test_synthetic_rotation_maps_all_vertices_and_has_an_exact_inverse() -> None:
    module = synthetic_module()
    # Pixel-boundary coordinates rotate around (50.5, 50.5): OpenCV's centre is
    # (50, 50) in pixel-centre coordinates. Use an asymmetric polygon, not its centre.
    matrix = module.glyph_transform((100, 100), (100, 100), 1.0, 90.0)
    polygon = [[10, 20], [30, 20], [30, 60], [10, 60]]
    mapped = module.transform_polygon(polygon, matrix)
    for actual, expected in zip(mapped, [[20, 91], [20, 71], [60, 71], [60, 91]], strict=True):
        assert actual == pytest.approx(expected)
    for actual, expected in zip(
        module.transform_polygon(mapped, module.invert_transform(matrix)), polygon, strict=True
    ):
        assert actual == pytest.approx(expected)


def test_synthetic_resize_tracks_actual_rounded_raster_dimensions() -> None:
    module = synthetic_module()
    matrix = module.glyph_transform((101, 151), (203, 305), 2.0, 0.0)
    assert module.transform_polygon([[50, 75]], matrix)[0] == pytest.approx(
        [100 * 101 / 203, 150 * 151 / 305]
    )


@pytest.mark.parametrize("angle", [float("nan"), float("inf")])
def test_synthetic_transform_rejects_nonfinite_angles(angle: float) -> None:
    with pytest.raises(ValueError, match="finite"):
        synthetic_module().glyph_transform((100, 100), (200, 200), 2.0, angle)


def test_synthetic_degradation_is_reproducible_and_does_not_mutate_input() -> None:
    # Scan rasterization is opt-in with the OCR extras; geometry/provenance tests
    # above and below remain dependency-free in the regular unit environment.
    np = pytest.importorskip("numpy", reason="synthetic raster probe requires OCR extras")
    pytest.importorskip("cv2", reason="synthetic raster probe requires OCR extras")

    module = synthetic_module()
    image = np.full((80, 100, 3), 255, dtype=np.uint8)
    image[20:60, 30:70] = 0
    original = image.copy()
    first = module.scan_image(image, (50, 40), seed=7)
    second = module.scan_image(image, (50, 40), seed=7)
    assert np.array_equal(first, second)
    assert np.array_equal(image, original)
    assert first.shape == (40, 50, 3)
    assert not np.array_equal(first, module.scan_image(image, (50, 40), seed=8))


def test_synthetic_transform_rejects_clipped_glyphs_instead_of_clamping() -> None:
    with pytest.raises(ValueError, match="clipped"):
        synthetic_module().validate_glyphs(
            [{"polygon": [[-1, 0], [2, 0], [2, 4], [-1, 4]]}], (100, 100)
        )


@pytest.mark.parametrize(
    "field,value", [("character", "木"), ("ruby", True), ("polygon", [[2, 2]] * 4)]
)
def test_synthetic_glyph_mutation_with_same_count_is_rejected(tmp_path, field, value) -> None:
    import hashlib

    html = tmp_path / "page.html"
    html.write_text("<p>本</p>", encoding="utf-8")
    glyph_file = tmp_path / "glyphs.json"
    glyphs = {
        "sourceHtmlSha256": hashlib.sha256(html.read_bytes()).hexdigest(),
        "glyphs": [{"character": "本", "ruby": False, "polygon": [[1, 1], [3, 1], [3, 5], [1, 5]]}],
    }
    glyph_file.write_text(json.dumps(glyphs), encoding="utf-8")
    record = {
        "glyphCount": 1,
        "html": {"path": str(html), "sha256": glyphs["sourceHtmlSha256"]},
        "glyphs": {
            "path": str(glyph_file),
            "sha256": hashlib.sha256(glyph_file.read_bytes()).hexdigest(),
        },
    }
    module = synthetic_module()
    assert module.read_render_glyphs(record) == glyphs["glyphs"]
    glyphs["glyphs"][0][field] = value
    glyph_file.write_text(json.dumps(glyphs), encoding="utf-8")
    with pytest.raises(ValueError, match="digest"):
        module.read_render_glyphs(record)


def test_synthetic_glyph_html_lineage_must_match_even_when_files_are_pinned(tmp_path) -> None:
    import hashlib

    html = tmp_path / "page.html"
    html.write_text("<p>本</p>", encoding="utf-8")
    glyph_file = tmp_path / "glyphs.json"
    glyph_file.write_text(
        json.dumps({"sourceHtmlSha256": "0" * 64, "glyphs": []}), encoding="utf-8"
    )
    record = {
        "glyphCount": 0,
        "html": {"path": str(html), "sha256": hashlib.sha256(html.read_bytes()).hexdigest()},
        "glyphs": {
            "path": str(glyph_file),
            "sha256": hashlib.sha256(glyph_file.read_bytes()).hexdigest(),
        },
    }
    with pytest.raises(ValueError, match="HTML lineage"):
        synthetic_module().read_render_glyphs(record)


def layout_case():
    source = [
        {
            "id": "0:0",
            "text": "本文",
            "polygon": [[0, 0], [10, 0], [10, 40], [0, 40]],
            "confidence": 0.9,
        },
        {
            "id": "0:1",
            "text": "ほん",
            "polygon": [[11, 0], [15, 0], [15, 20], [11, 20]],
            "confidence": 0.8,
        },
    ]
    members = {
        "0:0": {"role": "body", "article": "A", "band": "upper", "owner": None},
        "0:1": {"role": "ruby", "article": "A", "band": "upper", "owner": "0:0"},
    }
    gold = {
        "schemaVersion": 1,
        "sourceDigest": benchmark.source_digest(source),
        "status": "reviewed",
        "reviewers": ["image-transcriber", "independent-reviewer"],
        "order": ["0:0", "0:1"],
        "members": members,
        "separators": {"0:1": "\n\n"},
        "truth": {"body": "本文", "ruby": "ほん", "full": "本文\n\nほん"},
    }
    return (
        source,
        {"regions": deepcopy(source), "members": deepcopy(members), "text": "本文\n\nほん"},
        gold,
    )


def test_reading_order_evaluator_accepts_preserved_regions_and_per_article_ruby() -> None:
    source, candidate, gold = layout_case()
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert result["passed"] is True
    assert result["issues"] == []
    assert result["recognition"]["body"] == {"edits": 0, "characters": 2, "cer": 0.0}
    assert result["recognition"]["ruby"] == {"edits": 0, "characters": 2, "cer": 0.0}


@pytest.mark.parametrize("owner_role", ["question", "option", "example", "example-option", "note"])
def test_nonbody_ruby_preserves_separate_cer_partitions(owner_role: str) -> None:
    source, candidate, gold = layout_case()
    gold["members"]["0:0"]["role"] = owner_role
    candidate["members"]["0:0"]["role"] = owner_role
    for region_id in ("0:0", "0:1"):
        gold["members"][region_id]["article"] = None
        candidate["members"][region_id]["article"] = None
    gold["truth"]["body"] = ""
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert result["passed"] is True
    assert result["recognition"]["body"] == {"edits": 0, "characters": 0, "cer": None}
    assert result["recognition"]["ruby"] == {"edits": 0, "characters": 2, "cer": 0.0}
    assert result["recognition"]["full"]["edits"] == 0


@pytest.mark.parametrize(
    "fault", ["self", "missing", "noise", "ruby", "page-number", "other-article"]
)
def test_ruby_gold_rejects_invalid_owner(fault: str) -> None:
    source, candidate, gold = layout_case()
    if fault in {"self", "missing"}:
        gold["members"]["0:1"]["owner"] = "0:1" if fault == "self" else "unknown"
    elif fault == "other-article":
        gold["members"]["0:0"]["article"] = "B"
    else:
        gold["members"]["0:0"]["role"] = fault
    with pytest.raises(ValueError, match="owner"):
        benchmark.evaluate_layout(source, candidate, gold)


def sidebar_case():
    source, candidate, gold = layout_case()
    sidebar = {
        "id": "0:2",
        "text": "読解",
        "polygon": [[30, 0], [40, 0], [40, 25], [30, 25]],
        "confidence": 0.9,
    }
    source.append(sidebar)
    gold["members"]["0:2"] = {"role": "header", "article": None, "band": None, "owner": None}
    gold["sourceDigest"] = benchmark.source_digest(source)
    gold["order"] = ["0:2", "0:0", "0:1"]
    gold["allowedOrders"] = [gold["order"], ["0:0", "0:1", "0:2"]]
    gold["truth"]["full"] = "読解\n本文\n\nほん"
    candidate.update(
        regions=deepcopy(source), members=deepcopy(gold["members"]), text="本文\n\nほん\n読解"
    )
    return source, candidate, gold


def test_explicit_alternate_order_preserves_article_and_exact_format() -> None:
    source, candidate, gold = sidebar_case()
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert result["passed"] is True
    assert result["recognition"]["body"]["edits"] == 0
    assert result["recognition"]["ruby"]["edits"] == 0
    candidate["text"] = "本文\nほん\n読解"
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert {issue["code"] for issue in result["issues"]} == {"text-format"}


def test_alternate_metadata_order_does_not_allow_unlisted_body_ruby_order() -> None:
    source, candidate, gold = sidebar_case()
    candidate["regions"] = [source[1], source[0], source[2]]
    candidate["text"] = "ほん\n本文\n読解"
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert "reading-order" in {issue["code"] for issue in result["issues"]}


@pytest.mark.parametrize(
    "orders",
    [
        [],
        "0:2,0:0,0:1",
        [["0:2", "0:0"]],
        [["0:2", "0:0", "0:0"]],
        [["0:0", "0:1", "0:2"]],
        [["0:2", "0:0", "unknown"]],
    ],
)
def test_alternate_gold_orders_must_be_complete_and_include_canonical_order(orders) -> None:
    source, candidate, gold = sidebar_case()
    gold["allowedOrders"] = orders
    with pytest.raises(ValueError, match="gold.*order"):
        benchmark.evaluate_layout(source, candidate, gold)


def test_required_separator_cannot_be_lost_at_start_of_an_alternate_order() -> None:
    source, candidate, gold = sidebar_case()
    gold["allowedOrders"].append(["0:1", "0:0", "0:2"])
    with pytest.raises(ValueError, match="gold separators"):
        benchmark.evaluate_layout(source, candidate, gold)


@pytest.mark.parametrize("fault", ["omission", "duplicate", "foreign", "text", "polygon", "score"])
def test_whole_region_evaluator_rejects_lost_added_or_changed_source_tuples(fault) -> None:
    source, candidate, gold = layout_case()
    regions = candidate["regions"]
    if fault == "omission":
        regions.pop()
    elif fault == "duplicate":
        regions.append(deepcopy(regions[0]))
    elif fault == "foreign":
        regions[0]["id"] = "another-observation:0"
    elif fault == "text":
        regions[0]["text"] = "本又"
    elif fault == "polygon":
        regions[0]["polygon"][0][0] = 1
    else:
        regions[0]["confidence"] = 0.95
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert result["passed"] is False
    expected = {
        "omission": "missing-region",
        "duplicate": "duplicate-region",
        "foreign": "foreign-region",
    }.get(fault, "changed-tuple")
    assert expected in {issue["code"] for issue in result["issues"]}


@pytest.mark.parametrize(
    "fault", ["order", "role", "owner", "article", "band", "format", "lost-member"]
)
def test_layout_errors_are_independent_of_character_error(fault) -> None:
    source, candidate, gold = layout_case()
    if fault == "order":
        candidate["regions"].reverse()
    elif fault == "format":
        candidate["text"] = "本文\nほん"
    elif fault == "lost-member":
        del candidate["members"]["0:1"]
    else:
        candidate["members"]["0:1"][fault] = {
            "role": "body",
            "owner": "0:1",
            "article": "B",
            "band": "lower",
        }[fault]
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert result["passed"] is False
    expected = {
        "order": "reading-order",
        "format": "text-format",
        "lost-member": "membership-coverage",
    }.get(fault, f"wrong-{fault}")
    assert expected in {issue["code"] for issue in result["issues"]}
    assert result["recognition"]["ruby"]["edits"] == 0


def test_ruby_omission_cannot_lower_cer_by_changing_candidate_roles() -> None:
    source, candidate, gold = layout_case()
    candidate["regions"].pop()
    candidate["members"]["0:1"]["role"] = "noise"
    candidate["text"] = "本文"
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert result["recognition"]["ruby"] == {"edits": 2, "characters": 2, "cer": 1.0}
    assert result["recognition"]["body"]["edits"] == 0


@pytest.mark.parametrize(
    "fault", ["draft", "one-reviewer", "digest", "gold-omission", "gold-owner"]
)
def test_untrusted_or_incomplete_gold_cannot_report_a_pass(fault) -> None:
    source, candidate, gold = layout_case()
    if fault == "draft":
        gold["status"] = "draft"
    elif fault == "one-reviewer":
        gold["reviewers"] = ["same-person", "same-person"]
    elif fault == "digest":
        gold["sourceDigest"] = "0" * 64
    elif fault == "gold-omission":
        gold["order"].pop()
    else:
        gold["members"]["0:1"]["owner"] = "missing"
    with pytest.raises(ValueError, match="gold"):
        benchmark.evaluate_layout(source, candidate, gold)


def test_empty_reference_does_not_hide_hallucinated_characters() -> None:
    assert benchmark.character_error("", "0.00") == {"edits": 4, "characters": 0, "cer": None}


def test_body_cer_does_not_include_headers_or_fix_existing_recognition_errors() -> None:
    source, candidate, gold = layout_case()
    header = {
        "id": "0:2",
        "text": "N1",
        "polygon": [[0, 41], [10, 41], [10, 45], [0, 45]],
        "confidence": 0.9,
    }
    source.insert(0, header)
    candidate["regions"].insert(0, deepcopy(header))
    gold["members"]["0:2"] = {"role": "header", "article": None, "band": None, "owner": None}
    candidate["members"]["0:2"] = deepcopy(gold["members"]["0:2"])
    gold["order"].insert(0, "0:2")
    gold["sourceDigest"] = benchmark.source_digest(source)
    gold["truth"]["body"] = "本字"
    gold["truth"]["full"] = "N1\n本字\n\nほん"
    candidate["text"] = "N1\n本文\n\nほん"
    result = benchmark.evaluate_layout(source, candidate, gold)
    assert result["passed"] is True  # correct layout can retain an old recognition error
    assert result["recognition"]["body"] == {"edits": 1, "characters": 2, "cer": 0.5}


def test_replay_command_persists_source_bound_failure_and_returns_nonzero(tmp_path) -> None:
    source, candidate, gold = layout_case()
    candidate["members"]["0:1"]["article"] = "B"
    input_path = tmp_path / "case.json"
    output_path = tmp_path / "result.json"
    input_path.write_text(
        json.dumps({"source": source, "candidate": candidate, "gold": gold}), encoding="utf-8"
    )
    assert benchmark.main(["score", "--input", str(input_path), "--output", str(output_path)]) == 1
    report = json.loads(output_path.read_text(encoding="utf-8"))
    assert report["passed"] is False
    assert report["sourceDigest"] == gold["sourceDigest"]
    assert report["inputSha256"]
    assert report["scorerSha256"]
    with pytest.raises(FileExistsError):
        benchmark.main(["score", "--input", str(input_path), "--output", str(output_path)])


def test_observation_retains_original_slots_after_strict_empty_region_filtering() -> None:
    raw = [
        {
            "rec_texts": ["本文", " ", "ほん"],
            "rec_scores": [0.9, 0.0, 0.8],
            "rec_polys": [
                [[0, 0], [10, 0], [10, 40], [0, 40]],
                [[20, 0], [25, 0], [25, 40], [20, 40]],
                [[11, 0], [15, 0], [15, 20], [11, 20]],
            ],
        }
    ]
    observation = benchmark.normalize_observation(raw, "run:page", width=50, height=50)
    assert [region["id"] for region in observation["regions"]] == ["run:page:0:0", "run:page:0:2"]
    assert observation["omittedEmptySlots"] == ["run:page:0:1"]
    assert observation["text"] == "本文\nほん"
    raw[0]["rec_scores"][1] = -0.1
    with pytest.raises(PaddleResultNormalizationError):
        benchmark.normalize_observation(raw, "run:page", width=50, height=50)


@pytest.mark.parametrize(
    "fault", ["role", "band", "separator", "version", "empty", "boolean-score"]
)
def test_malformed_gold_or_source_is_rejected_before_scoring(fault) -> None:
    source, candidate, gold = layout_case()
    if fault == "role":
        gold["members"]["0:1"]["role"] = "anything"
    elif fault == "band":
        del gold["members"]["0:1"]["band"]
    elif fault == "separator":
        gold["separators"]["missing"] = "\n\n"
    elif fault == "version":
        gold["schemaVersion"] = True
    elif fault == "empty":
        source[0]["text"] = " "
        gold["sourceDigest"] = benchmark.source_digest(source)
    else:
        source[0]["confidence"] = True
        gold["sourceDigest"] = benchmark.source_digest(source)
    with pytest.raises((ValueError, PaddleResultNormalizationError)):
        benchmark.evaluate_layout(source, candidate, gold)


@pytest.mark.parametrize("reviewers", ["ab", {"a": 1, "b": 2}, ["a", " a "]])
def test_independent_reviewers_must_be_a_list_of_distinct_normalized_names(reviewers) -> None:
    source, candidate, gold = layout_case()
    gold["reviewers"] = reviewers
    with pytest.raises(ValueError, match="gold"):
        benchmark.evaluate_layout(source, candidate, gold)


def test_changed_input_after_preflight_is_rejected_at_the_actual_read(tmp_path) -> None:
    import hashlib

    image_path = tmp_path / "image.png"
    image_path.write_bytes(b"original-raster")
    frozen_sha = hashlib.sha256(image_path.read_bytes()).hexdigest()
    image_path.write_bytes(b"changed-raster")
    with pytest.raises(ValueError, match="digest"):
        benchmark.read_verified_bytes(image_path, frozen_sha)


@pytest.mark.parametrize("kind", ["document", "image"])
def test_material_freeze_rejects_bytes_changed_during_copy(tmp_path, monkeypatch, kind) -> None:
    import hashlib

    from PIL import Image

    runtime_spec = importlib.util.spec_from_file_location(
        "ocr_benchmark_runtime", MODULE_PATH.with_name("ocr_benchmark_runtime.py")
    )
    assert runtime_spec is not None and runtime_spec.loader is not None
    runtime = importlib.util.module_from_spec(runtime_spec)
    runtime_spec.loader.exec_module(runtime)
    source = tmp_path / ("input.pdf" if kind == "document" else "input.png")
    if kind == "document":
        source.write_bytes(
            (
                MODULE_PATH.parents[1] / "model-sources/commit-a/fixtures/ocr-scanned.pdf"
            ).read_bytes()
        )
    else:
        with Image.new("RGB", (4, 4), "white") as image:
            image.save(source)
    entry = {
        "id": "source",
        "path": str(source),
        "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "kind": "real",
    }
    request = {
        "documents": [entry] if kind == "document" else [],
        "images": [entry] if kind == "image" else [],
    }
    request_path = tmp_path / "request.json"
    request_path.write_text(json.dumps(request), encoding="utf-8")
    copyfile = runtime.shutil.copyfile

    def changed_copy(original, destination):
        result = copyfile(original, destination)
        # Both formats remain readable; this exercises identity, not renderer failure.
        with Path(destination).open("ab") as copied:
            copied.write(b"\n% changed-after-check\n")
        return result

    monkeypatch.setattr(runtime.shutil, "copyfile", changed_copy)
    output = tmp_path / "frozen"
    with pytest.raises(ValueError, match="material .*digest mismatch"):
        runtime.freeze_materials(request_path, output)
    assert not (output / "manifest.json").exists()


def test_cleanup_failure_cannot_leave_completed_evidence(tmp_path) -> None:
    class FailingCleanup:
        def close(self):
            raise RuntimeError("cleanup failed")

    with pytest.raises(RuntimeError, match="cleanup failed"):
        with benchmark.recorded_run(tmp_path) as report:
            with closing(FailingCleanup()):
                report["rows"] = [{"inference": "finished"}]
    assert not (tmp_path / "completed.json").exists()
    failure = json.loads((tmp_path / "failed.json").read_text(encoding="utf-8"))
    assert failure["type"] == "RuntimeError"
    assert failure["detail"] == "cleanup failed"
