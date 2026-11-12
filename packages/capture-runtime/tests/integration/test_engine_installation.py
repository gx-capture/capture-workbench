from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import pytest

import capture_runtime.provisioning.infrastructure.engine_installation as engine_installation_module
import capture_runtime.speech.infrastructure.progressive_capture as progressive_capture
from capture_runtime._worker_payloads import WorkerRunResult, WorkerSegment, WorkerWord
from capture_runtime.capture.application.streaming_capture_service import StreamingCaptureService
from capture_runtime.capture.infrastructure.capture_extraction import (
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.capture.infrastructure.streaming_repository import StreamingRepository
from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig, RuntimeSettings
from capture_runtime.constants import MAX_RUNTIME_ARTIFACT_BYTES, RUNTIME_VERSION
from capture_runtime.contracts import (
    CaptureEngine,
    CaptureSourceKind,
    OcrAdapterClass,
    OcrComputeMode,
    OcrComputePreflightV2,
    OpenIngestionV2,
    RawCaptureSegment,
    RuntimeRequirementsV2,
    StartCaptureV2,
    StreamingEventType,
    StructuringMode,
    TimeLocator,
)
from capture_runtime.dependencies import build_runtime_dependencies
from capture_runtime.diarization.domain.turn.models import SpeakerTurn
from capture_runtime.diarization.infrastructure.speaker_worker_result import (
    WorkerDiarizationResult,
)
from capture_runtime.install_progress import DownloadedBytes
from capture_runtime.provisioning.infrastructure._engine_download_cache import (
    CachingDownloader,
    VerifiedDownloadCache,
)
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    ActivatedArtifact,
    ActiveEngineState,
    EngineCatalog,
    EngineCatalogError,
    canonical_json_bytes,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    ArtifactDownloader,
    EngineInstallationError,
    EngineInstallationManager,
    EngineInstallBusyError,
    ModelFileDownloader,
)
from capture_runtime.speech.infrastructure.progressive_audio import (
    DecodedAudioWindow,
    ProgressiveSessionEvent,
)
from capture_runtime.speech.infrastructure.progressive_capture import ProgressiveCaptureProcessor
from capture_runtime.structuring.infrastructure.ollama import SystemRuntimeInstaller
from capture_runtime.worker_client import InstalledEngine, WorkerProbeResult
from capture_runtime.worker_process import WorkerExecutionError, WorkerTimeoutError


