"""Runtime requirement installation job orchestration."""

from __future__ import annotations

import asyncio
from contextlib import suppress
from typing import Protocol

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureFailureV2,
    RuntimeInstallationStatus,
    RuntimeInstallationV2,
)
from capture_runtime.install_progress import DownloadedBytes
from capture_runtime.provisioning.domain.installation import (
    InstallationJob,
    InstallationStatus,
)
from capture_runtime.provisioning.infrastructure.engine_installation import EngineInstallationError
from capture_runtime.provisioning.infrastructure.installation_repository import (
    InstallationRepository,
)
from capture_runtime.structuring.infrastructure.ollama import (
    ManualActionRequiredError,
    RuntimeInstaller,
)
from capture_runtime.worker_process import WorkerExecutionError

TERMINAL_INSTALLATION_STATUSES = {
    RuntimeInstallationStatus.COMPLETED,
    RuntimeInstallationStatus.FAILED,
    RuntimeInstallationStatus.CANCELLED,
    RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED,
}


def installation_failure_code(error: BaseException) -> str:
    """Classify installation failures without crossing the public error boundary.

    Installer exception messages are deliberately safe, but an unexpected
    exception used to be collapsed into the same generic code as a checksum,
    transport, or probe failure. Keep the classifier finite and message-free so
    paths, URLs, and backend diagnostics cannot leak through the API.
    """

    if isinstance(error, WorkerExecutionError):
        return "engine_probe_failed"
    if isinstance(error, (TimeoutError, OSError)):
        return "installation_filesystem"
    if not isinstance(error, EngineInstallationError):
        return "installation_unexpected"
    message = str(error).casefold()
    if "direct model download exhausted bounded retries" in message:
        return "direct_model_retries_exhausted"
    if "direct model" in message and "checksum" in message:
        return "direct_model_checksum"
    if ("engine artifact" in message or "engine archive" in message) and (
        "checksum" in message or "byte count" in message or "content-length" in message
    ):
        return "worker_archive_integrity"
    if "probe" in message and "failed" in message:
        return "engine_probe_failed"
    return "installation_failed"


def _to_domain(job: RuntimeInstallationV2) -> InstallationJob:
    return InstallationJob(
        installation_id=job.installation_id,
        requirement_id=job.requirement_id,
        status=InstallationStatus(job.status.value),
        progress=job.progress,
        download_bytes=job.download_bytes,
        downloaded_bytes=job.downloaded_bytes,
        failure_code=job.error.code if job.error else None,
        failure_message=job.error.message if job.error else None,
        retryable=job.error.retryable if job.error else False,
        created_at=job.created_at,
        updated_at=job.updated_at,
        completed_at=job.completed_at,
    )


def _to_contract(job: InstallationJob) -> RuntimeInstallationV2:
    error = None
    if job.failure_code and job.failure_message:
        error = CaptureFailureV2(
            code=job.failure_code,
            message=job.failure_message,
            stage="runtime",
            retryable=job.retryable,
        )
    return RuntimeInstallationV2(
        installation_id=job.installation_id,
        requirement_id=job.requirement_id,
        status=RuntimeInstallationStatus(job.status.value),
        progress=job.progress,
        download_bytes=job.download_bytes,
        downloaded_bytes=job.downloaded_bytes,
        error=error,
        created_at=job.created_at,
        updated_at=job.updated_at,
        completed_at=job.completed_at,
    )


class RequirementInUseError(RuntimeError):
    """An installation of the requirement or a capture has not finished."""


