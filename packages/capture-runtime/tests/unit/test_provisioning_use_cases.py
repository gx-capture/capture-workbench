"""Unit tests for provisioning application use cases."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from capture_runtime.contracts import RuntimeInstallationV2, RuntimeRequirementV2
from capture_runtime.provisioning.application.use_cases import (
    CancelInstallation,
    GetInstallation,
    InstallRequirement,
    ListInstallations,
    ListRequirements,
    UninstallRequirement,
)


@pytest.mark.anyio
async def test_install_requirement_use_case() -> None:
    mock_service = MagicMock()
    mock_job = MagicMock(spec=RuntimeInstallationV2)
    mock_service.create.return_value = mock_job

    use_case = InstallRequirement(mock_service)
    result = use_case.execute(
        idempotency_key="key-1",
        request_fingerprint="fp-1",
        requirement_id="req-1",
    )

    assert result is mock_job
    mock_service.create.assert_called_once_with(
        idempotency_key="key-1",
        request_fingerprint="fp-1",
        requirement_id="req-1",
    )


@pytest.mark.anyio
async def test_get_and_list_installations_use_cases() -> None:
    mock_service = MagicMock()
    mock_job = MagicMock(spec=RuntimeInstallationV2)
    mock_service.get.return_value = mock_job
    mock_service.list.return_value = [mock_job]

    get_uc = GetInstallation(mock_service)
    list_uc = ListInstallations(mock_service)

    assert get_uc.execute("job-1") is mock_job
    assert list_uc.execute() == [mock_job]


@pytest.mark.anyio
async def test_cancel_installation_use_case() -> None:
    mock_service = MagicMock()
    mock_job = MagicMock(spec=RuntimeInstallationV2)
    mock_service.cancel = AsyncMock(return_value=mock_job)

    use_case = CancelInstallation(mock_service)
    result = await use_case.execute("job-1")

    assert result is mock_job
    mock_service.cancel.assert_awaited_once_with("job-1")


@pytest.mark.anyio
async def test_uninstall_requirement_use_case() -> None:
    mock_service = MagicMock()
    mock_service.uninstall = AsyncMock()
    mock_gate = MagicMock()

    use_case = UninstallRequirement(mock_service)
    await use_case.execute("req-1", captures=mock_gate)

    mock_service.uninstall.assert_awaited_once_with("req-1", captures=mock_gate)


def test_list_requirements_use_case() -> None:
    mock_installer = MagicMock()
    req1 = MagicMock(spec=RuntimeRequirementV2, requirement_id="req-1")
    req2 = MagicMock(spec=RuntimeRequirementV2, requirement_id="req-2")
    mock_installer.requirements.return_value = [req1, req2]

    use_case = ListRequirements(mock_installer)
    results = use_case.execute(
        enabled_requirement_ids={"req-1", "req-2"},
        disabled_requirement_ids={"req-2"},
    )

    assert results == [req1]
    mock_installer.requirements.assert_called_once_with({"req-1", "req-2"})
