"""Asynchronous orchestration for allowlisted model downloads."""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from contextlib import suppress
from typing import Protocol

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureFailureV2,
    RuntimeInstallationStatus,
    RuntimeModelInstallationV2,
)
from capture_runtime.structuring.application.use_cases import (
    CancelModelInstallation,
    GetModelInstallation,
    InstallModelOption,
)
from capture_runtime.structuring.domain.installation.models import (
    TERMINAL_STATUSES,
    ModelInstallation,
)
from capture_runtime.structuring.infrastructure.model_installation_repository import (
    ModelInstallationRepository,
)
from capture_runtime.structuring.infrastructure.ollama.lifecycle_impl import (
    ManualActionRequiredError,
)


class ModelOptionInstaller(Protocol):
    async def install_model_option(
        self,
        option_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None: ...


TERMINAL_MODEL_INSTALLATION_STATUSES = TERMINAL_STATUSES


def _domain(job: RuntimeModelInstallationV2) -> ModelInstallation:
    return ModelInstallation(
        installation_id=job.installation_id,
        option_id=job.option_id,
        status=job.status,
        progress=job.progress,
        created_at=job.created_at,
        updated_at=job.updated_at,
        completed_at=job.completed_at,
        failure_code=job.error.code if job.error else None,
        failure_message=job.error.message if job.error else None,
        retryable=job.error.retryable if job.error else False,
    )


def _contract(job: ModelInstallation) -> RuntimeModelInstallationV2:
    return RuntimeModelInstallationV2(
        installation_id=job.installation_id,
        option_id=job.option_id,
        status=job.status,
        progress=job.progress,
        created_at=job.created_at,
        updated_at=job.updated_at,
        completed_at=job.completed_at,
        error=CaptureFailureV2(
            code=job.failure_code,
            message=job.failure_message,
            stage="runtime",
            retryable=job.retryable,
        )
        if job.failure_code and job.failure_message
        else None,
    )


class ModelInstallationService:
    def __init__(
        self,
        repository: ModelInstallationRepository,
        *,
        installer: ModelOptionInstaller,
        clock: Clock,
    ) -> None:
        self.repository = repository
        self.installer = installer
        self._clock = clock
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._cancellations: dict[str, asyncio.Event] = {}
        self._install_lock = asyncio.Lock()
        self.install_use_case = InstallModelOption(repository, schedule=self.schedule)
        self.get_use_case = GetModelInstallation(repository)
        self.cancel_use_case = CancelModelInstallation(
            repository, stop=self.stop, cancelled=self._cancelled_job
        )

    def schedule(self, installation_id: str) -> None:
        cancellation = asyncio.Event()
        self._cancellations[installation_id] = cancellation
        task = asyncio.create_task(
            self._process(installation_id, cancellation),
            name=f"model-installation-{installation_id}",
        )
        self._tasks[installation_id] = task
        task.add_done_callback(self._installation_done)

    def get(self, installation_id: str) -> RuntimeModelInstallationV2:
        return self.repository.get(installation_id).job

    def list(self) -> list[RuntimeModelInstallationV2]:
        return self.repository.list()

    async def stop(self, installation_id: str) -> None:
        self._cancellations.setdefault(installation_id, asyncio.Event()).set()
        task = self._tasks.get(installation_id)
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    async def shutdown(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        self._tasks.clear()

    def _installation_done(self, task: asyncio.Task[None]) -> None:
        installation_id = task.get_name().removeprefix("model-installation-")
        self._tasks.pop(installation_id, None)
        self._cancellations.pop(installation_id, None)

    async def _process(self, installation_id: str, cancellation: asyncio.Event) -> None:
        try:
            current = _domain(self.get(installation_id))
            current.mark_running(self._clock.now())
            self.repository.update_job(installation_id, _contract(current))

            def progress(value: float) -> None:
                job = _domain(self.get(installation_id))
                if job.is_terminal:
                    return
                job.update_progress(value, self._clock.now())
                self.repository.update_job(installation_id, _contract(job))

            async with self._install_lock:
                await self.installer.install_model_option(
                    current.option_id,
                    cancel_event=cancellation,
                    report_progress=progress,
                )
            completed = _domain(self.get(installation_id))
            completed.mark_completed(self._clock.now())
            self.repository.update_job(installation_id, _contract(completed))
        except asyncio.CancelledError:
            if cancellation.is_set():
                cancelled = self.get(installation_id)
                if cancelled.status not in TERMINAL_MODEL_INSTALLATION_STATUSES:
                    self.repository.update_job(installation_id, self._cancelled_job(cancelled))
            raise
        except ManualActionRequiredError:
            self._fail(
                installation_id,
                RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
                "manual_action_required",
                "Select a model option after the Ollama runtime is ready.",
                False,
            )
        except Exception:
            self._fail(
                installation_id,
                RuntimeInstallationStatus.FAILED,
                "installation_failed",
                "Runtime model installation failed.",
                True,
            )

    def _fail(
        self,
        installation_id: str,
        status: RuntimeInstallationStatus,
        code: str,
        message: str,
        retryable: bool,
    ) -> None:
        job = _domain(self.get(installation_id))
        job.mark_failed(
            code,
            message,
            retryable=retryable,
            now=self._clock.now(),
            manual_action=status is RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
        )
        self.repository.update_job(installation_id, _contract(job))

    def _cancelled_job(self, job: RuntimeModelInstallationV2) -> RuntimeModelInstallationV2:
        domain = _domain(job)
        domain.mark_cancelled(self._clock.now())
        return _contract(domain)


__all__ = ["ModelInstallationService"]
