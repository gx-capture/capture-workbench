"""Structuring model catalogue and installation routes."""

from __future__ import annotations

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, status

from capture_runtime.contracts import (
    RuntimeModelInstallationV2,
    RuntimeModelOptionStatus,
    RuntimeModelOptionsV2,
    RuntimeModelOptionV2,
    StartRuntimeModelInstallationV2,
)
from capture_runtime.dependencies import RuntimeDependencies
from capture_runtime.routes.common import ApiProblem, request_fingerprint
from capture_runtime.storage.common import IdempotencyConflictError, RecordNotFoundError
from capture_runtime.structuring.infrastructure.model_catalog import (
    MODEL_OPTIONS,
    ActiveModelSelectionStore,
    catalog_sha256,
)


def register_model_routes(
    router: APIRouter,
    dependencies: RuntimeDependencies,
) -> None:
    """Register structuring model catalogue and installation endpoints."""

    install_model = dependencies.model_installation_service.install_use_case
    get_model_job = dependencies.model_installation_service.get_use_case
    cancel_model_job = dependencies.model_installation_service.cancel_use_case

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
            return install_model.execute(
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
            return get_model_job.execute(installation_id)
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
            return await cancel_model_job.execute(installation_id)
        except RecordNotFoundError as error:
            raise ApiProblem(
                404, "installation_not_found", "Model installation job was not found."
            ) from error


__all__ = ["register_model_routes"]
