from __future__ import annotations

import asyncio
import hashlib
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

import capture_runtime.engine_adapters as engine_adapters
import capture_runtime.extractors as extractor_module
from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig, OllamaRuntimeConfig, RuntimeSettings
from capture_runtime.contracts import CaptureSource
from capture_runtime.engine_adapters import (
    EngineProbe,
    EngineRuntimeUnavailableError,
    FasterWhisperAdapter,
    OcrTextResult,
    WhisperTextSegment,
    WhisperTranscriptionResult,
    WindowsMLOcrAdapter,
)
from capture_runtime.extractors import (
    ExtractionRuntimeUnavailableError,
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.ollama import (
    IsolatedOllamaLifecycle,
)
from capture_runtime.worker_client import InstalledEngine, WorkerRunResult, WorkerSegment


def _write_windowsml_models(root: Path) -> None:
    for relative in (
        "det/inference.onnx",
        "det/inference.yml",
        "rec/inference.onnx",
        "rec/inference.yml",
        "rec/ppocrv6_dict.txt",
        "pipeline.json",
    ):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(relative.encode())


def _write_whisper_model(root: Path, model: str) -> None:
    directory = root / model
    directory.mkdir(parents=True, exist_ok=True)
    for name in ("config.json", "model.bin", "tokenizer.json", "vocabulary.json"):
        (directory / name).write_bytes(f"{model}:{name}".encode())


def test_windows_cuda_count_uses_system_driver_api(monkeypatch: pytest.MonkeyPatch) -> None:
    class Function:
        def __init__(self, callback):
            self.callback = callback
            self.argtypes = None
            self.restype = None

        def __call__(self, *args):
            return self.callback(*args)

    def set_count(pointer) -> int:
        pointer._obj.value = 2
        return 0

    driver = SimpleNamespace(
        cuInit=Function(lambda flags: 0 if flags == 0 else 1),
        cuDeviceGetCount=Function(set_count),
    )

    def load_driver(name: str, *, winmode: int):
        assert name == "nvcuda.dll"
        assert winmode == engine_adapters.LOAD_LIBRARY_SEARCH_SYSTEM32
        return driver

    monkeypatch.setattr(engine_adapters.sys, "platform", "win32")
    monkeypatch.setattr(engine_adapters.ctypes, "WinDLL", load_driver, raising=False)

    assert engine_adapters._windows_cuda_device_count() == 2


def test_windows_cuda_count_fails_closed_without_driver(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def missing_driver(*_args, **_kwargs):
        raise OSError("missing")

    monkeypatch.setattr(engine_adapters.sys, "platform", "win32")
    monkeypatch.setattr(
        engine_adapters.ctypes,
        "WinDLL",
        missing_driver,
        raising=False,
    )

    assert engine_adapters._windows_cuda_device_count() == 0


def test_offline_huggingface_stub_blocks_model_downloads() -> None:
    module_names = (
        "huggingface_hub",
        "huggingface_hub.logging",
        "huggingface_hub.utils",
    )
    original = {name: engine_adapters.sys.modules.get(name) for name in module_names}
    try:
        for name in module_names:
            engine_adapters.sys.modules.pop(name, None)
        engine_adapters._install_offline_huggingface_stubs()
        package = engine_adapters.sys.modules["huggingface_hub"]
        utils = engine_adapters.sys.modules["huggingface_hub.utils"]

        package.logging.set_verbosity_error()
        with pytest.raises(
            EngineRuntimeUnavailableError,
            match="only uses checksum-verified local model assets",
        ):
            package.snapshot_download("forbidden")
        assert issubclass(utils.RepositoryNotFoundError, utils.HfHubHTTPError)
    finally:
        for name in module_names:
            engine_adapters.sys.modules.pop(name, None)
            if original[name] is not None:
                engine_adapters.sys.modules[name] = original[name]


def _config(tmp_path: Path) -> ExtractionRuntimeConfig:
    return ExtractionRuntimeConfig(
        windowsml_model_dir=tmp_path / "windowsml",
        whisper_models_dir=tmp_path / "whisper",
        temp_dir=tmp_path / "temp",
        windowsml_device_id=0,
        max_pdf_pages=10,
        max_image_pixels=100_000,
        ocr_render_scale=2,
        max_audio_duration_ms=60_000,
        whisper_primary_model="large-v3-turbo",
        whisper_fallback_model="small",
        whisper_prefer_gpu=True,
    )


def test_windowsml_adapter_prefers_dml_with_cert_prep_adapter_zero_and_model_digest(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    configurations: list[dict[str, object]] = []

    class Result:
        json = {"res": {"rec_texts": ["First", "Second"]}}

    class Pipeline:
        def predict(self, source: str) -> list[Result]:
            assert Path(source).is_file()
            return [Result()]

    def factory(**kwargs: object) -> Pipeline:
        configurations.append(kwargs["engine_config"])
        return Pipeline()

    adapter = WindowsMLOcrAdapter(
        model_dir,
        pipeline_factory=factory,
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )
    result = adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")
    assert result.text == "First\nSecond"
    assert result.device == "windowsml-dml"
    assert result.digest.startswith("sha256:")
    assert result.warning is None
    assert configurations[0]["providers"] == [
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    ]
    assert configurations[0]["provider_options"] == [{"device_id": 0}, {}]
    assert configurations[0]["enable_mem_pattern"] is False
    assert configurations[0]["execution_mode"] == "sequential"


def test_windowsml_adapter_uses_cpu_only_when_dml_is_unavailable(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    configurations: list[dict[str, object]] = []

    class Result:
        json = {"res": {"rec_texts": ["CPU result"]}}

    class Pipeline:
        def predict(self, source: str) -> list[Result]:
            assert Path(source).is_file()
            return [Result()]

    def factory(**kwargs: object) -> Pipeline:
        configurations.append(kwargs["engine_config"])
        return Pipeline()

    adapter = WindowsMLOcrAdapter(
        model_dir,
        pipeline_factory=factory,
        provider_resolver=lambda: ["CPUExecutionProvider"],
    )

    result = adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert result.text == "CPU result"
    assert result.device == "cpu"
    assert "CPU OCR fallback" in (result.warning or "")
    assert configurations == [
        {
            "providers": ["CPUExecutionProvider"],
            "provider_options": [{}],
            "enable_mem_pattern": False,
            "execution_mode": "sequential",
        }
    ]


def test_windowsml_adapter_dml_failure_does_not_create_cpu_only_retry(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    configurations: list[dict[str, object]] = []

    class Pipeline:
        def predict(self, _source: str) -> list[object]:
            raise RuntimeError("DML operator failed")

    def factory(**kwargs: object) -> Pipeline:
        configurations.append(kwargs["engine_config"])
        return Pipeline()

    adapter = WindowsMLOcrAdapter(
        model_dir,
        pipeline_factory=factory,
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="CPU-only pipeline retry is disabled"):
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert len(configurations) == 1
    assert configurations[0]["providers"] == [
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    ]


def test_windowsml_adapter_dml_initialization_failure_fails_closed_without_cpu_retry(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    configurations: list[dict[str, object]] = []

    def factory(**kwargs: object) -> object:
        configurations.append(kwargs["engine_config"])
        raise RuntimeError("DML session initialization failed")

    adapter = WindowsMLOcrAdapter(
        model_dir,
        pipeline_factory=factory,
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="CPU-only pipeline retry is disabled"):
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert len(configurations) == 1
    assert configurations[0]["providers"] == [
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    ]


def test_windowsml_adapter_is_unavailable_without_dml_or_cpu(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    stages: list[str] = []
    adapter = WindowsMLOcrAdapter(
        model_dir,
        pipeline_factory=lambda **_kwargs: object(),
        provider_resolver=lambda: [],
        stage_reporter=stages.append,
    )

    probe = adapter.probe()

    assert probe.ready is False
    assert "CPUExecutionProvider is required" in probe.detail
    assert stages == [
        "ocr-probe-modules-start",
        "ocr-probe-modules-ready",
        "ocr-probe-assets-ready",
        "ocr-probe-providers-0-cpu-no-dml-no",
    ]


def test_runtime_settings_defaults_to_nvidia_whisper_gpu_preference() -> None:
    settings = RuntimeSettings.from_env({"CAPTURE_API_TOKEN": "a" * 32})

    assert settings.extraction.windowsml_device_id == 0
    assert settings.extraction.whisper_prefer_gpu is True
    assert settings.extraction.whisper_allow_cpu_fallback is True


def test_runtime_settings_allows_explicit_whisper_gpu_opt_in() -> None:
    settings = RuntimeSettings.from_env(
        {
            "CAPTURE_API_TOKEN": "a" * 32,
            "CAPTURE_WHISPER_PREFER_GPU": "true",
        }
    )

    assert settings.extraction.whisper_prefer_gpu is True


def test_runtime_settings_can_disable_whisper_cpu_fallback() -> None:
    settings = RuntimeSettings.from_env(
        {
            "CAPTURE_API_TOKEN": "a" * 32,
            "CAPTURE_WHISPER_ALLOW_CPU_FALLBACK": "false",
        }
    )

    assert settings.extraction.whisper_allow_cpu_fallback is False


def test_faster_whisper_uses_local_paths_gpu_fallback_and_bounded_segments(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")
    calls: list[tuple[str, str, str]] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: object):
            segments = [
                SimpleNamespace(start=0.0, end=1.25, text=" Alpha "),
                SimpleNamespace(start=1.25, end=2.5, text="Beta"),
            ]
            return segments, SimpleNamespace(duration=2.5)

    def factory(path: str, *, device: str, compute_type: str) -> Model:
        calls.append((Path(path).name, device, compute_type))
        if device == "cuda":
            raise RuntimeError("CUDA out of memory")
        return Model()

    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=True,
        max_duration_ms=60_000,
        model_factory=factory,
        cuda_count=lambda: 1,
    )
    result = adapter.transcribe(source, should_cancel=lambda: False)
    assert calls == [
        ("large-v3-turbo", "cuda", "float16"),
        ("small", "cpu", "int8_float32"),
    ]
    assert [(item.start_ms, item.end_ms, item.text) for item in result.segments] == [
        (0, 1250, "Alpha"),
        (1250, 2500, "Beta"),
    ]
    assert result.model == "small"
    assert "GPU fallback" in (result.warning or "")

    with pytest.raises(InterruptedError):
        adapter.transcribe(source, should_cancel=lambda: True)


def test_faster_whisper_progressive_windows_allow_empty_text_with_provenance(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")

    class SilentModel:
        def transcribe(self, _path: str, **_kwargs: object):
            return [], SimpleNamespace(duration=120.0)

    source = tmp_path / "silent.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=False,
        max_duration_ms=60_000 * 8,
        model_factory=lambda _path, **_kwargs: SilentModel(),
        cuda_count=lambda: 0,
    )

    result = adapter.transcribe(
        source,
        should_cancel=lambda: False,
        allow_empty_output=True,
    )

    assert result.segments == ()
    assert result.model == "small"
    assert result.device == "cpu"
    assert result.digest.startswith("sha256:")


def test_faster_whisper_reuses_a_loaded_model_for_progressive_windows(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    calls: list[tuple[str, str, str]] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: object):
            return [SimpleNamespace(start=0.0, end=1.0, text="words")], SimpleNamespace(
                duration=1.0
            )

    def factory(path: str, *, device: str, compute_type: str) -> Model:
        calls.append((Path(path).name, device, compute_type))
        return Model()

    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=False,
        max_duration_ms=60_000,
        model_factory=factory,
        cuda_count=lambda: 0,
    )

    adapter.transcribe(source, should_cancel=lambda: False)
    adapter.transcribe(source, should_cancel=lambda: False)

    assert calls == [("small", "cpu", "int8_float32")]


def test_faster_whisper_falls_back_when_cuda_model_initialization_has_no_cuda_text(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    calls: list[tuple[str, str, str]] = []
    stages: list[str] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: object):
            return [SimpleNamespace(start=0.0, end=1.0, text="words")], SimpleNamespace(
                duration=1.0
            )

    def factory(path: str, *, device: str, compute_type: str) -> Model:
        calls.append((Path(path).name, device, compute_type))
        if device == "cuda":
            raise RuntimeError("backend initialization failed")
        return Model()

    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=True,
        max_duration_ms=60_000,
        model_factory=factory,
        cuda_count=lambda: 1,
        stage_reporter=stages.append,
    )

    result = adapter.transcribe(source, should_cancel=lambda: False)

    assert calls == [
        ("large-v3-turbo", "cuda", "float16"),
        ("small", "cpu", "int8_float32"),
    ]
    assert result.device == "cpu"
    assert result.warning == "Whisper GPU fallback: RuntimeError"
    assert "whisper-gpu-fallback" in stages


def test_faster_whisper_strict_cuda_does_not_fall_back_to_cpu(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    calls: list[tuple[str, str, str]] = []

    def factory(path: str, *, device: str, compute_type: str) -> object:
        calls.append((Path(path).name, device, compute_type))
        raise RuntimeError("backend initialization failed")

    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=True,
        allow_cpu_fallback=False,
        max_duration_ms=60_000,
        model_factory=factory,
        cuda_count=lambda: 1,
    )

    with pytest.raises(RuntimeError, match="backend initialization failed"):
        adapter.transcribe(source, should_cancel=lambda: False)

    assert calls == [("large-v3-turbo", "cuda", "float16")]


def test_faster_whisper_strict_cuda_rejects_missing_cuda_device(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")

    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=True,
        allow_cpu_fallback=False,
        max_duration_ms=60_000,
        model_factory=lambda *_args, **_kwargs: object(),
        cuda_count=lambda: 0,
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="CUDA device is unavailable"):
        adapter.transcribe(source, should_cancel=lambda: False)


def test_faster_whisper_reports_only_constructor_exception_type(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    stages: list[str] = []

    def factory(_path: str, *, device: str, compute_type: str) -> object:
        del device, compute_type
        raise PermissionError("private model path must not cross diagnostics")

    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=False,
        max_duration_ms=60_000,
        model_factory=factory,
        cuda_count=lambda: 0,
        stage_reporter=stages.append,
    )

    with pytest.raises(PermissionError):
        adapter.transcribe(source, should_cancel=lambda: False)

    assert stages[-1] == "whisper-model-load-cpu-failed-permissionerror"


def test_faster_whisper_cpu_prefers_int8_float32_constructor(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    calls: list[str] = []
    stages: list[str] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: object):
            return [SimpleNamespace(start=0.0, end=1.0, text="words")], SimpleNamespace(
                duration=1.0
            )

    def factory(_path: str, *, device: str, compute_type: str) -> Model:
        assert device == "cpu"
        calls.append(compute_type)
        return Model()

    adapter = FasterWhisperAdapter(
        models,
        primary_model="small",
        fallback_model="small",
        prefer_gpu=False,
        max_duration_ms=60_000,
        model_factory=factory,
        cuda_count=lambda: 0,
        stage_reporter=stages.append,
    )

    result = adapter.transcribe(source, should_cancel=lambda: False)

    assert calls == ["int8_float32"]
    assert result.device == "cpu"
    assert result.model == "small"
    assert result.warning is None
    assert "whisper-model-load-cpu-fallback-float32" not in stages


def test_faster_whisper_cpu_int8_float32_runtimeerror_retries_with_float32_constructor(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    calls: list[str] = []
    stages: list[str] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: object):
            return [SimpleNamespace(start=0.0, end=1.0, text="words")], SimpleNamespace(
                duration=1.0
            )

    def factory(_path: str, *, device: str, compute_type: str) -> Model:
        assert device == "cpu"
        calls.append(compute_type)
        if compute_type == "int8_float32":
            raise RuntimeError("CPU int8_float32 constructor is unavailable")
        return Model()

    adapter = FasterWhisperAdapter(
        models,
        primary_model="small",
        fallback_model="small",
        prefer_gpu=False,
        max_duration_ms=60_000,
        model_factory=factory,
        cuda_count=lambda: 0,
        stage_reporter=stages.append,
    )

    result = adapter.transcribe(source, should_cancel=lambda: False)

    assert calls == ["int8_float32", "float32"]
    assert result.device == "cpu"
    assert result.model == "small"
    assert result.warning == "Whisper CPU int8_float32 compatibility fallback: RuntimeError"
    assert "whisper-model-load-cpu-fallback-float32" in stages


def test_faster_whisper_stage_markers_are_namespaced_and_cover_transcription_call(
    tmp_path: Path,
) -> None:
    models = tmp_path / "whisper"
    _write_whisper_model(models, "large-v3-turbo")
    _write_whisper_model(models, "small")
    source = tmp_path / "sample.wav"
    source.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    stages: list[str] = []

    class Model:
        def transcribe(self, _path: str, **_kwargs: object):
            return [SimpleNamespace(start=0.0, end=1.0, text="words")], SimpleNamespace(
                duration=1.0
            )

    adapter = FasterWhisperAdapter(
        models,
        primary_model="large-v3-turbo",
        fallback_model="small",
        prefer_gpu=False,
        max_duration_ms=60_000,
        model_factory=lambda *_args, **_kwargs: Model(),
        cuda_count=lambda: 0,
        stage_reporter=stages.append,
    )
    adapter.transcribe(source, should_cancel=lambda: False)

    assert stages == [
        "whisper-assets-probe-start",
        "whisper-assets-probe-complete",
        "whisper-device-probe-start",
        "whisper-device-probe-complete",
        "whisper-model-load-cpu-start",
        "whisper-model-load-cpu-complete",
        "whisper-transcription-call-start",
        "whisper-transcription-call-complete",
        "whisper-transcription-iteration-start",
        "whisper-transcription-complete",
    ]


class FakeOcrAdapter:
    def __init__(self, text: str = "OCR text") -> None:
        self.text = text
        self.images: list[bytes] = []

    def probe(self) -> EngineProbe:
        return EngineProbe(True, True, True, "ready")

    def extract_png(self, image_png: bytes) -> OcrTextResult:
        self.images.append(image_png)
        return OcrTextResult(
            text=self.text,
            device="windowsml-dml",
            model="pp-ocrv6-medium-windowsml",
            digest=f"sha256:{'1' * 64}",
        )


class FakeWhisperAdapter:
    def __init__(self) -> None:
        self.paths: list[Path] = []

    def probe(self) -> EngineProbe:
        return EngineProbe(True, True, True, "ready")

    def transcribe(self, source_path: Path, *, should_cancel):
        assert not should_cancel()
        assert source_path.is_file()
        self.paths.append(source_path)
        return WhisperTranscriptionResult(
            segments=(WhisperTextSegment(0, 900, "Audio words"),),
            duration_ms=900,
            device="cpu",
            model="small",
            digest=f"sha256:{'2' * 64}",
        )


def _source(content: bytes, name: str, media_type: str) -> CaptureSource:
    return CaptureSource(
        sha256=hashlib.sha256(content).hexdigest(),
        file_name=name,
        media_type=media_type,
        bytes=len(content),
    )


def test_standalone_image_normalization_and_audio_provenance(tmp_path: Path) -> None:
    ocr = FakeOcrAdapter()
    whisper = FakeWhisperAdapter()
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(), _config(tmp_path), ocr_adapter=ocr, whisper_adapter=whisper
    )
    image_buffer = BytesIO()
    Image.new("RGBA", (2, 2), (255, 0, 0, 0)).save(image_buffer, format="WEBP")
    image_content = image_buffer.getvalue()
    image_raw = asyncio.run(
        extractor.extract(
            image_content,
            _source(image_content, "source.webp", "image/webp"),
            asyncio.Event(),
        )
    )
    assert image_raw.segments[0].locator.page == 1
    assert image_raw.extraction_engine.engine == "windowsml-ocr"
    with Image.open(BytesIO(ocr.images[0])) as normalized:
        assert normalized.format == "PNG"
        assert normalized.mode == "RGB"
        assert normalized.getpixel((0, 0)) == (255, 255, 255)

    audio_content = b"RIFF\x00\x00\x00\x00WAVEpayload"
    audio_raw = asyncio.run(
        extractor.extract(
            audio_content,
            _source(audio_content, "source.wav", "audio/wav"),
            asyncio.Event(),
        )
    )
    assert audio_raw.segments[0].locator.start_ms == 0
    assert audio_raw.segments[0].locator.end_ms == 900
    assert audio_raw.extraction_engine.engine == "whisper-primary"
    assert whisper.paths and not whisper.paths[0].exists()


def test_worker_backed_audio_forwards_strict_cuda_fallback_policy(tmp_path: Path) -> None:
    class RecordingWorkerClient:
        def __init__(self) -> None:
            self.options: dict[str, object] | None = None

        async def run(self, _engine: InstalledEngine, **kwargs: object) -> WorkerRunResult:
            self.options = kwargs["options"]  # type: ignore[assignment]
            return WorkerRunResult(
                segments=(WorkerSegment(0, "Audio words", start_ms=0, end_ms=900),),
                engine="whisper-primary",
                model="large-v3-turbo",
                digest=f"sha256:{'2' * 64}",
                device="cuda",
                warnings=(),
            )

    worker_client = RecordingWorkerClient()

    class EngineManager:
        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="whisper-primary",
                artifact_version="0.4.0",
                executable=tmp_path / "whisper.exe",
                model_dir=tmp_path / "models",
            )

    manager = EngineManager()
    manager.worker_client = worker_client  # type: ignore[attr-defined]
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        replace(_config(tmp_path), whisper_allow_cpu_fallback=False),
        engine_manager=manager,  # type: ignore[arg-type]
    )
    audio_content = b"RIFF\x00\x00\x00\x00WAVEpayload"

    raw = asyncio.run(
        extractor.extract(
            audio_content,
            _source(audio_content, "source.wav", "audio/wav"),
            asyncio.Event(),
        )
    )

    assert raw.extraction_engine.device == "cuda"
    assert worker_client.options == {
        "maxDurationMs": 60_000,
        "preferGpu": True,
        "allowCpuFallback": False,
    }


def test_worker_backed_audio_engine_resolution_timeout_is_bounded(tmp_path: Path) -> None:
    class NeverResolvingEngineManager:
        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

    manager = NeverResolvingEngineManager()
    manager.worker_client = object()  # type: ignore[attr-defined]
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        replace(_config(tmp_path), engine_resolution_timeout_seconds=0.01),
        engine_manager=manager,  # type: ignore[arg-type]
    )
    audio_content = b"RIFF\x00\x00\x00\x00WAVEpayload"

    with pytest.raises(
        ExtractionRuntimeUnavailableError,
        match="could not be resolved within the bounded timeout",
    ):
        asyncio.run(
            extractor.extract(
                audio_content,
                _source(audio_content, "source.wav", "audio/wav"),
                asyncio.Event(),
            )
        )

    assert not extractor.config.temp_dir.exists()


