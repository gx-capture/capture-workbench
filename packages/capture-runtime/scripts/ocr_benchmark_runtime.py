"""Opt-in material preparation and canonical inference for the local OCR benchmark.

This calls the runtime's profile, Paddle factory, prediction and strict normalization
seams. It is research evidence, not packaged-worker or installed-product acceptance.
"""

from __future__ import annotations

import ctypes
import hashlib
import importlib.metadata
import json
import math
import platform
import shutil
import subprocess
import time
from contextlib import ExitStack
from ctypes import wintypes
from dataclasses import asdict
from pathlib import Path

from ocr_benchmark import normalize_observation, read_verified_bytes, recorded_run, save_json


def digest(path: Path) -> str:
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def freeze_materials(request_path: Path, output: Path) -> None:
    import pypdfium2 as pdfium
    from PIL import Image

    request_bytes = request_path.read_bytes()
    request = json.loads(request_bytes)
    output.mkdir(parents=True, exist_ok=False)
    documents = []
    cases = []
    seen_documents: set[str] = set()
    seen_ids: set[str] = set()
    for entry in request["documents"]:
        source = Path(entry["path"])
        source_sha = digest(source)
        if source_sha in seen_documents or entry["id"] in seen_ids:
            raise ValueError("duplicate material document")
        if entry.get("sha256", source_sha) != source_sha:
            raise ValueError("material document digest mismatch")
        seen_documents.add(source_sha)
        seen_ids.add(entry["id"])
        copy = output / "sources" / f"{entry['id']}.pdf"
        copy.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, copy)
        if digest(copy) != source_sha:
            raise ValueError("material document digest mismatch after copy")
        with pdfium.PdfDocument(copy) as pdf:
            selected = entry.get("pages", list(range(1, len(pdf) + 1)))
            if len(set(selected)) != len(selected) or any(p < 1 or p > len(pdf) for p in selected):
                raise ValueError("invalid selected pages")
            documents.append(
                {
                    "id": entry["id"],
                    "path": str(copy.resolve()),
                    "origin": str(source),
                    "sha256": source_sha,
                    "pageCount": len(pdf),
                    "selectedPages": selected,
                }
            )
            for page_number in selected:
                page = pdf[page_number - 1]
                try:
                    bitmap = page.render(scale=2)
                    try:
                        image = bitmap.to_pil().convert("RGB")
                        case_id = f"{entry['id']}-p{page_number}"
                        target = output / "images" / f"{case_id}.png"
                        target.parent.mkdir(exist_ok=True)
                        image.save(target)
                        cases.append(
                            {
                                "id": case_id,
                                "document": entry["id"],
                                "page": page_number,
                                "image_path": str(target.resolve()),
                                "width": image.width,
                                "height": image.height,
                                "image_sha256": digest(target),
                                "pdf_sha256": source_sha,
                                "kind": "real",
                            }
                        )
                    finally:
                        bitmap.close()
                finally:
                    page.close()
    # Synthetic and retained raster cases use exactly the same inference/score path.
    for entry in request.get("images", []):
        source = Path(entry["path"])
        if any(case["id"] == entry["id"] for case in cases):
            raise ValueError("duplicate case ID")
        if digest(source) != entry["sha256"]:
            raise ValueError("material image digest mismatch")
        target = output / "images" / f"{entry['id']}.png"
        target.parent.mkdir(exist_ok=True)
        shutil.copyfile(source, target)
        if digest(target) != entry["sha256"]:
            raise ValueError("material image digest mismatch after copy")
        with Image.open(target) as image:
            cases.append(
                {
                    "id": entry["id"],
                    "image_path": str(target.resolve()),
                    "width": image.width,
                    "height": image.height,
                    "image_sha256": digest(target),
                    "kind": entry["kind"],
                }
            )
    save_json(
        output / "manifest.json",
        {
            "schemaVersion": 1,
            "requestSha256": hashlib.sha256(request_bytes).hexdigest(),
            "renderScale": 2,
            "documents": documents,
            "cases": cases,
            "goldStatus": "incomplete",
            "pdfiumVersion": importlib.metadata.version("pypdfium2"),
            "pillowVersion": importlib.metadata.version("pillow"),
        },
    )
    print(json.dumps({"documents": len(documents), "cases": len(cases)}), flush=True)


class _MemoryCounters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t)
        for name in (
            "PeakWorkingSetSize",
            "WorkingSetSize",
            "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage",
            "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage",
            "PagefileUsage",
            "PeakPagefileUsage",
            "PrivateUsage",
        )
    ]


