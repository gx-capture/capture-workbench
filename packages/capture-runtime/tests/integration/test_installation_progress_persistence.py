"""Progress stays live while installation metadata writes are bounded."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable, Collection
from pathlib import Path
from typing import Any

import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.contracts import RuntimeRequirement
from capture_runtime.install_progress import DownloadedBytes, DownloadProgress
from capture_runtime.provisioning.application.installation_service import InstallationService
from capture_runtime.provisioning.application.requirement_installer import ManualActionRequiredError
from capture_runtime.provisioning.infrastructure import installation_repository
from capture_runtime.provisioning.infrastructure.installation_repository import (
    InstallationRepository,
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


@pytest.mark.parametrize("outcome", ["completed", "cancelled", "failed", "manual_action_required"])
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
                running = _stored(tmp_path, job_id)
                assert running["status"] == "running"
                report_progress(0.35)
                # Within the first second the stored progress is still the running state's.
                assert _stored(tmp_path, job_id)["progress"] == running["progress"]
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
                # A phase boundary within the same clock tick shares the throttle.
                report_progress(0.85)
                assert len(writes) == baseline + 3
                stored = _stored(tmp_path, job_id)
                assert stored["progress"] < 0.85
                assert stored["downloadedBytes"] == 2999
                report_progress(0.86)
                report_download(DownloadedBytes(3001, 6000))
                assert _stored(tmp_path, job_id)["downloadedBytes"] == 2999
                phase_ready.set()
                await finish.wait()
                if outcome == "manual_action_required":
                    raise ManualActionRequiredError("manual installation required")
                if outcome == "failed":
                    raise OSError("simulated download failure")
                report_download(DownloadedBytes(6000, 6000))
                assert _stored(tmp_path, job_id)["downloadedBytes"] == 2999
                assert len(writes) == baseline + 3

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
            assert _stored(tmp_path, job_id)["progress"] < 0.35  # throttled: not the live value
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
