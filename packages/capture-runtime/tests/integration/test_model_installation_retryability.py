"""A model installation is retryable only when another try could pass."""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
from pathlib import Path

import httpx
import pytest

from capture_runtime.clock import SystemClock
from capture_runtime.contracts import RuntimeInstallationStatus
from capture_runtime.provisioning.application.requirement_installer import (
    ModelOptionRejectedError,
)
from capture_runtime.structuring.application.model_installation_service import (
    ModelInstallationService,
)
from capture_runtime.structuring.infrastructure.model_catalog import (
    StructuringModelOption,
    model_option,
)
from capture_runtime.structuring.infrastructure.model_installation_repository import (
    ModelInstallationRepository,
)
from capture_runtime.structuring.infrastructure.ollama.installation_commands import CommandResult
from tests.integration.test_ollama_restart_readiness import (
    FakeProcessController,
    _installer,
    _tags_response,
)

_OPTION = "qwen3.5-0.8b-v1"
_MODEL_OPTION = (
    "capture_runtime.structuring.infrastructure.ollama.requirement_installation.model_option"
)


class _SuccessfulRunner:
    async def run(self, arguments: list[str], **_kwargs: object) -> CommandResult:
        return CommandResult(0, "ok")


def _install(installer: object, option_id: str = _OPTION) -> None:
    asyncio.run(
        installer.install_model_option(  # type: ignore[attr-defined]
            option_id,
            cancel_event=asyncio.Event(),
            report_progress=lambda _progress: None,
        )
    )


def test_an_option_outside_the_release_catalog_is_rejected(tmp_path: Path) -> None:
    installer, _lifecycle = _installer(tmp_path, FakeProcessController())
    with pytest.raises(ModelOptionRejectedError):
        _install(installer, "not-in-the-catalog")


def test_a_pulled_model_with_another_digest_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installer, lifecycle = _installer(tmp_path, FakeProcessController())
    installer._runner = _SuccessfulRunner()  # noqa: SLF001
    option = dataclasses.replace(model_option(_OPTION), expected_digest="e" * 64)
    monkeypatch.setattr(_MODEL_OPTION, lambda _option_id: option)
    pulled = {"name": option.model_reference, "digest": "sha256:" + "f" * 64, "size": 1}
    monkeypatch.setattr(
        httpx, "get", lambda *_args, **_kwargs: _tags_response(lifecycle.config, [pulled])
    )
    with pytest.raises(ModelOptionRejectedError, match="digest does not match"):
        _install(installer)


def test_a_catalog_profile_whose_bytes_do_not_match_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    installer, lifecycle = _installer(tmp_path, FakeProcessController())
    installer._runner = _SuccessfulRunner()  # noqa: SLF001

    @dataclasses.dataclass(frozen=True, slots=True)
    class TamperedOption(StructuringModelOption):
        @property
        def profile_spec_sha256(self) -> str:
            return hashlib.sha256(b"not the profile bytes").hexdigest()

    tampered = TamperedOption(**dataclasses.asdict(model_option(_OPTION)))
    monkeypatch.setattr(_MODEL_OPTION, lambda _option_id: tampered)
    monkeypatch.setattr(
        httpx, "get", lambda *_args, **_kwargs: _tags_response(lifecycle.config, [])
    )
    monkeypatch.setattr(
        installer, "_verify_pulled_model", lambda _option, _lease_url: ("a" * 64, 123)
    )
    with pytest.raises(ModelOptionRejectedError, match="profile specification digest"):
        _install(installer)


@pytest.mark.parametrize(
    ("error", "retryable"),
    [
        (ModelOptionRejectedError("The model option is not in the release catalog"), False),
        (RuntimeError("Ollama model pull failed (1)"), True),
    ],
)
def test_the_job_retries_only_a_transient_failure(
    tmp_path: Path, error: Exception, retryable: bool
) -> None:
    class Installer:
        async def install_model_option(self, option_id, *, cancel_event, report_progress):
            raise error

    async def scenario() -> None:
        clock = SystemClock()
        repository = ModelInstallationRepository(tmp_path, clock=clock, retention_hours=4)
        repository.initialize()
        service = ModelInstallationService(repository, installer=Installer(), clock=clock)
        job = service.install_use_case.execute(
            idempotency_key="model", request_fingerprint="model", option_id=_OPTION
        )
        await asyncio.gather(service._tasks[job.installation_id], return_exceptions=True)
        failed = service.get_use_case.execute(job.installation_id)
        await service.shutdown()
        assert failed.status is RuntimeInstallationStatus.FAILED
        assert failed.error is not None
        assert (failed.error.code, failed.error.retryable) == ("installation_failed", retryable)

    asyncio.run(scenario())