def memory() -> dict[str, int]:
    counters = _MemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(_MemoryCounters),
        wintypes.DWORD,
    ]
    if not psapi.GetProcessMemoryInfo(
        kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return {
        key: getattr(counters, key)
        for key in (
            "WorkingSetSize",
            "PeakWorkingSetSize",
            "PrivateUsage",
        )
    }


def source_snapshot(output: Path) -> dict[str, str]:
    package = Path(__file__).resolve().parents[1]
    paths = [
        p for p in (package / "src").rglob("*") if p.is_file() and p.suffix in (".py", ".json")
    ]
    paths += [package / name for name in ("pyproject.toml", "uv.lock", "project.json")]
    paths += list((package / "scripts").glob("ocr_benchmark*.py"))
    hashes = {}
    for path in sorted(paths):
        relative = path.relative_to(package)
        destination = output / "source" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        hashes[relative.as_posix()] = digest(destination)
    return hashes


def run_baseline(
    manifest_path: Path,
    model_dir: Path,
    output: Path,
    provider: str,
    case_ids: list[str],
    benchmark_ids: list[str],
) -> None:
    import onnxruntime as ort

    from capture_runtime.engine_adapters import (
        WindowsMLOcrAdapter,
        _default_paddle_pipeline,
        _paddle_payload,
        _paddle_results_sequence,
        _PaddleOcrExecutionEvidenceAdapter,
    )
    from capture_runtime.ocr_profile import load_profile_spec, validate_model_artifacts

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    cases = manifest["cases"] if isinstance(manifest, dict) else manifest
    if case_ids:
        cases = [case for case in cases if case["id"] in case_ids]
        if {case["id"] for case in cases} != set(case_ids):
            raise ValueError("unknown requested case")
    if not cases or not set(benchmark_ids) <= {case["id"] for case in cases}:
        raise ValueError("empty selection or unknown benchmark case")
    dml = provider == "dml"
    if dml and "DmlExecutionProvider" not in ort.get_available_providers():
        raise RuntimeError("DirectML is unavailable; a CPU retry is not permitted")
    profile = load_profile_spec()
    validate_model_artifacts(model_dir, profile)
    for case in cases:
        if digest(Path(case["image_path"])) != case["image_sha256"]:
            raise ValueError("input image changed after material freeze")
    output.mkdir(parents=True, exist_ok=False)
    evidence = _PaddleOcrExecutionEvidenceAdapter(output / "ort-profile") if dml else None
    snapshot = source_snapshot(output)
    head = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=Path(__file__).resolve().parents[3],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    save_json(
        output / "run.json",
        {
            "schemaVersion": 1,
            "policyId": "canonical-baseline-v1",
            "sourceHead": head,
            "sourceSnapshot": snapshot,
            "provider": provider,
            "availableProviders": ort.get_available_providers(),
            "manifestSha256": digest(manifest_path),
            "profileId": profile.profile_id,
            "profileSha256": profile.profile_spec_sha256,
            "models": [asdict(asset) for asset in profile.model_artifacts],
            "platform": platform.platform(),
            "machine": platform.machine(),
            "packages": {
                name: importlib.metadata.version(name)
                for name in (
                    "paddleocr",
                    "paddlex",
                    "onnxruntime-directml",
                    "pillow",
                    "pypdfium2",
                )
            },
            "caseIds": [case["id"] for case in cases],
            "benchmarkIds": benchmark_ids,
            "timingProtocol": {"warmupRuns": 2, "timedRuns": 20, "p95": "nearest-rank"},
            "timingScope": (
                "runtime PNG prediction and strict normalization; excludes PDF render/IPC"
            ),
            "acceptanceTier": "local-inference-only",
            "phasePass": False,
        },
    )
    started = time.perf_counter()
    pipeline = None
    rows = []
    with recorded_run(output) as completion, ExitStack() as cleanup:
        try:
            pipeline = _default_paddle_pipeline(
                **profile.paddle_kwargs(
                    model_dir=model_dir,
                    use_dml=dml,
                    device_id=0 if dml else None,
                    profile_file_prefix=str(output / "ort-profile") if dml else None,
                )
            )
            cleanup.callback(pipeline.close)
            if evidence is not None:
                evidence.prepare(pipeline, expected_device_id=0)
            initialization = time.perf_counter() - started
            for case in cases:
                image_bytes = read_verified_bytes(Path(case["image_path"]), case["image_sha256"])
                measured = case["id"] in benchmark_ids
                repeats = 22 if measured else 1
                times = []
                for repeat in range(repeats):
                    start = time.perf_counter()
                    raw = [
                        _paddle_payload(result)
                        for result in _paddle_results_sequence(
                            WindowsMLOcrAdapter._predict(pipeline, image_bytes)
                        )
                    ]
                    observation = normalize_observation(
                        raw,
                        f"{output.name}:{case['id']}:{repeat}",
                        width=case["width"],
                        height=case["height"],
                    )
                    elapsed = time.perf_counter() - start
                    times.append(elapsed)
                    save_json(
                        output / "observations" / f"{case['id']}-{repeat}.json",
                        {
                            "caseId": case["id"],
                            "imageSha256": case["image_sha256"],
                            "raw": raw,
                            "observation": observation,
                            "seconds": elapsed,
                            "sampleKind": ("warmup" if repeat < 2 else "timed")
                            if measured
                            else "baseline",
                            "memory": memory(),
                        },
                    )
                timed = times[2:] if measured else []  # Two warmups, then twenty timed runs.
                row = {
                    "caseId": case["id"],
                    "firstSeconds": times[0],
                    "timedSeconds": timed,
                    "p95Seconds": sorted(timed)[math.ceil(0.95 * len(timed)) - 1]
                    if timed
                    else None,
                    "memory": memory(),
                    "regions": len(observation["regions"]),
                }
                rows.append(row)
                print(
                    json.dumps(
                        {
                            "caseId": case["id"],
                            "regions": row["regions"],
                            "seconds": round(sum(times), 3),
                        }
                    ),
                    flush=True,
                )
            execution = asdict(evidence.finalize(pipeline)) if evidence is not None else None
            completion.update(
                {
                    "initializationSeconds": initialization,
                    "rows": rows,
                    "executionEvidence": execution,
                    "memory": memory(),
                    "phasePass": False,
                    "reason": "Gold and phase review are separate gates.",
                }
            )
        except BaseException:
            if evidence is not None:
                evidence.abort(pipeline)
            raise
