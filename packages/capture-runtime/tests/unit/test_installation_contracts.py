from __future__ import annotations

from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from capture_runtime.contracts import RuntimeInstallationV2

NOW = datetime(2026, 11, 2, tzinfo=UTC)


def _installation(**download: int) -> dict[str, object]:
    return {
        "installationId": "installation-1",
        "requirementId": "speech-recognition",
        "status": "running",
        "progress": 0.4,
        "createdAt": NOW.isoformat(),
        "updatedAt": NOW.isoformat(),
        **download,
    }


def test_an_installation_without_a_known_size_has_no_download_bytes() -> None:
    job = RuntimeInstallationV2.model_validate(_installation())

    assert job.download_bytes is None
    assert job.downloaded_bytes is None


def test_download_bytes_round_trip_on_the_wire() -> None:
    job = RuntimeInstallationV2.model_validate(
        _installation(downloadBytes=1000, downloadedBytes=400)
    )

    wire = job.model_dump(mode="json", by_alias=True)
    assert (wire["downloadBytes"], wire["downloadedBytes"]) == (1000, 400)


@pytest.mark.parametrize(
    "download",
    [
        {"downloadBytes": 1000},
        {"downloadedBytes": 400},
        {"downloadBytes": 1000, "downloadedBytes": 1001},
        {"downloadBytes": 0, "downloadedBytes": 0},
        {"downloadBytes": 1000, "downloadedBytes": -1},
    ],
)
def test_download_bytes_must_be_a_consistent_pair(download: dict[str, int]) -> None:
    with pytest.raises(ValidationError):
        RuntimeInstallationV2.model_validate(_installation(**download))
