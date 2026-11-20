"""Progress stays live while installation metadata writes are bounded."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Collection
from pathlib import Path
from typing import Any

import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.contracts import RuntimeInstallationStatus, RuntimeRequirement
from capture_runtime.install_progress import DownloadedBytes, DownloadProgress
from capture_runtime.provisioning.application.installation_service import InstallationService
from capture_runtime.provisioning.infrastructure import installation_repository
from capture_runtime.provisioning.infrastructure.installation_repository import (
    InstallationRepository,
)
from capture_runtime.structuring.application.model_installation_service import (
    ModelInstallationService,
)
from capture_runtime.structuring.infrastructure.model_installation_repository import (
    ModelInstallationRepository,
)


class ProgressClock:
    def __init__(self) -> None:
        self.ticks = 0

    def __call__(self) -> float:
        return self.ticks / 1000


def _stored(root: Path, installation_id: str) -> dict[str, Any]:
    payload: dict[str, Any] = json.loads((root / installation_id / "metadata.json").read_bytes())
    job: dict[str, Any] = payload["job"]
    return job


@pytest.mark.parametrize("outcome", ["completed", "cancelled", "failed"])
def test_chunk_progress_is_live_bounded_and_flushed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, outcome: str
) -> None:
    writes: list[float] = []
    progress_clock = ProgressClock()
    atomic_json = installation_repository.atomic_json

    def record_write(path: Path, payload: dict[str, object]) -> None:
        atomic_json(path, payload)
        writes.append(progress_clock())

    monkeypatch.setattr(installation_repository, "atomic_json", record_write)

    async def scenario() -> None:
        clock = SystemClock()
        repository = InstallationRepository(tmp_path, clock=clock, retention_hours=4)
        repository.initialize()
        first_batch = asyncio.Event()
        next_batch = asyncio.Event()
        phase_ready = asyncio.Event()
        finish = asyncio.Event()

        class Installer:
            def requirements(
                self, enabled_requirement_ids: Collection[str] | None = None
            ) -> list[RuntimeRequirement]:
                return []

            def is_uninstallable(self, requirement_id: str) -> bool:
                return False

            async def uninstall(self, requirement_id: str) -> None:
                raise AssertionError("unexpected uninstall")

            async def install(
                self,
                requirement_id: str,
                *,
                cancel_event: asyncio.Event,
                report_progress: Callable[[float], None],
                report_download: DownloadProgress | None = None,
            ) -> None:
                assert report_download is not None
                report_progress(0.35)
                assert _stored(tmp_path, job_id)["progress"] == 0.35
                baseline = len(writes)
                for chunk in range(1, 3001):
                    progress_clock.ticks = chunk
                    report_progress(0.4 + 0.2 * chunk / 3000)
                    report_download(DownloadedBytes(chunk, 6000))
                    if chunk == 500:
                        first_batch.set()
                        await next_batch.wait()
                # Both callbacks share one budget: exactly three writes in three seconds.
                assert len(writes) - baseline == 3
                assert writes[baseline:] == [1.0, 2.0, 3.0]
                # A phase boundary within the same clock tick bypasses the throttle.
                report_progress(0.85)
                assert len(writes) == baseline + 4
                stored = _stored(tmp_path, job_id)
                assert stored["progress"] == 0.85
                assert stored["downloadedBytes"] == 3000
                report_progress(0.86)
                report_download(DownloadedBytes(3001, 6000))
                assert _stored(tmp_path, job_id)["downloadedBytes"] == 3000
                phase_ready.set()
                await finish.wait()
                if outcome == "failed":
                    raise OSError("simulated download failure")
                report_download(DownloadedBytes(6000, 6000))
                assert _stored(tmp_path, job_id)["downloadedBytes"] == 6000

        service = InstallationService(
            repository, installer=Installer(), clock=clock, progress_clock=progress_clock
        )
        job = service.create(
            idempotency_key="chunks",
            request_fingerprint="chunks",
            requirement_id="text-recognition",
        )
        job_id = job.installation_id
        task = service._tasks[job_id]
        try:
            await asyncio.wait_for(first_batch.wait(), timeout=5)
            polled = service.get(job_id)
            assert polled.downloaded_bytes == 500
            assert polled.progress > 0.4
            assert service.list()[0] == polled
            assert _stored(tmp_path, job_id)["progress"] == 0.35
            next_batch.set()
            await asyncio.wait_for(phase_ready.wait(), timeout=5)
            assert service.get(job_id).downloaded_bytes == 3001
            if outcome == "cancelled":
                await service.cancel(job_id)
            else:
                finish.set()
                await task
            stored = _stored(tmp_path, job_id)
            assert stored["status"] == outcome
            assert stored["completedAt"] is not None
            assert stored["progress"] == (1 if outcome == "completed" else 0.86)
            assert stored["downloadedBytes"] == (6000 if outcome == "completed" else 3001)
            assert len(writes) <= 10
        finally:
            await service.shutdown()

    asyncio.run(scenario())


@pytest.mark.parametrize("outcome", ["completed", "cancelled", "failed"])
def test_structuring_model_milestones_and_terminal_state_are_persisted(
    tmp_path: Path, outcome: str
) -> None:
    async def scenario() -> None:
        clock = SystemClock()
        repository = ModelInstallationRepository(tmp_path, clock=clock, retention_hours=4)
        repository.initialize()
        ready = asyncio.Event()
        finish = asyncio.Event()

        class Installer:
            async def install_model_option(
                self,
                option_id: str,
                *,
                cancel_event: asyncio.Event,
                report_progress: Callable[[float], None],
            ) -> None:
                for milestone in (0.1, 0.75):
                    report_progress(milestone)
                    assert _stored(tmp_path, job_id)["progress"] == milestone
                ready.set()
                await finish.wait()
                if outcome == "failed":
                    raise OSError("simulated pull failure")
                report_progress(1)

        service = ModelInstallationService(repository, installer=Installer(), clock=clock)
        job = service.install_use_case.execute(
            idempotency_key="model", request_fingerprint="model", option_id="qwen3.5-0.8b-v1"
        )
        job_id = job.installation_id
        task = service._tasks[job_id]
        try:
            await asyncio.wait_for(ready.wait(), timeout=5)
            assert service.get_use_case.execute(job_id).progress == 0.75
            if outcome == "cancelled":
                await service.cancel_use_case.execute(job_id)
            else:
                finish.set()
                await task
            stored = _stored(tmp_path, job_id)
            assert stored["status"] == outcome
            assert stored["completedAt"] is not None
            assert stored["progress"] == (1 if outcome == "completed" else 0.75)
            assert service.get(job_id).status is RuntimeInstallationStatus(outcome)
        finally:
            await service.shutdown()

    asyncio.run(scenario())
