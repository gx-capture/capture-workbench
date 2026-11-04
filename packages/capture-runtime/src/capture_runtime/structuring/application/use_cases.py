"""Use cases for structuring and model installation."""

from __future__ import annotations

from typing import TYPE_CHECKING

from capture_runtime.contracts import (
    OpenStructuringSessionV2,
    RuntimeModelInstallationV2,
    StructuringSessionV2,
    SubmitStructuringBatchV2,
)

if TYPE_CHECKING:
    from capture_runtime.structuring.application.model_installation_service import (
        ModelInstallationService,
    )
    from capture_runtime.structuring.application.structuring_session_service import (
        StructuringSessionService,
    )


class OpenStructuringSession:
    """Open a durable pull-based structuring session for host-mode capture."""

    def __init__(self, service: StructuringSessionService) -> None:
        self._service = service

    def execute(self, request: OpenStructuringSessionV2) -> StructuringSessionV2:
        return self._service.open(request)


class SubmitStructuringBatch:
    """Submit a batch of semantic blocks to an open structuring session."""

    def __init__(self, service: StructuringSessionService) -> None:
        self._service = service

    def execute(
        self,
        session_id: str,
        batch_index: int,
        payload: SubmitStructuringBatchV2,
        *,
        idempotency_key: str,
    ) -> StructuringSessionV2:
        return self._service.submit(
            session_id,
            batch_index,
            payload,
            idempotency_key=idempotency_key,
        )


class GetStructuringSession:
    """Retrieve an existing structuring session."""

    def __init__(self, service: StructuringSessionService) -> None:
        self._service = service

    def execute(self, session_id: str) -> StructuringSessionV2:
        return self._service.get(session_id)


class InstallModelOption:
    """Start asynchronous installation for an allowlisted model option."""

    def __init__(self, service: ModelInstallationService) -> None:
        self._service = service

    def execute(
        self,
        *,
        idempotency_key: str,
        request_fingerprint: str,
        option_id: str,
    ) -> RuntimeModelInstallationV2:
        return self._service.create(
            idempotency_key=idempotency_key,
            request_fingerprint=request_fingerprint,
            option_id=option_id,
        )


class CancelModelInstallation:
    """Cancel an ongoing model installation job."""

    def __init__(self, service: ModelInstallationService) -> None:
        self._service = service

    async def execute(self, installation_id: str) -> RuntimeModelInstallationV2:
        return await self._service.cancel(installation_id)


class GetModelInstallation:
    """Retrieve the status and progress of a model option installation."""

    def __init__(self, service: ModelInstallationService) -> None:
        self._service = service

    def execute(self, installation_id: str) -> RuntimeModelInstallationV2:
        return self._service.get(installation_id)


__all__ = [
    "CancelModelInstallation",
    "GetModelInstallation",
    "GetStructuringSession",
    "InstallModelOption",
    "OpenStructuringSession",
    "SubmitStructuringBatch",
]
