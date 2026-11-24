from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from pathlib import Path

import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.contracts import RuntimeInstallationStatus
from capture_runtime.install_progress import DownloadedBytes, DownloadProgress
from capture_runtime.provisioning.application.installation_service import (
    TERMINAL_INSTALLATION_STATUSES,
    InstallationService,
    RequirementInUseError,
    installation_failure_code,
)
from capture_runtime.provisioning.infrastructure.engine_installation import EngineInstallationError
from capture_runtime.provisioning.infrastructure.installation_repository import (
    InstallationRepository,
)
from capture_runtime.routes.common import request_fingerprint
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


@pytest.mark.parametrize("status", ["completed", "running"])
@pytest.mark.parametrize(
    ("retired_id", "current_id"),
    [
        ("windowsml-ocr", "text-recognition"),
        ("ollama-runtime", "structuring-runtime"),
        ("capture-ollama-model", "structuring-model"),
    ],
)
def test_installation_repository_reads_historical_requirement_id(
    tmp_path: Path, status: str, retired_id: str, current_id: str
) -> None:
    repository = InstallationRepository(tmp_path, clock=SystemClock(), retention_hours=24)
    repository.initialize()
    record, _ = repository.create_or_get(
        idempotency_key="historical-install",
        request_fingerprint=request_fingerprint({"requirementId": current_id, "consent": True}),
        requirement_id=current_id,
    )
    installation_id = record.job.installation_id
    path = tmp_path / installation_id / "metadata.json"
    historical = json.loads(path.read_bytes())
    historical["job"]["requirementId"] = retired_id
    historical["requestFingerprint"] = request_fingerprint(
        {"requirementId": retired_id, "consent": True}
    )
    historical["job"]["status"] = status
    path.write_text(json.dumps(historical, indent=2), encoding="utf-8")
    before = path.read_bytes()

    repository.initialize()
    job = repository.get(installation_id).job
    assert repository.list() == [job]
    assert job.requirement_id == current_id
    replay, created = repository.create_or_get(
        idempotency_key="historical-install",
        request_fingerprint=request_fingerprint({"requirementId": current_id, "consent": True}),
        requirement_id=current_id,
    )
    assert not created and replay.job == job
    if status == "completed":
        assert job.status is RuntimeInstallationStatus.COMPLETED
        assert path.read_bytes() == before
    else:
        assert job.status is RuntimeInstallationStatus.FAILED
        assert job.error is not None and job.error.code == "runtime_restarted"
        after = json.loads(path.read_bytes())
        assert after["job"]["requirementId"] == retired_id
        assert after["requestFingerprint"] == historical["requestFingerprint"]


