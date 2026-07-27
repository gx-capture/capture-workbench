"""Fake runtime requirement installer for tests and deterministic hosts."""

from __future__ import annotations

import asyncio
from collections.abc import Callable, Collection

from capture_runtime.constants import (
    OLLAMA_MODEL_REQUIREMENT_ID,
    OLLAMA_RUNTIME_REQUIREMENT_ID,
    WHISPER_REQUIREMENT_ID,
    WINDOWSML_REQUIREMENT_ID,
)
from capture_runtime.contracts import RuntimeRequirementStatus, RuntimeRequirementV1
from capture_runtime.ollama.lifecycle_impl import ManualActionRequiredError


class FakeRuntimeInstaller:
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
    ) -> list[RuntimeRequirementV1]:
        descriptions = {
            WINDOWSML_REQUIREMENT_ID: ("OCR", "WindowsML OCR", ["pdf", "image"]),
            WHISPER_REQUIREMENT_ID: ("transcription", "Whisper transcription", ["audio"]),
            OLLAMA_RUNTIME_REQUIREMENT_ID: (
                "runtime",
                "Ollama application",
                ["runtime-structuring"],
            ),
            OLLAMA_MODEL_REQUIREMENT_ID: (
                "model",
                "Capture structuring model",
                ["runtime-structuring"],
            ),
        }
        enabled = (
            set(descriptions) if enabled_requirement_ids is None else set(enabled_requirement_ids)
        )
        return [
            RuntimeRequirementV1(
                requirement_id=requirement_id,
                kind=kind,
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
            for requirement_id, (kind, name, required_for) in descriptions.items()
            if requirement_id in enabled
        ]

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
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