def _manifest(files: dict[str, bytes]) -> bytes:
    return (
        json.dumps(
            {
                "manifestVersion": "1",
                "files": [
                    {
                        "path": name,
                        "bytes": len(content),
                        "sha256": hashlib.sha256(content).hexdigest(),
                    }
                    for name, content in sorted(files.items())
                ],
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode()


def _artifact(
    root: Path,
    *,
    requirement_id: str,
    version: str,
) -> tuple[dict[str, object], Path]:
    files = {"capture-engine-test.exe": f"worker-{version}".encode()}
    manifest = _manifest(files)
    archive = root / f"{requirement_id}-worker-{version}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as destination:
        for name, content in files.items():
            destination.writestr(name, content)
        destination.writestr("files-manifest.json", manifest)
    with zipfile.ZipFile(archive) as source:
        extracted_bytes = sum(item.file_size for item in source.infolist())
    return (
        {
            "role": "worker",
            "requirementId": requirement_id,
            "artifactVersion": version,
            "workerProtocolVersion": "1",
            "platform": "windows",
            "arch": "x86_64",
            "fileName": archive.name,
            "bytes": archive.stat().st_size,
            "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            "extractedBytes": extracted_bytes,
            "entryPoint": "capture-engine-test.exe",
            "filesManifestSha256": hashlib.sha256(manifest).hexdigest(),
            "url": f"https://downloads.example.test/{archive.name}",
        },
        archive,
    )


def _catalog(root: Path, *, version: str = "engine-1") -> tuple[EngineCatalog, dict[str, Path]]:
    sources: dict[str, Path] = {}
    worker, archive = _artifact(
        root,
        requirement_id="windowsml-ocr",
        version=version,
    )
    sources[archive.name] = archive
    revision = "a" * 40
    model_values = {
        "licenses/LICENSE.txt": b"license",
        "model/config.json": f"config-{version}".encode(),
        "model/model.bin": f"model-{version}".encode(),
        "model/pipeline.json": b'{"pipeline":"derived"}\n',
        "notices/NOTICE.txt": b"notice",
    }
    model_files = []
    for path, content in sorted(model_values.items()):
        kind = (
            "license"
            if path.startswith("licenses/")
            else "notice"
            if path.startswith("notices/")
            else "derived"
            if path == "model/pipeline.json"
            else "source"
        )
        source = root / f"{version}-{path.replace('/', '-')}"
        source.write_bytes(content)
        sources[path] = source
        model_files.append(
            {
                "bytes": len(content),
                "derivation": (
                    {
                        "algorithm": "canonical-json-v1",
                        "generator": "scripts/generate_pipeline.py",
                        "inputs": ["model/config.json"],
                        "sourceCommit": "c" * 40,
                        "toolVersions": {"python": "3.12.12"},
                    }
                    if kind == "derived"
                    else None
                ),
                "kind": kind,
                "licensePath": (None if kind in {"license", "notice"} else "licenses/LICENSE.txt"),
                "noticePath": (None if kind in {"license", "notice"} else "notices/NOTICE.txt"),
                "owner": "test-owner",
                "path": path,
                "redirectHosts": [],
                "revision": revision,
                "sha256": hashlib.sha256(content).hexdigest(),
                "spdx": "MIT",
                "url": f"https://downloads.example.test/{revision}/{path}",
            }
        )
    model_manifest = {
        "artifactVersion": version,
        "entryPoint": "model",
        "files": model_files,
        "manifestVersion": "1",
    }
    model_delivery = {
        "artifactVersion": version,
        "entryCount": len(model_files),
        "entryPoint": "model",
        "extractedBytes": sum(item["bytes"] for item in model_files),
        "files": model_files,
        "manifestSha256": hashlib.sha256(
            (
                json.dumps(model_manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
            ).encode()
        ).hexdigest(),
        "sourceLockSha256": "b" * 64,
    }
    return (
        EngineCatalog.from_dict(
            {
                "catalogVersion": "2",
                "runtimeVersion": RUNTIME_VERSION,
                "requirements": [
                    {
                        "requirementId": "windowsml-ocr",
                        "artifacts": [worker],
                        "modelFiles": model_delivery,
                        "unavailableReason": None,
                    }
                ],
            }
        ),
        sources,
    )


@dataclass
class CopyDownloader(ArtifactDownloader):
    sources: dict[str, Path]
    calls: int = 0
    fail: bool = False
    pause: asyncio.Event | None = None

    async def download(
        self,
        descriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress,
    ) -> None:
        self.calls += 1
        if self.pause is not None:
            await self.pause.wait()
        if self.fail:
            raise AssertionError("offline installation unexpectedly downloaded")
        if cancel_event.is_set():
            raise asyncio.CancelledError
        shutil.copyfile(self.sources[descriptor.file_name], destination)
        progress(descriptor.bytes)


@dataclass
class CopyModelDownloader(ModelFileDownloader):
    sources: dict[str, Path]
    calls: int = 0

    async def download(
        self,
        descriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress,
    ) -> None:
        self.calls += 1
        if cancel_event.is_set():
            raise asyncio.CancelledError
        shutil.copyfile(self.sources[descriptor.path], destination)
        progress(descriptor.bytes)


@dataclass
class CancellingModelDownloader(ModelFileDownloader):
    sources: dict[str, Path]

    async def download(
        self,
        descriptor,
        destination: Path,
        *,
        cancel_event: asyncio.Event,
        progress,
    ) -> None:
        if descriptor.path == "model/model.bin":
            destination.write_bytes(b"partial")
            cancel_event.set()
            raise asyncio.CancelledError
        shutil.copyfile(self.sources[descriptor.path], destination)
        progress(descriptor.bytes)


class FakeWorkerClient:
    def __init__(self, *, full_probe_ready: bool = True) -> None:
        self.full_probe_ready = full_probe_ready
        self.probes: list[tuple[InstalledEngine, bool, dict[str, object] | None]] = []
        self.shutdown_called = False

    async def probe(
        self,
        engine: InstalledEngine,
        *,
        include_model: bool,
        options: dict[str, object] | None = None,
        timeout_seconds: float = 30,
    ) -> WorkerProbeResult:
        del timeout_seconds
        self.probes.append((engine, include_model, options))
        ready = self.full_probe_ready if include_model else True
        return WorkerProbeResult(
            ready=ready,
            code_ready=True,
            assets_ready=ready,
            detail="ready" if ready else "model probe failed",
            device="windowsml-dml" if ready else None,
        )

    async def shutdown(self) -> None:
        self.shutdown_called = True


class ComputePreflightWorkerClient(FakeWorkerClient):
    def __init__(self, decision: object) -> None:
        super().__init__()
        self.decision = decision
        self.compute_preflight_calls: list[tuple[InstalledEngine, str]] = []

    async def ocr_compute_preflight(
        self,
        engine: InstalledEngine,
        *,
        contract_sha256: str,
        timeout_seconds: float = 30,
    ) -> object:
        del timeout_seconds
        self.compute_preflight_calls.append((engine, contract_sha256))
        return self.decision


class TimeoutComputePreflightWorkerClient(ComputePreflightWorkerClient):
    async def ocr_compute_preflight(
        self,
        engine: InstalledEngine,
        *,
        contract_sha256: str,
        timeout_seconds: float = 30,
    ) -> object:
        del engine, contract_sha256, timeout_seconds
        raise WorkerTimeoutError("worker request timed out at stage worker-process-timeout")


class CodeProbeFailureWorkerClient(FakeWorkerClient):
    async def probe(
        self,
        engine: InstalledEngine,
        *,
        include_model: bool,
        options: dict[str, object] | None = None,
        timeout_seconds: float = 30,
    ) -> WorkerProbeResult:
        if not include_model:
            raise RuntimeError("worker path C:\\private\\token=should-not-escape")
        return await super().probe(
            engine,
            include_model=include_model,
            options=options,
            timeout_seconds=timeout_seconds,
        )


class StageCodeProbeFailureWorkerClient(FakeWorkerClient):
    async def probe(
        self,
        engine: InstalledEngine,
        *,
        include_model: bool,
        options: dict[str, object] | None = None,
        timeout_seconds: float = 30,
    ) -> WorkerProbeResult:
        if not include_model:
            raise WorkerExecutionError("worker exited with code 1 at stage worker-entry-start")
        return await super().probe(
            engine,
            include_model=include_model,
            options=options,
            timeout_seconds=timeout_seconds,
        )


def test_code_probe_worker_stage_is_projected(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=StageCodeProbeFailureWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )

    with pytest.raises(
        EngineInstallationError,
        match=(
            "^engine worker code probe failed: "
            "worker exited with code 1 at stage worker-entry-start$"
        ),
    ):
        asyncio.run(
            manager.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )


def test_code_probe_failure_is_wrapped_without_worker_details(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=CodeProbeFailureWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )

    with pytest.raises(
        EngineInstallationError, match="^engine worker code probe failed$"
    ) as failure:
        asyncio.run(
            manager.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )
    assert "private" not in str(failure.value)
    assert "should-not-escape" not in str(failure.value)


class ModelProbeFailureWorkerClient(FakeWorkerClient):
    async def probe(
        self,
        engine: InstalledEngine,
        *,
        include_model: bool,
        options: dict[str, object] | None = None,
        timeout_seconds: float = 30,
    ) -> WorkerProbeResult:
        if include_model:
            raise WorkerExecutionError("probe_failed: Worker probe failed.")
        return await super().probe(
            engine,
            include_model=include_model,
            options=options,
            timeout_seconds=timeout_seconds,
        )


def test_post_install_probe_failure_keeps_the_worker_reason(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=ModelProbeFailureWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )

    with pytest.raises(
        EngineInstallationError,
        match="^engine post-install probe failed: probe_failed: Worker probe failed.$",
    ):
        asyncio.run(
            manager.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )
    assert manager.active_engine("windowsml-ocr") is None


@pytest.mark.skipif(sys.platform != "win32", reason="MAX_PATH is a Windows limit")
def test_worker_beyond_max_path_fails_before_the_model_download(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 0.7.0 downloaded about 10 GB for speech recognition, then its model probe
    # failed: the worker's native libraries cannot load from beyond MAX_PATH.
    catalog, sources = _catalog(tmp_path)
    worker = FakeWorkerClient()
    model_downloader = CopyModelDownloader(sources)
    root = tmp_path / "engines"
    manager = EngineInstallationManager(
        root,
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=model_downloader,
    )
    installed = root / "windowsml-ocr" / "versions" / "engine-1" / "worker"
    installed /= "capture-engine-test.exe"
    monkeypatch.setattr(
        engine_installation_module, "MAX_WORKER_FILE_PATH_CHARACTERS", len(str(installed)) - 1
    )

    with pytest.raises(
        EngineInstallationError, match=f"reach {len(str(installed))} characters, beyond Windows"
    ):
        asyncio.run(
            manager.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )
    assert model_downloader.calls == 0
    assert worker.probes == []
    assert manager.active_engine("windowsml-ocr") is None


def test_engine_installation_is_atomic_offline_ready_and_idempotent(
    tmp_path: Path,
) -> None:
    catalog, sources = _catalog(tmp_path)
    downloader = CopyDownloader(sources)
    worker = FakeWorkerClient()
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
        downloader=downloader,
        model_downloader=CopyModelDownloader(sources),
    )
    progress: list[float] = []
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=progress.append,
        )
    )
    engine = manager.active_engine("windowsml-ocr")
    assert engine is not None
    assert engine.executable.read_bytes() == b"worker-engine-1"
    assert (engine.model_dir / "model.bin").read_bytes() == b"model-engine-1"
    assert progress[-1] == 1
    assert [include_model for _engine, include_model, _options in worker.probes] == [False, True]
    first_calls = downloader.calls
    active_state = json.loads(
        (tmp_path / "engines" / "windowsml-ocr" / "active.json").read_text(encoding="utf-8")
    )
    active_digests = {item["role"]: item["sha256"] for item in active_state["activatedArtifacts"]}
    requirement = catalog.requirement("windowsml-ocr")
    assert active_digests == {
        "worker": requirement.worker_artifact().sha256,
        "model": requirement.model_delivery().manifest_sha256,
    }
    downloader.fail = True
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    assert downloader.calls == first_calls
    assert asyncio.run(manager.probe("windowsml-ocr")).ready is True  # type: ignore[union-attr]


def test_ocr_compute_preflight_uses_one_cached_worker_probe_after_install(
    tmp_path: Path,
) -> None:
    catalog, sources = _catalog(tmp_path)
    contract_sha256 = "a" * 64
    # The archive digest in the catalog is not the executable digest reported
    # by the worker.  The manager binds worker-owned preflight to the
    # extracted executable after archive verification.
    worker_executable_sha256 = hashlib.sha256(b"worker-engine-1").hexdigest()
    decision = OcrComputePreflightV2(
        contract_sha256=contract_sha256,
        worker_sha256=worker_executable_sha256,
        mode=OcrComputeMode.GPU_DML,
        adapter_class=OcrAdapterClass.DEDICATED,
        user_notice_required=False,
    )
    worker = ComputePreflightWorkerClient(decision)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    first = asyncio.run(manager.ocr_compute_preflight(contract_sha256=contract_sha256))
    second = asyncio.run(manager.ocr_compute_preflight(contract_sha256=contract_sha256))

    assert first == decision
    assert second == decision
    assert first.worker_sha256 == worker_executable_sha256
    assert len(worker.compute_preflight_calls) == 1


def test_ocr_compute_preflight_is_unavailable_when_worker_identity_mismatches_catalog(
    tmp_path: Path,
) -> None:
    catalog, sources = _catalog(tmp_path)
    contract_sha256 = "a" * 64
    decision = OcrComputePreflightV2(
        contract_sha256=contract_sha256,
        worker_sha256="b" * 64,
        mode=OcrComputeMode.GPU_DML,
        adapter_class=OcrAdapterClass.DEDICATED,
        user_notice_required=False,
    )
    worker = ComputePreflightWorkerClient(decision)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert asyncio.run(manager.ocr_compute_preflight(contract_sha256=contract_sha256)) is None


def test_ocr_compute_preflight_is_unavailable_when_worker_is_missing(
    tmp_path: Path,
) -> None:
    catalog, _sources = _catalog(tmp_path)
    worker = ComputePreflightWorkerClient(object())
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
    )

    assert asyncio.run(manager.ocr_compute_preflight(contract_sha256="a" * 64)) is None
    assert worker.compute_preflight_calls == []


def test_ocr_compute_preflight_is_unavailable_when_worker_protocol_is_malformed(
    tmp_path: Path,
) -> None:
    catalog, sources = _catalog(tmp_path)
    worker = ComputePreflightWorkerClient({"mode": "cpu-fallback"})
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert asyncio.run(manager.ocr_compute_preflight(contract_sha256="a" * 64)) is None


def test_ocr_compute_preflight_is_unavailable_when_worker_times_out(
    tmp_path: Path,
) -> None:
    catalog, sources = _catalog(tmp_path)
    worker = TimeoutComputePreflightWorkerClient(object())
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert asyncio.run(manager.ocr_compute_preflight(contract_sha256="a" * 64)) is None


def test_successful_activation_does_not_rehash_the_model_before_worker_launch(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog, sources = _catalog(tmp_path)
    verification_calls = 0
    verify_model = engine_installation_module.verify_direct_model_files

    def record_verification(root: Path, descriptor: object) -> None:
        nonlocal verification_calls
        verification_calls += 1
        verify_model(root, descriptor)  # type: ignore[arg-type]

    monkeypatch.setattr(
        engine_installation_module,
        "verify_direct_model_files",
        record_verification,
    )
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )

    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    assert verification_calls == 1

    assert manager.active_engine("windowsml-ocr") is not None
    assert verification_calls == 1


def test_active_engine_cache_is_invalidated_when_installed_files_change(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    engine = manager.active_engine("windowsml-ocr")
    assert engine is not None

    model = engine.model_dir / "model.bin"
    model.write_bytes(b"wrong-engine-1")

    assert manager.active_engine("windowsml-ocr") is None


def test_cold_active_engine_verification_does_not_block_the_event_loop(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog, _sources = _catalog(tmp_path)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
    )
    started = threading.Event()
    release = threading.Event()

    def slow_active_engine(_requirement_id: str) -> InstalledEngine | None:
        started.set()
        assert release.wait(timeout=5)
        return None

    monkeypatch.setattr(manager, "active_engine", slow_active_engine)

    async def run() -> None:
        resolution = asyncio.create_task(manager.resolve_active_engine("windowsml-ocr"))
        while not started.is_set():
            await asyncio.sleep(0)
        heartbeat = asyncio.create_task(asyncio.sleep(0))
        await heartbeat
        assert not resolution.done()
        release.set()
        assert await resolution is None

    asyncio.run(run())


def test_active_engine_resolution_times_out_when_verification_never_returns(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    catalog, _sources = _catalog(tmp_path)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        active_engine_resolution_timeout_seconds=0.01,
    )
    release = threading.Event()

    def blocked_active_engine(_requirement_id: str) -> InstalledEngine | None:
        assert release.wait(timeout=5)
        return None

    monkeypatch.setattr(manager, "active_engine", blocked_active_engine)

    async def run() -> None:
        try:
            with pytest.raises(TimeoutError):
                await manager.resolve_active_engine("windowsml-ocr")
        finally:
            release.set()

    asyncio.run(run())


def test_failed_upgrade_keeps_previous_active_state(tmp_path: Path) -> None:
    catalog_v1, sources_v1 = _catalog(tmp_path, version="engine-1")
    root = tmp_path / "engines"
    manager_v1 = EngineInstallationManager(
        root,
        catalog_v1,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources_v1),
        model_downloader=CopyModelDownloader(sources_v1),
    )
    asyncio.run(
        manager_v1.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    active_before = (root / "windowsml-ocr" / "active.json").read_bytes()
    catalog_v2, sources_v2 = _catalog(tmp_path, version="engine-2")
    manager_v2 = EngineInstallationManager(
        root,
        catalog_v2,
        worker_client=FakeWorkerClient(full_probe_ready=False),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources_v2),
        model_downloader=CopyModelDownloader(sources_v2),
    )
    with pytest.raises(EngineInstallationError, match="post-install probe"):
        asyncio.run(
            manager_v2.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )
    assert (root / "windowsml-ocr" / "active.json").read_bytes() == active_before
    assert manager_v1.active_engine("windowsml-ocr") is not None
    assert not (root / "windowsml-ocr" / "versions" / "engine-2").exists()


def test_active_state_write_failure_restores_previous_version_atomically(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "engines"
    catalog_v1, sources_v1 = _catalog(tmp_path, version="engine-1")
    manager_v1 = EngineInstallationManager(
        root,
        catalog_v1,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources_v1),
        model_downloader=CopyModelDownloader(sources_v1),
    )
    asyncio.run(
        manager_v1.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    requirement_root = root / "windowsml-ocr"
    active_before = (requirement_root / "active.json").read_bytes()
    catalog_v2, sources_v2 = _catalog(tmp_path, version="engine-2")
    manager_v2 = EngineInstallationManager(
        root,
        catalog_v2,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources_v2),
        model_downloader=CopyModelDownloader(sources_v2),
    )
    original_atomic_write = engine_installation_module._atomic_write_json

    def fail_active_write(path: Path, payload: object) -> None:
        if path.name == "active.json":
            raise OSError("injected active state write failure")
        original_atomic_write(path, payload)

    monkeypatch.setattr(engine_installation_module, "_atomic_write_json", fail_active_write)
    with pytest.raises(OSError, match="injected active state write failure"):
        asyncio.run(
            manager_v2.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )
    assert (requirement_root / "active.json").read_bytes() == active_before
    assert (requirement_root / "versions" / "engine-1").is_dir()
    assert not (requirement_root / "versions" / "engine-2").exists()
    assert not list((requirement_root / ".staging").glob("*"))
    assert not list(requirement_root.glob(".previous-*"))


def test_concurrent_install_observes_single_winning_activation(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    downloader = CopyDownloader(sources)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=downloader,
        model_downloader=CopyModelDownloader(sources),
    )

    async def install_twice() -> None:
        await asyncio.gather(
            manager.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            ),
            manager.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            ),
        )

    asyncio.run(install_twice())
    assert downloader.calls == 1
    assert manager.active_engine("windowsml-ocr") is not None
    versions = list((tmp_path / "engines" / "windowsml-ocr" / "versions").iterdir())
    assert [item.name for item in versions] == ["engine-1"]