def test_a_0_10_filesystem_failure_reads_as_a_generic_installation_failure(
    tmp_path: Path,
) -> None:
    repository = InstallationRepository(tmp_path, clock=SystemClock(), retention_hours=24)
    repository.initialize()
    record, _ = repository.create_or_get(
        idempotency_key="historical-filesystem",
        request_fingerprint=request_fingerprint(
            {"requirementId": "text-recognition", "consent": True}
        ),
        requirement_id="text-recognition",
    )
    path = tmp_path / record.job.installation_id / "metadata.json"
    historical = json.loads(path.read_bytes())
    historical["job"].update(
        status="failed",
        completedAt=historical["job"]["createdAt"],
        error={
            "code": "installation_filesystem",
            "message": "Runtime requirement installation failed (OSError:5).",
            "stage": None,
            "retryable": True,
        },
    )
    path.write_text(json.dumps(historical, indent=2), encoding="utf-8")
    before = path.read_bytes()

    repository.initialize()
    job = repository.get(record.job.installation_id).job
    # Whether it timed out is not recorded, so it reads as the generic failure.
    assert job.error is not None
    assert (job.error.code, job.error.retryable) == ("installation_failed", True)
    assert job.error.message == "Runtime requirement installation failed (OSError:5)."
    assert path.read_bytes() == before


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
        requirement_id="text-recognition",
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
        installation_failure_code(OSError("private filesystem detail")) == "installation_io_failed"
    )
    # TimeoutError is an OSError; it is told apart before the I/O class.
    assert installation_failure_code(TimeoutError("private detail")) == "installation_timeout"


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
        requirement_id="text-recognition",
    )
    speech = service.create(
        idempotency_key="speech-key",
        request_fingerprint="speech-fingerprint",
        requirement_id="speech-recognition",
    )
    await asyncio.gather(
        _wait_for_terminal(service, ocr.installation_id),
        _wait_for_terminal(service, speech.installation_id),
    )
    await service.shutdown()

    assert installer.max_active == 1
    assert installer.events == [
        "start:text-recognition",
        "end:text-recognition",
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


class UninstallingInstaller:
    def __init__(self, events: list[str]) -> None:
        self.events = events

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
        del cancel_event, report_download
        self.events.append(f"install:{requirement_id}")
        report_progress(1)

    def is_uninstallable(self, _requirement_id: str) -> bool:
        return True

    async def uninstall(self, requirement_id: str) -> None:
        self.events.append(f"uninstall:{requirement_id}")


class RecordingCaptureGate:
    def __init__(self, events: list[str], *, active: bool = False, holdable: bool = True) -> None:
        self.events = events
        self.active = active
        self.holdable = holdable

    def has_active_capture(self) -> bool:
        return self.active

    def hold_new_captures(self) -> bool:
        self.events.append("hold" if self.holdable else "hold-refused")
        return self.holdable

    async def release_warm_workers(self) -> None:
        self.events.append("release")

    def resume_captures(self) -> None:
        self.events.append("resume")


def _uninstall_service(tmp_path: Path, events: list[str]) -> InstallationService:
    repository = InstallationRepository(
        tmp_path / "installations", clock=SystemClock(), retention_hours=24
    )
    repository.initialize()
    return InstallationService(
        repository, installer=UninstallingInstaller(events), clock=SystemClock()
    )


def test_uninstall_holds_new_captures_around_the_removal(tmp_path: Path) -> None:
    events: list[str] = []
    service = _uninstall_service(tmp_path, events)

    asyncio.run(service.uninstall("text-recognition", captures=RecordingCaptureGate(events)))

    assert events == ["hold", "release", "uninstall:text-recognition", "resume"]


def test_uninstall_refuses_while_a_capture_is_active_or_starts_meanwhile(tmp_path: Path) -> None:
    events: list[str] = []
    service = _uninstall_service(tmp_path, events)

    with pytest.raises(RequirementInUseError):
        asyncio.run(
            service.uninstall(
                "text-recognition", captures=RecordingCaptureGate(events, active=True)
            )
        )
    with pytest.raises(RequirementInUseError):
        asyncio.run(
            service.uninstall(
                "text-recognition", captures=RecordingCaptureGate(events, holdable=False)
            )
        )

    assert events == ["hold-refused"]


def test_uninstall_waits_for_another_installation_and_then_runs_alone(tmp_path: Path) -> None:
    asyncio.run(_test_uninstall_waits_for_another_installation(tmp_path))


async def _test_uninstall_waits_for_another_installation(tmp_path: Path) -> None:
    events: list[str] = []

    class SlowInstaller(DownloadingInstaller):
        async def uninstall(self, requirement_id: str) -> None:
            events.append(f"uninstall:{requirement_id}")

    installer = SlowInstaller()
    repository = InstallationRepository(
        tmp_path / "installations", clock=SystemClock(), retention_hours=24
    )
    repository.initialize()
    service = InstallationService(
        repository,
        installer=installer,
        clock=SystemClock(),
    )
    job = service.create(
        idempotency_key="other-install",
        request_fingerprint="other-install",
        requirement_id="speech-recognition",
    )
    await asyncio.sleep(0.01)
    with pytest.raises(RequirementInUseError):
        await service.uninstall("speech-recognition", captures=RecordingCaptureGate(events))

    uninstall = asyncio.create_task(
        service.uninstall("text-recognition", captures=RecordingCaptureGate(events))
    )
    await asyncio.sleep(0.01)
    assert not uninstall.done()
    installer.resume.set()
    await uninstall
    await _wait_for_terminal(service, job.installation_id)
    await service.shutdown()

    assert service.get(job.installation_id).status.value == "completed"
    assert events == ["hold", "release", "uninstall:text-recognition", "resume"]
