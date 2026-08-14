"""Runtime readiness and installation routes."""

from __future__ import annotations

import asyncio
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, status

from capture_runtime.contracts import (
    RuntimeInstallationsV2,
    RuntimeInstallationV2,
    RuntimeModelInstallationV2,
    RuntimeModelOptionStatus,
    RuntimeModelOptionsV2,
    RuntimeModelOptionV2,
    RuntimeReady,
    RuntimeRequirementsV2,
    StartRuntimeInstallationV2,
    StartRuntimeModelInstallationV2,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.model_catalog import MODEL_OPTIONS, ActiveModelSelectionStore, catalog_sha256
from capture_runtime.release import CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256
from capture_runtime.routes.common import ApiProblem, request_fingerprint
from capture_runtime.services import IdempotencyConflictError, RecordNotFoundError


def register_runtime_routes(
    router: APIRouter,
    dependencies: RuntimeDependencies,
) -> None:
    """Register readiness, requirement and installation endpoints."""

    @router.get("/health/ready", response_model=RuntimeReady)
    async def ready() -> RuntimeReady:
        return RuntimeReady(
            ready=True,
            capture_document_schema_sha256=CAPTURE_DOCUMENT_SCHEMA_RELEASE_SHA256,
            capabilities={
                "captureKinds": ["pdf", "image", "audio"],
                "structuringModes": [
                    mode.value for mode in dependencies.supported_structuring_modes
                ],
                "supportsCancellation": True,
                "supportsRawDiagnostics": True,
                "maxUploadBytes": dependencies.settings.max_upload_bytes,
            },
        )

    @router.get("/runtime/requirements", response_model=RuntimeRequirementsV2)
    async def requirements() -> RuntimeRequirementsV2:
        items = await asyncio.to_thread(
            dependencies.installer.requirements,
            dependencies.enabled_requirement_ids,
        )
        return RuntimeRequirementsV2(
            items=[
                item
                for item in items
                if item.requirement_id not in dependencies.disabled_requirement_ids
            ]
        )

    @router.get("/runtime/model-options", response_model=RuntimeModelOptionsV2)
    async def model_options() -> RuntimeModelOptionsV2:
        if dependencies.settings.structuring_provider != "ollama":
            raise ApiProblem(
                422,
                "requirement_disabled",
                "This runtime delegates structuring to its host provider.",
            )
        active = ActiveModelSelectionStore(dependencies.lifecycle.config.app_data_dir).load()
        active_option_id = active.get("optionId") if active is not None else None
        return RuntimeModelOptionsV2(
            catalog_sha256=catalog_sha256(),
            items=[
                RuntimeModelOptionV2(
                    option_id=option.option_id,
                    display_name=option.display_name,
                    model_reference=option.model_reference,
                    expected_digest=option.expected_digest,
                    expected_bytes=option.expected_bytes,
                    profile_id=option.profile_id,
                    profile_spec_sha256=option.profile_spec_sha256,
                    status=(
                        RuntimeModelOptionStatus.ACTIVE
                        if option.option_id == active_option_id
                        else RuntimeModelOptionStatus.NOT_INSTALLED
                    ),
                )
                for option in MODEL_OPTIONS
            ],
        )

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

    @router.get("/runtime/installations", response_model=RuntimeInstallationsV2)
    async def list_installations() -> RuntimeInstallationsV2:
        return RuntimeInstallationsV2(items=dependencies.installation_service.list())

    @router.get("/runtime/installations/{installation_id}", response_model=RuntimeInstallationV2)
    async def get_installation(installation_id: str) -> RuntimeInstallationV2:
        try:
            return dependencies.installation_service.get(installation_id)
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
            return await dependencies.installation_service.cancel(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Installation job was not found."
            ) from error

    @router.post(
        "/runtime/model-installations",
        response_model=RuntimeModelInstallationV2,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_model_installation(
        payload: StartRuntimeModelInstallationV2,
        idempotency_key: Annotated[UUID, Header(alias="X-Idempotency-Key")],
    ) -> RuntimeModelInstallationV2:
        if dependencies.settings.structuring_provider != "ollama":
            raise ApiProblem(
                422,
                "requirement_disabled",
                "This runtime delegates structuring to its host provider.",
            )
        if payload.option_id not in {option.option_id for option in MODEL_OPTIONS}:
            raise ApiProblem(422, "model_option_unknown", "The model option is not allowlisted.")
        fingerprint = request_fingerprint(payload.model_dump(mode="json", by_alias=True))
        try:
            return dependencies.model_installation_service.create(
                idempotency_key=str(idempotency_key),
                request_fingerprint=fingerprint,
                option_id=payload.option_id,
            )
        except IdempotencyConflictError as error:
            raise ApiProblem(
                409,
                "idempotency_conflict",
                "Idempotency key was already used with a different request.",
            ) from error

    @router.get(
        "/runtime/model-installations/{installation_id}",
        response_model=RuntimeModelInstallationV2,
    )
    async def get_model_installation(installation_id: str) -> RuntimeModelInstallationV2:
        try:
            return dependencies.model_installation_service.get(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Model installation job was not found."
            ) from error

    @router.post(
        "/runtime/model-installations/{installation_id}/cancel",
        response_model=RuntimeModelInstallationV2,
    )
    async def cancel_model_installation(installation_id: str) -> RuntimeModelInstallationV2:
        try:
            return await dependencies.model_installation_service.cancel(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Model installation job was not found."
            ) from error


__all__ = ["register_runtime_routes"]
