"""Local OCR research evidence, separate from product inference and public contracts.

Layout gold binds an independently reviewed image annotation to one exact observation.
Recognition partitions use that binding, never the candidate's claimed ruby roles.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import unicodedata
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any


def source_digest(regions: list[dict[str, Any]]) -> str:
    canonical = json.dumps(
        regions, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def normalize_observation(
    raw: list[dict[str, Any]], observation_id: str, *, width: int, height: int
) -> dict[str, Any]:
    from capture_runtime.engine_adapters import normalize_paddle_results

    normalized = normalize_paddle_results(
        [{"res": payload} for payload in raw], raster_width=width, raster_height=height
    )
    slots = []
    omitted = []
    for result_index, result in enumerate(raw):
        for slot, text in enumerate(result["rec_texts"]):
            region_id = f"{observation_id}:{result_index}:{slot}"
            (slots if text.strip() else omitted).append(region_id)
    regions = [
        {
            "id": region_id,
            "text": region.text,
            "confidence": region.confidence,
            "polygon": [list(point) for point in region.polygon],
        }
        for region_id, region in zip(slots, normalized.regions, strict=True)
    ]
    return {
        "observationId": observation_id,
        "regions": regions,
        "text": normalized.text,
        "omittedEmptySlots": omitted,
        "sourceDigest": source_digest(regions),
    }


def character_error(reference: str, hypothesis: str) -> dict[str, int | float | None]:
    """NFKC/whitespace-free CER; exact output formatting is checked separately."""
    ref = "".join(c for c in unicodedata.normalize("NFKC", reference) if not c.isspace())
    hyp = "".join(c for c in unicodedata.normalize("NFKC", hypothesis) if not c.isspace())
    previous = list(range(len(hyp) + 1))
    for row, expected in enumerate(ref, 1):
        current = [row]
        for column, actual in enumerate(hyp, 1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[column] + 1,
                    previous[column - 1] + (expected != actual),
                )
            )
        previous = current
    edits = previous[-1]
    return {"edits": edits, "characters": len(ref), "cer": edits / len(ref) if ref else None}


def analyze_atomic_order(
    source: list[dict[str, Any]], allowed_span_orders: list[list[dict[str, Any]]]
) -> dict[str, Any]:
    """Diagnose reviewed image-to-source constraints, never infer runtime boundaries.

    Spans are half-open Python string offsets, supplied by independent image binding.
    Partial evidence can prove a contradiction, but cannot establish representability.
    Mutually exclusive allowed image orders are evaluated separately.
    """
    _validate_regions(source)
    parents = {region["id"]: region["text"] for region in source}
    if len(parents) != len(source):
        raise ValueError("span source contains duplicate parent IDs")
    if not isinstance(allowed_span_orders, list) or not allowed_span_orders:
        raise ValueError("span orders must be a nonempty list of alternatives")
    signatures = []
    for order in allowed_span_orders:
        if not isinstance(order, list):
            raise ValueError("span order must be a list")
        for span in order:
            if (
                not isinstance(span, dict)
                or set(span) != {"sourceId", "start", "end"}
                or not isinstance(span["sourceId"], str)
                or span["sourceId"] not in parents
                or type(span["start"]) is not int
                or type(span["end"]) is not int
                or not 0 <= span["start"] < span["end"] <= len(parents[span["sourceId"]])
            ):
                raise ValueError("span must identify a valid nonempty parent text interval")
        signatures.append(sorted((s["sourceId"], s["start"], s["end"]) for s in order))
    if any(signature != signatures[0] for signature in signatures[1:]):
        raise ValueError("span alternatives must represent the same intervals exactly once")
    intervals: dict[str, list[tuple[int, int]]] = {parent: [] for parent in parents}
    for parent, start, end in signatures[0]:
        if intervals[parent] and start < intervals[parent][-1][1]:
            raise ValueError("span intervals must not overlap or duplicate parent text")
        intervals[parent].append((start, end))
    coverage = {
        parent: {
            "covered": sum(end - start for start, end in spans),
            "characters": len(parents[parent]),
        }
        for parent, spans in intervals.items()
    }
    complete = all(row["covered"] == row["characters"] for row in coverage.values())
    alternatives = []
    possible = []
    for alternative_index, order in enumerate(allowed_span_orders):
        previous_end: dict[str, int] = {}
        runs: list[str] = []
        conflicts = []
        for span_index, span in enumerate(order):
            parent = span["sourceId"]
            if parent in previous_end and span["start"] < previous_end[parent]:
                conflicts.append(
                    {"code": "reversed-parent-spans", "sourceId": parent, "spanIndex": span_index}
                )
            previous_end[parent] = span["end"]
            if not runs or runs[-1] != parent:
                if parent in runs:
                    conflicts.append(
                        {
                            "code": "interleaved-parent",
                            "sourceId": parent,
                            "spanIndex": span_index,
                            "interveningSourceIds": runs[runs.index(parent) + 1 :],
                        }
                    )
                runs.append(parent)
        if not conflicts:
            possible.append(alternative_index)
        alternatives.append(
            {"conflicts": conflicts, "sourceOrder": runs if not conflicts else None}
        )
    return {
        "status": ("representable" if complete else "incomplete") if possible else "infeasible",
        "coverageComplete": complete,
        "coverage": coverage,
        "possibleAlternativeIndexes": possible,
        "alternatives": alternatives,
        "sourceDigest": source_digest(source),
        "phasePass": False,
        "evidenceTier": "reviewed-span-order-diagnostic-only",
    }


def evaluate_layout(
    source: list[dict[str, Any]], candidate: dict[str, Any], gold: dict[str, Any]
) -> dict[str, Any]:
    """Score one source-bound whole-region candidate without using its roles as GT."""
    _validate_gold(source, gold)
    regions = candidate["regions"]
    _validate_regions(regions)
    original = {region["id"]: region for region in source}
    counts = Counter(region["id"] for region in regions)
    issues = []
    for region_id in original:
        if not counts[region_id]:
            issues.append({"code": "missing-region", "id": region_id})
    for region_id, count in counts.items():
        if count > 1:
            issues.append({"code": "duplicate-region", "id": region_id})
        if region_id not in original:
            issues.append({"code": "foreign-region", "id": region_id})
    candidate_order = [region["id"] for region in regions]
    order_allowed = candidate_order in gold.get("allowedOrders", [gold["order"]])
    if not order_allowed:
        issues.append({"code": "reading-order"})
    if set(candidate["members"]) != set(original):
        issues.append({"code": "membership-coverage"})
    for region_id, expected in gold["members"].items():
        actual = candidate["members"].get(region_id, {})
        for field in ("role", "article", "band", "owner"):
            if actual.get(field) != expected[field]:
                issues.append({"code": f"wrong-{field}", "id": region_id})
    expected_text = "".join(
        (gold["separators"].get(region_id, "\n") if index else "") + original[region_id]["text"]
        for index, region_id in enumerate(candidate_order if order_allowed else gold["order"])
    )
    if candidate["text"] != expected_text:
        issues.append({"code": "text-format"})
    body = []
    ruby = []
    for region in regions:
        if region["id"] not in original:
            continue
        if region != original[region["id"]]:
            issues.append({"code": "changed-tuple", "id": region["id"]})
        role = gold["members"][region["id"]]["role"]
        if role == "ruby":
            ruby.append(region["text"])
        elif role == "body":
            body.append(region["text"])
    return {
        "passed": not issues,
        "issues": issues,
        "sourceDigest": source_digest(source),
        "recognition": {
            "body": character_error(gold["truth"]["body"], "\n".join(body)),
            "ruby": character_error(gold["truth"]["ruby"], "\n".join(ruby)),
            "full": character_error(gold["truth"]["full"], candidate["text"]),
        },
    }


def _validate_gold(source: list[dict[str, Any]], gold: dict[str, Any]) -> None:
    _validate_regions(source)
    source_ids = [region["id"] for region in source]
    if len(set(source_ids)) != len(source_ids):
        raise ValueError("source contains duplicate region IDs")
    if (
        type(gold.get("schemaVersion")) is not int
        or gold["schemaVersion"] != 1
        or gold.get("status") != "reviewed"
    ):
        raise ValueError("gold must be reviewed schema version 1")
    reviewers = gold.get("reviewers", [])
    if (
        not isinstance(reviewers, list)
        or not all(isinstance(r, str) and r.strip() for r in reviewers)
        or len({unicodedata.normalize("NFKC", r).strip().casefold() for r in reviewers}) < 2
    ):
        raise ValueError("gold requires independent transcription and cross-review")
    if gold.get("sourceDigest") != source_digest(source):
        raise ValueError("gold belongs to a different source observation")
    if Counter(gold.get("order", [])) != Counter(source_ids):
        raise ValueError("gold order must cover every source region exactly once")
    allowed_orders = gold.get("allowedOrders", [gold["order"]])
    if (
        not isinstance(allowed_orders, list)
        or not allowed_orders
        or gold["order"] not in allowed_orders
        or any(
            not isinstance(order, list)
            or not all(isinstance(region_id, str) for region_id in order)
            or Counter(order) != Counter(source_ids)
            for order in allowed_orders
        )
    ):
        raise ValueError("gold allowed orders must be complete and include the canonical order")
    members = gold.get("members", {})
    if set(members) != set(source_ids):
        raise ValueError("gold membership must cover every source region")
    separators = gold.get("separators", {})
    if any(not set(separators) <= set(order[1:]) for order in allowed_orders) or any(
        value not in ("\n", "\n\n") for value in separators.values()
    ):
        raise ValueError("gold separators must identify valid noninitial region boundaries")
    if not all(isinstance(gold.get("truth", {}).get(key), str) for key in ("body", "ruby", "full")):
        raise ValueError("gold requires independent body, ruby and full transcription")
    for region_id, member in members.items():
        if set(member) != {"role", "article", "band", "owner"} or member["role"] not in {
            "body",
            "ruby",
            "header",
            "instruction",
            "label",
            "signature",
            "note",
            "page-number",
            "title",
            "question",
            "option",
            "example",
            "example-option",
            "noise",
        }:
            raise ValueError("gold member requires a valid role, article, band and owner")
        if any(
            member[key] is not None
            and (not isinstance(member[key], str) or not member[key].strip())
            for key in ("article", "band", "owner")
        ):
            raise ValueError("gold group and owner IDs must be nonempty strings or null")
        owner = member.get("owner")
        if owner is not None and (owner not in members or owner == region_id):
            raise ValueError("gold owner must refer to a different existing region")
        if member.get("role") == "ruby" and (
            owner is None
            or members[owner].get("role")
            not in {
                "body",
                "header",
                "instruction",
                "label",
                "signature",
                "note",
                "title",
                "question",
                "option",
                "example",
                "example-option",
            }
            or members[owner].get("article") != member.get("article")
        ):
            raise ValueError("gold ruby requires a text-bearing owner in the same article")


def _validate_regions(regions: list[dict[str, Any]]) -> None:
    from capture_runtime.engine_adapters import normalize_paddle_results

    if not isinstance(regions, list) or any(
        not isinstance(region, dict)
        or set(region) != {"id", "text", "polygon", "confidence"}
        or not isinstance(region["id"], str)
        or not region["id"].strip()
        or not isinstance(region["text"], str)
        or not region["text"].strip()
        or region["text"] != region["text"].strip()
        for region in regions
    ):
        raise ValueError("region records must contain normalized nonempty text and original IDs")
    normalize_paddle_results(
        [
            {
                "res": {
                    "rec_texts": [region["text"] for region in regions],
                    "rec_scores": [region["confidence"] for region in regions],
                    "rec_polys": [region["polygon"] for region in regions],
                }
            }
        ],
        raster_width=None,
        raster_height=None,
    )


def save_json(path: Path, value: Any) -> None:
    """Create evidence once; never silently overwrite an earlier observation."""
    encoded = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as output:
        output.write(encoded)


def read_verified_bytes(path: Path, expected_sha256: str) -> bytes:
    """Validate the same immutable bytes that the caller sends into prediction."""
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != expected_sha256:
        raise ValueError("input digest changed after material freeze")
    return data


@contextmanager
def recorded_run(output: Path) -> Iterator[dict[str, Any]]:
    """A run is completed only after the caller's cleanup has also succeeded."""
    for name in ("completed.json", "failed.json"):
        if (output / name).exists():
            raise FileExistsError(output / name)
    report: dict[str, Any] = {}
    try:
        yield report
        if not report:
            raise ValueError("run produced no completion report")
    except BaseException as error:
        save_json(output / "failed.json", {"type": type(error).__name__, "detail": str(error)})
        raise
    else:
        save_json(output / "completed.json", report)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    score = commands.add_parser("score", help="Replay a source-bound semantic layout case")
    score.add_argument("--input", type=Path, required=True)
    score.add_argument("--output", type=Path, required=True)
    materials = commands.add_parser("freeze-materials", help="Freeze real or synthetic inputs")
    materials.add_argument("--input", type=Path, required=True)
    materials.add_argument("--output", type=Path, required=True)
    synthetic = commands.add_parser("synthetic-variants", help="Freeze scan/skew research rasters")
    synthetic.add_argument("--manifest", type=Path, required=True)
    synthetic.add_argument("--output", type=Path, required=True)
    baseline = commands.add_parser("baseline", help="Run canonical local CPU/DirectML inference")
    baseline.add_argument("--manifest", type=Path, required=True)
    baseline.add_argument("--model-dir", type=Path, required=True)
    baseline.add_argument("--output", type=Path, required=True)
    baseline.add_argument("--provider", choices=("cpu", "dml"), required=True)
    baseline.add_argument("--case", action="append", default=[])
    baseline.add_argument("--benchmark-case", action="append", default=[])
    args = parser.parse_args(argv)
    if args.command == "synthetic-variants":
        from ocr_benchmark_synthetic import build_variants

        build_variants(args.manifest, args.output)
        return 0
    if args.command == "freeze-materials":
        from ocr_benchmark_runtime import freeze_materials

        freeze_materials(args.input, args.output)
        return 0
    if args.command == "baseline":
        from ocr_benchmark_runtime import run_baseline

        run_baseline(
            args.manifest,
            args.model_dir,
            args.output,
            args.provider,
            args.case,
            args.benchmark_case,
        )
        return 0
    raw = args.input.read_bytes()
    case = json.loads(raw)
    report = evaluate_layout(case["source"], case["candidate"], case["gold"])
    report["inputSha256"] = hashlib.sha256(raw).hexdigest()
    report["scorerSha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    save_json(args.output, report)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
