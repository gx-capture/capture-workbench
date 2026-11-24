"""Fake requirement installer for tests."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection

from capture_runtime.constants import (
    SPEECH_RECOGNITION_REQUIREMENT_ID,
    STRUCTURING_MODEL_REQUIREMENT_ID,
    STRUCTURING_RUNTIME_REQUIREMENT_ID,
    TEXT_RECOGNITION_REQUIREMENT_ID,
)
from capture_runtime.contracts import RuntimeRequirement, RuntimeRequirementStatus
from capture_runtime.install_progress import DownloadProgress
from capture_runtime.provisioning.application.requirement_installer import ManualActionRequiredError


class FakeRequirementInstaller:
    def __init__(
        self,
        *,
        initially_ready: set[str] | None = None,
        delay_seconds: float = 0,
        manual_requirements: set[str] | None = None,
    ) -> None:
        self.ready = set(initially_ready or ())
        self.delay_seconds = delay_seconds
        self.manual_requirements = set(manual_requirements or ())

    def requirements(
        self,
        enabled_requirement_ids: Collection[str] | None = None,
    ) -> list[RuntimeRequirement]:
        descriptions = {
            TEXT_RECOGNITION_REQUIREMENT_ID: ("Text recognition", ["pdf", "image"]),
            SPEECH_RECOGNITION_REQUIREMENT_ID: (
                "Speech recognition",
                ["recording"],
            ),
            STRUCTURING_RUNTIME_REQUIREMENT_ID: (
                "Ollama application",
                ["runtime-structuring"],
            ),
            STRUCTURING_MODEL_REQUIREMENT_ID: (
                "Capture structuring model",
                ["runtime-structuring"],
            ),
        }
        enabled = (
            set(descriptions) if enabled_requirement_ids is None else set(enabled_requirement_ids)
        )
        return [
            RuntimeRequirement(
                requirement_id=requirement_id,
                kind=requirement_id,
                display_name=name,
                status=(
                    RuntimeRequirementStatus.READY
                    if requirement_id in self.ready
                    else RuntimeRequirementStatus.MANUAL_ACTION_REQUIRED
                    if requirement_id in self.manual_requirements
                    else RuntimeRequirementStatus.INSTALLABLE
                ),
                required_for=required_for,
                install_strategy="fake",
            )
            for requirement_id, (name, required_for) in descriptions.items()
            if requirement_id in enabled
        ]

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
        report_download: DownloadProgress | None = None,
    ) -> None:
        if requirement_id in self.manual_requirements:
            raise ManualActionRequiredError(f"{requirement_id} requires manual action")
        report_progress(0.1)
        if self.delay_seconds:
            try:
                await asyncio.wait_for(cancel_event.wait(), timeout=self.delay_seconds)
            except TimeoutError:
                pass
        if cancel_event.is_set():
            raise asyncio.CancelledError
        self.ready.add(requirement_id)
        report_progress(1)

    def is_uninstallable(self, requirement_id: str) -> bool:
        return requirement_id in {
            TEXT_RECOGNITION_REQUIREMENT_ID,
            SPEECH_RECOGNITION_REQUIREMENT_ID,
        }

    async def uninstall(self, requirement_id: str) -> None:
        self.ready.discard(requirement_id)

    async def install_model_option(
        self,
        option_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        report_progress(0.1)
        if cancel_event.is_set():
            raise asyncio.CancelledError
        self.ready.add(f"model-option:{option_id}")
        report_progress(1)
