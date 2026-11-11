from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from capture_runtime.capture.infrastructure.capture_worker_client import WorkerClient
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.provisioning.infrastructure import engine_installation
from capture_runtime.provisioning.infrastructure.engine_catalog import (
    EngineCatalog,
    canonical_json_bytes,
)
from capture_runtime.provisioning.infrastructure.engine_installation import (
    EngineInstallationManager,
)
from capture_runtime.worker_contracts import WORKER_PROTOCOL_VERSION
from tests.direct_model_fixtures import approved_source_lock

SCRIPT_DIR = Path(__file__).resolve().parents[2] / "scripts"
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


def _worker(requirement_id: str, file_name: str, version: str) -> dict[str, object]:
    return {
        "role": "worker",
        "requirementId": requirement_id,
        "artifactVersion": version,
        "workerProtocolVersion": WORKER_PROTOCOL_VERSION,
        "platform": "windows",
        "arch": "x86_64",
        "fileName": file_name,
        "bytes": 4,
        "sha256": hashlib.sha256(file_name.encode()).hexdigest(),
        "extractedBytes": 1,
        "entryPoint": file_name.removesuffix(".zip") + ".exe",
        "filesManifestSha256": "e" * 64,
        "url": f"https://example.invalid/{file_name}",
    }


def _with_files(delivery: dict[str, Any], files: list[dict[str, Any]]) -> dict[str, Any]:
    """The delivery with other files, still a valid catalog entry."""

    ordered = sorted(files, key=lambda item: item["path"])
    manifest = {
        "artifactVersion": delivery["artifactVersion"],
        "entryPoint": delivery["entryPoint"],
        "files": ordered,
        "manifestVersion": "1",
    }
    return {
        **delivery,
        "entryCount": len(ordered),
        "extractedBytes": sum(item["bytes"] for item in ordered),
        "files": ordered,
        "manifestSha256": hashlib.sha256(canonical_json_bytes(manifest)).hexdigest(),
    }


def _candidate_catalog(
    lock: dict[str, Any],
    *,
    speech_contents: bool,
    cuda_files: dict[str, Any] | None = None,
    cpu_files: dict[str, Any] | None = None,
    legacy_speech_files: dict[str, Any] | None = None,
) -> EngineCatalog:
    """The catalog the generator writes for ``lock``, with optional replaced deliveries."""

    requirements: list[dict[str, object]] = []
    for locked in lock["requirements"]:
        requirement_id = locked["requirementId"]
        delivery = candidate.model_delivery(lock, requirement_id)
        version = delivery["artifactVersion"]
        if requirement_id == "vertical-japanese-reader":
            requirements.append(
                {
                    "requirementId": requirement_id,
                    "artifacts": [],
                    "modelFiles": delivery,
                    "unavailableReason": None,
                }
            )
        elif requirement_id == "speech-recognition" and speech_contents:
            requirements.append(
                {
                    "requirementId": requirement_id,
                    "contents": [
                        {
                            "id": "cuda",
                            "artifacts": [
                                _worker(
                                    requirement_id,
                                    "capture-engine-speech-recognition.zip",
                                    version,
                                )
                            ],
                            "modelFiles": cuda_files or delivery,
                            "unavailableReason": None,
                        },
                        {
                            "id": "cpu",
                            "artifacts": [
                                _worker(
                                    requirement_id,
                                    "capture-engine-speech-recognition-cpu.zip",
                                    version,
                                )
                            ],
                            "modelFiles": cpu_files or candidate.cpu_speech_model_delivery(lock),
                            "unavailableReason": None,
                        },
                    ],
                }
            )
        else:
            name = {
                "windowsml-ocr": "capture-engine-ocr.zip",
                "speech-recognition": "capture-engine-speech-recognition.zip",
            }[requirement_id]
            if requirement_id == "speech-recognition" and legacy_speech_files is not None:
                delivery = legacy_speech_files
            requirements.append(
                {
                    "requirementId": requirement_id,
                    "artifacts": [_worker(requirement_id, name, version)],
                    "modelFiles": delivery,
                    "unavailableReason": None,
                }
            )
    return EngineCatalog.from_dict(
        {"catalogVersion": "2", "runtimeVersion": RUNTIME_VERSION, "requirements": requirements}
    )


def _locked_speech_file(lock: dict[str, Any], path: str) -> dict[str, Any]:
    speech = next(
        item for item in lock["requirements"] if item["requirementId"] == "speech-recognition"
    )
    return dict(next(item for item in speech["files"] if item["path"] == path))


def test_candidate_catalog_binding_accepts_the_generated_legacy_and_contents_catalogs() -> None:
    lock, _content = approved_source_lock()

    candidate._assert_candidate_catalog_bound(_candidate_catalog(lock, speech_contents=False), lock)
    candidate._assert_candidate_catalog_bound(_candidate_catalog(lock, speech_contents=True), lock)


def _cpu_delivery_variant(lock: dict[str, Any], variant: str) -> dict[str, Any]:
    subset = candidate.cpu_speech_model_delivery(lock)
    files = [dict(item) for item in subset["files"]]

    def changed(path: str, **fields: object) -> list[dict[str, Any]]:
        return [{**item, **fields} if item["path"] == path else item for item in files]

    if variant == "a file outside the lock":
        outside = _locked_speech_file(lock, "model/fallback/tokenizer.json")
        outside["path"] = "model/fallback/unlocked.json"
        return _with_files(subset, [*files, outside])
    if variant == "a wrong size":
        locked = _locked_speech_file(lock, "model/fallback/model.safetensors")
        return _with_files(
            subset, changed("model/fallback/model.safetensors", bytes=locked["bytes"] + 1)
        )
    if variant == "a wrong hash":
        return _with_files(subset, changed("model/fallback/model.safetensors", sha256="0" * 64))
    if variant == "a primary path":
        return _with_files(
            subset,
            [
                *files,
                _locked_speech_file(lock, "model/primary/model.safetensors"),
                _locked_speech_file(lock, "licenses/NOTICE-primary.md"),
            ],
        )
    if variant == "a missing expected path":
        return _with_files(
            subset, [item for item in files if item["path"] != "model/fallback/tokenizer.json"]
        )
    assert variant == "the full cuda delivery"
    return candidate.model_delivery(lock, "speech-recognition")


