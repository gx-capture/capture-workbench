"""System-backed runtime requirement installer."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Collection
from pathlib import Path
from uuid import uuid4

import httpx

from capture_runtime.clock import Clock
from capture_runtime.config import ExtractionRuntimeConfig, sanitized_child_environment
from capture_runtime.constants import (
    OLLAMA_MODEL_REQUIREMENT_ID,
    OLLAMA_RUNTIME_REQUIREMENT_ID,
    WHISPER_REQUIREMENT_ID,
    WINDOWSML_BUNDLE_BYTES,
    WINDOWSML_BUNDLE_SHA256,
    WINDOWSML_BUNDLE_URL,
    WINDOWSML_REQUIREMENT_ID,
)
from capture_runtime.contracts import RuntimeRequirementStatus, RuntimeRequirementV1
from capture_runtime.engine_adapters import (
    OcrAdapter,
    WhisperAdapter,
)
from capture_runtime.ollama.installer_runtime import (
    AsyncSubprocessCommandRunner,
    CommandRunner,
    _atomic_json,
    _extract_safe_zip,
    _sha256_file,
)
from capture_runtime.ollama.lifecycle_impl import (
    IsolatedOllamaLifecycle,
    ManualActionRequiredError,
    OllamaOwnershipError,
    RuntimeUnavailableError,
)


class SystemRuntimeInstaller:
    """Probe/install product requirements without script-download fallbacks."""

    def __init__(
        self,
        lifecycle: IsolatedOllamaLifecycle,
        *,
        command_runner: CommandRunner | None = None,
        winget_resolver: Callable[[], str | None] | None = None,
        extraction_config: ExtractionRuntimeConfig,
        ocr_adapter: OcrAdapter,
        whisper_adapter: WhisperAdapter,
        clock: Clock,
        http_client_factory: Callable[[], httpx.AsyncClient] | None = None,
        enabled_requirement_ids: Collection[str] | None = None,
        model_readiness_timeout_seconds: float = 10,
        model_readiness_poll_interval_seconds: float = 0.2,
    ) -> None:
        if model_readiness_timeout_seconds < 0:
            raise ValueError("model_readiness_timeout_seconds must be non-negative")
        if model_readiness_poll_interval_seconds < 0:
            raise ValueError("model_readiness_poll_interval_seconds must be non-negative")
        self._lifecycle = lifecycle
        self._runner = command_runner or AsyncSubprocessCommandRunner()
        self._resolve_winget = winget_resolver or (lambda: shutil.which("winget"))
        self._clock = clock
        self._markers = lifecycle.config.app_data_dir / "requirements"
        self._extraction_config = extraction_config
        self._ocr_adapter = ocr_adapter
        self._whisper_adapter = whisper_adapter
        self._http_client_factory = http_client_factory or (
            # GitHub release assets redirect to a signed object URL. The pinned
            # byte count and SHA-256 still gate the downloaded bytes.
            lambda: httpx.AsyncClient(timeout=120, follow_redirects=True)
        )
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

        windowsml_enabled = is_enabled(WINDOWSML_REQUIREMENT_ID)
        whisper_enabled = is_enabled(WHISPER_REQUIREMENT_ID)
        ollama_runtime_enabled = is_enabled(OLLAMA_RUNTIME_REQUIREMENT_ID)
        ollama_model_enabled = is_enabled(OLLAMA_MODEL_REQUIREMENT_ID)

        ollama_available = (
            self._lifecycle.executable() is not None
            if ollama_runtime_enabled or ollama_model_enabled
            else False
        )
        winget_available = self._resolve_winget() is not None if ollama_runtime_enabled else False
        model_ready = self._active_model_profile_ready() if ollama_model_enabled else False

        requirements: list[RuntimeRequirementV1] = []
        if windowsml_enabled:
            ocr_probe = self._ocr_adapter.probe()
            requirements.append(
                RuntimeRequirementV1(
                    requirement_id=WINDOWSML_REQUIREMENT_ID,
                    kind="OCR",
                    display_name="WindowsML OCR",
                    status=(
                        RuntimeRequirementStatus.READY
                        if ocr_probe.ready
                        else RuntimeRequirementStatus.UNAVAILABLE
                        if not ocr_probe.code_ready
                        else RuntimeRequirementStatus.INSTALLABLE
                    ),
                    required_for=["pdf", "image"],
                    install_strategy="bundled",
                    detail=ocr_probe.detail,
                )
            )
        if whisper_enabled:
            whisper_probe = self._whisper_adapter.probe()
            requirements.append(
                RuntimeRequirementV1(
                    requirement_id=WHISPER_REQUIREMENT_ID,
                    kind="transcription",
                    display_name="Whisper transcription",
                    status=(
                        RuntimeRequirementStatus.READY
                        if whisper_probe.ready
                        else RuntimeRequirementStatus.UNAVAILABLE
                        if not whisper_probe.code_ready
                        else RuntimeRequirementStatus.INSTALLABLE
                    ),
                    required_for=["audio"],
                    install_strategy="bundled",
                    detail=whisper_probe.detail,
                )
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
                        if winget_available
                        else RuntimeRequirementStatus.MANUAL_ACTION_REQUIRED
                    ),
                    required_for=["runtime-structuring"],
                    install_strategy="winget",
                    detail=None if ollama_available else "Ollama must be installed with winget.",
                )
            )
        if ollama_model_enabled:
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
                    detail=None
                    if model_ready
                    else f"Requires {self._lifecycle.config.base_model}.",
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
        if requirement_id == WINDOWSML_REQUIREMENT_ID:
            await self._install_windowsml(cancel_event, report_progress)
            return
        if requirement_id == WHISPER_REQUIREMENT_ID:
            await self._install_whisper(cancel_event, report_progress)
            return
        if requirement_id == OLLAMA_RUNTIME_REQUIREMENT_ID:
            await self._install_ollama(cancel_event, report_progress)
            return
        if requirement_id == OLLAMA_MODEL_REQUIREMENT_ID:
            await self._install_model(cancel_event, report_progress)
            return
        raise ValueError(f"unknown requirementId: {requirement_id}")

    async def _install_windowsml(
        self,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        target = self._extraction_config.windowsml_model_dir
        target.parent.mkdir(parents=True, exist_ok=True)
        archive = target.parent / f".{target.name}.{uuid4().hex}.zip"
        staging = target.parent / f".{target.name}.{uuid4().hex}.staging"
        backup = target.parent / f".{target.name}.{uuid4().hex}.backup"
        installed = False
        report_progress(0.05)
        try:
            await self._download_bundle(
                archive,
                cancel_event,
                report_progress,
            )
            actual_sha256 = _sha256_file(archive)
            if actual_sha256 != WINDOWSML_BUNDLE_SHA256:
                raise RuntimeError("WindowsML model bundle SHA-256 verification failed")
            report_progress(0.75)
            _extract_safe_zip(archive, staging, cancel_event)
            missing = [
                relative
                for relative in (
                    "det/inference.onnx",
                    "det/inference.yml",
                    "rec/inference.onnx",
                    "rec/inference.yml",
                    "rec/ppocr_keys_v1.txt",
                    "pipeline.json",
                )
                if not (staging / relative).is_file()
            ]
            if missing:
                raise RuntimeError("WindowsML model bundle is incomplete: " + ", ".join(missing))
            if cancel_event.is_set():
                raise asyncio.CancelledError
            if target.exists():
                os.replace(target, backup)
            try:
                os.replace(staging, target)
            except Exception:
                if backup.exists() and not target.exists():
                    os.replace(backup, target)
                raise
            probe = self._ocr_adapter.probe()
            if not probe.ready:
                raise RuntimeError(f"WindowsML OCR post-install probe failed: {probe.detail}")
            installed = True
            shutil.rmtree(backup, ignore_errors=True)
            report_progress(1)
        finally:
            archive.unlink(missing_ok=True)
            shutil.rmtree(staging, ignore_errors=True)
            if backup.exists() and not installed:
                shutil.rmtree(target, ignore_errors=True)
                os.replace(backup, target)
            shutil.rmtree(backup, ignore_errors=True)

    async def _download_bundle(
        self,
        destination: Path,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        try:
            await self._download_bundle_to_path(
                destination,
                cancel_event,
                report_progress,
            )
        except BaseException:
            destination.unlink(missing_ok=True)
            raise

    async def _download_bundle_to_path(
        self,
        destination: Path,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        async with self._http_client_factory() as client:
            async with client.stream("GET", WINDOWSML_BUNDLE_URL) as response:
                response.raise_for_status()
                declared_length = response.headers.get("content-length")
                if declared_length is not None:
                    try:
                        content_length = int(declared_length)
                    except ValueError as error:
                        raise RuntimeError("WindowsML bundle Content-Length is invalid") from error
                    if content_length != WINDOWSML_BUNDLE_BYTES:
                        raise RuntimeError(
                            "WindowsML model bundle Content-Length verification failed"
                        )
                copied = 0
                with destination.open("xb") as writer:
                    async for chunk in response.aiter_bytes(1024 * 1024):
                        if cancel_event.is_set():
                            raise asyncio.CancelledError
                        if copied + len(chunk) > WINDOWSML_BUNDLE_BYTES:
                            raise RuntimeError("WindowsML model bundle exceeded its declared bytes")
                        writer.write(chunk)
                        copied += len(chunk)
                        report_progress(0.05 + 0.6 * (copied / WINDOWSML_BUNDLE_BYTES))
                if copied != WINDOWSML_BUNDLE_BYTES:
                    raise RuntimeError("WindowsML model bundle byte count verification failed")

    async def _install_whisper(
        self,
        cancel_event: asyncio.Event,
        report_progress: Callable[[float], None],
    ) -> None:
        if not self._whisper_adapter.probe().code_ready:
            raise ManualActionRequiredError(
                "The packaged runtime does not include faster-whisper download support"
            )
        models = tuple(
            dict.fromkeys(
                (
                    self._extraction_config.whisper_primary_model,
                    self._extraction_config.whisper_fallback_model,
                )
            )
        )
        for index, model in enumerate(models):
            if cancel_event.is_set():
                raise asyncio.CancelledError
            output = self._extraction_config.whisper_models_dir / model
            if getattr(sys, "frozen", False):
                arguments = [
                    sys.executable,
                    "_download-whisper",
                    "--model",
                    model,
                    "--output",
                    str(output),
                ]
            else:
                arguments = [
                    sys.executable,
                    "-m",
                    "capture_runtime.whisper_download",
                    "--model",
                    model,
                    "--output",
                    str(output),
                ]
            report_progress(0.05 + (index / len(models)) * 0.85)
            result = await self._runner.run(
                arguments,
                environment=self._whisper_download_environment(),
                cwd=self._extraction_config.whisper_models_dir.parent,
                cancel_event=cancel_event,
                timeout_seconds=7200,
            )
            if result.return_code != 0:
                raise RuntimeError(
                    f"Whisper model download failed ({result.return_code}): {result.output}"
                )
        probe = self._whisper_adapter.probe()
        if not probe.ready:
            raise RuntimeError(f"Whisper post-install probe failed: {probe.detail}")
        report_progress(1)

    def _whisper_download_environment(self) -> dict[str, str]:
        environment = sanitized_child_environment()
        cache_root = self._extraction_config.whisper_models_dir.parent / ".huggingface"
        environment.update(
            {
                "HF_HOME": str(cache_root),
                "HF_HUB_CACHE": str(cache_root / "hub"),
                "HF_HUB_DISABLE_TELEMETRY": "1",
            }
        )
        return environment

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
        # Preserve the exact LF bytes used by the readiness marker. Path.write_text
        # would translate newlines on Windows and make every later probe fail.
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
                and _sha256_file(modelfile) == modelfile_digest
            )
        except (KeyError, OSError, TypeError, ValueError, json.JSONDecodeError):
            return False

    def _marker(self, requirement_id: str) -> Path:
        return self._markers / f"{requirement_id}.ready.json"
