"""Requirement installation ports and manual-action signal."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection
from typing import Protocol

from capture_runtime.contracts import RuntimeRequirementV2
from capture_runtime.install_progress import DownloadProgress


class ManualActionRequiredError(RuntimeError):
    pass


class RequirementInstaller(Protocol):
    def requirements(
        self,
        enabled_requirement_ids: Collection[str] | None = None,
    ) -> list[RuntimeRequirementV2]: ...

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        report_download: DownloadProgress | None = None,
    ) -> None: ...

    def is_uninstallable(self, requirement_id: str) -> bool:
        """Whether the requirement is an engine install unit this installer can remove."""
        ...

    async def uninstall(self, requirement_id: str) -> None:
        """Remove an installed engine unit; a unit that is not installed is a no-op."""
        ...


class StructuringRequirementInstaller(Protocol):
    def requirements(
        self,
        enabled_requirement_ids: Collection[str] | None = None,
    ) -> list[RuntimeRequirementV2]: ...

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None: ...
