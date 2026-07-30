from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import tempfile
from pathlib import Path
from typing import Any

import httpx
from model_source_lock import load_source_lock, source_lock_sha256

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


def _normalized_text(segments) -> str:
    return " ".join(text for segment in segments if (text := " ".join(segment.text.split())))


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


async def download_fixture(fixture: dict[str, Any], destination: Path) -> None:
    copied = 0
    digest = hashlib.sha256()
    try:
        async with httpx.AsyncClient(timeout=120, follow_redirects=False) as client:
            async with client.stream(
                "GET",
                fixture["url"],
                follow_redirects=False,
            ) as response:
                if 300 <= response.status_code < 400:
                    raise EngineInstallationError(
                        "real candidate fixture must use its exact non-redirecting URL"
                    )
                response.raise_for_status()
                declared = response.headers.get("content-length")
                if declared is not None and int(declared) != fixture["bytes"]:
                    raise EngineInstallationError("real candidate fixture Content-Length drifted")
                with destination.open("xb") as writer:
                    async for chunk in response.aiter_bytes(DOWNLOAD_CHUNK_BYTES):
                        copied += len(chunk)
                        if copied > fixture["bytes"]:
                            raise EngineInstallationError(
                                "real candidate fixture exceeded locked bytes"
                            )
                        writer.write(chunk)
                        digest.update(chunk)
                    writer.flush()
                    os.fsync(writer.fileno())
        if copied != fixture["bytes"] or digest.hexdigest() != fixture["sha256"]:
            raise EngineInstallationError("real candidate fixture bytes/hash drifted")
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


async def verify_candidate(
    *,
    catalog_path: Path,
    engine_dir: Path,
    source_lock_path: Path,
    output: Path,
) -> None:
    lock = load_source_lock(source_lock_path)
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

    with tempfile.TemporaryDirectory(prefix="capture-model-candidate-") as temporary:
        root = Path(temporary)
        fixture_root = root / "fixtures"
        fixture_root.mkdir()
        for kind, fixture in fixtures.items():
            await download_fixture(
                {
                    "bytes": fixture["licenseBytes"],
                    "sha256": fixture["licenseSha256"],
                    "url": fixture["licenseUrl"],
                },
                fixture_root / f"{kind}.license",
            )
            await download_fixture(fixture, fixture_root / kind)

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
                probe_options = {"deviceId": 0} if fixture_kind == "ocr" else None
                await manager.install(
                    requirement_id,
                    cancel_event=asyncio.Event(),
                    report_progress=lambda _value: None,
                    probe_options=probe_options,
                )
                engine = manager.active_engine(requirement_id)
                if engine is None:
                    raise EngineInstallationError(
                        f"{requirement_id} did not activate after candidate installation"
                    )
                fixture = fixtures[fixture_kind]
                run = await worker_client.run(
                    engine,
                    source_path=(fixture_root / fixture_kind).resolve(),
                    media_type=fixture["mediaType"],
                    options=(
                        {"deviceId": 0, "maxImagePixels": 100_000_000}
                        if fixture_kind == "ocr"
                        else {
                            "maxDurationMs": 600_000,
                            "preferGpu": fixture["preferGpu"],
                        }
                    ),
                    cancel_event=asyncio.Event(),
                    timeout_seconds=600,
                )
                normalized_text = _normalized_text(run.segments)
                if (
                    not run.segments
                    or run.engine != fixture["expectedEngine"]
                    or run.model != fixture["expectedModel"]
                    or run.device != fixture["expectedDevice"]
                    or normalized_text != fixture["expectedText"]
                ):
                    raise EngineInstallationError(
                        f"{requirement_id} real fixture output/provenance did not match "
                        "the exact approved expectation"
                    )
                results.append(
                    {
                        "assertionsPassed": True,
                        "device": run.device,
                        "digest": run.digest,
                        "engine": run.engine,
                        "fixtureSha256": fixture["sha256"],
                        "model": run.model,
                        "normalizedTextSha256": hashlib.sha256(
                            normalized_text.encode("utf-8")
                        ).hexdigest(),
                        "requirementId": requirement_id,
                        "segmentCount": len(run.segments),
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
        )
    )


if __name__ == "__main__":
    main()