class CaptureGate(Protocol):
    """The captures an uninstall must not run beside."""

    def has_active_capture(self) -> bool: ...

    def hold_new_captures(self) -> bool:
        """Keep new captures from reaching an engine; False, holding nothing, while one runs."""
        ...

    async def release_warm_workers(self) -> None: ...

    def resume_captures(self) -> None: ...


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
        # Runtime-owned dependencies are intentionally installed one at a time to
        # keep memory and IO bounded. The consenting host owns dependency order;
        # this service serializes accepted jobs but does not reorder independent
        # client requests or imply consent for a prerequisite the client omitted.
        self._install_lock = asyncio.Lock()

    def create(
        self, *, idempotency_key: str, request_fingerprint: str, requirement_id: str
    ) -> RuntimeInstallationV2:
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

    def get(self, installation_id: str) -> RuntimeInstallationV2:
        return self.repository.get(installation_id).job

    def list(self) -> list[RuntimeInstallationV2]:
        return self.repository.list()

    async def uninstall(self, requirement_id: str, *, captures: CaptureGate) -> None:
        """Remove an installed engine unit while no installation or capture can use it.

        Raises RequirementInUseError while an installation of the requirement or
        any capture has not finished: which engine a capture uses is not
        tracked. Uninstalling holds the install lock, so it never runs beside an
        installation, and the last check and holding new captures happen without
        yielding to the event loop, so nothing can start in between.
        """

        if self._has_active_installation(requirement_id) or captures.has_active_capture():
            raise RequirementInUseError(requirement_id)
        async with self._install_lock:
            # Checked again: a job or capture may have started while this waited.
            if self._has_active_installation(requirement_id) or not captures.hold_new_captures():
                raise RequirementInUseError(requirement_id)
            try:
                await captures.release_warm_workers()
                await self.installer.uninstall(requirement_id)
            finally:
                captures.resume_captures()

    def _has_active_installation(self, requirement_id: str) -> bool:
        return any(
            job.requirement_id == requirement_id
            and job.status not in TERMINAL_INSTALLATION_STATUSES
            for job in self.repository.list()
        )

    async def cancel(self, installation_id: str) -> RuntimeInstallationV2:
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
            domain_job = _to_domain(self.get(installation_id))
            domain_job.mark_running(self._clock.now())
            self.repository.update_job(installation_id, _to_contract(domain_job))

            def progress(value: float) -> None:
                job = _to_domain(self.get(installation_id))
                if job.is_terminal:
                    return
                job.update_progress(value, self._clock.now())
                self.repository.update_job(installation_id, _to_contract(job))

            def downloaded(value: DownloadedBytes) -> None:
                job = _to_domain(self.get(installation_id))
                if job.is_terminal:
                    return
                job.update_download(downloaded=value.done, total=value.total, now=self._clock.now())
                self.repository.update_job(installation_id, _to_contract(job))

            async with self._install_lock:
                await self.installer.install(
                    domain_job.requirement_id,
                    cancel_event=cancellation,
                    report_progress=progress,
                    report_download=downloaded,
                )
            completed_job = _to_domain(self.get(installation_id))
            completed_job.mark_completed(self._clock.now())
            self.repository.update_job(installation_id, _to_contract(completed_job))
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
        except EngineInstallationError as error:
            self._fail(
                installation_id,
                status=RuntimeInstallationStatus.FAILED,
                code=installation_failure_code(error),
                message=str(error)[:500],
                retryable=True,
            )
        except OSError as error:
            system_code = getattr(error, "winerror", None)
            if not isinstance(system_code, int):
                system_code = getattr(error, "errno", None)
            operation = getattr(error, "activation_operation", None)
            operation_detail = f":{operation}" if isinstance(operation, str) else ""
            detail = (
                f" ({type(error).__name__}:{system_code}{operation_detail})"
                if isinstance(system_code, int)
                else ""
            )
            self._fail(
                installation_id,
                status=RuntimeInstallationStatus.FAILED,
                code="installation_filesystem",
                message=f"Runtime requirement installation failed{detail}.",
                retryable=True,
            )
        except Exception as error:
            self._fail(
                installation_id,
                status=RuntimeInstallationStatus.FAILED,
                code=installation_failure_code(error),
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
        domain_job = _to_domain(self.get(installation_id))
        domain_job.mark_failed(
            code,
            message,
            retryable=retryable,
            now=self._clock.now(),
            manual_action=(status == RuntimeInstallationStatus.MANUAL_ACTION_REQUIRED),
        )
        self.repository.update_job(installation_id, _to_contract(domain_job))

    def _cancelled_job(self, job: RuntimeInstallationV2) -> RuntimeInstallationV2:
        domain_job = _to_domain(job)
        domain_job.mark_cancelled(self._clock.now())
        return _to_contract(domain_job)


__all__ = ["CaptureGate", "InstallationService", "RequirementInUseError"]