def test_cancelled_install_leaves_no_active_or_staging_state(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    cancelled = asyncio.Event()
    cancelled.set()
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            manager.install(
                "windowsml-ocr",
                cancel_event=cancelled,
                report_progress=lambda _value: None,
            )
        )
    requirement_root = tmp_path / "engines" / "windowsml-ocr"
    assert not (requirement_root / "active.json").exists()
    assert not list((requirement_root / ".staging").glob("*"))


def test_cancellation_during_direct_model_download_rolls_back_partial_version(
    tmp_path: Path,
) -> None:
    catalog, sources = _catalog(tmp_path)
    root = tmp_path / "engines"
    manager = EngineInstallationManager(
        root,
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CancellingModelDownloader(sources),
    )
    cancelled = asyncio.Event()
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            manager.install(
                "windowsml-ocr",
                cancel_event=cancelled,
                report_progress=lambda _value: None,
            )
        )
    requirement_root = root / "windowsml-ocr"
    assert not (requirement_root / "active.json").exists()
    assert not list((requirement_root / ".staging").glob("*"))
    assert not list((requirement_root / "versions").glob("*"))


def test_preexisting_unlocked_install_file_does_not_block_install(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    root = tmp_path / "engines"
    lock_path = root / "windowsml-ocr" / ".install.lock"
    lock_path.parent.mkdir(parents=True)
    lock_path.write_bytes(b"left behind by an exited process")
    manager = EngineInstallationManager(
        root,
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )

    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert manager.active_engine("windowsml-ocr") is not None
    assert lock_path.is_file()


def test_next_install_removes_only_validated_crash_residue(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    root = tmp_path / "engines"
    manager = EngineInstallationManager(
        root,
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    requirement_root = root / "windowsml-ocr"
    staging_residue = requirement_root / ".staging" / ("a" * 32)
    version_residue = requirement_root / "versions" / f".crashed-{RUNTIME_VERSION}.{'b' * 32}"
    invalid_staging = requirement_root / ".staging" / "not-owned"
    invalid_version = requirement_root / "versions" / ".not-owned"
    for path in (
        staging_residue,
        version_residue,
        invalid_staging,
        invalid_version,
    ):
        path.mkdir(parents=True)
        (path / "partial.bin").write_bytes(b"partial")

    active_before = manager.active_engine("windowsml-ocr")
    assert active_before is not None
    active_root = requirement_root / "versions" / active_before.artifact_version
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert not staging_residue.exists()
    assert not version_residue.exists()
    assert invalid_staging.is_dir()
    assert invalid_version.is_dir()
    assert active_root.is_dir()
    assert manager.active_engine("windowsml-ocr") is not None


def test_separate_process_install_lock_blocks_then_releases(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    root = tmp_path / "engines"
    lock_path = root / "windowsml-ocr" / ".install.lock"
    source_root = Path(__file__).parents[2] / "src"
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(source_root), environment.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    script = (
        "import sys\n"
        "from pathlib import Path\n"
        "from capture_runtime.provisioning.infrastructure.engine_installation "
        "import _ExclusiveInstallFile\n"
        "with _ExclusiveInstallFile(Path(sys.argv[1])):\n"
        "    print('locked', flush=True)\n"
        "    sys.stdin.read(1)\n"
    )
    holder = subprocess.Popen(
        [sys.executable, "-c", script, str(lock_path)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=environment,
    )
    manager = EngineInstallationManager(
        root,
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    try:
        assert holder.stdout is not None
        assert holder.stdout.readline().strip() == "locked"
        with pytest.raises(EngineInstallBusyError, match="installation is active"):
            asyncio.run(
                manager.install(
                    "windowsml-ocr",
                    cancel_event=asyncio.Event(),
                    report_progress=lambda _value: None,
                )
            )
    finally:
        if holder.poll() is None:
            assert holder.stdin is not None
            holder.stdin.write("\n")
            holder.stdin.flush()
        _stdout, stderr = holder.communicate(timeout=10)
        assert holder.returncode == 0, stderr

    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    assert manager.active_engine("windowsml-ocr") is not None
    assert lock_path.is_file()


@dataclass
class _LifecycleConfig:
    app_data_dir: Path


@dataclass
class _Lifecycle:
    config: _LifecycleConfig


def test_core_only_catalog_reports_models_unavailable_without_downloading(
    tmp_path: Path,
) -> None:
    catalog = EngineCatalog.from_dict(
        {
            "catalogVersion": "2",
            "runtimeVersion": RUNTIME_VERSION,
            "requirements": [],
        }
    )
    worker_downloader = CopyDownloader({}, fail=True)
    model_downloader = CopyModelDownloader({})
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=worker_downloader,
        model_downloader=model_downloader,
    )
    installer = SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids={"windowsml-ocr", "speech-recognition"},
    )

    requirements = {item.requirement_id: item for item in installer.requirements()}
    for requirement_id in ("windowsml-ocr", "speech-recognition"):
        requirement = requirements[requirement_id]
        assert requirement.status.value == "unavailable"
        assert requirement.artifact is None
        assert requirement.detail == "No downloadable model is published for this runtime release."

    with pytest.raises(EngineCatalogError, match="unknown engine requirement"):
        asyncio.run(
            installer.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )
    assert worker_downloader.calls == 0
    assert model_downloader.calls == 0


@pytest.mark.parametrize("shape", ["parts", "oversized"])
def test_requirements_list_a_worker_the_contract_cannot_describe_without_an_artifact(
    tmp_path: Path, shape: str
) -> None:
    # 0.7.0 answered 500 for every requirement: the speech worker ships as parts of 2.95 GB.
    payload = _catalog(tmp_path)[0].to_dict()
    worker = payload["requirements"][0]["artifacts"][0]
    if shape == "parts":
        del worker["url"]
        worker["bytes"] = 2_954_313_000
        worker["parts"] = [
            {
                "fileName": f"{worker['fileName']}.{index:03d}",
                "bytes": size,
                "sha256": str(index) * 64,
                "url": f"https://downloads.example.test/{worker['fileName']}.{index:03d}",
            }
            for index, size in ((1, 1_900_000_000), (2, 1_054_313_000))
        ]
    else:
        worker["bytes"] = MAX_RUNTIME_ARTIFACT_BYTES + 1
    manager = EngineInstallationManager(
        tmp_path / "engines",
        EngineCatalog.from_dict(payload),
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader({}, fail=True),
        model_downloader=CopyModelDownloader({}),
    )
    installer = SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids={"windowsml-ocr", "speech-recognition"},
    )

    items = installer.requirements()

    requirements = {item.requirement_id: item for item in items}
    assert requirements["windowsml-ocr"].status.value == "installable"
    assert requirements["windowsml-ocr"].artifact is None
    assert requirements["speech-recognition"].status.value == "unavailable"
    RuntimeRequirementsV2(items=items)


def test_system_installer_passes_nonzero_directml_device_to_model_probe(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    worker = FakeWorkerClient()
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker,  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    extraction = ExtractionRuntimeConfig(
        windowsml_model_dir=tmp_path / "windowsml",
        whisper_models_dir=tmp_path / "whisper",
        temp_dir=tmp_path / "temp",
        max_pdf_pages=10,
        max_image_pixels=100_000,
        ocr_render_scale=2,
        max_audio_duration_ms=60_000,
        whisper_prefer_gpu=False,
    )
    installer = SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        extraction_config=extraction,
        clock=SystemClock(),
    )

    asyncio.run(
        installer.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert [(include_model, options) for _engine, include_model, options in worker.probes] == [
        (False, None),
        (True, None),
    ]


def test_smoke_worker_mirror_maps_only_worker_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog, sources = _catalog(tmp_path)
    monkeypatch.setenv("CAPTURE_SMOKE_WORKER_MIRROR_OPT_IN", "1")
    monkeypatch.setenv("CAPTURE_SMOKE_WORKER_MIRROR_URL", "http://127.0.0.1:43123")

    class RecordingDownloader(CopyDownloader):
        seen_urls: list[str] = []

        async def download(self, descriptor, destination, *, cancel_event, progress) -> None:
            self.seen_urls.append(descriptor.url)
            await super().download(
                descriptor,
                destination,
                cancel_event=cancel_event,
                progress=progress,
            )

    class RecordingModelDownloader(CopyModelDownloader):
        seen_urls: list[str] = []

        async def download(self, descriptor, destination, *, cancel_event, progress) -> None:
            self.seen_urls.append(descriptor.url)
            await super().download(
                descriptor,
                destination,
                cancel_event=cancel_event,
                progress=progress,
            )

    downloader = RecordingDownloader(sources)
    model_downloader = RecordingModelDownloader(sources)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=downloader,
        model_downloader=model_downloader,
    )
    asyncio.run(
        manager.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert downloader.seen_urls == [
        "http://127.0.0.1:43123/" + catalog.requirement("windowsml-ocr").worker_artifact().file_name
    ]
    assert model_downloader.seen_urls == [
        item.url for item in catalog.requirement("windowsml-ocr").model_delivery().files
    ]
    assert all(url.startswith("https://") for url in model_downloader.seen_urls)


def test_pdf_ocr_e2e_local_worker_url_maps_only_ocr_worker_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog, sources = _catalog(tmp_path)
    payload = catalog.to_dict()
    whisper = json.loads(json.dumps(payload["requirements"][0]))
    whisper["requirementId"] = "speech-recognition"
    whisper["artifacts"][0]["requirementId"] = "speech-recognition"
    payload["requirements"].append(whisper)
    catalog = EngineCatalog.from_dict(payload)
    ocr_worker = catalog.requirement("windowsml-ocr").worker_artifact()
    dedicated_url = f"http://127.0.0.1:43124/{ocr_worker.file_name}"
    monkeypatch.setenv("CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN", "1")
    monkeypatch.setenv("CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL", dedicated_url)

    class RecordingDownloader(CopyDownloader):
        seen_urls: list[str] = []

        async def download(self, descriptor, destination, *, cancel_event, progress) -> None:
            self.seen_urls.append(descriptor.url)
            await super().download(
                descriptor,
                destination,
                cancel_event=cancel_event,
                progress=progress,
            )

    class RecordingModelDownloader(CopyModelDownloader):
        seen_urls: list[str] = []

        async def download(self, descriptor, destination, *, cancel_event, progress) -> None:
            self.seen_urls.append(descriptor.url)
            await super().download(
                descriptor,
                destination,
                cancel_event=cancel_event,
                progress=progress,
            )

    downloader = RecordingDownloader(sources)
    model_downloader = RecordingModelDownloader(sources)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=downloader,
        model_downloader=model_downloader,
    )
    for requirement_id in ("windowsml-ocr", "speech-recognition"):
        asyncio.run(
            manager.install(
                requirement_id,
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )

    assert downloader.seen_urls == [
        dedicated_url,
        catalog.requirement("speech-recognition").worker_artifact().url,
    ]
    assert model_downloader.seen_urls == [
        item.url
        for requirement_id in ("windowsml-ocr", "speech-recognition")
        for item in catalog.requirement(requirement_id).model_delivery().files
    ]
    assert all(url.startswith("https://") for url in model_downloader.seen_urls)


def test_pdf_ocr_e2e_local_worker_url_requires_opt_in_and_catalog_filename(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog, sources = _catalog(tmp_path)
    monkeypatch.setenv(
        "CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_URL",
        "http://127.0.0.1:43124/wrong-worker.zip",
    )
    manager_without_opt_in = EngineInstallationManager(
        tmp_path / "without-opt-in",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    asyncio.run(
        manager_without_opt_in.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    monkeypatch.setenv("CAPTURE_PDF_OCR_E2E_LOCAL_WORKER_OPT_IN", "1")
    manager_with_wrong_name = EngineInstallationManager(
        tmp_path / "wrong-name",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    with pytest.raises(EngineInstallationError, match="filename does not match catalog"):
        asyncio.run(
            manager_with_wrong_name.install(
                "windowsml-ocr",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )


def test_speaker_identification_is_listed_as_an_optional_unit(tmp_path: Path) -> None:
    catalog = EngineCatalog.from_dict(
        {"catalogVersion": "2", "runtimeVersion": RUNTIME_VERSION, "requirements": []}
    )
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader({}, fail=True),
        model_downloader=CopyModelDownloader({}),
    )
    installer = SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids={"windowsml-ocr", "speech-recognition", "speaker-diarization"},
    )

    requirements = {item.requirement_id: item for item in installer.requirements()}

    assert requirements["speaker-diarization"].optional is True
    assert requirements["speaker-diarization"].required_for == ["audio"]
    assert requirements["speaker-diarization"].status.value == "unavailable"
    assert requirements["speaker-diarization"].download_bytes is None
    assert requirements["speech-recognition"].optional is True
    assert requirements["windowsml-ocr"].optional is False


def _model_unit_catalog(tmp_path: Path) -> tuple[EngineCatalog, dict[str, Path]]:
    """A catalog whose only entry is a models-only unit, with files to download."""

    catalog, sources = _catalog(tmp_path)
    delivery = catalog.to_dict()["requirements"][0]["modelFiles"]
    return (
        EngineCatalog.from_dict(
            {
                "catalogVersion": "2",
                "runtimeVersion": RUNTIME_VERSION,
                "requirements": [
                    {
                        "requirementId": "vertical-japanese-reader",
                        "artifacts": [],
                        "modelFiles": delivery,
                        "unavailableReason": None,
                    }
                ],
            }
        ),
        sources,
    )


def _model_unit_manager(
    tmp_path: Path, downloader: ModelFileDownloader
) -> EngineInstallationManager:
    catalog, _sources = _model_unit_catalog(tmp_path)
    return EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader({}, fail=True),
        model_downloader=downloader,
    )


def test_a_models_only_unit_installs_without_a_worker_and_is_found_afterwards(
    tmp_path: Path,
) -> None:
    _catalog_value, sources = _model_unit_catalog(tmp_path)
    downloader = CopyModelDownloader(sources)
    manager = _model_unit_manager(tmp_path, downloader)
    progress: list[float] = []
    assert manager.active_model_unit("vertical-japanese-reader") is None
    assert manager.is_installed("vertical-japanese-reader") is False

    asyncio.run(
        manager.install(
            "vertical-japanese-reader",
            cancel_event=asyncio.Event(),
            report_progress=progress.append,
        )
    )

    directory = manager.active_model_unit("vertical-japanese-reader")
    assert directory is not None
    assert (directory / "config.json").is_file()
    assert manager.is_installed("vertical-japanese-reader") is True
    assert manager.active_engine("vertical-japanese-reader") is None
    assert progress[-1] == 1
    assert progress == sorted(progress)

    downloads = downloader.calls
    asyncio.run(
        manager.install(
            "vertical-japanese-reader",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    assert downloader.calls == downloads


def test_a_models_only_unit_with_an_altered_file_is_not_installed(tmp_path: Path) -> None:
    _catalog_value, sources = _model_unit_catalog(tmp_path)
    manager = _model_unit_manager(tmp_path, CopyModelDownloader(sources))
    asyncio.run(
        manager.install(
            "vertical-japanese-reader",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    directory = manager.active_model_unit("vertical-japanese-reader")
    assert directory is not None

    (directory / "model.bin").write_bytes(b"altered after installation")

    assert manager.active_model_unit("vertical-japanese-reader") is None
    assert manager.is_installed("vertical-japanese-reader") is False


def test_a_cancelled_models_only_install_leaves_nothing_behind(tmp_path: Path) -> None:
    _catalog_value, sources = _model_unit_catalog(tmp_path)
    manager = _model_unit_manager(tmp_path, CancellingModelDownloader(sources))

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            manager.install(
                "vertical-japanese-reader",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
            )
        )

    assert manager.active_model_unit("vertical-japanese-reader") is None
    versions = tmp_path / "engines" / "vertical-japanese-reader" / "versions"
    assert not versions.exists() or list(versions.iterdir()) == []


def test_catalog_keeps_workers_and_models_only_units_apart(tmp_path: Path) -> None:
    catalog, _sources = _catalog(tmp_path)
    worker_unit = catalog.to_dict()["requirements"][0]

    def parse(requirement: dict[str, object]) -> EngineCatalog:
        return EngineCatalog.from_dict(
            {
                "catalogVersion": "2",
                "runtimeVersion": RUNTIME_VERSION,
                "requirements": [requirement],
            }
        )

    with pytest.raises(EngineCatalogError, match="worker archive"):
        parse(
            worker_unit
            | {
                "requirementId": "vertical-japanese-reader",
                "artifacts": [
                    worker_unit["artifacts"][0] | {"requirementId": "vertical-japanese-reader"}
                ],
            }
        )
    with pytest.raises(EngineCatalogError):
        parse(worker_unit | {"artifacts": []})
    unit = parse(
        worker_unit | {"requirementId": "vertical-japanese-reader", "artifacts": []}
    ).requirement("vertical-japanese-reader")
    assert (unit.complete, unit.model_only) == (True, True)
    assert unit.artifact_version == worker_unit["modelFiles"]["artifactVersion"]
    with pytest.raises(EngineCatalogError):
        unit.worker_artifact()


def test_installed_models_only_unit_is_listed_as_a_ready_optional_unit(tmp_path: Path) -> None:
    _catalog_value, sources = _model_unit_catalog(tmp_path)
    manager = _model_unit_manager(tmp_path, CopyModelDownloader(sources))
    installer = SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids={"windowsml-ocr", "vertical-japanese-reader"},
    )

    def unit() -> object:
        return next(
            item
            for item in installer.requirements()
            if item.requirement_id == "vertical-japanese-reader"
        )

    before = unit()
    assert (before.status.value, before.optional, before.artifact) == ("installable", True, None)  # type: ignore[attr-defined]
    assert before.required_for == ["pdf", "image"]  # type: ignore[attr-defined]

    asyncio.run(
        installer.install(
            "vertical-japanese-reader",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )

    assert unit().status.value == "ready"  # type: ignore[attr-defined]


def test_install_counts_downloaded_bytes_up_to_the_size_it_lists(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader(sources),
        model_downloader=CopyModelDownloader(sources),
    )
    installer = SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids={"windowsml-ocr"},
    )
    requirement = catalog.requirement("windowsml-ocr")
    expected = requirement.worker_artifact().bytes + requirement.model_delivery().extracted_bytes

    listed = {item.requirement_id: item for item in installer.requirements()}["windowsml-ocr"]
    downloaded: list[DownloadedBytes] = []
    asyncio.run(
        installer.install(
            "windowsml-ocr",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
            report_download=downloaded.append,
        )
    )

    assert listed.download_bytes == expected
    assert {item.total for item in downloaded} == {expected}
    done = [item.done for item in downloaded]
    assert done == sorted(done)
    assert done[-1] == expected


def test_a_models_only_unit_counts_its_model_bytes(tmp_path: Path) -> None:
    catalog, sources = _model_unit_catalog(tmp_path)
    manager = _model_unit_manager(tmp_path, CopyModelDownloader(sources))
    total = catalog.requirement("vertical-japanese-reader").download_bytes
    downloaded: list[DownloadedBytes] = []

    asyncio.run(
        manager.install(
            "vertical-japanese-reader",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
            report_download=downloaded.append,
        )
    )

    assert total == catalog.requirement("vertical-japanese-reader").model_delivery().extracted_bytes
    assert downloaded[-1] == DownloadedBytes(total, total)


def _cached_manager(
    tmp_path: Path,
    catalog: EngineCatalog,
    sources: dict[str, Path],
    *,
    speech_variant: str = "auto",
    nvidia_driver_present: Callable[[], bool] | None = None,
) -> tuple[EngineInstallationManager, VerifiedDownloadCache, CopyDownloader]:
    cache = VerifiedDownloadCache(tmp_path / "cache")
    worker_downloader = CopyDownloader(sources)
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CachingDownloader(worker_downloader, cache),
        model_downloader=CachingDownloader(CopyModelDownloader(sources), cache),
        download_cache=cache,
        speech_variant=speech_variant,
        nvidia_driver_present=nvidia_driver_present,
    )
    return manager, cache, worker_downloader


def _cached(cache_root: Path, sha256: str) -> bool:
    return (cache_root / sha256[:2] / sha256).is_file()


def test_uninstall_removes_the_installed_engine_and_repeating_it_changes_nothing(
    tmp_path: Path,
) -> None:
    catalog, sources = _catalog(tmp_path)
    manager, _cache, _downloader = _cached_manager(tmp_path, catalog, sources)
    installer = SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids={"windowsml-ocr"},
    )
    asyncio.run(
        installer.install(
            "windowsml-ocr", cancel_event=asyncio.Event(), report_progress=lambda _value: None
        )
    )
    root = tmp_path / "engines" / "windowsml-ocr"
    assert (root / "active.json").is_file()
    assert installer.is_uninstallable("windowsml-ocr")

    asyncio.run(installer.uninstall("windowsml-ocr"))

    assert manager.active_engine("windowsml-ocr") is None
    assert [item.name for item in root.iterdir()] == [".install.lock"]
    assert manager.worker_client.shutdown_called  # type: ignore[attr-defined]
    (requirement,) = installer.requirements()
    assert requirement.status.value == "installable"

    asyncio.run(installer.uninstall("windowsml-ocr"))
    assert [item.name for item in root.iterdir()] == [".install.lock"]


def test_uninstall_frees_only_the_cached_downloads_no_other_unit_references(
    tmp_path: Path,
) -> None:
    worker_catalog, sources = _catalog(tmp_path)
    worker_unit = worker_catalog.to_dict()["requirements"][0]
    # The reader unit lists the same model files, so their cache entries are shared.
    catalog = EngineCatalog.from_dict(
        {
            "catalogVersion": "2",
            "runtimeVersion": RUNTIME_VERSION,
            "requirements": [
                worker_unit,
                worker_unit | {"requirementId": "vertical-japanese-reader", "artifacts": []},
            ],
        }
    )
    manager, _cache, _downloader = _cached_manager(tmp_path, catalog, sources)
    asyncio.run(
        manager.install(
            "windowsml-ocr", cancel_event=asyncio.Event(), report_progress=lambda _value: None
        )
    )
    requirement = catalog.requirement("windowsml-ocr")
    worker_sha256 = requirement.worker_artifact().sha256
    model_sha256s = [item.sha256 for item in requirement.model_delivery().files]
    cache_root = tmp_path / "cache"
    assert _cached(cache_root, worker_sha256)
    assert all(_cached(cache_root, sha256) for sha256 in model_sha256s)

    asyncio.run(manager.uninstall("windowsml-ocr"))

    assert not _cached(cache_root, worker_sha256)
    assert all(_cached(cache_root, sha256) for sha256 in model_sha256s)


def test_an_uninstalled_engine_installs_again(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager, _cache, downloader = _cached_manager(tmp_path, catalog, sources)

    def install() -> None:
        asyncio.run(
            manager.install(
                "windowsml-ocr", cancel_event=asyncio.Event(), report_progress=lambda _value: None
            )
        )

    install()
    asyncio.run(manager.uninstall("windowsml-ocr"))
    install()

    engine = manager.active_engine("windowsml-ocr")
    assert engine is not None
    assert engine.executable.read_bytes() == b"worker-engine-1"
    assert downloader.calls == 2


def test_a_crash_after_the_marker_is_removed_leaves_the_engine_not_installed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    catalog, sources = _catalog(tmp_path)
    manager, _cache, _downloader = _cached_manager(tmp_path, catalog, sources)
    asyncio.run(
        manager.install(
            "windowsml-ocr", cancel_event=asyncio.Event(), report_progress=lambda _value: None
        )
    )

    def crash(_root: Path) -> None:
        raise EngineInstallationError("stale engine install residue could not be removed")

    monkeypatch.setattr(engine_installation_module, "remove_unit_files", crash)
    with pytest.raises(EngineInstallationError):
        asyncio.run(manager.uninstall("windowsml-ocr"))
    assert manager.active_engine("windowsml-ocr") is None
    assert (tmp_path / "engines" / "windowsml-ocr" / "versions").is_dir()

    monkeypatch.undo()
    asyncio.run(manager.uninstall("windowsml-ocr"))
    assert not (tmp_path / "engines" / "windowsml-ocr" / "versions").exists()


def test_uninstall_removes_a_models_only_unit(tmp_path: Path) -> None:
    _catalog_value, sources = _model_unit_catalog(tmp_path)
    manager = _model_unit_manager(tmp_path, CopyModelDownloader(sources))
    asyncio.run(
        manager.install(
            "vertical-japanese-reader",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    assert manager.is_installed("vertical-japanese-reader")

    asyncio.run(manager.uninstall("vertical-japanese-reader"))

    assert manager.is_installed("vertical-japanese-reader") is False
    root = tmp_path / "engines" / "vertical-japanese-reader"
    assert [item.name for item in root.iterdir()] == [".install.lock"]


def _reject_driver() -> bool:
    raise AssertionError("driver detection ran")


class _Driver:
    def __init__(self, present: bool) -> None:
        self.present = present
        self.calls = 0

    def __call__(self) -> bool:
        self.calls += 1
        return self.present


def _requirements_installer(
    tmp_path: Path, manager: EngineInstallationManager, *requirement_ids: str
) -> SystemRuntimeInstaller:
    return SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids=set(requirement_ids),
    )


def _listed(installer: SystemRuntimeInstaller, requirement_id: str):
    return next(item for item in installer.requirements() if item.requirement_id == requirement_id)


def _archive(
    root: Path,
    *,
    requirement_id: str,
    file_name: str,
    entry_point: str,
    payload: bytes,
) -> dict[str, object]:
    files = {entry_point: payload}
    manifest = _manifest(files)
    archive = root / file_name
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_STORED) as destination:
        for name, content in files.items():
            destination.writestr(name, content)
        destination.writestr("files-manifest.json", manifest)
    with zipfile.ZipFile(archive) as source:
        extracted_bytes = sum(item.file_size for item in source.infolist())
    return {
        "role": "worker",
        "requirementId": requirement_id,
        "artifactVersion": "engine-1",
        "workerProtocolVersion": "1",
        "platform": "windows",
        "arch": "x86_64",
        "fileName": archive.name,
        "bytes": archive.stat().st_size,
        "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "extractedBytes": extracted_bytes,
        "entryPoint": entry_point,
        "filesManifestSha256": hashlib.sha256(manifest).hexdigest(),
        "url": f"https://downloads.example.test/{archive.name}",
    }


def _direct_delivery(
    root: Path, sources: dict[str, Path], files: dict[str, bytes]
) -> dict[str, object]:
    revision = "a" * 40
    described: list[dict[str, object]] = []
    for path, content in sorted(files.items()):
        if path.startswith("licenses/"):
            kind = "license"
        elif path.startswith("notices/"):
            kind = "notice"
        else:
            kind = "source"
        source = root / path.replace("/", "-")
        source.write_bytes(content)
        sources[path] = source
        described.append(
            {
                "bytes": len(content),
                "derivation": None,
                "kind": kind,
                "licensePath": None if kind in {"license", "notice"} else "licenses/LICENSE.txt",
                "noticePath": None if kind in {"license", "notice"} else "notices/NOTICE.txt",
                "owner": "test-owner",
                "path": path,
                "redirectHosts": [],
                "revision": revision,
                "sha256": hashlib.sha256(content).hexdigest(),
                "spdx": "MIT",
                "url": f"https://downloads.example.test/{revision}/{path}",
            }
        )
    manifest = {
        "artifactVersion": "engine-1",
        "entryPoint": "model",
        "files": described,
        "manifestVersion": "1",
    }
    return {
        "artifactVersion": "engine-1",
        "entryCount": len(described),
        "entryPoint": "model",
        "extractedBytes": sum(len(content) for content in files.values()),
        "files": described,
        "manifestSha256": hashlib.sha256(canonical_json_bytes(manifest)).hexdigest(),
        "sourceLockSha256": "b" * 64,
    }


def _speech_contents_catalog(
    root: Path,
    *,
    include_cuda: bool = True,
    include_cpu: bool = True,
    include_speaker: bool = False,
) -> tuple[EngineCatalog, dict[str, Path]]:
    sources: dict[str, Path] = {}
    shared = {"licenses/LICENSE.txt": b"license", "notices/NOTICE.txt": b"notice"}
    contents: list[dict[str, object]] = []
    if include_cuda:
        cuda_name = "capture-engine-speech-recognition.zip"
        cuda_worker = _archive(
            root,
            requirement_id="speech-recognition",
            file_name=cuda_name,
            entry_point="capture-engine-speech-recognition.exe",
            payload=b"cuda-worker",
        )
        sources[cuda_name] = root / cuda_name
        contents.append(
            {
                "id": "cuda",
                "artifacts": [cuda_worker],
                "modelFiles": _direct_delivery(
                    root, sources, {**shared, "model/primary.bin": b"primary-weights"}
                ),
                "unavailableReason": None,
            }
        )
    if include_cpu:
        cpu_name = "capture-engine-speech-recognition-cpu.zip"
        cpu_worker = _archive(
            root,
            requirement_id="speech-recognition",
            file_name=cpu_name,
            entry_point="capture-engine-speech-recognition-cpu.exe",
            payload=b"cpu-worker",
        )
        sources[cpu_name] = root / cpu_name
        contents.append(
            {
                "id": "cpu",
                "artifacts": [cpu_worker],
                "modelFiles": _direct_delivery(
                    root, sources, {**shared, "model/fallback.bin": b"fallback-weights"}
                ),
                "unavailableReason": None,
            }
        )
    requirements: list[dict[str, object]] = [
        {"requirementId": "speech-recognition", "contents": contents}
    ]
    if include_speaker:
        speaker_name = "capture-engine-speaker-diarization.zip"
        speaker_worker = _archive(
            root,
            requirement_id="speaker-diarization",
            file_name=speaker_name,
            entry_point="capture-engine-speaker-diarization.exe",
            payload=b"speaker-worker",
        )
        sources[speaker_name] = root / speaker_name
        requirements.append(
            {
                "requirementId": "speaker-diarization",
                "artifacts": [speaker_worker],
                "modelFiles": _direct_delivery(root, sources, dict(shared)),
                "unavailableReason": None,
            }
        )
    return (
        EngineCatalog.from_dict(
            {
                "catalogVersion": "2",
                "runtimeVersion": RUNTIME_VERSION,
                "requirements": requirements,
            }
        ),
        sources,
    )


def _install(manager: EngineInstallationManager, requirement_id: str, downloaded=None) -> None:
    asyncio.run(
        manager.install(
            requirement_id,
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
            report_download=None if downloaded is None else downloaded.append,
        )
    )


def _tree_bytes(root: Path) -> dict[str, bytes | None]:
    recorded: dict[str, bytes | None] = {}
    for item in root.rglob("*"):
        relative = item.relative_to(root).as_posix()
        recorded[relative] = None if item.is_dir() else item.read_bytes()
    return recorded


def test_a_requirement_without_contents_ignores_the_variant(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager, _cache, downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cpu",
        nvidia_driver_present=_reject_driver,
    )
    installer = _requirements_installer(tmp_path, manager, "windowsml-ocr")
    expected = catalog.requirement("windowsml-ocr").download_bytes

    listed = _listed(installer, "windowsml-ocr")
    assert listed.status.value == "installable"
    assert listed.download_bytes == expected

    _install(manager, "windowsml-ocr")

    state = json.loads(
        (tmp_path / "engines" / "windowsml-ocr" / "active.json").read_text(encoding="utf-8")
    )
    assert state["stateVersion"] == "1"
    assert "contentId" not in state
    legacy = manager.active_engine("windowsml-ocr")
    assert legacy is not None and legacy.content_id is None
    legacy_client = manager.worker_client
    assert isinstance(legacy_client, FakeWorkerClient)
    assert [options for _engine, _include, options in legacy_client.probes] == [None, None]
    assert set(state) == {
        "activatedArtifacts",
        "artifactVersion",
        "entryPoint",
        "requirementId",
        "stateVersion",
        "workerProtocolVersion",
    }
    assert _listed(installer, "windowsml-ocr").download_bytes == expected
    assert downloader.calls == 1


def test_an_installed_content_stays_when_the_driver_or_override_changes(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    speech = catalog.requirement("speech-recognition")
    cpu = speech.find_content("cpu")
    cuda = speech.find_content("cuda")
    assert cpu is not None and cuda is not None
    assert cpu.download_bytes != cuda.download_bytes
    driver = _Driver(False)
    manager, _cache, downloader = _cached_manager(
        tmp_path, catalog, sources, nvidia_driver_present=driver
    )
    installer = _requirements_installer(tmp_path, manager, "speech-recognition")

    listed = _listed(installer, "speech-recognition")
    assert listed.status.value == "installable"
    assert listed.artifact is None
    assert listed.download_bytes == cpu.download_bytes
    assert driver.calls == 1

    downloaded: list[DownloadedBytes] = []
    _install(manager, "speech-recognition", downloaded)
    assert {item.total for item in downloaded} == {cpu.download_bytes}
    assert downloaded[-1].done == cpu.download_bytes
    assert driver.calls == 2
    state = json.loads(
        (tmp_path / "engines" / "speech-recognition" / "active.json").read_text(encoding="utf-8")
    )
    assert state["stateVersion"] == "2"
    assert state["contentId"] == "cpu"
    worker_sha = next(
        item["sha256"] for item in state["activatedArtifacts"] if item["role"] == "worker"
    )
    assert worker_sha == cpu.worker_artifact().sha256
    engine = manager.active_engine("speech-recognition")
    assert engine is not None
    assert engine.content_id == "cpu"
    assert engine.executable.read_bytes() == b"cpu-worker"
    installed_client = manager.worker_client
    assert isinstance(installed_client, FakeWorkerClient)
    assert [(include, options) for _engine, include, options in installed_client.probes] == [
        (False, None),
        (True, {"content": "cpu"}),
    ]

    driver.present = True
    calls = driver.calls
    downloads = downloader.calls
    downloader.fail = True
    ready = _listed(installer, "speech-recognition")
    assert ready.status.value == "ready"
    assert ready.download_bytes == cpu.download_bytes
    kept = manager.active_engine("speech-recognition")
    assert kept is not None
    assert kept.executable.read_bytes() == b"cpu-worker"
    _install(manager, "speech-recognition")
    assert driver.calls == calls
    assert downloader.calls == downloads

    fresh_downloader = CopyDownloader(sources, fail=True)
    fresh = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=fresh_downloader,
        model_downloader=CopyModelDownloader(sources),
        speech_variant="cuda",
        nvidia_driver_present=_reject_driver,
    )
    fresh_engine = fresh.active_engine("speech-recognition")
    assert fresh_engine is not None
    assert fresh_engine.content_id == "cpu"
    assert fresh_engine.executable.read_bytes() == b"cpu-worker"
    fresh_listed = _listed(
        _requirements_installer(tmp_path, fresh, "speech-recognition"), "speech-recognition"
    )
    assert fresh_listed.status.value == "ready"
    assert fresh_listed.download_bytes == cpu.download_bytes
    _install(fresh, "speech-recognition")
    assert fresh_downloader.calls == 0


def test_auto_with_a_driver_installs_the_cuda_content(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    cuda = catalog.requirement("speech-recognition").find_content("cuda")
    assert cuda is not None
    manager, _cache, _downloader = _cached_manager(
        tmp_path, catalog, sources, nvidia_driver_present=_Driver(True)
    )
    downloaded: list[DownloadedBytes] = []

    _install(manager, "speech-recognition", downloaded)

    state = json.loads(
        (tmp_path / "engines" / "speech-recognition" / "active.json").read_text(encoding="utf-8")
    )
    assert state["contentId"] == "cuda"
    engine = manager.active_engine("speech-recognition")
    assert engine is not None
    assert engine.content_id == "cuda"
    assert engine.executable.read_bytes() == b"cuda-worker"
    cuda_client = manager.worker_client
    assert isinstance(cuda_client, FakeWorkerClient)
    assert [(include, options) for _engine, include, options in cuda_client.probes] == [
        (False, None),
        (True, {"content": "cuda"}),
    ]
    assert downloaded[-1].total == cuda.download_bytes


def test_a_forced_cuda_variant_installs_cuda_without_a_driver(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    cuda = catalog.requirement("speech-recognition").find_content("cuda")
    assert cuda is not None
    manager, _cache, _downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cuda",
        nvidia_driver_present=_reject_driver,
    )
    installer = _requirements_installer(tmp_path, manager, "speech-recognition")

    listed = _listed(installer, "speech-recognition")
    assert listed.status.value == "installable"
    assert listed.download_bytes == cuda.download_bytes
    _install(manager, "speech-recognition")

    state = json.loads(
        (tmp_path / "engines" / "speech-recognition" / "active.json").read_text(encoding="utf-8")
    )
    assert state["contentId"] == "cuda"
    engine = manager.active_engine("speech-recognition")
    assert engine is not None
    assert engine.executable.read_bytes() == b"cuda-worker"


def test_a_forced_variant_whose_content_is_missing_is_unavailable(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path, include_cpu=False)
    manager, _cache, downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cpu",
        nvidia_driver_present=_reject_driver,
    )
    listed = _listed(
        _requirements_installer(tmp_path, manager, "speech-recognition"), "speech-recognition"
    )

    assert listed.status.value == "unavailable"
    assert listed.download_bytes is None
    assert listed.artifact is None
    assert listed.detail == "No cpu content is published for this runtime release."
    with pytest.raises(EngineInstallationError, match="No cpu content"):
        _install(manager, "speech-recognition")
    assert downloader.calls == 0
    assert not (tmp_path / "engines" / "speech-recognition" / "active.json").exists()


def test_an_incomplete_content_lists_its_reason_and_no_size(tmp_path: Path) -> None:
    reason = "cpu pack is not in this release"
    catalog = EngineCatalog.from_dict(
        {
            "catalogVersion": "2",
            "runtimeVersion": RUNTIME_VERSION,
            "requirements": [
                {
                    "requirementId": "speech-recognition",
                    "contents": [
                        {
                            "id": "cpu",
                            "artifacts": [],
                            "modelFiles": None,
                            "unavailableReason": reason,
                        }
                    ],
                }
            ],
        }
    )
    manager = EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=FakeWorkerClient(),  # type: ignore[arg-type]
        downloader=CopyDownloader({}, fail=True),
        model_downloader=CopyModelDownloader({}),
        speech_variant="cpu",
        nvidia_driver_present=_reject_driver,
    )
    listed = _listed(
        _requirements_installer(tmp_path, manager, "speech-recognition"), "speech-recognition"
    )

    assert listed.status.value == "unavailable"
    assert listed.download_bytes is None
    assert listed.artifact is None
    assert listed.detail == reason


def test_a_version_1_state_is_not_ready_on_a_requirement_with_contents(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    manager, _cache, _downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cuda",
        nvidia_driver_present=_reject_driver,
    )
    _install(manager, "speech-recognition")
    cuda = catalog.requirement("speech-recognition").find_content("cuda")
    assert cuda is not None
    path = tmp_path / "engines" / "speech-recognition" / "active.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["contentId"] == "cuda"
    worker_sha = next(
        item["sha256"] for item in payload["activatedArtifacts"] if item["role"] == "worker"
    )
    assert worker_sha == cuda.worker_artifact().sha256

    del payload["contentId"]
    payload["stateVersion"] = "1"
    path.write_text(json.dumps(payload), encoding="utf-8")

    parsed = ActiveEngineState.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert parsed.content_id is None
    assert manager.active_engine("speech-recognition") is None


def test_uninstall_drops_every_content_cache_and_keeps_another_requirements(
    tmp_path: Path,
) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path, include_speaker=True)
    manager, cache, _downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cuda",
        nvidia_driver_present=_reject_driver,
    )
    _install(manager, "speech-recognition")
    speech = catalog.requirement("speech-recognition")
    cuda = speech.find_content("cuda")
    cpu = speech.find_content("cpu")
    assert cuda is not None and cpu is not None
    speaker = catalog.requirement("speaker-diarization")
    cuda_files = cuda.model_delivery().files
    cpu_files = cpu.model_delivery().files
    cuda_worker = cuda.worker_artifact().sha256
    cpu_worker = cpu.worker_artifact().sha256
    primary = next(item.sha256 for item in cuda_files if item.path == "model/primary.bin")
    fallback = next(item.sha256 for item in cpu_files if item.path == "model/fallback.bin")
    shared = next(item.sha256 for item in cuda_files if item.kind == "license")
    speaker_worker = speaker.worker_artifact().sha256
    cache_root = tmp_path / "cache"
    assert _cached(cache_root, cuda_worker)
    assert _cached(cache_root, primary)
    assert _cached(cache_root, shared)
    cache.store(cpu_worker, sources["capture-engine-speech-recognition-cpu.zip"])
    cache.store(fallback, sources["model/fallback.bin"])
    cache.store(speaker_worker, sources["capture-engine-speaker-diarization.zip"])

    asyncio.run(manager.uninstall("speech-recognition"))

    assert not _cached(cache_root, cuda_worker)
    assert not _cached(cache_root, primary)
    assert not _cached(cache_root, cpu_worker)
    assert not _cached(cache_root, fallback)
    assert _cached(cache_root, shared)
    assert _cached(cache_root, speaker_worker)


def test_auto_without_a_driver_installs_the_only_cuda_content(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path, include_cpu=False)
    cuda = catalog.requirement("speech-recognition").find_content("cuda")
    assert cuda is not None
    driver = _Driver(False)
    manager, _cache, _downloader = _cached_manager(
        tmp_path, catalog, sources, nvidia_driver_present=driver
    )
    installer = _requirements_installer(tmp_path, manager, "speech-recognition")

    listed = _listed(installer, "speech-recognition")
    assert listed.status.value == "installable"
    assert listed.artifact is None
    assert listed.download_bytes == cuda.download_bytes
    assert driver.calls == 1

    _install(manager, "speech-recognition")

    state = json.loads(
        (tmp_path / "engines" / "speech-recognition" / "active.json").read_text(encoding="utf-8")
    )
    assert state["stateVersion"] == "2"
    assert state["contentId"] == "cuda"
    engine = manager.active_engine("speech-recognition")
    assert engine is not None
    assert engine.executable.read_bytes() == b"cuda-worker"


def test_auto_with_a_driver_installs_the_only_cpu_content(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path, include_cuda=False)
    cpu = catalog.requirement("speech-recognition").find_content("cpu")
    assert cpu is not None
    driver = _Driver(True)
    manager, _cache, _downloader = _cached_manager(
        tmp_path, catalog, sources, nvidia_driver_present=driver
    )
    installer = _requirements_installer(tmp_path, manager, "speech-recognition")

    listed = _listed(installer, "speech-recognition")
    assert listed.status.value == "installable"
    assert listed.download_bytes == cpu.download_bytes
    assert driver.calls == 1

    _install(manager, "speech-recognition")

    state = json.loads(
        (tmp_path / "engines" / "speech-recognition" / "active.json").read_text(encoding="utf-8")
    )
    assert state["contentId"] == "cpu"
    engine = manager.active_engine("speech-recognition")
    assert engine is not None
    assert engine.executable.read_bytes() == b"cpu-worker"


def test_a_forced_cuda_variant_whose_content_is_missing_is_unavailable(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path, include_cuda=False)
    manager, _cache, downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cuda",
        nvidia_driver_present=_reject_driver,
    )
    listed = _listed(
        _requirements_installer(tmp_path, manager, "speech-recognition"), "speech-recognition"
    )

    assert listed.status.value == "unavailable"
    assert listed.download_bytes is None
    assert listed.artifact is None
    assert listed.detail == "No cuda content is published for this runtime release."
    with pytest.raises(EngineInstallationError, match="No cuda content"):
        _install(manager, "speech-recognition")
    assert downloader.calls == 0
    assert not (tmp_path / "engines" / "speech-recognition" / "active.json").exists()


def test_auto_with_a_driver_lists_the_cuda_size_before_install(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    speech = catalog.requirement("speech-recognition")
    cuda = speech.find_content("cuda")
    cpu = speech.find_content("cpu")
    assert cuda is not None and cpu is not None
    assert cuda.download_bytes != cpu.download_bytes
    driver = _Driver(True)
    manager, _cache, _downloader = _cached_manager(
        tmp_path, catalog, sources, nvidia_driver_present=driver
    )

    listed = _listed(
        _requirements_installer(tmp_path, manager, "speech-recognition"), "speech-recognition"
    )

    assert listed.status.value == "installable"
    assert listed.artifact is None
    assert listed.download_bytes == cuda.download_bytes
    assert driver.calls == 1
    assert not (tmp_path / "engines" / "speech-recognition" / "active.json").exists()


def test_a_version_2_state_on_a_requirement_without_contents_is_not_ready(tmp_path: Path) -> None:
    catalog, sources = _catalog(tmp_path)
    manager, _cache, _downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cpu",
        nvidia_driver_present=_reject_driver,
    )
    _install(manager, "windowsml-ocr")
    root = tmp_path / "engines" / "windowsml-ocr"
    path = root / "active.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["stateVersion"] == "1"
    payload["stateVersion"] = "2"
    payload["contentId"] = "cpu"
    path.write_text(json.dumps(payload), encoding="utf-8")
    parsed = ActiveEngineState.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert parsed.content_id == "cpu"
    before = _tree_bytes(root)

    assert manager.active_engine("windowsml-ocr") is None
    assert _tree_bytes(root) == before
    listed = _listed(_requirements_installer(tmp_path, manager, "windowsml-ocr"), "windowsml-ocr")
    assert listed.status.value == "installable"


def test_a_recorded_content_the_catalog_dropped_is_replaced_on_install(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path, include_cuda=False)
    manager, _cache, _downloader = _cached_manager(
        tmp_path, catalog, sources, nvidia_driver_present=_Driver(False)
    )
    root = tmp_path / "engines" / "speech-recognition"
    root.mkdir(parents=True)
    state = ActiveEngineState(
        requirement_id="speech-recognition",
        artifact_version="engine-1",
        worker_protocol_version="1",
        entry_point="versions/engine-1/worker/capture-engine-speech-recognition.exe",
        activated_artifacts=(
            ActivatedArtifact("worker", "a" * 64),
            ActivatedArtifact("model", "b" * 64),
        ),
        state_version="2",
        content_id="cuda",
    )
    path = root / "active.json"
    path.write_bytes(canonical_json_bytes(state.to_dict()))
    (root / "kept.txt").write_bytes(b"keep")
    loaded = ActiveEngineState.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert loaded.content_id == "cuda"
    before = _tree_bytes(root)

    assert manager.active_engine("speech-recognition") is None
    assert _tree_bytes(root) == before

    _install(manager, "speech-recognition")

    updated = json.loads(path.read_text(encoding="utf-8"))
    assert updated["stateVersion"] == "2"
    assert updated["contentId"] == "cpu"
    engine = manager.active_engine("speech-recognition")
    assert engine is not None
    assert engine.executable.read_bytes() == b"cpu-worker"


def test_a_version_1_state_on_a_contents_requirement_installs_as_version_2(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    manager, _cache, _downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cuda",
        nvidia_driver_present=_reject_driver,
    )
    _install(manager, "speech-recognition")
    path = tmp_path / "engines" / "speech-recognition" / "active.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["contentId"] == "cuda"
    del payload["contentId"]
    payload["stateVersion"] = "1"
    path.write_text(json.dumps(payload), encoding="utf-8")
    recorded = ActiveEngineState.from_dict(json.loads(path.read_text(encoding="utf-8")))
    assert recorded.content_id is None
    assert manager.active_engine("speech-recognition") is None

    _install(manager, "speech-recognition")

    updated = json.loads(path.read_text(encoding="utf-8"))
    assert updated["stateVersion"] == "2"
    assert updated["contentId"] == "cuda"
    engine = manager.active_engine("speech-recognition")
    assert engine is not None
    assert engine.executable.read_bytes() == b"cuda-worker"


def test_uninstall_after_a_cpu_install_frees_both_contents_and_keeps_a_shared_digest(
    tmp_path: Path,
) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path, include_speaker=True)
    manager, cache, _downloader = _cached_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cpu",
        nvidia_driver_present=_reject_driver,
    )
    _install(manager, "speech-recognition")
    root = tmp_path / "engines" / "speech-recognition"
    assert (root / "active.json").is_file()
    speech = catalog.requirement("speech-recognition")
    cuda = speech.find_content("cuda")
    cpu = speech.find_content("cpu")
    assert cuda is not None and cpu is not None
    speaker = catalog.requirement("speaker-diarization")
    cuda_files = cuda.model_delivery().files
    cpu_files = cpu.model_delivery().files
    cuda_worker = cuda.worker_artifact().sha256
    cpu_worker = cpu.worker_artifact().sha256
    primary = next(item.sha256 for item in cuda_files if item.path == "model/primary.bin")
    fallback = next(item.sha256 for item in cpu_files if item.path == "model/fallback.bin")
    shared = next(item.sha256 for item in cpu_files if item.kind == "license")
    speaker_worker = speaker.worker_artifact().sha256
    cache_root = tmp_path / "cache"
    assert _cached(cache_root, cpu_worker)
    assert _cached(cache_root, fallback)
    assert _cached(cache_root, shared)
    cache.store(cuda_worker, sources["capture-engine-speech-recognition.zip"])
    cache.store(primary, sources["model/primary.bin"])
    cache.store(speaker_worker, sources["capture-engine-speaker-diarization.zip"])

    asyncio.run(manager.uninstall("speech-recognition"))

    assert manager.active_engine("speech-recognition") is None
    assert [item.name for item in root.iterdir()] == [".install.lock"]
    assert not (root / "versions").exists()
    assert not _cached(cache_root, cpu_worker)
    assert not _cached(cache_root, fallback)
    assert not _cached(cache_root, cuda_worker)
    assert not _cached(cache_root, primary)
    assert _cached(cache_root, shared)
    assert _cached(cache_root, speaker_worker)


def test_the_settings_variant_selects_the_listed_content(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(engine_installation_module, "detect_nvidia_driver", _reject_driver)
    settings = RuntimeSettings.from_env(
        {
            "CAPTURE_API_TOKEN": "a" * 32,
            "CAPTURE_APP_DATA_DIR": str(tmp_path / "app-data"),
            "CAPTURE_EXTRACTION_PROVIDER": "fake",
            "CAPTURE_STRUCTURING_PROVIDER": "fake",
            "CAPTURE_SPEECH_RECOGNITION_VARIANT": "cpu",
        }
    )
    dependencies = build_runtime_dependencies(settings)
    catalog_root = tmp_path / "catalog"
    catalog_root.mkdir()
    catalog, _sources = _speech_contents_catalog(catalog_root)
    speech = catalog.requirement("speech-recognition")
    cpu = speech.find_content("cpu")
    cuda = speech.find_content("cuda")
    assert cpu is not None and cuda is not None
    assert cpu.download_bytes != cuda.download_bytes
    dependencies.engine_manager.catalog = catalog

    listed = next(
        item
        for item in dependencies.installer.requirements(["speech-recognition"])
        if item.requirement_id == "speech-recognition"
    )

    assert listed.status.value == "installable"
    assert listed.artifact is None
    assert listed.download_bytes == cpu.download_bytes


_MISSING_CPU_MODEL = (
    "Speech recognition model tea-asr-1.1 is not in the installed cpu content. "
    "Set CAPTURE_SPEECH_RECOGNITION_MODEL to auto or tea-asr-1.1-mini, "
    "or uninstall speech-recognition and install it with "
    "CAPTURE_SPEECH_RECOGNITION_VARIANT=cuda."
)
_INSTALLABLE_DETAIL = "Pinned worker and direct model files are available for installation."
_WAV = b"RIFF\x00\x00\x00\x00WAVEpayload"


def _speech_config(tmp_path: Path, *, model: str, variant: str) -> ExtractionRuntimeConfig:
    return ExtractionRuntimeConfig(
        windowsml_model_dir=tmp_path / "windowsml",
        whisper_models_dir=tmp_path / "whisper",
        temp_dir=tmp_path / "temp",
        max_pdf_pages=10,
        max_image_pixels=100_000,
        ocr_render_scale=2,
        max_audio_duration_ms=60_000,
        whisper_prefer_gpu=True,
        speech_recognition_model=model,
        speech_recognition_variant=variant,
        speech_worker_idle_seconds=0,
    )


def _content_manager(
    tmp_path: Path,
    catalog: EngineCatalog,
    sources: dict[str, Path],
    *,
    speech_variant: str,
    nvidia_driver_present: Callable[[], bool],
    worker_client: FakeWorkerClient,
) -> EngineInstallationManager:
    cache = VerifiedDownloadCache(tmp_path / "cache")
    return EngineInstallationManager(
        tmp_path / "engines",
        catalog,
        worker_client=worker_client,  # type: ignore[arg-type]
        downloader=CachingDownloader(CopyDownloader(sources), cache),
        model_downloader=CachingDownloader(CopyModelDownloader(sources), cache),
        download_cache=cache,
        speech_variant=speech_variant,
        nvidia_driver_present=nvidia_driver_present,
    )


def _speaker_requirement(root: Path, sources: dict[str, Path]) -> dict[str, object]:
    speaker_name = "capture-engine-speaker-diarization.zip"
    speaker_worker = _archive(
        root,
        requirement_id="speaker-diarization",
        file_name=speaker_name,
        entry_point="capture-engine-speaker-diarization.exe",
        payload=b"speaker-worker",
    )
    sources[speaker_name] = root / speaker_name
    return {
        "requirementId": "speaker-diarization",
        "artifacts": [speaker_worker],
        "modelFiles": _direct_delivery(
            root,
            sources,
            {
                "licenses/LICENSE.txt": b"license",
                "notices/NOTICE.txt": b"notice",
                "model/speaker.bin": b"speaker-weights",
            },
        ),
        "unavailableReason": None,
    }


def _speech_catalog_for(root: Path, *, legacy: bool) -> tuple[EngineCatalog, dict[str, Path]]:
    if legacy:
        catalog, sources = _catalog(root)
        speech = json.loads(json.dumps(catalog.to_dict()["requirements"][0]))
        speech["requirementId"] = "speech-recognition"
        speech["artifacts"][0]["requirementId"] = "speech-recognition"
        requirements = [speech]
    else:
        catalog, sources = _speech_contents_catalog(root)
        requirements = catalog.to_dict()["requirements"]
    requirements.append(_speaker_requirement(root, sources))
    return (
        EngineCatalog.from_dict(
            {
                "catalogVersion": "2",
                "runtimeVersion": RUNTIME_VERSION,
                "requirements": requirements,
            }
        ),
        sources,
    )


def _model_installer(
    tmp_path: Path,
    manager: EngineInstallationManager,
    *,
    model: str | None,
    variant: str,
) -> SystemRuntimeInstaller:
    config = None if model is None else _speech_config(tmp_path, model=model, variant=variant)
    return SystemRuntimeInstaller(
        _Lifecycle(_LifecycleConfig(tmp_path / "app-data")),  # type: ignore[arg-type]
        engine_manager=manager,
        clock=SystemClock(),
        enabled_requirement_ids={"speech-recognition"},
        extraction_config=config,
    )


class _RecordingWorkerClient(FakeWorkerClient):
    def __init__(self) -> None:
        super().__init__()
        self.runs: list[tuple[str, dict[str, object]]] = []
        self.diarizations: list[str] = []

    async def run(self, engine: InstalledEngine, **kwargs: object) -> WorkerRunResult:
        options = kwargs["options"]
        if not isinstance(options, dict):
            raise AssertionError("speech worker options must be a mapping")
        self.runs.append((engine.requirement_id, dict(options)))
        _report_permille(kwargs)
        words = (
            WorkerWord(0, 400, " Good"),
            WorkerWord(400, 900, " morning"),
            WorkerWord(1_100, 1_500, " Hello"),
            WorkerWord(1_500, 1_900, " there"),
        )
        return WorkerRunResult(
            segments=(
                WorkerSegment(
                    0,
                    "Good morning Hello there",
                    start_ms=0,
                    end_ms=1_900,
                    words=words,
                ),
            ),
            engine="speech-recognition",
            model="tea-asr-1.1",
            digest=f"sha256:{'2' * 64}",
            device="cuda",
            warnings=(),
            elapsed_ms=1500,
            stage_ms={
                "modelLoad": 200,
                "transcription": 800,
                "alignerLoad": 100,
                "alignment": 300,
            },
        )

    async def diarize(self, engine: InstalledEngine, **kwargs: object) -> WorkerDiarizationResult:
        self.diarizations.append(engine.requirement_id)
        _report_permille(kwargs)
        turns = (
            SpeakerTurn(0, 1_000, "SPEAKER_00"),
            SpeakerTurn(1_000, 2_000, "SPEAKER_01"),
        )
        return WorkerDiarizationResult(
            turns=turns,
            exclusive_turns=turns,
            duration_ms=2_000,
            engine="speaker-diarization",
            model="nvidia-nemotron-3-diarization",
            digest=f"sha256:{'3' * 64}",
            device="cpu",
            warnings=("Diarization GPU fallback: cuda_out_of_memory",),
            elapsed_ms=2400,
            stage_ms={"modelLoad": 300, "inference": 900, "postprocessing": 50},
        )


def _report_permille(kwargs: dict[str, object]) -> None:
    report = kwargs.get("on_permille")
    if callable(report):
        report(500)
        report(1000)


def _patch_streaming_session(
    monkeypatch: pytest.MonkeyPatch, starts: list[tuple[str | None, str]]
) -> None:
    """Finish an allowed streaming capture without starting a real worker process."""

    class _Session:
        def __init__(self) -> None:
            self._closed = False

        @property
        def alive(self) -> bool:
            return not self._closed

        async def begin(self, **_kwargs: object) -> None:
            return None

        async def input(
            self, _window: object, _cancellation: object, _on_event: object
        ) -> list[object]:
            return []

        async def finish(
            self, _cancellation: object, on_event: Callable[..., object]
        ) -> list[object]:
            segment = RawCaptureSegment(
                segment_id="segment-1",
                order=0,
                locator=TimeLocator(start_ms=0, end_ms=1_000),
                text="hello streaming",
            )
            engine = CaptureEngine(
                engine="speech-recognition",
                model="tea-asr-1.1-mini",
                digest=f"sha256:{'a' * 64}",
                device="cpu",
            )
            event = ProgressiveSessionEvent(
                StreamingEventType.SEGMENT,
                "extracting",
                partial_revision=1,
                covered_until_ms=1_000,
                segments=(segment,),
                extraction_engine=engine,
            )
            completed = ProgressiveSessionEvent(StreamingEventType.COMPLETED, "completed")
            await on_event(event)
            await on_event(completed)
            return [event, completed]

        async def close(self) -> None:
            self._closed = True

    async def start(*, engine: InstalledEngine, config: ExtractionRuntimeConfig) -> _Session:
        starts.append((engine.content_id, config.speech_recognition_model))
        return _Session()

    def decode_windows(self: object):
        yield DecodedAudioWindow(0, 1_000, b"\x00\x02")

    monkeypatch.setattr(progressive_capture._SessionWorker, "start", start)
    monkeypatch.setattr(progressive_capture.PyAVFileDecoder, "windows", decode_windows)


def _open_wav(repository: StreamingRepository) -> str:
    digest = hashlib.sha256(_WAV).hexdigest()
    ingestion = repository.create_ingestion(
        OpenIngestionV2(
            client_request_id="speech-model-content",
            kind=CaptureSourceKind.AUDIO,
            file_name="sample.wav",
            media_type="audio/wav",
            total_bytes=len(_WAV),
            source_sha256=digest,
        )
    )
    repository.append_chunk(
        ingestion.ingestion_id,
        chunk_index=0,
        byte_offset=0,
        data=_WAV,
        sha256=digest,
        max_chunk_bytes=4 * 1024 * 1024,
        declared_total_bytes=len(_WAV),
    )
    repository.finalize_ingestion(ingestion.ingestion_id, total_bytes=len(_WAV), sha256=digest)
    return ingestion.ingestion_id


def _assert_speech_options(options: dict[str, object], *, content: str | None, model: str) -> None:
    # The capture config's variant is the opposite of the installed content.
    # The worker must see the recorded content id, and no content key when the
    # engine is legacy.
    if model == "auto":
        assert "model" not in options
    else:
        assert options["model"] == model
    if content is None:
        assert "content" not in options
    else:
        assert options["content"] == content


@pytest.mark.parametrize(
    ("content", "model", "allowed"),
    [
        ("cpu", "tea-asr-1.1", False),
        ("cpu", "auto", True),
        ("cpu", "tea-asr-1.1-mini", True),
        ("cuda", "tea-asr-1.1", True),
        (None, "tea-asr-1.1", True),
    ],
    ids=["cpu-full", "cpu-auto", "cpu-mini", "cuda-full", "legacy-full"],
)
@pytest.mark.parametrize("identify_speakers", [False, True], ids=["streaming", "speakers"])
def test_a_missing_cpu_model_fails_before_the_worker_starts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    content: str | None,
    model: str,
    allowed: bool,
    identify_speakers: bool,
) -> None:
    catalog, sources = _speech_catalog_for(tmp_path, legacy=content is None)
    client = _RecordingWorkerClient()
    manager = _content_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cpu" if content is None else "auto",
        nvidia_driver_present=_reject_driver if content is None else _Driver(content == "cuda"),
        worker_client=client,
    )
    _install(manager, "speech-recognition")
    _install(manager, "speaker-diarization")
    installed = manager.active_engine("speech-recognition")
    assert installed is not None
    assert installed.content_id == content
    probes = len(client.probes)
    starts: list[tuple[str | None, str]] = []
    _patch_streaming_session(monkeypatch, starts)
    # Disagree with the installed content so a variant cannot select the model.
    variant = "cuda" if content == "cpu" else "cpu"
    config = _speech_config(tmp_path, model=model, variant=variant)

    async def scenario() -> None:
        clock = SystemClock()
        repository = StreamingRepository(tmp_path / "streaming", clock=clock, retention_hours=4)
        repository.initialize()
        ingestion_id = _open_wav(repository)
        service = StreamingCaptureService(
            repository,
            clock=clock,
            processor=ProgressiveCaptureProcessor(
                clock=clock,
                config=config,
                engine_manager=manager,
            ),
            extractor=StandaloneRuntimeCaptureExtractor(clock, config, engine_manager=manager),
        )
        operation = service.start_capture_use_case.execute(
            StartCaptureV2(
                client_request_id="speech-model-content",
                ingestion_id=ingestion_id,
                structuring_mode=StructuringMode.HOST,
                identify_speakers=identify_speakers,
            )
        )
        task = service._tasks[operation.capture_id]
        await task
        captured = service.get_capture(operation.capture_id)
        if allowed:
            assert captured.status.value == "awaiting_structuring"
            assert captured.error is None
            if identify_speakers:
                assert starts == []
                assert [item[0] for item in client.runs] == ["speech-recognition"]
                _assert_speech_options(client.runs[0][1], content=content, model=model)
                assert client.diarizations == ["speaker-diarization"]
                text = service.raw(operation.capture_id).source_text
                assert text == "Good morning\nHello there"
            else:
                assert starts == [(content, model)]
                assert client.runs == []
                assert client.diarizations == []
                assert service.raw(operation.capture_id).source_text == "hello streaming"
        else:
            assert captured.status.value == "failed"
            assert captured.error is not None
            assert captured.error.code == "requirement_unavailable"
            assert captured.error.stage == "extraction"
            assert captured.error.retryable is False
            assert captured.error.message == _MISSING_CPU_MODEL
            assert starts == []
            assert client.runs == []
            assert client.diarizations == []
        assert len(client.probes) == probes
        await service.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("content", "model", "detail"),
    [
        ("cpu", "tea-asr-1.1", _MISSING_CPU_MODEL),
        ("cpu", "auto", None),
        ("cpu", "tea-asr-1.1-mini", None),
        ("cuda", "tea-asr-1.1", None),
        (None, "tea-asr-1.1", None),
    ],
    ids=["cpu-full", "cpu-auto", "cpu-mini", "cuda-full", "legacy-full"],
)
def test_a_ready_speech_requirement_names_only_a_missing_cpu_model(
    tmp_path: Path, content: str | None, model: str, detail: str | None
) -> None:
    catalog, sources = _speech_catalog_for(tmp_path, legacy=content is None)
    manager = _content_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="cpu" if content is None else "auto",
        nvidia_driver_present=_reject_driver if content is None else _Driver(content == "cuda"),
        worker_client=FakeWorkerClient(),
    )
    _install(manager, "speech-recognition")
    listed = _listed(
        _model_installer(
            tmp_path,
            manager,
            model=model,
            variant="cuda" if content == "cpu" else "cpu",
        ),
        "speech-recognition",
    )

    assert listed.status.value == "ready"
    assert listed.detail == detail


def test_a_ready_cpu_install_omits_detail_when_no_model_is_configured(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    manager, _cache, _downloader = _cached_manager(
        tmp_path, catalog, sources, nvidia_driver_present=_Driver(False)
    )
    _install(manager, "speech-recognition")
    installer = _requirements_installer(tmp_path, manager, "speech-recognition")

    listed = _listed(installer, "speech-recognition")

    assert listed.status.value == "ready"
    assert listed.detail is None
    assert listed.artifact is None


def test_an_uninstalled_cpu_candidate_keeps_todays_installable_detail(tmp_path: Path) -> None:
    catalog, sources = _speech_contents_catalog(tmp_path)
    manager = _content_manager(
        tmp_path,
        catalog,
        sources,
        speech_variant="auto",
        nvidia_driver_present=_Driver(False),
        worker_client=FakeWorkerClient(),
    )
    listed = _listed(
        _model_installer(tmp_path, manager, model="tea-asr-1.1", variant="cuda"),
        "speech-recognition",
    )

    assert listed.status.value == "installable"
    assert listed.detail == _INSTALLABLE_DETAIL
    assert listed.artifact is None
