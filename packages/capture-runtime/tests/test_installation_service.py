from __future__ import annotations

import asyncio
from collections.abc import Callable
from pathlib import Path

from capture_runtime.clock import SystemClock
from capture_runtime.engine_installation import EngineInstallationError
from capture_runtime.services.installation_service import (
    TERMINAL_INSTALLATION_STATUSES,
    InstallationService,
)
from capture_runtime.storage import InstallationRepository


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
    ) -> None:
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
    ) -> None:
        del cancel_event, report_progress
        raise EngineInstallationError("engine archive checksum does not match catalog")


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
    assert failed.error.code == "installation_failed"
    assert failed.error.message == "engine archive checksum does not match catalog"


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
        requirement_id="whisper-primary",
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
        "start:whisper-primary",
        "end:whisper-primary",
    ]
