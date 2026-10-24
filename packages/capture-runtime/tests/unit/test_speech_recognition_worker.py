from __future__ import annotations

from pathlib import Path
from threading import Event

import pytest

import capture_runtime.workers.speech_recognition_main as whisper_main
from capture_runtime.constants import RUNTIME_VERSION
from capture_runtime.speech_recognition import TeaAsrAdapter
from capture_runtime.worker_contracts import WorkerRequest
from tests.speech_model_fakes import FakeModels, model_tree


def _request(
    model_root: Path,
    source: Path,
    *,
    prefer_gpu: bool,
    allow_cpu_fallback: bool | None = None,
) -> WorkerRequest:
    options: dict[str, object] = {
        "maxDurationMs": 60_000,
        "preferGpu": prefer_gpu,
    }
    if allow_cpu_fallback is not None:
        options["allowCpuFallback"] = allow_cpu_fallback
    return WorkerRequest(
        request_id="speech-recognition-worker-test",
        operation="run",
        payload={
            "requirementId": "speech-recognition",
            "artifactVersion": RUNTIME_VERSION,
            "modelPath": str(model_root),
            "sourcePath": str(source),
            "mediaType": "audio/wav",
            "options": options,
        },
    )


def _probe_request(*, options: object) -> WorkerRequest:
    return WorkerRequest(
        request_id="speech-recognition-worker-probe-test",
        operation="probe",
        payload={
            "requirementId": "speech-recognition",
            "artifactVersion": RUNTIME_VERSION,
            "modelPath": None,
            "options": options,
        },
    )


def test_worker_code_probe_accepts_prefer_gpu_install_option(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(whisper_main.importlib.util, "find_spec", lambda _name: object())
    result = whisper_main._probe(_probe_request(options={"preferGpu": True}))

    assert result["ready"] is True
    assert result["codeReady"] is True
    assert result["assetsReady"] is False
    assert result["device"] is None


@pytest.mark.parametrize("options", [{"unexpected": True}, {"preferGpu": 1}, None])
def test_worker_code_probe_rejects_invalid_options(options: object) -> None:
    with pytest.raises(ValueError, match="Speech recognition probe"):
        whisper_main._probe(_probe_request(options=options))


def _run_with_factory(
    monkeypatch: pytest.MonkeyPatch,
    request: WorkerRequest,
    *,
    fail_cuda: bool,
) -> tuple[dict[str, object], list[tuple[str, str]], list[dict[str, object]]]:
    calls: list[tuple[str, str]] = []
    constructors: list[dict[str, object]] = []

    fake = FakeModels(monkeypatch)
    if fail_cuda:
        fake.failures[("asr", "inference")] = RuntimeError("CUDA out of memory")

    class TestAdapter(TeaAsrAdapter):
        def __init__(self, model_path: Path, **kwargs: object) -> None:
            constructors.append(kwargs)
            super().__init__(
                model_path,
                torch_module=fake._torch(),
                transformers_module=fake._transformers(),
                decoder=lambda *_a, **_k: [0.0] * 16_000,
                **kwargs,
            )

    monkeypatch.setattr(whisper_main, "TeaAsrAdapter", TestAdapter)
    monkeypatch.setattr(whisper_main, "_import_speech_runtime", lambda: None)
    result = whisper_main._run(request, Event())
    calls = [
        (Path(event[2]).name, "cuda" if i == 0 else "cpu")
        for i, event in enumerate(fake.loads("asr"))
    ]
    return result, calls, constructors


def test_worker_reports_actual_gpu_model_name_for_primary_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = iter(range(0, 1000, 5))
    monkeypatch.setattr("capture_runtime.speech_recognition.time.perf_counter", lambda: next(clock))
    model_root = tmp_path / "models"
    model_tree(model_root)
    source = tmp_path / "fixture.wav"
    source.write_bytes(b"RIFF" + b"\x00" * 8 + b"WAVE")

    result, calls, constructors = _run_with_factory(
        monkeypatch,
        _request(model_root, source, prefer_gpu=True),
        fail_cuda=False,
    )

    assert calls == [("primary", "cuda")]
    assert constructors[0]["primary_model"] == "primary"
    assert constructors[0]["fallback_model"] == "fallback"
    assert constructors[0]["primary_provenance_model"] == "tea-asr-1.1"
    assert constructors[0]["fallback_provenance_model"] == "tea-asr-1.1-mini"
    assert result["provenance"] == {
        "engine": "speech-recognition",
        "model": "tea-asr-1.1",
        "device": "cuda",
        "digest": result["provenance"]["digest"],
        "elapsedMs": 45000,
        "stageMs": {
            "modelLoad": 5000,
            "transcription": 5000,
            "alignerLoad": 5000,
            "alignment": 5000,
        },
    }


def test_worker_reports_actual_cpu_model_name_after_gpu_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_root = tmp_path / "models"
    model_tree(model_root)
    source = tmp_path / "fixture.wav"
    source.write_bytes(b"RIFF" + b"\x00" * 8 + b"WAVE")

    result, calls, _constructors = _run_with_factory(
        monkeypatch,
        _request(model_root, source, prefer_gpu=True),
        fail_cuda=True,
    )

    assert calls == [("primary", "cuda"), ("fallback", "cpu")]
    assert result["provenance"]["model"] == "tea-asr-1.1-mini"
    assert result["provenance"]["device"] == "cpu"
    assert result["warnings"] == ["Speech recognition GPU fallback: RuntimeError"]


def test_worker_strict_cuda_failure_does_not_run_cpu_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_root = tmp_path / "models"
    model_tree(model_root)
    source = tmp_path / "fixture.wav"
    source.write_bytes(b"RIFF" + b"\x00" * 8 + b"WAVE")

    with pytest.raises(RuntimeError, match="CUDA out of memory"):
        _run_with_factory(
            monkeypatch,
            _request(
                model_root,
                source,
                prefer_gpu=True,
                allow_cpu_fallback=False,
            ),
            fail_cuda=True,
        )
