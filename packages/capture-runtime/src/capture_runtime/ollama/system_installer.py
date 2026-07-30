"""System-backed runtime requirement installer.

Optional OCR/Whisper artifacts are delegated to the engine installation owner;
this module retains the existing app-managed Ollama lifecycle.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
import subprocess
import time
from collections.abc import Callable, Collection
from pathlib import Path

import httpx

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig, sanitized_child_environment
from capture_runtime.constants import (
    OLLAMA_MODEL_REQUIREMENT_ID,
    OLLAMA_RUNTIME_REQUIREMENT_ID,
    WHISPER_REQUIREMENT_ID,
    WINDOWSML_REQUIREMENT_ID,
)
from capture_runtime.contracts import (
    RuntimeArtifactDescriptorV1,
    RuntimeRequirementStatus,
    RuntimeRequirementV1,
)
from capture_runtime.engine_catalog import EngineCatalogError
from capture_runtime.engine_installation import EngineInstallationManager, sha256_file
from capture_runtime.ollama.installer_runtime import (
    AsyncSubprocessCommandRunner,
    CommandRunner,
    _atomic_json,
)
from capture_runtime.ollama.lifecycle_impl import (
    IsolatedOllamaLifecycle,
    ManualActionRequiredError,
    OllamaOwnershipError,
    RuntimeUnavailableError,
)


class SystemRuntimeInstaller:
    """Probe/install product requirements without dynamic package installation."""

    def __init__(
        self,
        lifecycle: IsolatedOllamaLifecycle,
        *,
        engine_manager: EngineInstallationManager | None = None,
        clock: Clock,
        command_runner: CommandRunner | None = None,
        winget_resolver: Callable[[], str | None] | None = None,
        enabled_requirement_ids: Collection[str] | None = None,
        model_readiness_timeout_seconds: float = 10,
        model_readiness_poll_interval_seconds: float = 0.2,
        extraction_config: ExtractionRuntimeConfig | None = None,
        ocr_adapter: object | None = None,
        whisper_adapter: object | None = None,
        http_client_factory: object | None = None,
    ) -> None:
        if model_readiness_timeout_seconds < 0:
            raise ValueError("model_readiness_timeout_seconds must be non-negative")
        if model_readiness_poll_interval_seconds < 0:
            raise ValueError("model_readiness_poll_interval_seconds must be non-negative")
        self._lifecycle = lifecycle
        self._engine_manager = engine_manager
        self._windowsml_device_id = (
            extraction_config.windowsml_device_id if extraction_config is not None else 0
        )
        del ocr_adapter, whisper_adapter, http_client_factory
        self._runner = command_runner or AsyncSubprocessCommandRunner()
        self._resolve_winget = winget_resolver or (lambda: shutil.which("winget"))
        self._clock = clock
        self._markers = lifecycle.config.app_data_dir / "requirements"
        self._enabled_requirement_ids = (
            None if enabled_requirement_ids is None else frozenset(enabled_requirement_ids)
        )
        self._model_readiness_timeout_seconds = model_readiness_timeout_seconds
        self._model_readiness_poll_interval_seconds = model_readiness_poll_interval_seconds

    def requirements(
        self,
        enabled_requirement_ids: Collection[str] | None = None,
    ) -> list[RuntimeRequirementV1]:
        effective_requirement_ids = (
            self._enabled_requirement_ids
            if enabled_requirement_ids is None
            else frozenset(enabled_requirement_ids)
            if self._enabled_requirement_ids is None
            else self._enabled_requirement_ids.intersection(enabled_requirement_ids)
        )

        def is_enabled(requirement_id: str) -> bool:
            return effective_requirement_ids is None or requirement_id in effective_requirement_ids

        requirements: list[RuntimeRequirementV1] = []
        for requirement_id, kind, display_name, required_for in (
            (WINDOWSML_REQUIREMENT_ID, "OCR", "WindowsML OCR", ["pdf", "image"]),
            (WHISPER_REQUIREMENT_ID, "transcription", "Whisper transcription", ["audio"]),
        ):
            if not is_enabled(requirement_id):
                continue
            try:
                if self._engine_manager is None:
                    raise EngineCatalogError("engine manager is unavailable")
                descriptor = self._engine_manager.requirement(requirement_id)
                active = self._engine_manager.active_engine(requirement_id)
                worker = descriptor.worker_artifact() if descriptor.complete else None
                artifact = (
                    RuntimeArtifactDescriptorV1(
                        artifact_url=worker.url,
                        artifact_file_name=worker.file_name,
                        bytes=worker.bytes,
                        sha256=worker.sha256,
                    )
                    if worker is not None
                    else None
                )
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
                detail = "No downloadable model is published for this runtime release."
            requirements.append(
                RuntimeRequirementV1(
                    requirement_id=requirement_id,
                    kind=kind,
                    display_name=display_name,
                    status=status,
                    required_for=required_for,
                    install_strategy="runtime-catalog",
                    detail=detail,
                    artifact=artifact,
                )
            )

        ollama_runtime_enabled = is_enabled(OLLAMA_RUNTIME_REQUIREMENT_ID)
        ollama_model_enabled = is_enabled(OLLAMA_MODEL_REQUIREMENT_ID)
        ollama_available = (
            self._lifecycle.executable() is not None
            if ollama_runtime_enabled or ollama_model_enabled
            else False
        )
        if ollama_runtime_enabled:
            requirements.append(
                RuntimeRequirementV1(
                    requirement_id=OLLAMA_RUNTIME_REQUIREMENT_ID,
                    kind="runtime",
                    display_name="Ollama application",
                    status=(
                        RuntimeRequirementStatus.READY
                        if ollama_available
                        else RuntimeRequirementStatus.INSTALLABLE
                        if self._resolve_winget() is not None
                        else RuntimeRequirementStatus.MANUAL_ACTION_REQUIRED
                    ),
                    required_for=["runtime-structuring"],
                    install_strategy="winget",
                    detail=None if ollama_available else "Ollama must be installed with winget.",
                )
            )
        if ollama_model_enabled:
            model_ready = self._active_model_profile_ready()
            requirements.append(
                RuntimeRequirementV1(
                    requirement_id=OLLAMA_MODEL_REQUIREMENT_ID,
                    kind="model",
                    display_name="Capture structuring model",
                    status=(
                        RuntimeRequirementStatus.READY
                        if model_ready
                        else RuntimeRequirementStatus.INSTALLABLE
                        if ollama_available
                        else RuntimeRequirementStatus.MISSING
                    ),
                    required_for=["runtime-structuring"],
                    install_strategy="ollama",
                    detail=(
                        None if model_ready else f"Requires {self._lifecycle.config.base_model}."
                    ),
                )
            )
        return requirements

    async def install(
        self,
        requirement_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        if requirement_id in {WINDOWSML_REQUIREMENT_ID, WHISPER_REQUIREMENT_ID}:
            if self._engine_manager is None:
                raise RuntimeError("runtime-owned engine catalog is unavailable")
            await self._engine_manager.install(
                requirement_id,
                cancel_event=cancel_event,
                report_progress=report_progress,
                probe_options=(
                    {"deviceId": self._windowsml_device_id}
                    if requirement_id == WINDOWSML_REQUIREMENT_ID
                    else None
                ),
            )
            return
        if requirement_id == OLLAMA_RUNTIME_REQUIREMENT_ID:
            await self._install_ollama(cancel_event, report_progress)
            return
        if requirement_id == OLLAMA_MODEL_REQUIREMENT_ID:
            await self._install_model(cancel_event, report_progress)
            return
        raise ValueError(f"unknown requirementId: {requirement_id}")

    async def _install_ollama(
        self,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        winget = self._resolve_winget()
        if winget is None:
            raise ManualActionRequiredError("winget is unavailable; install Ollama manually")
        report_progress(0.1)
        result = await self._runner.run(
            [
                winget,
                "install",
                "--id",
                "Ollama.Ollama",
                "--exact",
                "--silent",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ],
            environment=sanitized_child_environment(),
            cwd=None,
            cancel_event=cancel_event,
            timeout_seconds=900,
        )
        if result.return_code != 0:
            raise RuntimeError(f"winget Ollama installation failed ({result.return_code})")
        report_progress(1)

    async def _install_model(
        self,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        executable = self._lifecycle.executable()
        if executable is None:
            raise ManualActionRequiredError("Install the Ollama application first")
        self._lifecycle.start()
        environment = self._lifecycle.config.process_environment()
        report_progress(0.1)
        pull = await self._runner.run(
            [executable, "pull", self._lifecycle.config.base_model],
            environment=environment,
            cwd=self._lifecycle.config.app_data_dir,
            cancel_event=cancel_event,
            timeout_seconds=3600,
        )
        if pull.return_code != 0:
            raise RuntimeError(f"Ollama model pull failed ({pull.return_code})")
        report_progress(0.75)
        modelfile = self._lifecycle.config.app_data_dir / "Capture.Modelfile"
        modelfile_text = (
            f"FROM {self._lifecycle.config.base_model}\n"
            "PARAMETER temperature 0\n"
            "SYSTEM Return only JSON matching the supplied schema. "
            "Preserve source provenance exactly.\n"
        )
        modelfile_bytes = modelfile_text.encode("utf-8")
        modelfile.write_bytes(modelfile_bytes)
        create = await self._runner.run(
            [
                executable,
                "create",
                self._lifecycle.config.profile_id,
                "-f",
                str(modelfile),
            ],
            environment=environment,
            cwd=self._lifecycle.config.app_data_dir,
            cancel_event=cancel_event,
            timeout_seconds=600,
        )
        if create.return_code != 0:
            raise RuntimeError(f"Ollama capture profile creation failed ({create.return_code})")
        _atomic_json(
            self._marker(OLLAMA_MODEL_REQUIREMENT_ID),
            {
                "profileId": self._lifecycle.config.profile_id,
                "baseModel": self._lifecycle.config.base_model,
                "modelfileSha256": hashlib.sha256(modelfile_bytes).hexdigest(),
                "installedAt": self._clock.now().isoformat(),
            },
        )
        report_progress(1)

    def _active_model_profile_ready(self) -> bool:
        if not self._recorded_model_profile_matches() or self._lifecycle.executable() is None:
            return False
        try:
            self._lifecycle.start()
        except (
            OllamaOwnershipError,
            RuntimeUnavailableError,
            OSError,
            subprocess.SubprocessError,
        ):
            return False
        expected_names = {
            self._lifecycle.config.profile_id,
            f"{self._lifecycle.config.profile_id}:latest",
        }
        deadline = time.monotonic() + self._model_readiness_timeout_seconds
        while True:
            if not self._lifecycle.owns_running_process():
                return False
            remaining = max(0.0, deadline - time.monotonic())
            try:
                response = httpx.get(
                    f"{self._lifecycle.config.host_url}/api/tags",
                    timeout=max(0.05, min(0.5, remaining)),
                    follow_redirects=False,
                )
                response.raise_for_status()
            except httpx.HTTPError:
                if remaining <= 0:
                    return False
                time.sleep(min(self._model_readiness_poll_interval_seconds, remaining))
                continue
            if not self._lifecycle.owns_running_process():
                return False
            try:
                models = response.json().get("models", [])
            except (AttributeError, TypeError, ValueError):
                return False
            if not isinstance(models, list):
                return False
            return any(
                str(model.get("name") or model.get("model") or "") in expected_names
                and bool(re.fullmatch(r"(?:sha256:)?[0-9a-f]{64}", str(model.get("digest") or "")))
                for model in models
                if isinstance(model, dict)
            )

    def _recorded_model_profile_matches(self) -> bool:
        try:
            payload = json.loads(
                self._marker(OLLAMA_MODEL_REQUIREMENT_ID).read_text(encoding="utf-8")
            )
            modelfile_digest = str(payload["modelfileSha256"])
            modelfile = self._lifecycle.config.app_data_dir / "Capture.Modelfile"
            return (
                payload["profileId"] == self._lifecycle.config.profile_id
                and payload["baseModel"] == self._lifecycle.config.base_model
                and bool(re.fullmatch(r"[0-9a-f]{64}", modelfile_digest))
                and sha256_file(modelfile) == modelfile_digest
            )
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            return False

    def _marker(self, requirement_id: str) -> Path:
        return self._markers / f"{requirement_id}.ready.json"
