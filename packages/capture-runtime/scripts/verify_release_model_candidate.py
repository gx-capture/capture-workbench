from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import httpx
from model_source_lock import (
    PENDING_WHISPER_FREEZE_BLOCKER,
    load_source_lock,
    source_lock_sha256,
)

from capture_runtime.engine_catalog import (
    EngineArtifactDescriptor,
    canonical_json_bytes,
    load_engine_catalog,
)
from capture_runtime.engine_installation import (
    DOWNLOAD_CHUNK_BYTES,
    ArtifactDownloader,
    EngineInstallationError,
    EngineInstallationManager,
)
from capture_runtime.worker_client import WorkerClient

WHISPER_CANDIDATE_MAX_DURATION_MS = 60 * 60 * 1000
WHISPER_CANDIDATE_TIMEOUT_SECONDS = 60 * 60


def _whisper_run_options(fixture: dict[str, Any]) -> dict[str, object]:
    return {
        "maxDurationMs": WHISPER_CANDIDATE_MAX_DURATION_MS,
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
        or approval.get("blockers") != [PENDING_WHISPER_FREEZE_BLOCKER]
        or not isinstance(requirements, list)
        or [item.get("requirementId") for item in requirements]
        != [
            "windowsml-ocr",
            "whisper-primary",
        ]
        or not isinstance(fixtures, list)
        or [item.get("kind") for item in fixtures] != ["ocr", "whisper"]
    ):
        raise EngineInstallationError(
            "private Whisper preflight requires the exact blocked two-run freeze lock"
        )
    whisper_fixture = fixtures[1]
    if any(
        whisper_fixture.get(field) is not None
        for field in ("expectedModel", "expectedDevice", "expectedNormalizedOutputSha256")
    ):
        raise EngineInstallationError("private Whisper preflight requires an unfrozen fixture")


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
        raise EngineInstallationError("private Whisper fixture is unavailable")
    if source.stat().st_size != fixture["bytes"]:
        raise EngineInstallationError("private Whisper fixture byte count drifted")
    digest = hashlib.sha256()
    try:
        with source.open("rb") as reader, destination.open("xb") as writer:
            while chunk := reader.read(DOWNLOAD_CHUNK_BYTES):
                writer.write(chunk)
                digest.update(chunk)
            writer.flush()
            os.fsync(writer.fileno())
        if digest.hexdigest() != fixture["sha256"]:
            raise EngineInstallationError("private Whisper fixture checksum drifted")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


