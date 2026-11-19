"""System-backed installation of engine and structuring requirements."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection

from capture_runtime.config import ExtractionRuntimeConfig
from capture_runtime.constants import (
    DIARIZATION_REQUIREMENT_ID,
    MAX_RUNTIME_ARTIFACT_BYTES,
    SPEECH_RECOGNITION_REQUIREMENT_ID,
    STRUCTURING_MODEL_REQUIREMENT_ID,
    STRUCTURING_RUNTIME_REQUIREMENT_ID,
    TEXT_RECOGNITION_REQUIREMENT_ID,
    VERTICAL_READER_REQUIREMENT_ID,
)
from capture_runtime.constants.requirements import RETIRED_STRUCTURING_REQUIREMENT_IDS
from capture_runtime.contracts import (
    RuntimeArtifactDescriptorV2,
    RuntimeRequirementStatus,
    RuntimeRequirementV2,
)
from capture_runtime.install_progress import DownloadProgress
from capture_runtime.provisioning.application.requirement_installer import (
    StructuringRequirementInstaller,
)
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    EngineArtifactDescriptor,
    EngineCatalogError,
    EngineContentDescriptor,
    EngineRequirementDescriptor,
)
from capture_runtime.provisioning.infrastructure.engine_content_selection import (
    speech_model_not_installed_message,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineInstallationManager,
)


def _artifact_descriptor(worker: EngineArtifactDescriptor) -> RuntimeArtifactDescriptorV2 | None:
    """Describe a worker in the public contract, which names one download of at most 512 MiB.

    A larger worker, such as the speech recognition worker published as parts, installs the
    same way from the engine catalog; its requirement then carries no artifact, like a
    models-only unit.
    """
    if worker.url is None or worker.bytes > MAX_RUNTIME_ARTIFACT_BYTES:
        return None
    return RuntimeArtifactDescriptorV2(
        artifact_url=worker.url,
        artifact_file_name=worker.file_name,
        bytes=worker.bytes,
        sha256=worker.sha256,
    )


_ENGINE_UNIT_IDS = frozenset(
    {
        TEXT_RECOGNITION_REQUIREMENT_ID,
        SPEECH_RECOGNITION_REQUIREMENT_ID,
        DIARIZATION_REQUIREMENT_ID,
        VERTICAL_READER_REQUIREMENT_ID,
    }
)


def _validate_enabled_requirements(requirement_ids: Collection[str] | None) -> None:
    if requirement_ids is not None and "windowsml-ocr" in requirement_ids:
        raise ValueError("windowsml-ocr is retired; use text-recognition")
    for requirement_id in requirement_ids or ():
        replacement = RETIRED_STRUCTURING_REQUIREMENT_IDS.get(requirement_id)
        if replacement is not None:
            raise ValueError(f"{requirement_id} is retired; use {replacement}")


class SystemRequirementInstaller:
    """Probe/install product requirements without dynamic package installation."""

    def __init__(
        self,
        structuring: StructuringRequirementInstaller,
        *,
        engine_manager: EngineInstallationManager | None = None,
        enabled_requirement_ids: Collection[str] | None = None,
        extraction_config: ExtractionRuntimeConfig | None = None,
    ) -> None:
        _validate_enabled_requirements(enabled_requirement_ids)
        self._structuring = structuring
        self._engine_manager = engine_manager
        self._extraction_config = extraction_config
        self._enabled_requirement_ids = (
            None if enabled_requirement_ids is None else frozenset(enabled_requirement_ids)
        )

    def requirements(
        self,
        enabled_requirement_ids: Collection[str] | None = None,
    ) -> list[RuntimeRequirementV2]:
        _validate_enabled_requirements(enabled_requirement_ids)
        effective_requirement_ids = (
            self._enabled_requirement_ids
            if enabled_requirement_ids is None
            else frozenset(enabled_requirement_ids)
            if self._enabled_requirement_ids is None
            else self._enabled_requirement_ids.intersection(enabled_requirement_ids)
        )

        def is_enabled(requirement_id: str) -> bool:
            return effective_requirement_ids is None or requirement_id in effective_requirement_ids

        requirements: list[RuntimeRequirementV2] = []
        for requirement_id, display_name, required_for, optional in (
            (TEXT_RECOGNITION_REQUIREMENT_ID, "Text recognition", ["pdf", "image"], False),
            (
                SPEECH_RECOGNITION_REQUIREMENT_ID,
                "Speech recognition",
                ["recording"],
                True,
            ),
            (
                DIARIZATION_REQUIREMENT_ID,
                "Speaker identification",
                ["recording"],
                True,
            ),
            (
                VERTICAL_READER_REQUIREMENT_ID,
                "Vertical Japanese reader",
                ["pdf", "image"],
                True,
            ),
        ):
            if not is_enabled(requirement_id):
                continue
            try:
                if self._engine_manager is None:
                    raise EngineCatalogError("engine manager is unavailable")
                descriptor = self._engine_manager.requirement(requirement_id)
                if descriptor.contents:
                    status, artifact, download_bytes, detail = self._listed_content_requirement(
                        self._engine_manager, requirement_id, descriptor
                    )
                else:
                    active = self._engine_manager.is_installed(requirement_id) or None
                    worker = (
                        descriptor.worker_artifact()
                        if descriptor.complete and not descriptor.model_only
                        else None
                    )
                    artifact = _artifact_descriptor(worker) if worker is not None else None
                    download_bytes = descriptor.download_bytes
                    status = (
                        RuntimeRequirementStatus.READY
                        if active is not None
                        else RuntimeRequirementStatus.INSTALLABLE
                        if descriptor.complete
                        else RuntimeRequirementStatus.UNAVAILABLE
                    )
                    detail = (
                        None
                        if active is not None
                        else descriptor.unavailable_reason
                        if not descriptor.complete
                        else "Pinned worker and direct model files are available for installation."
                    )
            except EngineCatalogError:
                status = RuntimeRequirementStatus.UNAVAILABLE
                artifact = None
                download_bytes = None
                detail = "No downloadable model is published for this runtime release."
            requirements.append(
                RuntimeRequirementV2(
                    requirement_id=requirement_id,
                    kind=requirement_id,
                    display_name=display_name,
                    status=status,
                    required_for=required_for,
                    install_strategy="runtime-catalog",
                    optional=optional,
                    detail=detail,
                    artifact=artifact,
                    download_bytes=download_bytes,
                )
            )

        requirements.extend(self._structuring.requirements(effective_requirement_ids))
        return requirements

    def _listed_content_requirement(
        self,
        manager: EngineInstallationManager,
        requirement_id: str,
        descriptor: EngineRequirementDescriptor,
    ) -> tuple[
        RuntimeRequirementStatus,
        RuntimeArtifactDescriptorV2 | None,
        int | None,
        str | None,
    ]:
        """Status and size for a requirement that publishes cuda and cpu contents.

        Not installed: the content this machine would download. Installed: the
        content recorded at install time, so a removal dialog shows what is on
        disk. Speech stays ``artifact: null`` for every content. A single-file
        CPU archive can be under the 512 MiB public cap while the parted CUDA
        archive is not, and hosts must not start that download themselves on
        only some machines.
        """

        installed = manager.is_installed(requirement_id)
        delivery: EngineContentDescriptor | None
        if installed:
            delivery = manager.installed_content(requirement_id)
            content_id = None if delivery is None else delivery.content_id
            if delivery is None:
                installed = False
                content_id, delivery = manager.choose_content(descriptor)
        else:
            content_id, delivery = manager.choose_content(descriptor)
        if delivery is None:
            return (
                RuntimeRequirementStatus.UNAVAILABLE,
                None,
                None,
                f"No {content_id} content is published for this runtime release.",
            )
        worker = (
            delivery.worker_artifact() if delivery.complete and not delivery.model_only else None
        )
        if requirement_id == SPEECH_RECOGNITION_REQUIREMENT_ID:
            artifact = None
        else:
            artifact = _artifact_descriptor(worker) if worker is not None else None
        status = (
            RuntimeRequirementStatus.READY
            if installed
            else RuntimeRequirementStatus.INSTALLABLE
            if delivery.complete
            else RuntimeRequirementStatus.UNAVAILABLE
        )
        detail = (
            None
            if installed
            else delivery.unavailable_reason
            if not delivery.complete
            else "Pinned worker and direct model files are available for installation."
        )
        # auto and mini still run on a cpu install, so the status stays ready.
        # Hosts treat any other status as unavailable.
        if (
            installed
            and requirement_id == SPEECH_RECOGNITION_REQUIREMENT_ID
            and self._extraction_config is not None
        ):
            missing_model = speech_model_not_installed_message(
                content_id, self._extraction_config.speech_recognition_model
            )
            if missing_model is not None:
                detail = missing_model
        return status, artifact, delivery.download_bytes, detail

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        report_download: DownloadProgress | None = None,
    ) -> None:
        if requirement_id in _ENGINE_UNIT_IDS:
            if self._engine_manager is None:
                raise RuntimeError("runtime-owned engine catalog is unavailable")
            await self._engine_manager.install(
                requirement_id,
                cancel_event=cancel_event,
                report_progress=report_progress,
                report_download=report_download,
            )
            return
        if requirement_id in {STRUCTURING_RUNTIME_REQUIREMENT_ID, STRUCTURING_MODEL_REQUIREMENT_ID}:
            await self._structuring.install(
                requirement_id,
                cancel_event=cancel_event,
                report_progress=report_progress,
            )
            return
        raise ValueError(f"unknown requirementId: {requirement_id}")

    def is_uninstallable(self, requirement_id: str) -> bool:
        return self._engine_manager is not None and requirement_id in _ENGINE_UNIT_IDS

    async def uninstall(self, requirement_id: str) -> None:
        if self._engine_manager is None or requirement_id not in _ENGINE_UNIT_IDS:
            raise ValueError(f"requirement is not an engine install unit: {requirement_id}")
        await self._engine_manager.uninstall(requirement_id)
