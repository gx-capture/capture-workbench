"""Runtime requirement installation job orchestration."""

from __future__ import annotations

import asyncio
from contextlib import suppress

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureFailureV1,
    RuntimeInstallationStatus,
    RuntimeInstallationV1,
)
from capture_runtime.ollama import ManualActionRequiredError, RuntimeInstaller
from capture_runtime.storage import InstallationRepository

TERMINAL_INSTALLATION_STATUSES = {
    RuntimeInstallationStatus.COMPLETED,
    RuntimeInstallationStatus.FAILED,
    RuntimeInstallationStatus.CANCELLED,
    RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
}


class InstallationService:
    def __init__(
        self,
        repository: InstallationRepository,
        *,
        installer: RuntimeInstaller,
        clock: Clock,
    ) -> None:
        self.repository = repository
        self.installer = installer
        self._clock = clock
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancellations: dict[str, asyncio.Event] = {}

    def create(
        self, *, idempotency_key: str, request_fingerprint: str, requirement_id: str
    ) -> RuntimeInstallationV1:
        record, created = self.repository.create_or_get(
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            requirement_id=requirement_id,
        )
        if created:
            cancellation = asyncio.Event()
            self._cancellations[record.job.installation_id] = cancellation
            task = asyncio.create_task(
                self._process(record.job.installation_id, cancellation),
                name=f"installation-{record.job.installation_id}",
            )
            self._tasks[record.job.installation_id] = task
            task.add_done_callback(self._installation_done)
        return record.job

    def get(self, installation_id: str) -> RuntimeInstallationV1:
        return self.repository.get(installation_id).job

    def list(self) -> list[RuntimeInstallationV1]:
        return self.repository.list()

    async def cancel(self, installation_id: str) -> RuntimeInstallationV1:
        job = self.get(installation_id)
        if job.status in TERMINAL_INSTALLATION_STATUSES:
            return job
        cancellation = self._cancellations.setdefault(installation_id, asyncio.Event())
        cancellation.set()
        task = self._tasks.get(installation_id)
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        current = self.get(installation_id)
        if current.status not in TERMINAL_INSTALLATION_STATUSES:
            current = self._cancelled_job(current)
            self.repository.update_job(installation_id, current)
        return current

    async def shutdown(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()

    def _installation_done(self, task: asyncio.Task[None]) -> None:
        installation_id = task.get_name().removeprefix("installation-")
        self._tasks.pop(installation_id, None)
        self._cancellations.pop(installation_id, None)

    async def _process(self, installation_id: str, cancellation: asyncio.Event) -> None:
        try:
            current = self.get(installation_id)
            current = current.model_copy(
                update={
                    "status": RuntimeInstallationStatus.RUNNING,
                    "progress": 0.05,
                    "updated_at": self._clock.now(),
                }
            )
            self.repository.update_job(installation_id, current)

            def progress(value: float) -> None:
                job = self.get(installation_id)
                if job.status in TERMINAL_INSTALLATION_STATUSES:
                    return
                self.repository.update_job(
                    installation_id,
                    job.model_copy(
                        update={
                            "progress": max(0.0, min(1.0, value)),
                            "updated_at": self._clock.now(),
                        }
                    ),
                )

            await self.installer.install(
                current.requirement_id,
                cancel_event=cancellation,
                report_progress=progress,
            )
            now = self._clock.now()
            completed = self.get(installation_id).model_copy(
                update={
                    "status": RuntimeInstallationStatus.COMPLETED,
                    "progress": 1.0,
                    "updated_at": now,
                    "completed_at": now,
                }
            )
            self.repository.update_job(installation_id, completed)
        except asyncio.CancelledError:
            if cancellation.is_set():
                current = self.get(installation_id)
                if current.status not in TERMINAL_INSTALLATION_STATUSES:
                    self.repository.update_job(installation_id, self._cancelled_job(current))
            raise
        except ManualActionRequiredError:
            self._fail(
                installation_id,
                status=RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
                code="manual_action_required",
                message="This runtime requirement requires a manual installation action.",
                retryable=False,
            )
        except Exception:
            self._fail(
                installation_id,
                status=RuntimeInstallationStatus.FAILED,
                code="installation_failed",
                message="Runtime requirement installation failed.",
                retryable=True,
            )

    def _fail(
        self,
        installation_id: str,
        *,
        status: RuntimeInstallationStatus,
        code: str,
        message: str,
        retryable: bool,
    ) -> None:
        now = self._clock.now()
        job = self.get(installation_id).model_copy(
            update={
                "status": status,
                "error": CaptureFailureV1(
                    code=code,
                    message=message,
                    stage="runtime",
                    retryable=retryable,
                ),
                "updated_at": now,
                "completed_at": now,
            }
        )
        self.repository.update_job(installation_id, job)

    def _cancelled_job(self, job: RuntimeInstallationV1) -> RuntimeInstallationV1:
        now = self._clock.now()
        return job.model_copy(
            update={
                "status": RuntimeInstallationStatus.CANCELLED,
                "error": CaptureFailureV1(
                    code="installation_cancelled",
                    message="Runtime installation was cancelled.",
                    stage="runtime",
                    retryable=True,
                ),
                "updated_at": now,
                "completed_at": now,
            }
        )


__all__ = ["InstallationService"]