async def _verify_whisper_preflight(
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

    whisper_fixture = next(
        (item for item in lock["fixtures"] if item.get("kind") == "whisper"), None
    )
    if whisper_fixture is None:
        raise EngineInstallationError("private Whisper fixture is missing")
    with tempfile.TemporaryDirectory(prefix="capture-model-preflight-") as temporary:
        root = Path(temporary)
        fixture_path = root / "whisper"
        await _copy_private_fixture(private_fixture, fixture_path, whisper_fixture)
        worker_client = WorkerClient()
        manager = EngineInstallationManager(
            root / "engines",
            catalog,
            worker_client=worker_client,
            downloader=LocalWorkerDownloader(engine_dir),
        )
        try:
            await manager.install(
                "whisper-primary",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
                probe_options={"preferGpu": True},
            )
            engine = manager.active_engine("whisper-primary")
            if engine is None:
                raise EngineInstallationError("private Whisper preflight did not activate")
            run = await worker_client.run(
                engine,
                source_path=fixture_path,
                media_type=whisper_fixture["mediaType"],
                options={
                    "maxDurationMs": WHISPER_CANDIDATE_MAX_DURATION_MS,
                    "preferGpu": True,
                },
                cancel_event=asyncio.Event(),
                timeout_seconds=WHISPER_CANDIDATE_TIMEOUT_SECONDS,
            )
            normalized_digest = hashlib.sha256(
                _normalized_text(run.segments).encode("utf-8")
            ).hexdigest()
            monotonic = _segments_monotonic(run.segments)
            count = whisper_fixture["expectedSegmentCount"]
            if (
                run.engine != whisper_fixture["expectedEngine"]
                or not run.segments
                or not count["minimum"] <= len(run.segments) <= count["maximum"]
                or not monotonic
            ):
                raise EngineInstallationError("private Whisper preflight output is invalid")
            evidence = {
                "catalogSha256": hashlib.sha256(catalog_path.read_bytes()).hexdigest(),
                "evidenceVersion": "1-preflight",
                "requirements": [
                    {
                        "device": run.device,
                        "digest": run.digest,
                        "engine": run.engine,
                        "fixtureSha256": whisper_fixture["sha256"],
                        "model": run.model,
                        "normalizedOutputSha256": normalized_digest,
                        "requirementId": "whisper-primary",
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
    private_whisper_fixture: Path | None,
    preflight: bool = False,
) -> None:
    lock = load_source_lock(source_lock_path, require_approved=not preflight)
    if preflight:
        _assert_pending_preflight_lock(lock)
    lock_sha256 = source_lock_sha256(lock)
    catalog = load_engine_catalog(catalog_path)
    for requirement in catalog.requirements:
        if (
            not requirement.complete
            or requirement.model_delivery().source_lock_sha256 != lock_sha256
        ):
            raise EngineInstallationError(
                "candidate catalog is incomplete or not bound to the exact source lock"
            )
    fixtures = {item["kind"]: item for item in lock["fixtures"]}
    if set(fixtures) != {"ocr", "whisper"}:
        raise EngineInstallationError("candidate requires exact real OCR and Whisper fixtures")
    private_fixture = private_whisper_fixture or (
        Path(os.environ["CAPTURE_PRIVATE_WHISPER_FIXTURE"])
        if os.environ.get("CAPTURE_PRIVATE_WHISPER_FIXTURE")
        else None
    )
    if private_fixture is None:
        raise EngineInstallationError("private Whisper fixture is required on the trusted runner")

    if preflight:
        await _verify_whisper_preflight(
            lock=lock,
            lock_sha256=lock_sha256,
            catalog_path=catalog_path,
            catalog=catalog,
            engine_dir=engine_dir,
            private_fixture=private_fixture,
            output=output,
        )
        return

    with tempfile.TemporaryDirectory(prefix="capture-model-candidate-") as temporary:
        root = Path(temporary)
        fixture_root = root / "fixtures"
        fixture_root.mkdir()
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
        whisper_fixture = fixtures["whisper"]
        await _copy_private_fixture(private_fixture, fixture_root / "whisper", whisper_fixture)

        worker_client = WorkerClient()
        manager = EngineInstallationManager(
            root / "engines",
            catalog,
            worker_client=worker_client,
            downloader=LocalWorkerDownloader(engine_dir),
        )
        results = []
        try:
            for requirement_id, fixture_kind in (
                ("windowsml-ocr", "ocr"),
                ("whisper-primary", "whisper"),
            ):
                await manager.install(
                    requirement_id,
                    cancel_event=asyncio.Event(),
                    report_progress=lambda _value: None,
                    probe_options=(
                        {"deviceId": 0} if fixture_kind == "ocr" else {"preferGpu": True}
                    ),
                )
                engine = manager.active_engine(requirement_id)
                if engine is None:
                    raise EngineInstallationError("candidate requirement did not activate")
                fixture = fixtures[fixture_kind]
                run = await worker_client.run(
                    engine,
                    source_path=(fixture_root / fixture_kind).resolve(),
                    media_type=fixture["mediaType"],
                    options=(
                        {"deviceId": 0, "maxImagePixels": 100_000_000}
                        if fixture_kind == "ocr"
                        else _whisper_run_options(fixture)
                    ),
                    cancel_event=asyncio.Event(),
                    timeout_seconds=(
                        600 if fixture_kind == "ocr" else WHISPER_CANDIDATE_TIMEOUT_SECONDS
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
                            "candidate Whisper segment count exceeded lock"
                        )
                    normalized_digest = hashlib.sha256(
                        _normalized_text(run.segments).encode("utf-8")
                    ).hexdigest()
                    if normalized_digest != fixture["expectedNormalizedOutputSha256"]:
                        raise EngineInstallationError("candidate Whisper output digest drifted")
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
    parser.add_argument("--private-whisper-fixture", type=Path)
    parser.add_argument(
        "--preflight-whisper",
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
            private_whisper_fixture=arguments.private_whisper_fixture,
            preflight=arguments.preflight_whisper,
        )
    )


if __name__ == "__main__":
    main()
