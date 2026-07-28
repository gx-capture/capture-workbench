from __future__ import annotations

import asyncio
import hashlib
import zipfile
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from PIL import Image

import capture_runtime.extractors as extractor_module
import capture_runtime.ollama.system_installer as system_installer_module
from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig, OllamaRuntimeConfig, RuntimeSettings
from capture_runtime.contracts import CaptureSourceV1
from capture_runtime.engine_adapters import (
    EngineProbe,
    EngineRuntimeUnavailableError,
    FasterWhisperAdapter,
    OcrTextResult,
    WhisperTextSegment,
    WhisperTranscriptionResult,
    WindowsMLOcrAdapter,
)
from capture_runtime.extractors import StandaloneRuntimeCaptureExtractor
from capture_runtime.ollama import (
    CommandResult,
    IsolatedOllamaLifecycle,
    SystemRuntimeInstaller,
)


def _write_windowsml_models(root: Path) -> None:
    for relative in (
        "det/inference.onnx",
        "det/inference.yml",
        "rec/inference.onnx",
        "rec/inference.yml",
        "rec/ppocr_keys_v1.txt",
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


def test_windowsml_adapter_dml_failure_does_not_create_cpu_retry(tmp_path: Path) -> None:
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

    with pytest.raises(EngineRuntimeUnavailableError, match="CPU fallback is disabled"):
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert len(configurations) == 1
    assert configurations[0]["providers"] == [
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    ]


def test_windowsml_adapter_is_unavailable_without_dml_or_cpu(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    adapter = WindowsMLOcrAdapter(
        model_dir,
        pipeline_factory=lambda **_kwargs: object(),
        provider_resolver=lambda: [],
    )

    probe = adapter.probe()

    assert probe.ready is False
    assert "CPUExecutionProvider is required" in probe.detail


def test_runtime_settings_defaults_to_cert_prep_i_gpu_adapter() -> None:
    settings = RuntimeSettings.from_env({"CAPTURE_API_TOKEN": "a" * 32})

    assert settings.extraction.windowsml_device_id == 0


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
        ("small", "cpu", "int8"),
    ]
    assert [(item.start_ms, item.end_ms, item.text) for item in result.segments] == [
        (0, 1250, "Alpha"),
        (1250, 2500, "Beta"),
    ]
    assert result.model == "small"
    assert "GPU fallback" in (result.warning or "")

    with pytest.raises(InterruptedError):
        adapter.transcribe(source, should_cancel=lambda: True)


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


def _source(content: bytes, name: str, media_type: str) -> CaptureSourceV1:
    return CaptureSourceV1(
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


def test_runtime_owned_windowsml_bundle_installs_and_reprobes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    source = tmp_path / "models"
    _write_windowsml_models(source)
    archive = tmp_path / "windowsml.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        for path in source.rglob("*"):
            if path.is_file():
                bundle.write(path, path.relative_to(source).as_posix())
    archive_bytes = archive.read_bytes()
    monkeypatch.setattr(
        system_installer_module,
        "WINDOWSML_BUNDLE_URL",
        "https://downloads.example.test/windowsml.zip",
    )
    monkeypatch.setattr(system_installer_module, "WINDOWSML_BUNDLE_BYTES", len(archive_bytes))
    monkeypatch.setattr(
        system_installer_module,
        "WINDOWSML_BUNDLE_SHA256",
        hashlib.sha256(archive_bytes).hexdigest(),
    )
    config = _config(tmp_path)

    class AssetProbeOcr(FakeOcrAdapter):
        def probe(self) -> EngineProbe:
            missing = [
                relative
                for relative in (
                    "det/inference.onnx",
                    "det/inference.yml",
                    "rec/inference.onnx",
                    "rec/inference.yml",
                    "rec/ppocr_keys_v1.txt",
                    "pipeline.json",
                )
                if not (config.windowsml_model_dir / relative).is_file()
            ]
            return EngineProbe(
                not missing, True, not missing, "ready" if not missing else "missing"
            )

    installer = SystemRuntimeInstaller(
        _lifecycle(tmp_path),
        winget_resolver=lambda: None,
        extraction_config=config,
        ocr_adapter=AssetProbeOcr(),
        whisper_adapter=FakeWhisperAdapter(),
        clock=SystemClock(),
        http_client_factory=lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda request: httpx.Response(
                    200,
                    headers={"content-length": str(len(archive_bytes))},
                    content=archive_bytes,
                    request=request,
                )
            ),
            follow_redirects=True,
        ),
    )
    before = next(
        item for item in installer.requirements() if item.requirement_id == "windowsml-ocr"
    )
    assert before.status == "installable"
    progress: list[float] = []
    asyncio.run(
        installer.install(
            "windowsml-ocr", cancel_event=asyncio.Event(), report_progress=progress.append
        )
    )
    assert progress[-1] == 1
    after = next(
        item for item in installer.requirements() if item.requirement_id == "windowsml-ocr"
    )
    assert after.status == "ready"


def test_whisper_install_runs_cancellable_model_subprocesses_and_reprobes(
    tmp_path: Path,
) -> None:
    config = _config(tmp_path)
    adapter = FasterWhisperAdapter(
        config.whisper_models_dir,
        primary_model=config.whisper_primary_model,
        fallback_model=config.whisper_fallback_model,
        prefer_gpu=False,
        max_duration_ms=config.max_audio_duration_ms,
        model_factory=lambda *_args, **_kwargs: object(),
    )

    class DownloadRunner:
        def __init__(self) -> None:
            self.commands: list[list[str]] = []
            self.environments: list[dict[str, str]] = []

        async def run(
            self,
            arguments: list[str],
            *,
            environment,
            cwd,
            cancel_event: asyncio.Event,
            timeout_seconds: float,
        ) -> CommandResult:
            del cwd, timeout_seconds
            if cancel_event.is_set():
                raise asyncio.CancelledError
            self.commands.append(arguments)
            self.environments.append(dict(environment))
            model = arguments[arguments.index("--model") + 1]
            output = Path(arguments[arguments.index("--output") + 1])
            _write_whisper_model(output.parent, model)
            return CommandResult(0, "downloaded")

    runner = DownloadRunner()
    installer = SystemRuntimeInstaller(
        _lifecycle(tmp_path),
        command_runner=runner,
        winget_resolver=lambda: None,
        extraction_config=config,
        ocr_adapter=FakeOcrAdapter(),
        whisper_adapter=adapter,
        clock=SystemClock(),
    )
    before = next(
        item for item in installer.requirements() if item.requirement_id == "whisper-primary"
    )
    assert before.status == "installable"
    asyncio.run(
        installer.install(
            "whisper-primary",
            cancel_event=asyncio.Event(),
            report_progress=lambda _value: None,
        )
    )
    assert len(runner.commands) == 2
    assert all(
        environment["HF_HOME"] == str(config.whisper_models_dir.parent / ".huggingface")
        and environment["HF_HUB_CACHE"]
        == str(config.whisper_models_dir.parent / ".huggingface" / "hub")
        and "HF_TOKEN" not in environment
        for environment in runner.environments
    )
    assert adapter.probe().ready is True
