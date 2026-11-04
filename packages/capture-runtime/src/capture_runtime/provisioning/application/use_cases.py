"""Business action use cases for engine provisioning."""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from capture_runtime.contracts import RuntimeInstallationV2, RuntimeRequirementV2

if TYPE_CHECKING:
    from capture_runtime.provisioning.application.installation_service import (
        InstallationService,
    )
    from capture_runtime.structuring.infrastructure.ollama import RuntimeInstaller


class CaptureGate(Protocol):
    """The captures an uninstall must not run beside."""

    def has_active_capture(self) -> bool: ...

    def hold_new_captures(self) -> bool:
        """Keep new captures from reaching an engine; False, holding nothing, while one runs."""
        ...

    async def release_warm_workers(self) -> None: ...

    def resume_captures(self) -> None: ...


class InstallRequirement:
    """Create or resume an engine requirement installation job."""

    def __init__(self, service: InstallationService) -> None:
        self._service = service

    def execute(
        self,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        requirement_id: str,
    ) -> RuntimeInstallationV2:
        return self._service.create(
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            requirement_id=requirement_id,
        )


class CancelInstallation:
    """Cancel a pending or running installation job."""

    def __init__(self, service: InstallationService) -> None:
        self._service = service

    async def execute(self, installation_id: str) -> RuntimeInstallationV2:
        return await self._service.cancel(installation_id)


class GetInstallation:
    """Retrieve an installation job by ID."""

    def __init__(self, service: InstallationService) -> None:
        self._service = service

    def execute(self, installation_id: str) -> RuntimeInstallationV2:
        return self._service.get(installation_id)


class ListInstallations:
    """List all recorded runtime installation jobs."""

    def __init__(self, service: InstallationService) -> None:
        self._service = service

    def execute(self) -> list[RuntimeInstallationV2]:
        return self._service.list()


class UninstallRequirement:
    """Safely uninstall an engine requirement when no captures or installations use it."""

    def __init__(self, service: InstallationService) -> None:
        self._service = service

    async def execute(self, requirement_id: str, *, captures: CaptureGate) -> None:
        await self._service.uninstall(requirement_id, captures=captures)


class ListRequirements:
    """List available runtime requirements and their current status."""

    def __init__(self, installer: RuntimeInstaller) -> None:
        self._installer = installer

    def execute(
        self,
        *,
        enabled_requirement_ids: set[str] | None = None,
        disabled_requirement_ids: set[str] | None = None,
    ) -> list[RuntimeRequirementV2]:
        items = self._installer.requirements(enabled_requirement_ids)
        if disabled_requirement_ids:
            items = [item for item in items if item.requirement_id not in disabled_requirement_ids]
        return items


__all__ = [
    "CancelInstallation",
    "GetInstallation",
    "InstallRequirement",
    "ListInstallations",
    "ListRequirements",
    "UninstallRequirement",
]
