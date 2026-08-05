from __future__ import annotations

from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

import capture_runtime.workers.whisper_main as whisper_main
from capture_runtime.engine_adapters import FasterWhisperAdapter
from capture_runtime.worker_contracts import WorkerRequest


def _model_tree(root: Path, name: str) -> None:
    model = root / name
    model.mkdir(parents=True)
    for filename in ("config.json", "model.bin", "tokenizer.json", "vocabulary.json"):
        (model / filename).write_bytes(f"{name}:{filename}".encode())


def _request(model_root: Path, source: Path, *, prefer_gpu: bool) -> WorkerRequest:
    return WorkerRequest(
        request_id="whisper-worker-test",
        operation="run",
        payload={
            "requirementId": "whisper-primary",
            "artifactVersion": "0.3.10",
            "modelPath": str(model_root),
            "sourcePath": str(source),
            "mediaType": "audio/wav",
            "options": {
                "maxDurationMs": 60_000,
                "preferGpu": prefer_gpu,
            },
        },
    )


def _probe_request(*, options: object) -> WorkerRequest:
    return WorkerRequest(
        request_id="whisper-worker-probe-test",
        operation="probe",
        payload={
            "requirementId": "whisper-primary",
            "artifactVersion": "0.3.10",
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
    with pytest.raises(ValueError, match="Whisper probe"):
        whisper_main._probe(_probe_request(options=options))


def _run_with_factory(
    monkeypatch: pytest.MonkeyPatch,
    request: WorkerRequest,
    *,
    fail_cuda: bool,
) -> tuple[dict[str, object], list[tuple[str, str]], list[dict[str, object]]]:
    calls: list[tuple[str, str]] = []
    constructors: list[dict[str, object]] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: object):
            return [SimpleNamespace(start=0.0, end=1.0, text="worker words")], SimpleNamespace(
                duration=1.0
            )

    def factory(path: str, *, device: str, compute_type: str) -> Model:
        del compute_type
        calls.append((Path(path).name, device))
        if fail_cuda and device == "cuda":
            raise RuntimeError("CUDA out of memory")
        return Model()

    class TestAdapter(FasterWhisperAdapter):
        def __init__(self, model_path: Path, **kwargs: object) -> None:
            constructors.append(kwargs)
            super().__init__(
                model_path,
                model_factory=factory,
                cuda_count=lambda: 1,
                **kwargs,
            )

    monkeypatch.setattr(whisper_main, "FasterWhisperAdapter", TestAdapter)
    monkeypatch.setattr(whisper_main, "_import_whisper_runtime", lambda: None)
    return whisper_main._run(request, Event()), calls, constructors


def test_worker_reports_actual_gpu_model_name_for_primary_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_root = tmp_path / "models"
    _model_tree(model_root, "primary")
    _model_tree(model_root, "fallback")
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
    assert constructors[0]["primary_provenance_model"] == "large-v3-turbo"
    assert constructors[0]["fallback_provenance_model"] == "small"
    assert result["provenance"] == {
        "engine": "whisper-primary",
        "model": "large-v3-turbo",
        "device": "cuda",
        "digest": result["provenance"]["digest"],
    }


def test_worker_reports_actual_cpu_model_name_after_gpu_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_root = tmp_path / "models"
    _model_tree(model_root, "primary")
    _model_tree(model_root, "fallback")
    source = tmp_path / "fixture.wav"
    source.write_bytes(b"RIFF" + b"\x00" * 8 + b"WAVE")

    result, calls, _constructors = _run_with_factory(
        monkeypatch,
        _request(model_root, source, prefer_gpu=True),
        fail_cuda=True,
    )

    assert calls == [("primary", "cuda"), ("fallback", "cpu")]
    assert result["provenance"]["model"] == "small"
    assert result["provenance"]["device"] == "cpu"
    assert result["warnings"] == ["Whisper GPU fallback: CUDA out of memory"]
