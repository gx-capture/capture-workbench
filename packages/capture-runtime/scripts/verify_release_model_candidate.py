from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import os
import re
import tempfile
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from model_source_lock import (
    PENDING_SPEECH_FREEZE_BLOCKER,
    ModelSourceLockError,
    cpu_speech_model_delivery,
    load_source_lock,
    model_delivery,
    source_lock_sha256,
)

from capture_runtime.capture.infrastructure.capture_worker_client import WorkerClient
from capture_runtime.contract_set import load_contract_set
from capture_runtime.ocr.infrastructure.image_normalization import normalize_image_content
from capture_runtime.ocr.infrastructure.ocr_projection import OcrPipeline, image_page_manifest
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    EngineArtifactDescriptor,
    EngineCatalog,
    EngineRequirementDescriptor,
    canonical_json_bytes,
    load_engine_catalog,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    DOWNLOAD_CHUNK_BYTES,
    ArtifactDownloader,
    EngineInstallationError,
    EngineInstallationManager,
)
from capture_runtime.release import assert_release_speech_contents
from capture_runtime.worker_client import InstalledEngine

SPEECH_CANDIDATE_MAX_DURATION_MS = 60 * 60 * 1000
SPEECH_CANDIDATE_TIMEOUT_SECONDS = 60 * 60
# The cpu pass transcribes the same private fixture with TEA-ASR-1.1-mini on
# the CPU, which is several times slower than the CUDA pass.
CPU_SPEECH_CANDIDATE_TIMEOUT_SECONDS = 3 * 60 * 60
CPU_SPEECH_CONTENT_MODEL = "tea-asr-1.1-mini"
# Local runs keep their work directory (the OCR, cuda and cpu speech installs,
# gigabytes of small files) instead of deleting it: the delete stalls a
# Windows development machine and is not what the verifier checks. The format
# matches tools/kept-run-trees.ts, which lists and removes these trees.
KEPT_RUN_TREE_MARKER = "kept-run-tree.json"
KEPT_RUN_TREES_ROOT_VARIABLE = "CAPTURE_KEPT_RUN_TREES_ROOT"
REPOSITORY_ROOT = Path(__file__).resolve().parents[3]


def keeps_run_trees() -> bool:
    """Whether this run keeps its work directory: everywhere but a GitHub runner.

    Local verify scripts set ``CI=true``, so only ``GITHUB_ACTIONS`` tells a
    GitHub runner apart from a development machine.
    """
    return os.environ.get("GITHUB_ACTIONS") != "true"


