"""Runtime readiness and installation routes."""

from __future__ import annotations

import asyncio
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, status

from capture_runtime.contracts import (
    RuntimeCapabilitiesV1,
    RuntimeInstallationsV1,
    RuntimeInstallationV1,
    RuntimeReadyV1,
    RuntimeRequirementsV1,
    StartRuntimeInstallationV1,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.routes.common import ApiProblem, request_fingerprint
from capture_runtime.services import IdempotencyConflictError, RecordNotFoundError


def register_runtime_routes(router: APIRouter, dependencies: RuntimeDependencies) -> None:
    """Register readiness, requirement and installation endpoints."""

    @router.get("/health/ready", response_model=RuntimeReadyV1)
    async def ready() -> RuntimeReadyV1:
        return RuntimeReadyV1(
            ready=True,
            capabilities=RuntimeCapabilitiesV1(
                capture_kinds=["pdf", "image", "audio"],
                structuring_modes=dependencies.supported_structuring_modes,
                max_upload_bytes=dependencies.settings.max_upload_bytes,
            ),
        )

    @router.get("/runtime/requirements", response_model=RuntimeRequirementsV1)
    async def requirements() -> RuntimeRequirementsV1:
        items = await asyncio.to_thread(
            dependencies.installer.requirements,
            dependencies.enabled_requirement_ids,
        )
        return RuntimeRequirementsV1(
            items=[
                item
                for item in items
                if item.requirement_id not in dependencies.disabled_requirement_ids
            ]
        )

    @router.post(
        "/runtime/installations",
        response_model=RuntimeInstallationV1,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_installation(
        payload: StartRuntimeInstallationV1,
        idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    ) -> RuntimeInstallationV1:
        if payload.requirement_id in dependencies.disabled_requirement_ids:
            raise ApiProblem(
                422,
                "requirement_disabled",
                "This runtime process delegates structuring to its host provider.",
            )
        fingerprint = request_fingerprint(payload.model_dump(mode="json", by_alias=True))
        try:
            return dependencies.installation_service.create(
                idempotency_key=str(idempotency_key),
                request_fingerprint=fingerprint,
                requirement_id=payload.requirement_id,
            )
        except IdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Idempotency key was already used with a different request.",
            ) from error

    @router.get("/runtime/installations", response_model=RuntimeInstallationsV1)
    async def list_installations() -> RuntimeInstallationsV1:
        return RuntimeInstallationsV1(items=dependencies.installation_service.list())

    @router.get("/runtime/installations/{installation_id}", response_model=RuntimeInstallationV1)
    async def get_installation(installation_id: str) -> RuntimeInstallationV1:
        try:
            return dependencies.installation_service.get(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Installation job was not found."
            ) from error

    @router.post(
        "/runtime/installations/{installation_id}/cancel",
        response_model=RuntimeInstallationV1,
    )
    async def cancel_installation(installation_id: str) -> RuntimeInstallationV1:
        try:
            return await dependencies.installation_service.cancel(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Installation job was not found."
            ) from error


__all__ = ["register_runtime_routes"]
