"""Explicit runtime dependency context used by the application and routes."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from capture_runtime.clock import Clock, SystemClock
from capture_runtime.config import RuntimeSettings
from capture_runtime.constants import (
    OLLAMA_MODEL_REQUIREMENT_ID,
    OLLAMA_RUNTIME_REQUIREMENT_ID,
    WHISPER_REQUIREMENT_ID,
    WINDOWSML_REQUIREMENT_ID,
)
from capture_runtime.contracts import StructuringMode
from capture_runtime.engine_catalog import load_engine_catalog
from capture_runtime.engine_installation import EngineInstallationManager
from capture_runtime.extractors import (
    CaptureExtractor,
    DeterministicCaptureExtractor,
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.ollama import (
    ExternalOllamaCaptureStructuringProvider,
    IsolatedOllamaLifecycle,
    OllamaCaptureStructuringProvider,
    ProcessController,
    RuntimeInstaller,
    SystemRuntimeInstaller,
)
from capture_runtime.services import CaptureService, InstallationService, ModelInstallationService
from capture_runtime.storage import (
    CaptureRepository,
    InstallationRepository,
    ModelInstallationRepository,
)
from capture_runtime.structuring_provider import (
    CaptureStructuringProvider,
    FakeCaptureStructuringProvider,
    HostOnlyCaptureStructuringProvider,
)
from capture_runtime.worker_client import WorkerClient
from capture_runtime.worker_process import WorkerProcess


@dataclass(slots=True)
class RuntimeDependencies:
    """All process-local dependencies for one runtime app instance."""

    settings: RuntimeSettings
    clock: Clock
    lifecycle: IsolatedOllamaLifecycle
    extractor: CaptureExtractor
    structurer: CaptureStructuringProvider
    installer: RuntimeInstaller
    capture_repository: CaptureRepository
    installation_repository: InstallationRepository
    capture_service: CaptureService
    installation_service: InstallationService
    model_installation_repository: ModelInstallationRepository
    model_installation_service: ModelInstallationService
    engine_manager: EngineInstallationManager
    staging_root: Path
    supported_structuring_modes: list[StructuringMode]
    disabled_requirement_ids: set[str]
    enabled_requirement_ids: set[str] | None


def build_runtime_dependencies(
    settings: RuntimeSettings,
    *,
    clock: Clock | None = None,
    extractor: CaptureExtractor | None = None,
    structurer: CaptureStructuringProvider | None = None,
    installer: RuntimeInstaller | None = None,
    process_controller: ProcessController | None = None,
    capture_repository: CaptureRepository | None = None,
    installation_repository: InstallationRepository | None = None,
    model_installation_repository: ModelInstallationRepository | None = None,
) -> RuntimeDependencies:
    """Build one isolated dependency graph for a runtime application."""

    runtime_clock = clock or SystemClock()
    lifecycle = IsolatedOllamaLifecycle(
        settings.ollama,
        process_controller=process_controller,
        clock=runtime_clock,
    )
    worker_process = WorkerProcess()
    worker_client = WorkerClient(worker_process)
    engine_manager = EngineInstallationManager(
        settings.app_data_dir / "engines",
        load_engine_catalog(),
        worker_client=worker_client,
    )
    standalone_extractor = StandaloneRuntimeCaptureExtractor(
        runtime_clock,
        settings.extraction,
        engine_manager=engine_manager,
    )
    active_extractor = extractor
    if active_extractor is None:
        active_extractor = (
            DeterministicCaptureExtractor(runtime_clock)
            if settings.extraction_provider == "fake"
            else standalone_extractor
        )

    active_structurer = structurer
    if active_structurer is None:
        if settings.structuring_provider == "fake":
            active_structurer = FakeCaptureStructuringProvider(runtime_clock)
        elif settings.structuring_provider == "ollama":
            active_structurer = OllamaCaptureStructuringProvider(lifecycle, clock=runtime_clock)
        elif settings.structuring_provider == "external-ollama":
            if settings.external_ollama is None:
                raise ValueError("external Ollama configuration is required")
            active_structurer = ExternalOllamaCaptureStructuringProvider(
                settings.external_ollama,
                clock=runtime_clock,
            )
        else:
            active_structurer = HostOnlyCaptureStructuringProvider()

    supported_structuring_modes = (
        [StructuringMode.HOST]
        if settings.structuring_provider == "host"
        else [StructuringMode.RUNTIME, StructuringMode.HOST]
    )
    disabled_requirement_ids = (
        {OLLAMA_RUNTIME_REQUIREMENT_ID, OLLAMA_MODEL_REQUIREMENT_ID}
        if settings.structuring_provider in {"host", "external-ollama"}
        else set()
    )
    enabled_requirement_ids = (
        {WINDOWSML_REQUIREMENT_ID, WHISPER_REQUIREMENT_ID}
        if settings.structuring_provider in {"host", "external-ollama"}
        else None
    )
    active_installer = installer or SystemRuntimeInstaller(
        lifecycle,
        engine_manager=engine_manager,
        clock=runtime_clock,
        enabled_requirement_ids=enabled_requirement_ids,
        extraction_config=settings.extraction,
    )

    active_capture_repository = capture_repository or CaptureRepository(
        settings.app_data_dir / "jobs" / "captures",
        clock=runtime_clock,
        retention_hours=settings.retention_hours,
    )
    active_installation_repository = installation_repository or InstallationRepository(
        settings.app_data_dir / "jobs" / "installations",
        clock=runtime_clock,
        retention_hours=settings.retention_hours,
    )
    active_model_installation_repository = (
        model_installation_repository
        or ModelInstallationRepository(
            settings.app_data_dir / "jobs" / "model-installations",
            clock=runtime_clock,
            retention_hours=settings.retention_hours,
        )
    )
    staging_root = settings.app_data_dir / "jobs" / "staging"
    capture_service = CaptureService(
        active_capture_repository,
        extractor=active_extractor,
        structurer=active_structurer,
        clock=runtime_clock,
    )
    installation_service = InstallationService(
        active_installation_repository,
        installer=active_installer,
        clock=runtime_clock,
    )
    model_installation_service = ModelInstallationService(
        active_model_installation_repository,
        installer=active_installer,
        clock=runtime_clock,
    )
    return RuntimeDependencies(
        settings=settings,
        clock=runtime_clock,
        lifecycle=lifecycle,
        extractor=active_extractor,
        structurer=active_structurer,
        installer=active_installer,
        capture_repository=active_capture_repository,
        installation_repository=active_installation_repository,
        capture_service=capture_service,
        installation_service=installation_service,
        model_installation_repository=active_model_installation_repository,
        model_installation_service=model_installation_service,
        engine_manager=engine_manager,
        staging_root=staging_root,
        supported_structuring_modes=supported_structuring_modes,
        disabled_requirement_ids=disabled_requirement_ids,
        enabled_requirement_ids=enabled_requirement_ids,
    )


__all__ = ["RuntimeDependencies", "build_runtime_dependencies"]
