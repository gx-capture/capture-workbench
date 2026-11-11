from __future__ import annotations

import asyncio
import hashlib
import importlib.util
import sys
from pathlib import Path
from types import ModuleType
from typing import Any, cast

import pytest

from capture_runtime._worker_payloads import WorkerProbeResult, WorkerRunResult, WorkerSegment
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
from capture_runtime.worker_client import InstalledEngine
from capture_runtime.worker_contracts import WORKER_PROTOCOL_VERSION
from tests.direct_model_fixtures import approved_source_lock, pending_source_lock

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


def test_cpu_pass_installs_the_cpu_speech_content_on_a_machine_with_a_driver(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock, _content = approved_source_lock()
    catalog = _candidate_catalog(lock, speech_contents=True)
    driver_probes: list[bool] = []

    def driver() -> bool:
        driver_probes.append(True)
        return True

    monkeypatch.setattr(engine_installation, "detect_nvidia_driver", driver)
    manager = candidate._candidate_installation_manager(
        tmp_path / "cpu", catalog, WorkerClient(), tmp_path, speech_variant="cpu"
    )

    assert _first_worker_download(manager, monkeypatch) == (
        "capture-engine-speech-recognition-cpu.zip"
    )
    assert driver_probes == []


def _write_candidate_inputs(
    tmp_path: Path, lock: dict[str, Any], payload: dict[str, Any]
) -> tuple[Path, Path]:
    lock_path = tmp_path / "model-source-lock.json"
    lock_path.write_bytes(canonical_json_bytes(lock))
    catalog_path = tmp_path / "capture-engine-catalog.json"
    catalog_path.write_bytes(canonical_json_bytes(payload))
    return lock_path, catalog_path


def _speech_payload(payload: dict[str, Any]) -> dict[str, Any]:
    return next(
        item for item in payload["requirements"] if item["requirementId"] == "speech-recognition"
    )


@pytest.mark.parametrize("shape", ["legacy", "cuda only", "cpu only"])
def test_model_enabled_candidate_requires_both_speech_contents(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, shape: str
) -> None:
    lock, _content = approved_source_lock()
    payload = _candidate_catalog(lock, speech_contents=shape != "legacy").to_dict()
    if shape != "legacy":
        kept = "cuda" if shape == "cuda only" else "cpu"
        speech = _speech_payload(payload)
        speech["contents"] = [item for item in speech["contents"] if item["id"] == kept]
    lock_path, catalog_path = _write_candidate_inputs(tmp_path, lock, payload)
    monkeypatch.delenv("CAPTURE_PRIVATE_WHISPER_FIXTURE", raising=False)
    output = tmp_path / "evidence.json"

    with pytest.raises(candidate.EngineInstallationError, match="cuda and cpu contents"):
        asyncio.run(
            candidate.verify_candidate(
                catalog_path=catalog_path,
                engine_dir=tmp_path,
                source_lock_path=lock_path,
                output=output,
                private_whisper_fixture=None,
            )
        )
    assert not output.exists()


def test_model_enabled_candidate_with_both_speech_contents_goes_on_to_the_fixtures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock, _content = approved_source_lock()
    payload = _candidate_catalog(lock, speech_contents=True).to_dict()
    lock_path, catalog_path = _write_candidate_inputs(tmp_path, lock, payload)
    monkeypatch.delenv("CAPTURE_PRIVATE_WHISPER_FIXTURE", raising=False)

    with pytest.raises(candidate.EngineInstallationError, match="private Whisper fixture"):
        asyncio.run(
            candidate.verify_candidate(
                catalog_path=catalog_path,
                engine_dir=tmp_path,
                source_lock_path=lock_path,
                output=tmp_path / "evidence.json",
                private_whisper_fixture=None,
            )
        )


def test_speech_preflight_still_reads_a_legacy_catalog(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    lock = pending_source_lock()
    payload = _candidate_catalog(lock, speech_contents=False).to_dict()
    lock_path, catalog_path = _write_candidate_inputs(tmp_path, lock, payload)
    monkeypatch.delenv("CAPTURE_PRIVATE_WHISPER_FIXTURE", raising=False)

    # The legacy catalog passes the binding check and stops only at the
    # missing private fixture, not at the release rule for both speech packs.
    with pytest.raises(candidate.EngineInstallationError, match="private Whisper fixture"):
        asyncio.run(
            candidate.verify_candidate(
                catalog_path=catalog_path,
                engine_dir=tmp_path,
                source_lock_path=lock_path,
                output=tmp_path / "evidence.json",
                private_whisper_fixture=None,
                preflight=True,
            )
        )


class _FakeCpuWorker:
    """Answers the cpu pass's probe and run with chosen provenance."""

    def __init__(
        self,
        *,
        probe_ready: bool = True,
        probe_device: str = "cpu",
        model: str = "tea-asr-1.1-mini",
        device: str = "cpu",
        text: str = "fixture words",
    ) -> None:
        self.probe_ready, self.probe_device = probe_ready, probe_device
        self.model, self.device, self.text = model, device, text
        self.probe_options: list[dict[str, object] | None] = []
        self.run_options: list[dict[str, object]] = []

    async def probe(
        self,
        _engine: InstalledEngine,
        *,
        include_model: bool,
        options: dict[str, object] | None = None,
        timeout_seconds: float = 0,
    ) -> WorkerProbeResult:
        assert include_model
        self.probe_options.append(options)
        return WorkerProbeResult(
            ready=self.probe_ready,
            code_ready=True,
            assets_ready=self.probe_ready,
            detail="probe",
            device=self.probe_device,
        )

    async def run(
        self,
        _engine: InstalledEngine,
        *,
        source_path: Path,
        media_type: str,
        options: dict[str, object],
        cancel_event: asyncio.Event,
        timeout_seconds: float,
    ) -> WorkerRunResult:
        self.run_options.append(options)
        return WorkerRunResult(
            segments=(
                WorkerSegment(order=0, text=self.text, start_ms=0, end_ms=1_000),
                WorkerSegment(order=1, text=self.text, start_ms=1_000, end_ms=2_000),
            ),
            engine="speech-recognition",
            model=self.model,
            digest="sha256:" + "a" * 64,
            device=self.device,
            warnings=(),
        )


def _cpu_engine(tmp_path: Path, content_id: str | None = "cpu") -> InstalledEngine:
    return InstalledEngine(
        requirement_id="speech-recognition",
        artifact_version=RUNTIME_VERSION,
        executable=tmp_path / "capture-engine-speech-recognition-cpu.exe",
        model_dir=tmp_path / "model",
        content_id=content_id,
    )


def _cpu_pass(tmp_path: Path, worker: _FakeCpuWorker, content_id: str | None = "cpu"):
    lock, _content = approved_source_lock()
    fixture = next(item for item in lock["fixtures"] if item["kind"] == "whisper")
    return asyncio.run(
        candidate._verify_cpu_speech_engine(
            _cpu_engine(tmp_path, content_id),
            cast(Any, worker),
            source_path=tmp_path / "whisper",
            fixture=fixture,
        )
    ), fixture


def test_cpu_pass_records_mini_on_the_cpu_without_the_transcript(tmp_path: Path) -> None:
    worker = _FakeCpuWorker()

    evidence, fixture = _cpu_pass(tmp_path, worker)

    assert worker.probe_options == [{"preferGpu": True, "content": "cpu"}]
    assert worker.run_options == [
        {
            "maxDurationMs": candidate.WHISPER_CANDIDATE_MAX_DURATION_MS,
            "preferGpu": True,
            "allowCpuFallback": True,
            "content": "cpu",
        }
    ]
    assert evidence == {
        "assertionsPassed": True,
        "contentId": "cpu",
        "device": "cpu",
        "digest": "sha256:" + "a" * 64,
        "engine": "speech-recognition",
        "fixtureSha256": fixture["sha256"],
        "model": "tea-asr-1.1-mini",
        "normalizedOutputSha256": hashlib.sha256(b"fixture words fixture words").hexdigest(),
        "requirementId": "speech-recognition",
        "segmentCount": 2,
        "segmentsMonotonic": True,
    }
    assert b"fixture words" not in canonical_json_bytes(evidence)


@pytest.mark.parametrize(
    ("worker", "content_id", "message"),
    [
        (_FakeCpuWorker(model="tea-asr-1.1"), "cpu", "output/provenance"),
        (_FakeCpuWorker(device="cuda"), "cpu", "output/provenance"),
        (_FakeCpuWorker(text="   "), "cpu", "output/provenance"),
        (_FakeCpuWorker(probe_device="cuda"), "cpu", "probe"),
        (_FakeCpuWorker(probe_ready=False), "cpu", "probe"),
        (_FakeCpuWorker(), "cuda", "did not activate"),
        (_FakeCpuWorker(), None, "did not activate"),
    ],
    ids=[
        "the full model",
        "a cuda device",
        "an empty transcript",
        "a cuda probe",
        "a probe that is not ready",
        "the cuda content",
        "a legacy install",
    ],
)
def test_cpu_pass_rejects(
    tmp_path: Path, worker: _FakeCpuWorker, content_id: str | None, message: str
) -> None:
    with pytest.raises(candidate.EngineInstallationError, match=message):
        _cpu_pass(tmp_path, worker, content_id)


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
