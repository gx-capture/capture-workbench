"""Runtime requirement installation job orchestration."""

from __future__ import annotations

import asyncio
from contextlib import suppress

from capture_runtime.clock import Clock
from capture_runtime.contracts import (
    CaptureFailureV2,
    RuntimeInstallationStatus,
    RuntimeInstallationV2,
)
from capture_runtime.engine_installation import EngineInstallationError
from capture_runtime.ollama import ManualActionRequiredError, RuntimeInstaller
from capture_runtime.storage import InstallationRepository
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

            async with self._install_lock:
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
        now = self._clock.now()
        job = self.get(installation_id).model_copy(
            update={
                "status": status,
                "error": CaptureFailureV2(
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

    def _cancelled_job(self, job: RuntimeInstallationV2) -> RuntimeInstallationV2:
        now = self._clock.now()
        return job.model_copy(
            update={
                "status": RuntimeInstallationStatus.CANCELLED,
                "error": CaptureFailureV2(
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
