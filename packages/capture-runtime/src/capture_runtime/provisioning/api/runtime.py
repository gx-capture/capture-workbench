"""Runtime readiness and installation routes."""

from __future__ import annotations

import asyncio
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, status

from capture_runtime.constants.requirements import RETIRED_STRUCTURING_REQUIREMENT_IDS
from capture_runtime.contracts import (
    RuntimeInstallationsV2,
    RuntimeInstallationV2,
    RuntimeReady,
    RuntimeRequirementsV2,
    RuntimeRequirementV2,
    StartRuntimeInstallationV2,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.provisioning.application.installation_service import RequirementInUseError
from capture_runtime.provisioning.application.use_cases import (
    CancelInstallation,
    GetInstallation,
    InstallRequirement,
    ListInstallations,
    ListRequirements,
    UninstallRequirement,
)
from capture_runtime.provisioning.infrastructure.engine_installation import EngineInstallationError
from capture_runtime.release import CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256
from capture_runtime.routes.common import ApiProblem, request_fingerprint
from capture_runtime.storage.common import IdempotencyConflictError, RecordNotFoundError


def register_runtime_routes(
    router: APIRouter,
    dependencies: RuntimeDependencies,
) -> None:
    """Register readiness, requirement and installation endpoints."""

    install_requirement = InstallRequirement(dependencies.installation_service)
    cancel_installation_uc = CancelInstallation(dependencies.installation_service)
    get_installation_uc = GetInstallation(dependencies.installation_service)
    list_installations_uc = ListInstallations(dependencies.installation_service)
    uninstall_requirement_uc = UninstallRequirement(dependencies.installation_service)
    list_requirements = ListRequirements(dependencies.installer)

    @router.get("/health/ready", response_model=RuntimeReady)
    async def ready() -> RuntimeReady:
        ocr_compute = await dependencies.ocr_preflight.decide_async()
        return RuntimeReady(
            ready=True,
            capture_document_schema_sha256=CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
            capabilities={
                "captureKinds": ["pdf", "image", "recording"],
                "structuringModes": [
                    mode.value for mode in dependencies.supported_structuring_modes
                ],
                "supportsCancellation": True,
                "supportsRawDiagnostics": True,
                "maxUploadBytes": dependencies.settings.max_upload_bytes,
            },
            ocr_compute=ocr_compute,
        )

    @router.get("/runtime/requirements", response_model=RuntimeRequirementsV2)
    async def requirements() -> RuntimeRequirementsV2:
        items = await asyncio.to_thread(
            list_requirements.execute,
            enabled_requirement_ids=dependencies.enabled_requirement_ids,
            disabled_requirement_ids=dependencies.disabled_requirement_ids,
        )
        return RuntimeRequirementsV2(items=items)

    @router.post(
        "/runtime/installations",
        response_model=RuntimeInstallationV2,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_installation(
        payload: StartRuntimeInstallationV2,
        idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    ) -> RuntimeInstallationV2:
        if payload.requirement_id in dependencies.disabled_requirement_ids:
            raise ApiProblem(
                422,
                "requirement_disabled",
                "This runtime process delegates structuring to its host provider.",
            )
        fingerprint = request_fingerprint(payload.model_dump(mode="json", by_alias=True))
        try:
            return install_requirement.execute(
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

    @router.get("/runtime/installations", response_model=RuntimeInstallationsV2)
    async def list_installations() -> RuntimeInstallationsV2:
        return RuntimeInstallationsV2(items=list_installations_uc.execute())

    @router.get("/runtime/installations/{installation_id}", response_model=RuntimeInstallationV2)
    async def get_installation(installation_id: str) -> RuntimeInstallationV2:
        try:
            return get_installation_uc.execute(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Installation job was not found."
            ) from error

    @router.post(
        "/runtime/installations/{installation_id}/cancel",
        response_model=RuntimeInstallationV2,
    )
    async def cancel_installation(installation_id: str) -> RuntimeInstallationV2:
        try:
            return await cancel_installation_uc.execute(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Installation job was not found."
            ) from error

    @router.delete(
        "/runtime/requirements/{requirement_id}/installation",
        response_model=RuntimeRequirementV2,
    )
    async def uninstall_requirement(requirement_id: str) -> RuntimeRequirementV2:
        replacement = RETIRED_STRUCTURING_REQUIREMENT_IDS.get(requirement_id)
        if replacement is not None:
            raise ApiProblem(
                422, "validation_error", f"{requirement_id} is retired; use {replacement}"
            )
        if requirement_id in dependencies.disabled_requirement_ids:
            raise ApiProblem(
                422,
                "requirement_disabled",
                "This runtime process delegates structuring to its host provider.",
            )
        if await _requirement(requirement_id) is None:
            raise ApiProblem(404, "requirement_not_found", "Runtime requirement was not found.")
        if not dependencies.installer.is_uninstallable(requirement_id):
            raise ApiProblem(
                422,
                "requirement_not_uninstallable",
                "Only engines the runtime installs can be uninstalled.",
            )
        try:
            await uninstall_requirement_uc.execute(
                requirement_id, captures=dependencies.streaming_capture_service
            )
        except RequirementInUseError as error:
            raise ApiProblem(
                409,
                "requirement_in_use",
                "An installation or capture is active; try again when it has finished.",
            ) from error
        except EngineInstallationError as error:
            # Another process installs the engine, or a file is still open. The
            # unit is already reported as not installed; a retry removes the rest.
            raise ApiProblem(
                409,
                "requirement_in_use",
                "The engine files are in use; try again later.",
            ) from error
        requirement = await _requirement(requirement_id)
        if requirement is None:
            raise ApiProblem(404, "requirement_not_found", "Runtime requirement was not found.")
        return requirement

    async def _requirement(requirement_id: str) -> RuntimeRequirementV2 | None:
        items = await asyncio.to_thread(
            dependencies.installer.requirements, dependencies.enabled_requirement_ids
        )
        return next((item for item in items if item.requirement_id == requirement_id), None)


__all__ = ["register_runtime_routes"]