@pytest.mark.parametrize(
    "variant",
    [
        "a file outside the lock",
        "a wrong size",
        "a wrong hash",
        "a primary path",
        "a missing expected path",
        "the full cuda delivery",
    ],
)
def test_candidate_catalog_binding_rejects_a_cpu_content_with(variant: str) -> None:
    lock, _content = approved_source_lock()
    catalog = _candidate_catalog(
        lock, speech_contents=True, cpu_files=_cpu_delivery_variant(lock, variant)
    )

    with pytest.raises(candidate.EngineInstallationError, match="incomplete or not bound"):
        candidate._assert_candidate_catalog_bound(catalog, lock)


def test_candidate_catalog_binding_rejects_a_cuda_content_that_is_not_the_full_lock() -> None:
    lock, _content = approved_source_lock()
    catalog = _candidate_catalog(
        lock,
        speech_contents=True,
        cuda_files=candidate.cpu_speech_model_delivery(lock),
    )

    with pytest.raises(candidate.EngineInstallationError, match="incomplete or not bound"):
        candidate._assert_candidate_catalog_bound(catalog, lock)


def test_candidate_catalog_binding_rejects_an_unavailable_cpu_content() -> None:
    lock, _content = approved_source_lock()
    payload = _candidate_catalog(lock, speech_contents=True).to_dict()
    speech = next(
        item for item in payload["requirements"] if item["requirementId"] == "speech-recognition"
    )
    speech["contents"][1] = {
        "id": "cpu",
        "artifacts": [],
        "modelFiles": None,
        "unavailableReason": "The CPU speech worker archive was not supplied.",
    }

    with pytest.raises(candidate.EngineInstallationError, match="incomplete or not bound"):
        candidate._assert_candidate_catalog_bound(EngineCatalog.from_dict(payload), lock)


def test_candidate_catalog_binding_keeps_the_legacy_source_lock_check() -> None:
    lock, _content = approved_source_lock()
    other_lock = {**lock, "releaseVersion": "0.0.0-other"}
    rebound = {
        **candidate.model_delivery(lock, "speech-recognition"),
        "sourceLockSha256": candidate.source_lock_sha256(other_lock),
    }
    catalog = _candidate_catalog(lock, speech_contents=False, legacy_speech_files=rebound)

    with pytest.raises(candidate.EngineInstallationError, match="incomplete or not bound"):
        candidate._assert_candidate_catalog_bound(catalog, lock)


class _DownloadRequested(Exception):
    pass


def _first_worker_download(
    manager: EngineInstallationManager,
    monkeypatch: pytest.MonkeyPatch,
) -> str:
    """Install speech up to the first worker download and return the archive it asks for."""

    requested: list[str] = []

    async def record(_self, descriptor, _destination, *, cancel_event, progress) -> None:
        requested.append(descriptor.file_name)
        raise _DownloadRequested

    monkeypatch.setattr(candidate.LocalWorkerDownloader, "download", record)
    with pytest.raises(_DownloadRequested):
        asyncio.run(
            manager.install(
                "speech-recognition",
                cancel_event=asyncio.Event(),
                report_progress=lambda _value: None,
                probe_options={"preferGpu": True},
            )
        )
    assert len(requested) == 1
    return requested[0]


def test_candidate_installs_the_cuda_speech_content_on_a_machine_without_a_driver(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock, _content = approved_source_lock()
    catalog = _candidate_catalog(lock, speech_contents=True)
    driver_probes: list[bool] = []

    def no_driver() -> bool:
        driver_probes.append(False)
        return False

    monkeypatch.setattr(engine_installation, "detect_nvidia_driver", no_driver)

    # Without the pin, this machine installs the cpu content.
    unpinned = EngineInstallationManager(
        tmp_path / "auto",
        catalog,
        worker_client=WorkerClient(),
        downloader=candidate.LocalWorkerDownloader(tmp_path),
    )
    assert (
        _first_worker_download(unpinned, monkeypatch) == "capture-engine-speech-recognition-cpu.zip"
    )
    assert driver_probes == [False]

    pinned = candidate._candidate_installation_manager(
        tmp_path / "candidate", catalog, WorkerClient(), tmp_path
    )
    assert _first_worker_download(pinned, monkeypatch) == "capture-engine-speech-recognition.zip"
    # The pinned manager never asks the driver.
    assert driver_probes == [False]


def test_candidate_pin_does_not_change_a_legacy_speech_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock, _content = approved_source_lock()
    catalog = _candidate_catalog(lock, speech_contents=False)
    monkeypatch.setattr(engine_installation, "detect_nvidia_driver", lambda: False)
    unpinned = EngineInstallationManager(
        tmp_path / "auto",
        catalog,
        worker_client=WorkerClient(),
        downloader=candidate.LocalWorkerDownloader(tmp_path),
    )
    pinned = candidate._candidate_installation_manager(
        tmp_path / "candidate", catalog, WorkerClient(), tmp_path
    )

    assert (
        _first_worker_download(pinned, monkeypatch)
        == _first_worker_download(unpinned, monkeypatch)
        == "capture-engine-speech-recognition.zip"
    )
