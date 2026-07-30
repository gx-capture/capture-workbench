from __future__ import annotations

import asyncio
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile
from dataclasses import dataclass
from pathlib import Path

import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.engine_catalog import EngineCatalog, EngineCatalogError
from capture_runtime.engine_installation import (
    ArtifactDownloader,
    EngineInstallationError,
    EngineInstallationManager,
    EngineInstallBusyError,
    ModelFileDownloader,
)
from capture_runtime.ollama import SystemRuntimeInstaller
from capture_runtime.worker_client import InstalledEngine, WorkerProbeResult


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
                "runtimeVersion": "0.3.4",
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
    version_residue = requirement_root / "versions" / f".crashed-0.3.4.{'b' * 32}"
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
    source_root = Path(__file__).parents[1] / "src"
    environment = dict(os.environ)
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(source_root), environment.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    script = (
        "import sys\n"
        "from pathlib import Path\n"
        "from capture_runtime.engine_installation import _ExclusiveInstallFile\n"
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
            "runtimeVersion": "0.3.4",
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
        enabled_requirement_ids={"windowsml-ocr", "whisper-primary"},
    )

    requirements = {item.requirement_id: item for item in installer.requirements()}
    for requirement_id in ("windowsml-ocr", "whisper-primary"):
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
        windowsml_device_id=7,
        max_pdf_pages=10,
        max_image_pixels=100_000,
        ocr_render_scale=2,
        max_audio_duration_ms=60_000,
        whisper_primary_model="large-v3-turbo",
        whisper_fallback_model="small",
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
        (False, {"deviceId": 7}),
        (True, {"deviceId": 7}),
    ]