def create_kept_run_tree(script: str, directory_prefix: str) -> Path:
    """Create a fresh, marked ``<prefix>-<yyyyMMddHHmmss>`` directory under the kept-trees root."""
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", directory_prefix):
        raise ValueError("A kept run tree prefix must be lowercase letters, digits and hyphens.")
    configured = os.environ.get(KEPT_RUN_TREES_ROOT_VARIABLE, "").strip()
    if configured and not Path(configured).is_absolute():
        raise ValueError(f"{KEPT_RUN_TREES_ROOT_VARIABLE} must be an absolute path.")
    root = (
        Path(os.path.abspath(configured))
        if configured
        else REPOSITORY_ROOT.parent / ".kept-run-trees"
    )
    root.mkdir(parents=True, exist_ok=True)
    now = datetime.now(UTC)
    base = f"{directory_prefix}-{now.astimezone().strftime('%Y%m%d%H%M%S')}"
    for attempt in range(1, 1000):
        path = root / (base if attempt == 1 else f"{base}-{attempt}")
        try:
            path.mkdir()
        except FileExistsError:
            continue
        marker = {
            "script": script,
            "createdAt": now.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "reason": "Kept by a local run; safe to delete when no run uses it.",
            "remove": f"pnpm run kept-run-trees -- --remove {path}",
        }
        (path / KEPT_RUN_TREE_MARKER).write_bytes(
            (json.dumps(marker, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
        )
        return path
    raise RuntimeError(f"could not create a fresh kept run tree for {base}")


@contextlib.contextmanager
def _work_directory(script: str, directory_prefix: str) -> Iterator[Path]:
    """A kept run tree locally; a deleted temporary directory on a GitHub runner."""
    if not keeps_run_trees():
        with tempfile.TemporaryDirectory(prefix=f"capture-{directory_prefix}-") as temporary:
            yield Path(temporary)
        return
    path = create_kept_run_tree(script, directory_prefix)
    try:
        yield path
    finally:
        print(
            f"Kept the work directory at {path}; "
            f"remove it with pnpm run kept-run-trees -- --remove {path}",
            flush=True,
        )


def _speech_run_options(fixture: dict[str, Any]) -> dict[str, object]:
    return {
        "maxDurationMs": SPEECH_CANDIDATE_MAX_DURATION_MS,
        "preferGpu": fixture["preferGpu"],
        "allowCpuFallback": fixture["expectedDevice"] != "cuda",
    }


def _normalized_text(segments) -> str:
    return " ".join(text for segment in segments if (text := " ".join(segment.text.split())))


def _segments_monotonic(segments) -> bool:
    previous_start = -1
    previous_end = -1
    for segment in segments:
        if segment.start_ms is None or segment.end_ms is None:
            continue
        if segment.start_ms < previous_start or segment.end_ms < previous_end:
            return False
        previous_start = segment.start_ms
        previous_end = segment.end_ms
    return True


class LocalWorkerDownloader(ArtifactDownloader):
    def __init__(self, engine_dir: Path) -> None:
        self.engine_dir = engine_dir

    async def download(
        self,
        descriptor: EngineArtifactDescriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress,
    ) -> None:
        source = self.engine_dir / descriptor.file_name
        if not source.is_file() or source.is_symlink():
            raise EngineInstallationError("candidate worker archive is missing or unsafe")
        copied = 0
        digest = hashlib.sha256()
        with source.open("rb") as reader, destination.open("xb") as writer:
            while chunk := reader.read(DOWNLOAD_CHUNK_BYTES):
                if cancel_event.is_set():
                    raise asyncio.CancelledError
                copied += len(chunk)
                if copied > descriptor.bytes:
                    raise EngineInstallationError("candidate worker exceeded catalog bytes")
                writer.write(chunk)
                digest.update(chunk)
                progress(copied)
            writer.flush()
            os.fsync(writer.fileno())
        if copied != descriptor.bytes or digest.hexdigest() != descriptor.sha256:
            destination.unlink(missing_ok=True)
            raise EngineInstallationError("candidate worker does not match catalog")


def _assert_pending_preflight_lock(lock: dict[str, Any]) -> None:
    approval = lock.get("approval")
    requirements = lock.get("requirements")
    fixtures = lock.get("fixtures")
    if (
        not isinstance(approval, dict)
        or approval.get("status") != "blocked"
        or approval.get("blockers") != [PENDING_SPEECH_FREEZE_BLOCKER]
        or not isinstance(requirements, list)
        or [item.get("requirementId") for item in requirements][:2]
        != [
            "text-recognition",
            "speech-recognition",
        ]
        or not isinstance(fixtures, list)
        or [item.get("kind") for item in fixtures] != ["ocr", "speech-recognition"]
    ):
        raise EngineInstallationError(
            "private speech preflight requires the exact blocked two-run freeze lock"
        )
    speech_fixture = fixtures[1]
    if any(
        speech_fixture.get(field) is not None
        for field in ("expectedModel", "expectedDevice", "expectedNormalizedOutputSha256")
    ):
        raise EngineInstallationError("private speech preflight requires an unfrozen fixture")


async def _download_exact_url(
    *,
    url: str,
    expected_bytes: int,
    expected_sha256: str,
    destination: Path,
) -> None:
    copied = 0
    digest = hashlib.sha256()
    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
            async with client.stream(
                "GET",
                url,
                follow_redirects=False,
                headers={"Accept-Encoding": "identity"},
            ) as response:
                if 300 <= response.status_code < 400:
                    raise EngineInstallationError("candidate fixture URL unexpectedly redirected")
                response.raise_for_status()
                declared = response.headers.get("content-length")
                if declared is not None and int(declared) != expected_bytes:
                    raise EngineInstallationError("candidate fixture Content-Length drifted")
                with destination.open("xb") as writer:
                    async for chunk in response.aiter_bytes(DOWNLOAD_CHUNK_BYTES):
                        copied += len(chunk)
                        if copied > expected_bytes:
                            raise EngineInstallationError("candidate fixture exceeded locked bytes")
                        writer.write(chunk)
                        digest.update(chunk)
                    writer.flush()
                    os.fsync(writer.fileno())
        if copied != expected_bytes or digest.hexdigest() != expected_sha256:
            raise EngineInstallationError("candidate fixture bytes/hash drifted")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


async def _copy_private_fixture(
    source: Path,
    destination: Path,
    fixture: dict[str, Any],
) -> None:
    if not source.is_file() or source.is_symlink():
        raise EngineInstallationError("private speech fixture is unavailable")
    if source.stat().st_size != fixture["bytes"]:
        raise EngineInstallationError("private speech fixture byte count drifted")
    digest = hashlib.sha256()
    try:
        with source.open("rb") as reader, destination.open("xb") as writer:
            while chunk := reader.read(DOWNLOAD_CHUNK_BYTES):
                writer.write(chunk)
                digest.update(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        if digest.hexdigest() != fixture["sha256"]:
            raise EngineInstallationError("private speech fixture checksum drifted")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


_UNBOUND_CANDIDATE_CATALOG = "candidate catalog is incomplete or not bound to the exact source lock"


def _expected_content_delivery(
    lock: dict[str, Any], requirement: EngineRequirementDescriptor, content_id: str
) -> dict[str, Any]:
    """``cuda`` delivers the lock's full unit; ``cpu`` the subset the generator derives."""

    if content_id == "cpu" and requirement.requirement_id == "speech-recognition":
        return cpu_speech_model_delivery(lock)
    if content_id == "cuda":
        return model_delivery(lock, requirement.requirement_id)
    raise EngineInstallationError(_UNBOUND_CANDIDATE_CATALOG)


def _assert_candidate_catalog_bound(catalog: EngineCatalog, lock: dict[str, Any]) -> None:
    lock_sha256 = source_lock_sha256(lock)
    for requirement in catalog.requirements:
        if not requirement.contents:
            # A legacy delivery keeps the check it has always had.
            if (
                not requirement.complete
                or requirement.model_delivery().source_lock_sha256 != lock_sha256
            ):
                raise EngineInstallationError(_UNBOUND_CANDIDATE_CATALOG)
            continue
        for content in requirement.contents:
            if not content.complete:
                raise EngineInstallationError(_UNBOUND_CANDIDATE_CATALOG)
            try:
                expected = _expected_content_delivery(lock, requirement, content.content_id)
            except (ModelSourceLockError, StopIteration) as error:
                raise EngineInstallationError(_UNBOUND_CANDIDATE_CATALOG) from error
            if content.model_delivery().to_dict() != expected:
                raise EngineInstallationError(_UNBOUND_CANDIDATE_CATALOG)


def _assert_release_speech_contents(catalog: EngineCatalog) -> None:
    try:
        assert_release_speech_contents(catalog)
    except ValueError as error:
        raise EngineInstallationError(str(error)) from error


def _candidate_installation_manager(
    root: Path,
    catalog: EngineCatalog,
    worker_client: WorkerClient,
    engine_dir: Path,
    *,
    speech_variant: str = "cuda",
) -> EngineInstallationManager:
    """Pin the speech content, whatever the driver says.

    ``cuda`` by default: the frozen fixture is tea-asr-1.1 on CUDA. The cpu pass
    pins ``cpu`` so it installs the candidate's own CPU archive on any machine.
    """

    return EngineInstallationManager(
        root,
        catalog,
        worker_client=worker_client,
        downloader=LocalWorkerDownloader(engine_dir),
        speech_variant=speech_variant,
    )


def _cpu_speech_run_options() -> dict[str, object]:
    """The runtime's defaults: the cpu content runs on the CPU even when a GPU is preferred."""

    return {
        "maxDurationMs": SPEECH_CANDIDATE_MAX_DURATION_MS,
        "preferGpu": True,
        "allowCpuFallback": True,
        "content": "cpu",
    }


async def _verify_cpu_speech_engine(
    engine: InstalledEngine | None,
    worker_client: WorkerClient,
    *,
    source_path: Path,
    fixture: dict[str, Any],
) -> dict[str, object]:
    """Probe and run the installed ``cpu`` content on the fixture's audio.

    No transcript is frozen for this content (product owner, 2026-11-11), so the
    pass checks provenance, a non-empty transcript and ordered segments. The
    evidence keeps hashes and counts only, like the CUDA pass.
    """

    if engine is None or engine.content_id != "cpu":
        raise EngineInstallationError("candidate cpu speech content did not activate")
    probe = await worker_client.probe(
        engine, include_model=True, options={"preferGpu": True, "content": "cpu"}
    )
    if not probe.ready or probe.device != "cpu":
        raise EngineInstallationError("candidate cpu speech worker probe was not ready on cpu")
    run = await worker_client.run(
        engine,
        source_path=source_path,
        media_type=fixture["mediaType"],
        options=_cpu_speech_run_options(),
        cancel_event=asyncio.Event(),
        timeout_seconds=CPU_SPEECH_CANDIDATE_TIMEOUT_SECONDS,
    )
    normalized = _normalized_text(run.segments)
    monotonic = _segments_monotonic(run.segments)
    if (
        not normalized
        or run.engine != fixture["expectedEngine"]
        or run.model != CPU_SPEECH_CONTENT_MODEL
        or run.device != "cpu"
        or not monotonic
    ):
        raise EngineInstallationError("candidate cpu speech output/provenance is invalid")
    return {
        "assertionsPassed": True,
        "contentId": "cpu",
        "device": run.device,
        "digest": run.digest,
        "engine": run.engine,
        "fixtureSha256": fixture["sha256"],
        "model": run.model,
        "normalizedOutputSha256": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
        "requirementId": "speech-recognition",
        "segmentCount": len(run.segments),
        "segmentsMonotonic": monotonic,
    }


async def _verify_cpu_speech_content(
    *,
    root: Path,
    catalog: EngineCatalog,
    engine_dir: Path,
    source_path: Path,
    fixture: dict[str, Any],
) -> dict[str, object]:
    """Install the candidate's own ``cpu`` worker archive and models, then probe and run it."""

    worker_client = WorkerClient()
    manager = _candidate_installation_manager(
        root, catalog, worker_client, engine_dir, speech_variant="cpu"
    )
    try:
        await manager.install(
            "speech-recognition",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
            probe_options={"preferGpu": True},
        )
        return await _verify_cpu_speech_engine(
            manager.active_engine("speech-recognition"),
            worker_client,
            source_path=source_path,
            fixture=fixture,
        )
    finally:
        await manager.shutdown()


async def _verify_speech_preflight(
    *,
    lock: dict[str, Any],
    lock_sha256: str,
    catalog_path: Path,
    catalog,
    engine_dir: Path,
    private_fixture: Path,
    output: Path,
) -> None:
    """Run one private-audio preflight without requiring a frozen expectation.

    The resulting evidence contains only hashes, provenance, segment bounds,
    and monotonicity.  It intentionally never persists the source path or
    transcript text, so two runner invocations can be compared before the
    approved lock is frozen.
    """

    speech_fixture = next(
        (item for item in lock["fixtures"] if item.get("kind") == "speech-recognition"), None
    )
    if speech_fixture is None:
        raise EngineInstallationError("private speech fixture is missing")
    with _work_directory(
        "capture-runtime:verify-speech-recognition-preflight", "model-preflight"
    ) as root:
        fixture_path = root / "speech-recognition"
        await _copy_private_fixture(private_fixture, fixture_path, speech_fixture)
        worker_client = WorkerClient()
        manager = _candidate_installation_manager(
            root / "engines",
            catalog,
            worker_client,
            engine_dir,
        )
        try:
            await manager.install(
                "speech-recognition",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
                probe_options={"preferGpu": True},
            )
            engine = manager.active_engine("speech-recognition")
            if engine is None:
                raise EngineInstallationError("private speech preflight did not activate")
            run = await worker_client.run(
                engine,
                source_path=fixture_path,
                media_type=speech_fixture["mediaType"],
                options={
                    "maxDurationMs": SPEECH_CANDIDATE_MAX_DURATION_MS,
                    "preferGpu": True,
                },
                cancel_event=asyncio.Event(),
                timeout_seconds=SPEECH_CANDIDATE_TIMEOUT_SECONDS,
            )
            normalized_digest = hashlib.sha256(
                _normalized_text(run.segments).encode("utf-8")
            ).hexdigest()
            monotonic = _segments_monotonic(run.segments)
            count = speech_fixture["expectedSegmentCount"]
            if (
                run.engine != speech_fixture["expectedEngine"]
                or not run.segments
                or not count["minimum"] <= len(run.segments) <= count["maximum"]
                or not monotonic
            ):
                raise EngineInstallationError("private speech preflight output is invalid")
            evidence = {
                "catalogSha256": hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
                "evidenceVersion": "1-preflight",
                "requirements": [
                    {
                        "device": run.device,
                        "digest": run.digest,
                        "engine": run.engine,
                        "fixtureSha256": speech_fixture["sha256"],
                        "model": run.model,
                        "normalizedOutputSha256": normalized_digest,
                        "requirementId": "speech-recognition",
                        "segmentCount": len(run.segments),
                        "segmentsMonotonic": monotonic,
                    }
                ],
                "sourceLockSha256": lock_sha256,
            }
        finally:
            await manager.shutdown()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_json_bytes(evidence))


async def verify_candidate(
    *,
    catalog_path: Path,
    engine_dir: Path,
    source_lock_path: Path,
    output: Path,
    private_speech_fixture: Path | None,
    preflight: bool = False,
) -> None:
    lock = load_source_lock(source_lock_path, require_approved=not preflight)
    if preflight:
        _assert_pending_preflight_lock(lock)
    lock_sha256 = source_lock_sha256(lock)
    catalog = load_engine_catalog(catalog_path)
    _assert_candidate_catalog_bound(catalog, lock)
    if not preflight:
        # The preflight catalog target passes no CPU archive and freezes nothing
        # for release; a release candidate must carry both speech packs.
        _assert_release_speech_contents(catalog)
    fixtures = {item["kind"]: item for item in lock["fixtures"]}
    if set(fixtures) != {"ocr", "speech-recognition"}:
        raise EngineInstallationError("candidate requires exact real OCR and speech fixtures")
    private_fixture = private_speech_fixture or (
        Path(os.environ["CAPTURE_PRIVATE_SPEECH_FIXTURE"])
        if os.environ.get("CAPTURE_PRIVATE_SPEECH_FIXTURE")
        else None
    )
    if private_fixture is None:
        raise EngineInstallationError("private speech fixture is required on the trusted runner")

    if preflight:
        await _verify_speech_preflight(
            lock=lock,
            lock_sha256=lock_sha256,
            catalog_path=catalog_path,
            catalog=catalog,
            engine_dir=engine_dir,
            private_fixture=private_fixture,
            output=output,
        )
        return

    with _work_directory(
        "capture-runtime:verify-release-model-candidate", "model-candidate"
    ) as root:
        fixture_root = root / "fixtures"
        fixture_root.mkdir()
        contract_set_sha256 = load_contract_set().sha256
        ocr_fixture = fixtures["ocr"]
        await _download_exact_url(
            url=ocr_fixture["licenseUrl"],
            expected_bytes=ocr_fixture["licenseBytes"],
            expected_sha256=ocr_fixture["licenseSha256"],
            destination=fixture_root / "ocr-license",
        )
        await _download_exact_url(
            url=ocr_fixture["noticeUrl"],
            expected_bytes=ocr_fixture["noticeBytes"],
            expected_sha256=ocr_fixture["noticeSha256"],
            destination=fixture_root / "ocr-notice",
        )
        await _download_exact_url(
            url=ocr_fixture["url"],
            expected_bytes=ocr_fixture["bytes"],
            expected_sha256=ocr_fixture["sha256"],
            destination=fixture_root / "ocr",
        )
        await _download_exact_url(
            url=ocr_fixture["pdfUrl"],
            expected_bytes=ocr_fixture["pdfBytes"],
            expected_sha256=ocr_fixture["pdfSha256"],
            destination=fixture_root / "ocr.pdf",
        )
        speech_fixture = fixtures["speech-recognition"]
        await _copy_private_fixture(
            private_fixture, fixture_root / "speech-recognition", speech_fixture
        )

        worker_client = WorkerClient()
        manager = _candidate_installation_manager(
            root / "engines",
            catalog,
            worker_client,
            engine_dir,
        )
        results = []
        try:
            for requirement_id, fixture_kind in (
                ("text-recognition", "ocr"),
                ("speech-recognition", "speech-recognition"),
            ):
                await manager.install(
                    requirement_id,
                    cancel_event=asyncio.Event(),
                    report_progress=lambda _value: None,
                    probe_options=None if fixture_kind == "ocr" else {"preferGpu": True},
                )
                engine = manager.active_engine(requirement_id)
                if engine is None:
                    raise EngineInstallationError("candidate requirement did not activate")
                fixture = fixtures[fixture_kind]
                source_path = (fixture_root / fixture_kind).resolve()
                if fixture_kind == "ocr":
                    selection = await manager.ocr_compute_selection(
                        contract_set_sha256=contract_set_sha256,
                    )
                    if selection is None:
                        raise EngineInstallationError("candidate OCR compute plan was unavailable")
                    max_image_pixels = 100_000_000
                    render_scale = 1.0
                    content = source_path.read_bytes()
                    raster = normalize_image_content(
                        content, scale=render_scale, max_pixels=max_image_pixels
                    )
                    page = image_page_manifest(content, raster)
                    run_options: dict[str, object] = {
                        "computePlan": selection.execution_plan.to_dict(),
                        "maxImagePixels": max_image_pixels,
                        "renderScale": render_scale,
                        "pageManifest": OcrPipeline().serialize_manifest((page,)),
                    }
                else:
                    run_options = _speech_run_options(fixture)
                run = await worker_client.run(
                    engine,
                    source_path=source_path,
                    media_type=fixture["mediaType"],
                    options=run_options,
                    cancel_event=asyncio.Event(),
                    timeout_seconds=(
                        600 if fixture_kind == "ocr" else SPEECH_CANDIDATE_TIMEOUT_SECONDS
                    ),
                )
                monotonic = _segments_monotonic(run.segments)
                if (
                    not run.segments
                    or run.engine != fixture["expectedEngine"]
                    or run.model != fixture["expectedModel"]
                    or run.device != fixture["expectedDevice"]
                    or not monotonic
                ):
                    raise EngineInstallationError(
                        "candidate fixture output/provenance did not match lock"
                    )
                if fixture_kind == "ocr":
                    normalized = _normalized_text(run.segments)
                    if normalized != fixture["expectedText"]:
                        raise EngineInstallationError(
                            "candidate OCR fixture text did not match lock"
                        )
                    normalized_digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()
                    segment_count = len(run.segments)
                else:
                    count = fixture["expectedSegmentCount"]
                    if not count["minimum"] <= len(run.segments) <= count["maximum"]:
                        raise EngineInstallationError(
                            "candidate speech segment count exceeded lock"
                        )
                    normalized_digest = hashlib.sha256(
                        _normalized_text(run.segments).encode("utf-8")
                    ).hexdigest()
                    if normalized_digest != fixture["expectedNormalizedOutputSha256"]:
                        raise EngineInstallationError("candidate speech output digest drifted")
                    segment_count = len(run.segments)
                results.append(
                    {
                        "assertionsPassed": True,
                        "device": run.device,
                        "digest": run.digest,
                        "engine": run.engine,
                        "fixtureSha256": fixture["sha256"],
                        "model": run.model,
                        "normalizedOutputSha256": normalized_digest,
                        "requirementId": requirement_id,
                        "segmentCount": segment_count,
                        "segmentsMonotonic": monotonic,
                    }
                )
        finally:
            await manager.shutdown()
        # A second install root, so the cpu pass gets the candidate's own CPU
        # archive and model subset rather than reusing the cuda install.
        results.append(
            await _verify_cpu_speech_content(
                root=root / "engines-cpu",
                catalog=catalog,
                engine_dir=engine_dir,
                source_path=(fixture_root / "speech-recognition").resolve(),
                fixture=speech_fixture,
            )
        )
    evidence = {
        "catalogSha256": hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
        "evidenceVersion": "1",
        "requirements": results,
        "sourceLockSha256": lock_sha256,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(canonical_json_bytes(evidence))


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--catalog",
        type=Path,
        default=root / "dist" / "catalog" / "capture-engine-catalog.json",
    )
    parser.add_argument("--engine-dir", type=Path, default=root / "dist" / "engines")
    parser.add_argument(
        "--source-lock",
        type=Path,
        default=root / "model-sources" / "release-model-source-lock.json",
    )
    parser.add_argument("--private-speech-fixture", type=Path)
    parser.add_argument(
        "--preflight-speech-recognition",
        action="store_true",
        help="Run one privacy-safe private-audio preflight while expectations are pending.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=root / "dist" / "candidate" / "model-probe-evidence.json",
    )
    arguments = parser.parse_args()
    asyncio.run(
        verify_candidate(
            catalog_path=arguments.catalog,
            engine_dir=arguments.engine_dir,
            source_lock_path=arguments.source_lock,
            output=arguments.output,
            private_speech_fixture=arguments.private_speech_fixture,
            preflight=arguments.preflight_speech_recognition,
        )
    )


if __name__ == "__main__":
    main()
