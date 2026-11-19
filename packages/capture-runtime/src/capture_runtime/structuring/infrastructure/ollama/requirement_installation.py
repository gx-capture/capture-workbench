"""Ollama requirement discovery and installation for structuring."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import shutil
from collections.abc import Callable, Collection
from pathlib import Path

import httpx

from capture_runtime.clock import Clock
from capture_runtime.config import sanitized_child_environment
from capture_runtime.constants import (
    STRUCTURING_MODEL_REQUIREMENT_ID,
    STRUCTURING_RUNTIME_REQUIREMENT_ID,
)
from capture_runtime.contracts import RuntimeRequirement, RuntimeRequirementStatus
from capture_runtime.provisioning.application.requirement_installer import (
    ManualActionRequiredError,
    ModelOptionRejectedError,
)
from capture_runtime.provisioning.infrastructure.engine_installation import sha256_file
from capture_runtime.structuring.infrastructure.model_catalog import (
    ActiveModelSelectionStore,
    StructuringModelOption,
    legacy_profile_id,
    model_option,
)
from capture_runtime.structuring.infrastructure.ollama.installation_commands import (
    AsyncSubprocessCommandRunner,
    CommandRunner,
)
from capture_runtime.structuring.infrastructure.ollama.lifecycle_impl import (
    IsolatedOllamaLifecycle,
    RuntimeUnavailableError,
    _atomic_json,
)


class OllamaRequirementInstaller:
    """Install the Ollama application and selected structuring models."""

    def __init__(
        self,
        lifecycle: IsolatedOllamaLifecycle,
        *,
        clock: Clock,
        command_runner: CommandRunner | None = None,
        winget_resolver: Callable[[], str | None] | None = None,
    ) -> None:
        self._lifecycle = lifecycle
        self._runner = command_runner or AsyncSubprocessCommandRunner()
        self._resolve_winget = winget_resolver or (lambda: shutil.which("winget"))
        self._clock = clock
        self._markers = lifecycle.config.app_data_dir / "requirements"
        self._model_selection = ActiveModelSelectionStore(lifecycle.config.app_data_dir)

    def requirements(
        self,
        enabled_requirement_ids: Collection[str] | None = None,
    ) -> list[RuntimeRequirement]:
        def is_enabled(requirement_id: str) -> bool:
            return enabled_requirement_ids is None or requirement_id in enabled_requirement_ids

        requirements: list[RuntimeRequirement] = []
        ollama_runtime_enabled = is_enabled(STRUCTURING_RUNTIME_REQUIREMENT_ID)
        ollama_model_enabled = is_enabled(STRUCTURING_MODEL_REQUIREMENT_ID)
        ollama_available = (
            self._lifecycle.executable() is not None
            if ollama_runtime_enabled or ollama_model_enabled
            else False
        )
        if ollama_runtime_enabled:
            requirements.append(
                RuntimeRequirement(
                    requirement_id=STRUCTURING_RUNTIME_REQUIREMENT_ID,
                    kind=STRUCTURING_RUNTIME_REQUIREMENT_ID,
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
            # Requirements discovery is a pure projection of persisted state.
            # Starting/probing Ollama here competes with OCR and speech recognition for
            # the machine's model memory; structuring acquires the live lease
            # when it actually needs the process.
            model_ready = self._recorded_model_profile_matches()
            requirements.append(
                RuntimeRequirement(
                    requirement_id=STRUCTURING_MODEL_REQUIREMENT_ID,
                    kind=STRUCTURING_MODEL_REQUIREMENT_ID,
                    display_name="Capture structuring model",
                    status=(
                        RuntimeRequirementStatus.READY
                        if model_ready
                        else RuntimeRequirementStatus.MANUAL_ACTION_REQUIRED
                        if ollama_available
                        else RuntimeRequirementStatus.MISSING
                    ),
                    required_for=["runtime-structuring"],
                    install_strategy="ollama",
                    detail=(
                        None
                        if model_ready
                        else "Select a structuring model after the Ollama runtime is ready."
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
        if requirement_id == STRUCTURING_RUNTIME_REQUIREMENT_ID:
            await self._install_ollama(cancel_event, report_progress)
            return
        if requirement_id == STRUCTURING_MODEL_REQUIREMENT_ID:
            raise ManualActionRequiredError(
                "Select a model option through the model-installation API."
            )
        raise ValueError(f"unknown requirementId: {requirement_id}")

    async def install_model_option(
        self,
        option_id: str,
        *,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        try:
            option = model_option(option_id)
        except KeyError as error:
            raise ModelOptionRejectedError(
                "The model option is not in the release catalog"
            ) from error
        executable = self._lifecycle.executable()
        if executable is None:
            raise ManualActionRequiredError("Install the Ollama application first")
        self._lifecycle.start()
        try:
            await self._wait_for_ollama_server(cancel_event)
            report_progress(0.1)
            environment = self._lifecycle.process_environment()
            self._require_lease(f"http://{environment['OLLAMA_HOST']}")
            pull = await self._runner.run(
                [executable, "pull", option.model_reference],
                environment=environment,
                cwd=self._lifecycle.config.app_data_dir,
                cancel_event=cancel_event,
                timeout_seconds=3600,
            )
            if pull.return_code != 0:
                raise RuntimeError(f"Ollama model pull failed ({pull.return_code})")
            self._require_lease(f"http://{environment['OLLAMA_HOST']}")
            observed_digest, observed_bytes = self._verify_pulled_model(
                option, f"http://{environment['OLLAMA_HOST']}"
            )
            report_progress(0.75)
            modelfile = self._lifecycle.config.app_data_dir / "Capture.Modelfile"
            modelfile_bytes = option.profile_spec_bytes
            if hashlib.sha256(modelfile_bytes).hexdigest() != option.profile_spec_sha256:
                raise ModelOptionRejectedError("Ollama profile specification digest is invalid")
            modelfile.write_bytes(modelfile_bytes)
            environment = self._lifecycle.process_environment()
            self._require_lease(f"http://{environment['OLLAMA_HOST']}")
            create = await self._runner.run(
                [
                    executable,
                    "create",
                    option.profile_id,
                    "-f",
                    str(modelfile),
                ],
                environment=environment,
                cwd=self._lifecycle.config.app_data_dir,
                cancel_event=cancel_event,
                timeout_seconds=600,
            )
            self._require_lease(f"http://{environment['OLLAMA_HOST']}")
            if create.return_code != 0:
                raise RuntimeError(f"Ollama capture profile creation failed ({create.return_code})")
            _atomic_json(
                self._marker(STRUCTURING_MODEL_REQUIREMENT_ID),
                {
                    "profileId": option.profile_id,
                    "baseModel": option.model_reference,
                    "modelfileSha256": hashlib.sha256(modelfile_bytes).hexdigest(),
                    "installedAt": self._clock.now().isoformat(),
                },
            )
            self._model_selection.save(
                option,
                observed_digest=observed_digest,
                observed_bytes=observed_bytes,
            )
            report_progress(1)
        finally:
            # Model installation only needs a short Ollama lease. Release the
            # native process on success, failure, or cancellation before OCR or
            # speech recognition can claim the machine's model memory; later structuring
            # starts a fresh owned lease.
            self._lifecycle.stop()

    async def _wait_for_ollama_server(self, cancel_event: asyncio.Event) -> None:
        lease_url = self._lifecycle.host_url
        deadline = asyncio.get_running_loop().time() + 30
        while asyncio.get_running_loop().time() < deadline:
            if cancel_event.is_set():
                raise asyncio.CancelledError
            self._require_lease(lease_url)
            try:
                response = await asyncio.to_thread(
                    httpx.get,
                    f"{lease_url}/api/tags",
                    timeout=2,
                    follow_redirects=False,
                    trust_env=False,
                )
                self._require_lease(lease_url)
                if response.status_code == 200:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.2)
        raise RuntimeError("Capture Ollama server did not become ready")

    def _require_lease(self, expected_url: str) -> None:
        if self._lifecycle.host_url != expected_url:
            raise RuntimeUnavailableError("isolated Ollama lease changed during installation")

    def _verify_pulled_model(
        self, option: StructuringModelOption, lease_url: str | None = None
    ) -> tuple[str, int]:
        if lease_url is None:
            lease_url = self._lifecycle.host_url
        try:
            self._require_lease(lease_url)
            response = httpx.get(
                f"{lease_url}/api/tags",
                timeout=5,
                follow_redirects=False,
                trust_env=False,
            )
            self._require_lease(lease_url)
            response.raise_for_status()
            models = response.json().get("models", [])
        except (httpx.HTTPError, AttributeError, TypeError, ValueError) as error:
            raise RuntimeError("Ollama model list could not be verified") from error
        for model in models if isinstance(models, list) else []:
            if not isinstance(model, dict):
                continue
            name = str(model.get("name") or model.get("model") or "")
            if name not in {option.model_reference, f"{option.model_reference}:latest"}:
                continue
            digest = str(model.get("digest") or "").removeprefix("sha256:")
            size = model.get("size")
            if not re.fullmatch(r"[0-9a-f]{64}", digest) or not isinstance(size, int) or size <= 0:
                raise ModelOptionRejectedError(
                    "Ollama model verification returned invalid digest or size"
                )
            if option.expected_digest is not None and digest != option.expected_digest:
                raise ModelOptionRejectedError(
                    "Ollama model digest does not match the release catalog"
                )
            if option.download_bytes is not None and size != option.download_bytes:
                raise ModelOptionRejectedError(
                    "Ollama model size does not match the release catalog"
                )
            return digest, size
        raise RuntimeError("Ollama did not report the selected model after pull")

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

    def _recorded_model_profile_matches(self) -> bool:
        selection = self._model_selection.load()
        if selection is None:
            return False
        try:
            option = model_option(str(selection["optionId"]))
            try:
                source = self._marker(STRUCTURING_MODEL_REQUIREMENT_ID).read_text(encoding="utf-8")
            except FileNotFoundError:
                source = (self._markers / "capture-ollama-model.ready.json").read_text(
                    encoding="utf-8"
                )
            payload = json.loads(source)
            modelfile_digest = str(payload["modelfileSha256"])
            modelfile = self._lifecycle.config.app_data_dir / "Capture.Modelfile"
            selection_profile_id = selection["profileId"]
            return (
                selection_profile_id in {option.profile_id, legacy_profile_id(option)}
                and selection["modelReference"] == option.model_reference
                and selection["profileSpecSha256"] == option.profile_spec_sha256
                and payload["profileId"] == selection_profile_id
                and payload["baseModel"] == option.model_reference
                and bool(re.fullmatch(r"[0-9a-f]{64}", modelfile_digest))
                and modelfile_digest == option.profile_spec_sha256
                and sha256_file(modelfile) == option.profile_spec_sha256
            )
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            return False

    def _marker(self, requirement_id: str) -> Path:
        return self._markers / f"{requirement_id}.ready.json"