def test_pdf_embedded_and_scanned_pages_preserve_page_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ocr = FakeOcrAdapter("Scanned OCR")
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=ocr,
        whisper_adapter=FakeWhisperAdapter(),
    )
    pages = [
        SimpleNamespace(extract_text=lambda: "Embedded text"),
        SimpleNamespace(extract_text=lambda: ""),
    ]
    monkeypatch.setattr(extractor_module, "PdfReader", lambda _source: SimpleNamespace(pages=pages))
    monkeypatch.setattr(extractor, "_render_pdf_page", lambda _content, _index: b"png")
    content = b"%PDF-1.7 deterministic"
    raw = asyncio.run(
        extractor.extract(
            content,
            _source(content, "mixed.pdf", "application/pdf"),
            asyncio.Event(),
        )
    )
    assert [segment.text for segment in raw.segments] == ["Embedded text", "Scanned OCR"]
    assert [segment.locator.page for segment in raw.segments] == [1, 2]
    assert raw.extraction_engine.engine == "pdf-embedded+windowsml-ocr"
    assert raw.source_text == "Embedded text\nScanned OCR"


def _lifecycle(tmp_path: Path) -> IsolatedOllamaLifecycle:
    root = tmp_path / "ollama"
    return IsolatedOllamaLifecycle(
        OllamaRuntimeConfig(
            host_url="http://127.0.0.1:12439",
            app_data_dir=root,
            pid_file=root / "ollama.pid.json",
            models_dir=root / "models",
        ),
        executable_resolver=lambda: None,
        clock=SystemClock(),
    )
