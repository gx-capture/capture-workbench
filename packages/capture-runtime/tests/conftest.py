from __future__ import annotations

import time
from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient

from capture_runtime.app import create_app
from capture_runtime.config import RuntimeSettings

TOKEN = "capture-test-token-abcdefghijklmnopqrstuvwxyz-123456"


@pytest.fixture
def settings_factory(tmp_path: Path) -> Callable[..., RuntimeSettings]:
    counter = 0

    def create(**overrides: str) -> RuntimeSettings:
        nonlocal counter
        counter += 1
        environment = {
            "CAPTURE_HOST": "127.0.0.1",
            "CAPTURE_PORT": str(9000 + counter),
            "CAPTURE_API_TOKEN": TOKEN,
            "CAPTURE_ALLOWED_HOSTS": f"127.0.0.1:{9000 + counter}",
            "CAPTURE_ALLOWED_ORIGINS": "tauri://localhost",
            "CAPTURE_APP_DATA_DIR": str(tmp_path / f"runtime-{counter}"),
            "CAPTURE_EXTRACTION_PROVIDER": "fake",
            "CAPTURE_STRUCTURING_PROVIDER": "fake",
        }
        environment.update(overrides)
        return RuntimeSettings.from_env(environment)

    return create


@pytest.fixture
def client(settings_factory: Callable[..., RuntimeSettings]) -> Generator[TestClient, None, None]:
    settings = settings_factory()
    with TestClient(
        create_app(settings),
        base_url=f"http://127.0.0.1:{settings.port}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    ) as test_client:
        yield test_client


def idempotency_headers() -> dict[str, str]:
    return {"X-Idempotency-Key": str(uuid4())}


def poll_installation(
    client: TestClient,
    installation_id: str,
    predicate: Callable[[dict[str, Any]], bool],
) -> dict[str, Any]:
    deadline = time.monotonic() + 3
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        response = client.get(f"/v2/runtime/installations/{installation_id}")
        assert response.status_code == 200, response.text
        last = response.json()
        if predicate(last):
            return last
        time.sleep(0.01)
    raise AssertionError(f"installation did not reach expected state: {last}")
