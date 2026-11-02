from __future__ import annotations

from capture_runtime.worker_process import WorkerProcess as BaseWorkerProcess


class WorkerProcess(BaseWorkerProcess):
    @property
    def active_process_count(self) -> int:
        return len(self._active)


def active_process_count(owner: BaseWorkerProcess) -> int:
    return len(owner._active)
