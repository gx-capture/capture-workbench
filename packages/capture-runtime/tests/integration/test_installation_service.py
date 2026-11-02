from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path

from capture_runtime.clock import SystemClock
from capture_runtime.engine_installation import EngineInstallationError
from capture_runtime.install_progress import DownloadedBytes, DownloadProgress
from capture_runtime.services.installation_service import (
    TERMINAL_INSTALLATION_STATUSES,
    InstallationService,
    installation_failure_code,
)
from capture_runtime.storage import InstallationRepository
from capture_runtime.worker_process import WorkerExecutionError


class RecordingInstaller:
    def __init__(self) -> None:
        self.active = 0
        self.max_active = 0
        self.events: list[str] = []

    def requirements(self, _enabled_requirement_ids=None):
        return []

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        report_download: DownloadProgress | None = None,
    ) -> None:
        del report_download
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        self.events.append(f"start:{requirement_id}")
        try:
            await asyncio.sleep(0.02)
            assert not cancel_event.is_set()
            report_progress(1)
        finally:
            self.events.append(f"end:{requirement_id}")
            self.active -= 1


class FailingInstaller:
    def requirements(self, _enabled_requirement_ids=None):
        return []

    async def install(
        self,
        _requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        report_download: DownloadProgress | None = None,
    ) -> None:
        del cancel_event, report_progress, report_download
        raise EngineInstallationError("engine archive checksum does not match catalog")


class DownloadingInstaller:
    """Downloads 400 of 1000 bytes, waits for the test, then finishes."""

    def __init__(self) -> None:
        self.resume = asyncio.Event()

    def requirements(self, _enabled_requirement_ids=None):
        return []

    async def install(
        self,
        _requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        report_download: DownloadProgress | None = None,
    ) -> None:
        del cancel_event
        assert report_download is not None
        report_progress(0.1)
        report_download(DownloadedBytes(400, 1000))
        await self.resume.wait()
        report_download(DownloadedBytes(1000, 1000))
        report_progress(1)


async def _wait_for_terminal(service: InstallationService, installation_id: str) -> None:
    for _ in range(100):
        if service.get(installation_id).status in TERMINAL_INSTALLATION_STATUSES:
            return
        await asyncio.sleep(0.005)
    raise AssertionError(f"installation did not finish: {installation_id}")


def test_engine_installation_failure_preserves_safe_runtime_message(tmp_path: Path) -> None:
    asyncio.run(_test_engine_installation_failure_preserves_safe_runtime_message(tmp_path))


async def _test_engine_installation_failure_preserves_safe_runtime_message(tmp_path: Path) -> None:
    repository = InstallationRepository(
        tmp_path / "installations", clock=SystemClock(), retention_hours=24
    )
    repository.initialize()
    service = InstallationService(repository, installer=FailingInstaller(), clock=SystemClock())
    job = service.create(
        idempotency_key="failure-key",
        request_fingerprint="failure-fingerprint",
        requirement_id="windowsml-ocr",
    )

    await _wait_for_terminal(service, job.installation_id)
    failed = service.get(job.installation_id)
    await service.shutdown()

    assert failed.status.value == "failed"
    assert failed.error is not None
    assert failed.error.code == "worker_archive_integrity"
    assert failed.error.message == "engine archive checksum does not match catalog"


def test_installation_failure_code_is_finite_and_path_free() -> None:
    assert (
        installation_failure_code(
            EngineInstallationError("direct model download exhausted bounded retries")
        )
        == "direct_model_retries_exhausted"
    )
    assert (
        installation_failure_code(
            EngineInstallationError("direct model file checksum does not match catalog")
        )
        == "direct_model_checksum"
    )
    assert (
        installation_failure_code(
            EngineInstallationError("engine post-install probe failed: private detail")
        )
        == "engine_probe_failed"
    )
    assert installation_failure_code(RuntimeError("C:\\private\\path")) == "installation_unexpected"
    assert (
        installation_failure_code(WorkerExecutionError("private worker detail"))
        == "engine_probe_failed"
    )
    assert (
        installation_failure_code(OSError("private filesystem detail")) == "installation_filesystem"
    )


def test_dependency_installations_are_serialized_in_submission_order(tmp_path: Path) -> None:
    asyncio.run(_test_dependency_installations_are_serialized(tmp_path))


async def _test_dependency_installations_are_serialized(tmp_path: Path) -> None:
    repository = InstallationRepository(
        tmp_path / "installations", clock=SystemClock(), retention_hours=24
    )
    repository.initialize()
    installer = RecordingInstaller()
    service = InstallationService(repository, installer=installer, clock=SystemClock())

    ocr = service.create(
        idempotency_key="ocr-key",
        request_fingerprint="ocr-fingerprint",
        requirement_id="windowsml-ocr",
    )
    whisper = service.create(
        idempotency_key="whisper-key",
        request_fingerprint="whisper-fingerprint",
        requirement_id="speech-recognition",
    )
    await asyncio.gather(
        _wait_for_terminal(service, ocr.installation_id),
        _wait_for_terminal(service, whisper.installation_id),
    )
    await service.shutdown()

    assert installer.max_active == 1
    assert installer.events == [
        "start:windowsml-ocr",
        "end:windowsml-ocr",
        "start:speech-recognition",
        "end:speech-recognition",
    ]


def test_installation_reports_downloaded_bytes_and_keeps_them(tmp_path: Path) -> None:
    asyncio.run(_test_installation_reports_downloaded_bytes(tmp_path))


async def _test_installation_reports_downloaded_bytes(tmp_path: Path) -> None:
    root = tmp_path / "installations"
    repository = InstallationRepository(root, clock=SystemClock(), retention_hours=24)
    repository.initialize()
    installer = DownloadingInstaller()
    service = InstallationService(repository, installer=installer, clock=SystemClock())
    job = service.create(
        idempotency_key="speech-key",
        request_fingerprint="speech-fingerprint",
        requirement_id="speech-recognition",
    )
    for _ in range(100):
        if service.get(job.installation_id).downloaded_bytes is not None:
            break
        await asyncio.sleep(0.005)
    running = service.get(job.installation_id)
    assert running.status.value == "running"
    assert (running.downloaded_bytes, running.download_bytes) == (400, 1000)

    installer.resume.set()
    await _wait_for_terminal(service, job.installation_id)
    await service.shutdown()
    completed = service.get(job.installation_id)
    assert completed.status.value == "completed"
    assert (completed.downloaded_bytes, completed.download_bytes) == (1000, 1000)

    reloaded = InstallationRepository(root, clock=SystemClock(), retention_hours=24)
    reloaded.initialize()
    stored = reloaded.get(job.installation_id).job
    assert (stored.downloaded_bytes, stored.download_bytes) == (1000, 1000)
