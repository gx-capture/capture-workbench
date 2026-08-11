from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
MODULE_PATH = SCRIPT_DIR / "verify_release_model_candidate.py"


def _load_module() -> ModuleType:
    sys.path.insert(0, str(SCRIPT_DIR))
    try:
        spec = importlib.util.spec_from_file_location("verify_release_model_candidate", MODULE_PATH)
        assert spec is not None and spec.loader is not None
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(str(SCRIPT_DIR))


candidate = _load_module()


def test_candidate_fixture_download_requests_identity_encoding(
    tmp_path: Path,
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    class Response:
        status_code = 200
        headers = {"content-length": "3"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        def raise_for_status(self) -> None:
            return None

        async def aiter_bytes(self, _chunk_bytes: int):
            yield b"abc"

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args: object) -> None:
            return None

        def stream(self, method: str, url: str, **kwargs: object) -> Response:
            captured.update({"method": method, "url": url, **kwargs})
            return Response()

    monkeypatch.setattr(candidate.httpx, "AsyncClient", lambda **_kwargs: Client())
    destination = tmp_path / "fixture"

    asyncio.run(
        candidate._download_exact_url(
            url="https://example.invalid/fixture",
            expected_bytes=3,
            expected_sha256=hashlib.sha256(b"abc").hexdigest(),
            destination=destination,
        )
    )

    assert destination.read_bytes() == b"abc"
    assert captured["headers"] == {"Accept-Encoding": "identity"}


def test_whisper_candidate_uses_bounded_one_hour_audio_budget() -> None:
    assert candidate.WHISPER_CANDIDATE_MAX_DURATION_MS == 3_600_000
    assert candidate.WHISPER_CANDIDATE_TIMEOUT_SECONDS == 3_600


def test_cuda_source_lock_candidate_disables_cpu_fallback() -> None:
    assert candidate._whisper_run_options({"preferGpu": True, "expectedDevice": "cuda"}) == {
        "maxDurationMs": candidate.WHISPER_CANDIDATE_MAX_DURATION_MS,
        "preferGpu": True,
        "allowCpuFallback": False,
    }
