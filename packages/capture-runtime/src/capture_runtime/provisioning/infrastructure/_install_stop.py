"""The stop signal that an install's file work polls."""

from __future__ import annotations

import asyncio
from typing import Literal


class InstallStop(asyncio.Event):
    """Set by the user's cancel, or by the cancellation of the task doing the work.

    The job's cancel event means only that the user cancelled: a runtime
    shutdown cancels the task without it, and the job stays recoverable as
    interrupted. Work in a worker thread cannot see a task cancellation, so
    the cancelled task sets this event instead and the work polls it.
    """

    def __init__(self, cancel_event: asyncio.Event) -> None:
        super().__init__()
        self._cancel_event = cancel_event

    def is_set(self) -> bool:
        return super().is_set() or self._cancel_event.is_set()

    async def wait(self) -> Literal[True]:
        # The user's event does not wake this event's waiters, so poll both.
        while not self.is_set():
            await asyncio.sleep(0.05)
        return True


__all__ = ["InstallStop"]
