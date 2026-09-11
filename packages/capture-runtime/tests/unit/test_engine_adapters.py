from __future__ import annotations

import asyncio
import gc
import hashlib
import json
from dataclasses import replace
from io import BytesIO
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest
from PIL import Image

import capture_runtime.engine_adapters as engine_adapters
import capture_runtime.extractors as extractor_module
from capture_runtime.clock import SystemClock
from capture_runtime.config import ExtractionRuntimeConfig, OllamaRuntimeConfig, RuntimeSettings
from capture_runtime.contracts import CaptureSource, OcrAdapterClass, OcrProvenanceV3
from capture_runtime.engine_adapters import (
    EngineProbe,
    EngineRuntimeUnavailableError,
    FasterWhisperAdapter,
    OcrExecutionEvidence,
    OcrRegion,
    OcrTextResult,
    PaddleResultNormalizationError,
    WhisperTextSegment,
    WhisperTranscriptionResult,
    WindowsMLOcrAdapter,
)
from capture_runtime.extractors import (
    ExtractionRuntimeUnavailableError,
    OcrExtractionFailure,
    OcrSourcePreflightError,
    StandaloneRuntimeCaptureExtractor,
)
from capture_runtime.ocr_preflight import (
    OcrComputePlan,
    OcrExecutionPlan,
    OcrGpuAdapter,
    OcrGpuCapabilitySnapshot,
)
from capture_runtime.ocr_profile import (
    CANONICAL_PROFILE_PATH,
    canonical_json_bytes,
    load_profile_spec,
)
from capture_runtime.ocr_projection import OcrBoxInput
from capture_runtime.ollama import (
    IsolatedOllamaLifecycle,
)
from capture_runtime.worker_client import (
    InstalledEngine,
    OcrWorkerFailure,
    WorkerOcrPage,
    WorkerOcrProgress,
    WorkerRunResult,
    WorkerSegment,
)


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
        if relative != "pipeline.json":
            path.write_bytes(relative.encode())
    profile = json.loads(CANONICAL_PROFILE_PATH.read_text(encoding="utf-8"))
    for artifact in profile["artifacts"]:
        data = (root / artifact["path"]).read_bytes()
        artifact["bytes"] = len(data)
        artifact["sha256"] = hashlib.sha256(data).hexdigest()
        if artifact["path"] == "rec/ppocrv6_dict.txt":
            profile["dictionary"]["sha256"] = artifact["sha256"]
    (root / "pipeline.json").write_bytes(canonical_json_bytes(profile))


def _write_whisper_model(root: Path, model: str) -> None:
    directory = root / model
    directory.mkdir(parents=True, exist_ok=True)
    for name in ("config.json", "model.bin", "tokenizer.json", "vocabulary.json"):
        (directory / name).write_bytes(f"{model}:{name}".encode())


class _StaticGpuProbe:
    def __init__(self, snapshot: OcrGpuCapabilitySnapshot) -> None:
        self.snapshot = snapshot

    def probe(self) -> OcrGpuCapabilitySnapshot:
        return self.snapshot


def _cpu_plan() -> OcrExecutionPlan:
    selection = OcrComputePlan(
        contract_sha256="a" * 64,
        worker_sha256="b" * 64,
        capability_probe=_StaticGpuProbe(OcrGpuCapabilitySnapshot()),
    ).select()
    assert selection is not None
    return selection.execution_plan


def _gpu_plan_kwargs() -> dict[str, object]:
    adapter = OcrGpuAdapter(
        index=0,
        adapter_class=OcrAdapterClass.DEDICATED,
        is_software=False,
        luid="00000000000000aa",
        high_performance_rank=0,
        vendor_id=0x10DE,
        pci_device_id=0x2204,
        subsystem_id=0x00000001,
        revision=1,
        description="test-gpu",
        assessment="positive-usable",
    )
    selection = OcrComputePlan(
        contract_sha256="a" * 64,
        worker_sha256="b" * 64,
        capability_probe=_StaticGpuProbe(
            OcrGpuCapabilitySnapshot(
                adapters=(adapter,),
                high_performance_adapters=(adapter,),
                ordinary_adapters=(adapter,),
                dml_provider_available=True,
                ort_version="1.24.4",
            )
        ),
    ).select()
    assert selection is not None
    plan = selection.execution_plan
    return {
        "execution_plan": plan,
        "adapter_map_resolver": lambda: (plan.adapter_map_sha256, plan.identity.luid, True),
    }


def _worker_ocr_plan_selection() -> SimpleNamespace:
    return SimpleNamespace(
        execution_plan=SimpleNamespace(
            to_dict=lambda: _gpu_plan_kwargs()["execution_plan"].to_dict()
        )
    )


def _resolved_ocr_provenance() -> OcrProvenanceV3:
    return OcrProvenanceV3(
        status="resolved",
        engine="windowsml-ocr",
        model="pp-ocrv6-medium-windowsml",
        model_digest="sha256:" + "1" * 64,
        device="windowsml-dml",
        profile_id="capture-workbench-ocr-pipeline-v1",
        profile_spec_sha256="c" * 64,
    )


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
    stages: list[str] = []

    class Result:
        json = {
            "res": {
                "rec_texts": ["First", "Second"],
                "rec_scores": [0.91, 0.83],
                "rec_boxes": [[10, 20, 100, 60], [120, 80, 300, 140]],
            }
        }

    class Pipeline:
        def predict(self, source: str) -> list[Result]:
            assert Path(source).is_file()
            return [Result()]

    def factory(**kwargs: object) -> Pipeline:
        configurations.append(kwargs["engine_config"])
        return Pipeline()

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=factory,
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=_StaticOcrEvidenceAdapter(
            OcrExecutionEvidence(dml_node_count=2, cpu_node_count=1)
        ),
        stage_reporter=stages.append,
    )
    result = adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")
    assert result.text == "First\nSecond"
    assert result.device == "windowsml-dml"
    assert result.digest.startswith("sha256:")
    expected_digest = hashlib.sha256()
    for relative in engine_adapters.WINDOWSML_REQUIRED_MODEL_FILES:
        expected_digest.update(relative.encode("utf-8"))
        expected_digest.update(b"\0")
        expected_digest.update((model_dir / relative).read_bytes())
    assert result.digest == f"sha256:{expected_digest.hexdigest()}"
    assert result.warning is None
    assert [region.text for region in result.regions] == ["First", "Second"]
    assert result.regions[0].confidence == pytest.approx(0.91)
    assert result.regions[0].box == (10, 20, 90, 40)
    assert configurations[0]["providers"] == [
        "DmlExecutionProvider",
        "CPUExecutionProvider",
    ]
    assert configurations[0]["provider_options"] == [{"device_id": 0}, {}]
    assert configurations[0]["enable_mem_pattern"] is False
    assert configurations[0]["execution_mode"] == "sequential"
    session_options = configurations[0]["session_options"]
    assert session_options["enable_profiling"] is True
    assert isinstance(session_options["profile_file_prefix"], str)
    assert Path(session_options["profile_file_prefix"]).name.startswith("capture-runtime-ocr-")
    assert [
        stage
        for stage in stages
        if stage
        in {
            "ocr-native-map-before",
            "ocr-paddle-factory",
            "ocr-native-map-after",
            "ocr-execution-evidence-prepare",
        }
    ] == [
        "ocr-native-map-before",
        "ocr-paddle-factory",
        "ocr-native-map-after",
        "ocr-execution-evidence-prepare",
    ]


def test_planless_dml_pipeline_construction_fails_closed(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    adapter = WindowsMLOcrAdapter(
        model_dir,
        pipeline_factory=lambda **_kwargs: object(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="requires a retained compute plan"):
        adapter._get_pipeline()


def test_native_map_bracket_rejects_stale_factory_even_when_map_is_unchanged(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    plan = _gpu_plan_kwargs()["execution_plan"]
    assert isinstance(plan, OcrExecutionPlan)

    class Lease:
        def __init__(self) -> None:
            self.current_calls = 0
            self.closed = False

        def is_current(self) -> bool:
            self.current_calls += 1
            return self.current_calls == 1

        def adapter_map(self) -> tuple[str, tuple[object, ...]]:
            return (
                plan.adapter_map_sha256 or "",
                (SimpleNamespace(index=plan.dml_device_id, luid=plan.identity.luid),),
            )

        def close(self) -> None:
            self.closed = True

    lease = Lease()
    adapter = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=plan,
        adapter_map_lease_factory=lambda: lease,  # type: ignore[arg-type]
        pipeline_factory=lambda **_kwargs: object(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=_StaticOcrEvidenceAdapter(
            OcrExecutionEvidence(dml_node_count=1, cpu_node_count=0)
        ),
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="native adapter map"):
        adapter._get_pipeline()
    assert lease.current_calls == 2
    assert lease.closed is True


def test_native_map_bracket_rejects_factory_current_query_exception(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    plan = _gpu_plan_kwargs()["execution_plan"]
    assert isinstance(plan, OcrExecutionPlan)
    factory_calls = 0

    class Lease:
        def is_current(self) -> bool:
            raise RuntimeError("DXGI IsCurrent failed")

        def adapter_map(self) -> tuple[str, tuple[object, ...]]:
            raise AssertionError("map must not be read after IsCurrent fails")

        def close(self) -> None:
            return None

    def factory(**_kwargs: object) -> object:
        nonlocal factory_calls
        factory_calls += 1
        return object()

    adapter = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=plan,
        adapter_map_lease_factory=lambda: Lease(),  # type: ignore[arg-type]
        pipeline_factory=factory,
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="native adapter map"):
        adapter._get_pipeline()
    assert factory_calls == 0


def test_windowsml_adapter_uses_cpu_only_when_dml_is_unavailable(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    configurations: list[dict[str, object]] = []

    class Result:
        json = {
            "res": {
                "rec_texts": ["CPU result"],
                "rec_scores": [0.9],
                "rec_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
            }
        }

    class Pipeline:
        def predict(self, source: str) -> list[Result]:
            assert Path(source).is_file()
            return [Result()]

    def factory(**kwargs: object) -> Pipeline:
        configurations.append(kwargs["engine_config"])
        return Pipeline()

    adapter = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
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


def test_windowsml_adapter_hands_paddle_only_profile_derived_kwargs(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    received: dict[str, object] = {}

    class Result:
        json = {
            "res": {
                "rec_texts": ["profile-bound"],
                "rec_scores": [0.9],
                "rec_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    def factory(**kwargs: object) -> Pipeline:
        received.update(kwargs)
        return Pipeline()

    WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
        pipeline_factory=factory,
        provider_resolver=lambda: ["CPUExecutionProvider"],
    ).extract_png(b"not-a-raster-but-sufficient-for-the-fake-pipeline")

    expected = load_profile_spec(model_dir / "pipeline.json").paddle_kwargs(
        model_dir=model_dir,
        use_dml=False,
        profile_file_prefix=None,
    )
    assert received == expected
    assert "targetLanguage" not in received
    assert "ocrLanguage" not in received


def test_paddle_adapter_preserves_predictor_polygon_order_and_coordinates(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    polygon = [[11.25, 20.5], [91.75, 18.0], [104.0, 61.25], [4.5, 64.0]]

    class Result:
        json = {
            "res": {
                "rec_texts": ["perspective"],
                "rec_scores": [0.93],
                "rec_polys": [polygon],
                "rec_boxes": [[4, 18, 104, 64]],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    image = BytesIO()
    Image.new("RGB", (120, 80), "white").save(image, format="PNG")

    adapter = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["CPUExecutionProvider"],
    )

    result = adapter.extract_png(image.getvalue())

    assert result.regions[0].polygon == tuple(tuple(point) for point in polygon)


def test_paddle_adapter_converts_xyxy_rectangle_to_four_point_polygon(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = {
            "res": {
                "rec_texts": ["rectangle"],
                "rec_scores": [0.8],
                "rec_boxes": [[10, 20, 50, 70]],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    image = BytesIO()
    Image.new("RGB", (120, 80), "white").save(image, format="PNG")

    result = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["CPUExecutionProvider"],
    ).extract_png(image.getvalue())

    assert result.regions[0].polygon == (
        (10.0, 20.0),
        (50.0, 20.0),
        (50.0, 70.0),
        (10.0, 70.0),
    )


def test_paddle_adapter_uses_detection_polygon_when_recognition_polygon_is_empty(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = {
            "res": {
                "rec_texts": ["detected"],
                "rec_scores": [0.8],
                "rec_polys": [],
                "dt_polys": [[[10, 20], [50, 20], [48, 70], [8, 68]]],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    image = BytesIO()
    Image.new("RGB", (120, 80), "white").save(image, format="PNG")

    result = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["CPUExecutionProvider"],
    ).extract_png(image.getvalue())

    assert result.regions[0].polygon == (
        (10.0, 20.0),
        (50.0, 20.0),
        (48.0, 70.0),
        (8.0, 68.0),
    )


@pytest.mark.parametrize(
    "polygon",
    [
        [[0, 0], [10, 0], [10, 10]],
        [[0, 0], [10, 0], [10, 10], [0, 10], [float("nan"), 0]],
        [[0, 0], [10, 0], [10, 10], [-1, 10]],
        [[0, 0], [10, 0], [101, 10], [0, 10]],
    ],
)
def test_paddle_adapter_rejects_malformed_or_out_of_raster_polygon(
    tmp_path: Path,
    polygon: list[list[float]],
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = {
            "res": {
                "rec_texts": ["invalid"],
                "rec_scores": [0.8],
                "rec_polys": [polygon],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    image = BytesIO()
    Image.new("RGB", (100, 80), "white").save(image, format="PNG")

    adapter = WindowsMLOcrAdapter(
        model_dir,
        execution_plan=_cpu_plan(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="polygon"):
        adapter.extract_png(image.getvalue())


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
        **_gpu_plan_kwargs(),
        pipeline_factory=factory,
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=_StaticOcrEvidenceAdapter(
            OcrExecutionEvidence(dml_node_count=1, cpu_node_count=1)
        ),
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
        **_gpu_plan_kwargs(),
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


def test_default_paddle_factory_does_not_patch_onnxruntime_globals(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    observed: list[tuple[object, object, dict[str, object]]] = []

    class InferenceSession:
        pass

    class SessionOptions:
        pass

    ort_module = ModuleType("onnxruntime")
    ort_module.InferenceSession = InferenceSession  # type: ignore[attr-defined]
    ort_module.SessionOptions = SessionOptions  # type: ignore[attr-defined]

    class FakePaddleOCR:
        def __init__(self, **kwargs: object) -> None:
            observed.append(
                (
                    ort_module.InferenceSession,
                    ort_module.SessionOptions,
                    kwargs,
                )
            )

    paddleocr_module = ModuleType("paddleocr")
    paddleocr_module.PaddleOCR = FakePaddleOCR  # type: ignore[attr-defined]
    monkeypatch.setitem(engine_adapters.sys.modules, "onnxruntime", ort_module)
    monkeypatch.setitem(engine_adapters.sys.modules, "paddleocr", paddleocr_module)

    result = engine_adapters._default_paddle_pipeline(engine="onnxruntime")

    assert isinstance(result, FakePaddleOCR)
    assert observed == [(InferenceSession, SessionOptions, {"engine": "onnxruntime"})]


@pytest.mark.parametrize(
    "providers",
    [
        ["CPUExecutionProvider"],
        ["CPUExecutionProvider", "DmlExecutionProvider"],
        ["DmlExecutionProvider"],
    ],
    ids=["constructor-cpu-retry", "provider-reordered", "cpu-dropped"],
)
def test_ort_session_identity_rejects_non_dml_first_session_before_inference(
    tmp_path: Path,
    providers: list[str],
) -> None:
    class Session:
        def __init__(self) -> None:
            self.disabled = False

        def get_providers(self) -> list[str]:
            return providers

        def disable_fallback(self) -> None:
            self.disabled = True

    session = Session()
    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=session)),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    with pytest.raises(EngineRuntimeUnavailableError, match="provider identity"):
        evidence_adapter.prepare(pipeline)

    assert session.disabled is False


def test_constructor_cpu_retry_identity_fails_before_predict(tmp_path: Path) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    predict_calls: list[str] = []

    class Session:
        def get_providers(self) -> list[str]:
            return ["CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            raise AssertionError("run-time fallback must not be disabled on a rejected session")

    class Pipeline:
        paddlex_pipeline = SimpleNamespace(
            text_det_model=SimpleNamespace(
                runner=SimpleNamespace(session=Session()),
            )
        )

        def predict(self, _source: str) -> list[object]:
            predict_calls.append(_source)
            return []

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="CPU-only pipeline retry is disabled"):
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert predict_calls == []


def test_windowsml_adapter_rejects_registered_dml_with_zero_assigned_nodes(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = {"res": {"rec_texts": ["must not be trusted"]}}

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=_StaticOcrEvidenceAdapter(
            OcrExecutionEvidence(dml_node_count=0, cpu_node_count=6)
        ),
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="DML execution evidence"):
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")


def test_windowsml_adapter_fails_closed_without_dml_execution_evidence(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = {"res": {"rec_texts": ["must not be trusted"]}}

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="DML execution evidence"):
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")


def test_windowsml_adapter_accepts_dml_nodes_with_cpu_fallback_nodes(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = {
            "res": {
                "rec_texts": ["mixed provider result"],
                "rec_scores": [0.9],
                "rec_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=_StaticOcrEvidenceAdapter(
            OcrExecutionEvidence(dml_node_count=3, cpu_node_count=4)
        ),
    )

    result = adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert result.device == "windowsml-dml"


def test_windowsml_provenance_requires_evidence_not_provider_configuration(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Pipeline:
        def predict(self, _source: str) -> list[object]:
            return []

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=_StaticOcrEvidenceAdapter(
            OcrExecutionEvidence(dml_node_count=1, cpu_node_count=2)
        ),
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="after OCR prediction"):
        adapter.provenance()


def test_windowsml_dml_provenance_is_finalized_after_prediction(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    events: list[str] = []

    class Result:
        json = {
            "res": {
                "rec_texts": ["evidenced result"],
                "rec_scores": [0.9],
                "rec_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            events.append("predict")
            return [Result()]

    class EvidenceAdapter:
        def prepare(self, _pipeline: object, expected_device_id: int | None = None) -> None:
            del expected_device_id
            events.append("prepare")
            return None

        def finalize(self, _pipeline: object) -> OcrExecutionEvidence:
            assert events[-1] == "predict"
            events.append("finalize")
            return OcrExecutionEvidence(dml_node_count=1, cpu_node_count=2)

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=EvidenceAdapter(),
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="after OCR prediction"):
        adapter.provenance()
    result = adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert events == ["prepare", "predict", "finalize"]
    assert result.provenance is not None and result.provenance.is_resolved
    assert result.device == "windowsml-dml"


def test_windowsml_adapter_preserves_typed_profile_cleanup_failure(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)

    class Result:
        json = {
            "res": {
                "rec_texts": ["must not become resolved"],
                "rec_scores": [0.9],
                "rec_polys": [[[0, 0], [1, 0], [1, 1], [0, 1]]],
            }
        }

    class Pipeline:
        def predict(self, _source: str) -> list[Result]:
            return [Result()]

    class EvidenceAdapter:
        def prepare(self, _pipeline: object, expected_device_id: int | None = None) -> None:
            del expected_device_id
            return None

        def finalize(self, _pipeline: object) -> OcrExecutionEvidence:
            raise engine_adapters.OcrExecutionEvidenceError(
                [engine_adapters.OcrExecutionEvidenceFailure("profile_residue")],
                cleanup_verified=False,
            )

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
        provider_evidence_adapter=EvidenceAdapter(),
    )

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert raised.value.profile_paths_absent is False


def test_windowsml_prediction_failure_aborts_all_ort_profiles(
    tmp_path: Path,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    end_calls: list[int] = []

    class Session:
        def __init__(self, index: int) -> None:
            self.index = index

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, int]]:
            return {"DmlExecutionProvider": {"device_id": 0}}

        def disable_fallback(self) -> None:
            return None

        def end_profiling(self) -> str:
            end_calls.append(self.index)
            path = adapter._profile_file_prefix.parent / (
                f"{adapter._profile_file_prefix.name}_{self.index + 1}.json"
            )
            path.write_text("[]", encoding="utf-8")
            return str(path)

    sessions = tuple(Session(index) for index in range(3))

    class Pipeline:
        paddlex_pipeline = SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[0])),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[1])),
            textline_orientation_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[2])),
        )

        def predict(self, _source: str) -> list[object]:
            raise RuntimeError("predict failed at a private source path")

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )

    with pytest.raises(EngineRuntimeUnavailableError, match="DirectML OCR execution failed"):
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert end_calls == [0, 1, 2]
    assert not tuple(
        adapter._profile_file_prefix.parent.glob(adapter._profile_file_prefix.name + "_*.json")
    )
    with pytest.raises(EngineRuntimeUnavailableError, match="after OCR prediction"):
        adapter.provenance()


def test_windowsml_prediction_failure_preserves_primary_kind_when_cleanup_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model_dir = tmp_path / "windowsml"
    _write_windowsml_models(model_dir)
    profile_paths: list[Path] = []

    class Session:
        def __init__(self, index: int) -> None:
            self.index = index

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, int]]:
            return {"DmlExecutionProvider": {"device_id": 0}}

        def disable_fallback(self) -> None:
            return None

        def end_profiling(self) -> str:
            path = adapter._profile_file_prefix.parent / (
                f"{adapter._profile_file_prefix.name}_{self.index + 1}.json"
            )
            path.write_text("[]", encoding="utf-8")
            profile_paths.append(path)
            return str(path)

    sessions = tuple(Session(index) for index in range(3))

    class Pipeline:
        paddlex_pipeline = SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[0])),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[1])),
            textline_orientation_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[2])),
        )

        def predict(self, _source: str) -> list[object]:
            raise RuntimeError("prediction failed")

    adapter = WindowsMLOcrAdapter(
        model_dir,
        **_gpu_plan_kwargs(),
        pipeline_factory=lambda **_kwargs: Pipeline(),
        provider_resolver=lambda: ["DmlExecutionProvider", "CPUExecutionProvider"],
    )
    original_unlink = Path.unlink
    failed_path: Path | None = None

    def unlink(path: Path, *args: object, **kwargs: object) -> None:
        nonlocal failed_path
        if len(profile_paths) >= 2 and path == profile_paths[1] and failed_path is None:
            failed_path = path
            raise OSError("delete failed")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)

    with pytest.raises(engine_adapters.OcrInferenceCleanupError) as raised:
        adapter.extract_png(b"valid-png-bytes-for-fake-pipeline")

    assert raised.value.primary_code == "ocr_prediction_failed"
    assert any(failure.code == "profile_delete_failed" for failure in raised.value.cleanup_failures)
    assert raised.value.cleanup_verified is False
    assert failed_path is not None and failed_path.exists()
    assert str(tmp_path) not in str(raised.value)


def test_ort_profile_abort_retries_cleanup_after_transient_delete_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_prefix = tmp_path / "ocr-profile"
    profile_path = tmp_path / "ocr-profile_1.json"

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def end_profiling(self) -> str:
            profile_path.write_text("[]", encoding="utf-8")
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    original_unlink = Path.unlink
    failed_once = False

    def unlink(path: Path, *args: object, **kwargs: object) -> None:
        nonlocal failed_once
        if path == profile_path and not failed_once:
            failed_once = True
            raise OSError("transient delete failure")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(profile_prefix)
    evidence_adapter.prepare(pipeline)

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        evidence_adapter.abort(pipeline)
    assert raised.value.cleanup_verified is False
    assert profile_path.exists()

    evidence_adapter.abort(pipeline)
    assert not profile_path.exists()


def test_ort_profile_abort_fails_closed_when_absence_probe_is_unknown(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_prefix = tmp_path / "ocr-profile"
    profile_path = tmp_path / "ocr-profile_1.json"

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def end_profiling(self) -> str:
            profile_path.write_text("[]", encoding="utf-8")
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    original_iterdir = Path.iterdir

    def iterdir(path: Path):
        if path == profile_prefix.parent:
            raise PermissionError("profile directory unavailable")
        return original_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", iterdir)
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(profile_prefix)
    evidence_adapter.prepare(pipeline)

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        evidence_adapter.abort(pipeline)

    assert raised.value.cleanup_verified is False
    assert any(
        failure.code in {"profile_discovery_failed", "profile_presence_unknown"}
        for failure in raised.value.cleanup_failures
    )
    assert str(tmp_path) not in str(raised.value)


def test_ort_profile_evidence_counts_actual_assigned_nodes_and_disables_fallback(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}},'
        '{"cat":"Node","args":{"provider":"CPUExecutionProvider"}},'
        '{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        encoding="utf-8",
    )

    class Session:
        def __init__(self) -> None:
            self.disabled = False

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            self.disabled = True

        def end_profiling(self) -> str:
            return str(profile_path)

    session = Session()
    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=session)),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=session)),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    evidence_adapter.prepare(pipeline)
    evidence = evidence_adapter.finalize(pipeline)

    assert session.disabled is True
    assert evidence == OcrExecutionEvidence(dml_node_count=2, cpu_node_count=1)
    assert profile_path.exists() is False


def test_ort_profile_evidence_does_not_delete_a_foreign_profile_path(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "foreign-profile.json"
    profile_path.write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        encoding="utf-8",
    )

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    with pytest.raises(EngineRuntimeUnavailableError, match="does not belong"):
        evidence_adapter.finalize(pipeline)

    assert profile_path.exists() is True


@pytest.mark.parametrize("profile_payload", [None, "not-json", "[null]", "[]"])
def test_ort_profile_finalize_is_not_trusted_when_missing_unreadable_or_zero(
    tmp_path: Path,
    profile_payload: str | None,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    if profile_payload is not None:
        profile_path.write_text(profile_payload, encoding="utf-8")

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    if profile_payload == "[]":
        assert evidence_adapter.finalize(pipeline) == OcrExecutionEvidence(
            dml_node_count=0,
            cpu_node_count=0,
        )
    else:
        with pytest.raises(EngineRuntimeUnavailableError, match="DML execution evidence"):
            evidence_adapter.finalize(pipeline)
    assert not profile_path.exists()


def test_ort_profile_finalize_attempts_every_session_after_an_earlier_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_prefix = tmp_path / "ocr-profile"
    malformed_profile = tmp_path / "ocr-profile_2.json"
    delete_failure_profile = tmp_path / "ocr-profile_3.json"
    malformed_profile.write_text("not-json", encoding="utf-8")
    delete_failure_profile.write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        encoding="utf-8",
    )
    end_calls: list[str] = []

    class Session:
        def __init__(self, name: str, profile: Path | None = None) -> None:
            self.name = name
            self.profile = profile

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            end_calls.append(self.name)
            if self.name == "session-1":
                raise RuntimeError("end failed")
            assert self.profile is not None
            return str(self.profile)

    session_1 = Session("session-1")
    session_2 = Session("session-2", malformed_profile)
    session_3 = Session("session-3", delete_failure_profile)
    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=session_1)),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=session_2)),
            textline_orientation_model=SimpleNamespace(runner=SimpleNamespace(session=session_3)),
        )
    )

    original_unlink = Path.unlink

    def unlink(path: Path, *args: object, **kwargs: object) -> None:
        if path == delete_failure_profile:
            raise OSError("delete failed")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(profile_prefix)
    evidence_adapter.prepare(pipeline)

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        evidence_adapter.finalize(pipeline)

    assert end_calls == ["session-1", "session-2", "session-3"]
    assert malformed_profile.exists() is False
    assert delete_failure_profile.exists() is True
    assert {failure.code for failure in raised.value.failures} >= {
        "profile_end_failed",
        "profile_invalid",
        "profile_delete_failed",
    }
    assert raised.value.profile_paths_absent is False
    assert str(tmp_path) not in str(raised.value)


def test_ort_profile_finalize_aggregates_all_session_node_counts(
    tmp_path: Path,
) -> None:
    profile_paths = [
        tmp_path / "ocr-profile_1.json",
        tmp_path / "ocr-profile_2.json",
        tmp_path / "ocr-profile_3.json",
    ]
    profile_paths[0].write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}},'
        '{"cat":"Node","args":{"provider":"CPUExecutionProvider"}}]',
        encoding="utf-8",
    )
    profile_paths[1].write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}},'
        '{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        encoding="utf-8",
    )
    profile_paths[2].write_text(
        '[{"cat":"Node","args":{"provider":"CPUExecutionProvider"}}]',
        encoding="utf-8",
    )

    class Session:
        def __init__(self, profile_path: Path) -> None:
            self.profile_path = profile_path

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            return str(self.profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(
                runner=SimpleNamespace(session=Session(profile_paths[0]))
            ),
            text_rec_model=SimpleNamespace(
                runner=SimpleNamespace(session=Session(profile_paths[1]))
            ),
            textline_orientation_model=SimpleNamespace(
                runner=SimpleNamespace(session=Session(profile_paths[2]))
            ),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    evidence_adapter.prepare(pipeline)
    evidence = evidence_adapter.finalize(pipeline)

    assert evidence == OcrExecutionEvidence(dml_node_count=3, cpu_node_count=2)
    assert all(not path.exists() for path in profile_paths)


def test_ort_profile_finalize_rejects_duplicate_profile_paths_but_cleans_once(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_duplicate.json"
    profile_path.write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        encoding="utf-8",
    )

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        evidence_adapter.finalize(pipeline)

    assert any(failure.code == "profile_path_duplicate" for failure in raised.value.failures)
    assert raised.value.cleanup_verified is True
    assert profile_path.exists() is False
    assert str(tmp_path) not in str(raised.value)


def test_ort_profile_finalize_disambiguates_same_second_timestamp_profiles(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_2026-08-26_10-32-51.json"
    profile_payload = '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]'

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            # ORT can reuse this second-resolution path for both PaddleX
            # sessions.  Each call still produces a fresh profile file.
            profile_path.write_text(profile_payload, encoding="utf-8")
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    evidence = evidence_adapter.finalize(pipeline)

    assert evidence == OcrExecutionEvidence(dml_node_count=2, cpu_node_count=0)
    assert profile_path.exists() is False
    assert not tuple(tmp_path.glob("ocr-profile_*.json"))


def test_ort_profile_finalize_rejects_timestamp_duplicate_without_new_profile(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_2026-08-26_10-32-51.json"
    profile_path.write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        encoding="utf-8",
    )

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        evidence_adapter.finalize(pipeline)

    assert any(failure.code == "profile_path_duplicate" for failure in raised.value.failures)
    assert raised.value.cleanup_verified is True
    assert not tuple(tmp_path.glob("ocr-profile_*.json"))


def test_ort_profile_finalize_copies_locked_timestamp_profiles_and_cleans_aliases(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_path = tmp_path / "ocr-profile_2026-08-26_10-32-51.json"
    payloads = (
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        '[{"cat":"Node","args":{"provider":"CPUExecutionProvider"}}]',
    )

    class Session:
        def __init__(self, index: int) -> None:
            self.index = index

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            profile_path.write_text(payloads[self.index], encoding="utf-8")
            return str(profile_path)

    def rename(_source: Path, _destination: Path) -> None:
        raise OSError("profile handle is still open")

    monkeypatch.setattr(Path, "rename", rename)
    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session(0))),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=Session(1))),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    evidence = evidence_adapter.finalize(pipeline)

    assert evidence == OcrExecutionEvidence(dml_node_count=1, cpu_node_count=1)
    assert not tuple(tmp_path.glob("ocr-profile_*.json"))


def test_ort_profile_finalize_missing_profile_is_failure_but_enoent_cleanup_is_proven(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_missing.json"

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        evidence_adapter.finalize(pipeline)

    assert any(failure.code == "profile_missing" for failure in raised.value.failures)
    assert raised.value.cleanup_verified is True
    assert profile_path.exists() is False


def test_ort_profile_finalize_delete_failure_can_retry_idempotently(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    profile_path = tmp_path / "ocr-profile_retry.json"
    end_calls = 0

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def end_profiling(self) -> str:
            nonlocal end_calls
            end_calls += 1
            profile_path.write_text(
                '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
                encoding="utf-8",
            )
            return str(profile_path)

    original_unlink = Path.unlink
    unlink_calls = 0

    def unlink(path: Path, *args: object, **kwargs: object) -> None:
        nonlocal unlink_calls
        if path == profile_path and unlink_calls == 0:
            unlink_calls += 1
            raise OSError("transient delete failure")
        original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", unlink)
    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline)

    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as first:
        evidence_adapter.finalize(pipeline)
    assert any(failure.code == "profile_delete_failed" for failure in first.value.failures)
    assert first.value.cleanup_verified is False
    assert profile_path.exists() is True

    evidence = evidence_adapter.finalize(pipeline)

    assert evidence == OcrExecutionEvidence(dml_node_count=1, cpu_node_count=0)
    assert end_calls == 2
    assert profile_path.exists() is False


def test_ort_graph_assignment_evidence_counts_assigned_provider_nodes(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text("[]", encoding="utf-8")

    class Assignment:
        def __init__(self, provider: str, node_count: int) -> None:
            self.ep_name = provider
            self._node_count = node_count

        def get_nodes(self) -> list[object]:
            return [object() for _ in range(self._node_count)]

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def get_provider_graph_assignment_info(self) -> list[Assignment]:
            return [
                Assignment("DmlExecutionProvider", 2),
                Assignment("CPUExecutionProvider", 5),
            ]

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    evidence_adapter.prepare(pipeline)
    evidence = evidence_adapter.finalize(pipeline)

    assert evidence == OcrExecutionEvidence(
        dml_node_count=2,
        cpu_node_count=5,
        source="ort-graph-assignment",
    )
    assert profile_path.exists() is False


def test_ort_graph_assignment_empty_fails_for_retained_gpu_plan(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text("[]", encoding="utf-8")
    plan = _gpu_plan_kwargs()["execution_plan"]
    assert isinstance(plan, OcrExecutionPlan)

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[object]:
            return []

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline, expected_device_id=plan.dml_device_id)

    with pytest.raises(EngineRuntimeUnavailableError, match="zero assigned DML nodes"):
        evidence_adapter.finalize(pipeline)


def test_ort_graph_assignment_cpu_only_fails_for_retained_gpu_plan(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text("[]", encoding="utf-8")
    plan = _gpu_plan_kwargs()["execution_plan"]
    assert isinstance(plan, OcrExecutionPlan)

    class Assignment:
        ep_name = "CPUExecutionProvider"

        def get_nodes(self) -> list[object]:
            return [object(), object()]

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[Assignment]:
            return [Assignment()]

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline, expected_device_id=plan.dml_device_id)

    with pytest.raises(EngineRuntimeUnavailableError, match="zero assigned DML nodes"):
        evidence_adapter.finalize(pipeline)


def test_ort_graph_assignment_requires_dml_nodes_in_every_retained_gpu_session(
    tmp_path: Path,
) -> None:
    profile_paths = [tmp_path / "ocr-profile_1.json", tmp_path / "ocr-profile_2.json"]
    for profile_path in profile_paths:
        profile_path.write_text("[]", encoding="utf-8")
    plan = _gpu_plan_kwargs()["execution_plan"]
    assert isinstance(plan, OcrExecutionPlan)

    class Assignment:
        def __init__(self, provider: str) -> None:
            self.ep_name = provider

        def get_nodes(self) -> list[object]:
            return [object()]

    class Session:
        def __init__(self, index: int) -> None:
            self.index = index

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[Assignment]:
            return [] if self.index == 1 else [Assignment("DmlExecutionProvider")]

        def end_profiling(self) -> str:
            return str(profile_paths[self.index])

    sessions = (Session(0), Session(1))
    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[0])),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[1])),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline, expected_device_id=plan.dml_device_id)

    with pytest.raises(EngineRuntimeUnavailableError, match="zero assigned DML nodes"):
        evidence_adapter.finalize(pipeline)


@pytest.mark.parametrize(
    "profile_payloads, message",
    [
        ((None,), "profile_missing"),
        (
            (
                '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
                "[]",
            ),
            "not associated",
        ),
    ],
    ids=["missing-session-profile", "zero-dml-session-profile"],
)
def test_ort_profile_fallback_requires_dml_in_every_retained_gpu_session(
    tmp_path: Path,
    profile_payloads: tuple[str | None, ...],
    message: str,
) -> None:
    profile_paths = [
        tmp_path / f"ocr-profile_{index + 1}.json" for index in range(len(profile_payloads))
    ]
    plan = _gpu_plan_kwargs()["execution_plan"]
    assert isinstance(plan, OcrExecutionPlan)

    class Session:
        def __init__(self, index: int) -> None:
            self.index = index

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[object]:
            raise RuntimeError(
                "Session configuration entry "
                "'session.record_ep_graph_assignment_info' must be set to \"1\""
            )

        def end_profiling(self) -> str:
            payload = profile_payloads[self.index]
            if payload is not None:
                profile_paths[self.index].write_text(payload, encoding="utf-8")
            return str(profile_paths[self.index])

    sessions = tuple(Session(index) for index in range(len(profile_paths)))
    models = {
        "text_det_model": SimpleNamespace(runner=SimpleNamespace(session=sessions[0])),
    }
    if len(sessions) == 2:
        models["text_rec_model"] = SimpleNamespace(runner=SimpleNamespace(session=sessions[1]))
    pipeline = SimpleNamespace(paddlex_pipeline=SimpleNamespace(**models))
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    evidence_adapter.prepare(pipeline, expected_device_id=plan.dml_device_id)

    with pytest.raises(EngineRuntimeUnavailableError, match=message):
        evidence_adapter.finalize(pipeline)

    assert all(not path.exists() for path in profile_paths)


@pytest.mark.parametrize(
    "unknown_provider",
    [
        "CUDAExecutionProvider",
        "DmlExecutionProvider:spoof",
        "cpuexecutionprovider",
        "",
        None,
    ],
)
def test_ort_graph_assignment_rejects_unknown_provider_and_cleans_profiles(
    tmp_path: Path,
    unknown_provider: object,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text("[]", encoding="utf-8")

    class Assignment:
        def __init__(self, provider: object) -> None:
            self.ep_name = provider

        def get_nodes(self) -> list[object]:
            return [object()]

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[Assignment]:
            return [Assignment("DmlExecutionProvider"), Assignment(unknown_provider)]

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    evidence_adapter.prepare(pipeline)
    with pytest.raises(engine_adapters.OcrExecutionEvidenceError) as raised:
        evidence_adapter.finalize(pipeline)

    assert any(failure.code == "graph_unknown_provider" for failure in raised.value.failures)
    assert raised.value.cleanup_verified is True
    assert profile_path.exists() is False


@pytest.mark.parametrize(
    "unknown_provider",
    [
        "CUDAExecutionProvider",
        "DmlExecutionProvider:spoof",
        "cpuexecutionprovider",
        "",
        None,
    ],
)
def test_ort_profile_rejects_same_unknown_provider_policy(
    tmp_path: Path,
    unknown_provider: object,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text(
        json.dumps([{"cat": "Node", "args": {"provider": unknown_provider}}]),
        encoding="utf-8",
    )

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            return None

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    evidence_adapter.prepare(pipeline)
    with pytest.raises(EngineRuntimeUnavailableError, match="unknown_provider"):
        evidence_adapter.finalize(pipeline)

    assert profile_path.exists() is False


def test_ort_graph_api_without_recording_config_uses_profile_evidence(
    tmp_path: Path,
) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text(
        '[{"cat":"Node","args":{"provider":"DmlExecutionProvider"}}]',
        encoding="utf-8",
    )

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def disable_fallback(self) -> None:
            pass

        def get_provider_graph_assignment_info(self) -> list[object]:
            raise RuntimeError(
                "Session configuration entry "
                "'session.record_ep_graph_assignment_info' must be set to \"1\""
            )

        def end_profiling(self) -> str:
            return str(profile_path)

    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=Session())),
        )
    )
    evidence_adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    evidence_adapter.prepare(pipeline)
    evidence = evidence_adapter.finalize(pipeline)

    assert evidence == OcrExecutionEvidence(dml_node_count=1, cpu_node_count=0)
    assert evidence.source == "ort-profile"
    assert profile_path.exists() is False


class _StaticOcrEvidenceAdapter:
    def __init__(self, evidence: OcrExecutionEvidence) -> None:
        self.evidence = evidence
        self.prepare_calls = 0
        self.inspect_calls = 0
        self.finalize_calls = 0

    def prepare(self, _pipeline: object, expected_device_id: int | None = None) -> None:
        del expected_device_id
        self.prepare_calls += 1
        return None

    def inspect(self, _pipeline: object) -> OcrExecutionEvidence:
        self.inspect_calls += 1
        return self.evidence

    def finalize(self, _pipeline: object) -> OcrExecutionEvidence:
        self.finalize_calls += 1
        return self.evidence


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

    assert settings.extraction.whisper_prefer_gpu is True
    assert settings.extraction.whisper_allow_cpu_fallback is True


def test_runtime_settings_rejects_retired_windowsml_device_override() -> None:
    with pytest.raises(ValueError, match="CAPTURE_WINDOWSML_DEVICE_ID is retired"):
        RuntimeSettings.from_env(
            {"CAPTURE_API_TOKEN": "a" * 32, "CAPTURE_WINDOWSML_DEVICE_ID": "0"}
        )


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
            raster_width=1,
            raster_height=1,
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


@pytest.fixture(autouse=True)
def _stub_legacy_pdf_manifest_dimensions(monkeypatch: pytest.MonkeyPatch) -> None:
    """Keep existing marker-only PDF adapter tests focused on their seam."""

    original = getattr(StandaloneRuntimeCaptureExtractor, "_pdf_page_raster_dimensions", None)

    def dimensions(
        extractor: StandaloneRuntimeCaptureExtractor,
        content: bytes,
        cancel_event: asyncio.Event,
        page_numbers: tuple[int, ...],
    ) -> tuple[tuple[int, int], ...]:
        if content.startswith(b"%PDF-1.7") and b"1 0 obj" not in content:
            extractor._checkpoint(cancel_event)
            return tuple((60, 40) for _ in page_numbers)
        if original is None:
            raise AssertionError("PDF metadata dimension seam is not implemented")
        return original(extractor, content, cancel_event, page_numbers)

    monkeypatch.setattr(
        StandaloneRuntimeCaptureExtractor,
        "_pdf_page_raster_dimensions",
        dimensions,
        raising=False,
    )


def _geometry_pdf(*, rotation: int, crop: tuple[float, float, float, float]) -> bytes:
    width, height = 123.4, 56.7
    left, bottom, right, top = crop
    cropbox = (left, bottom, width - right, height - top)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {width} {height}] "
            f"/CropBox [{cropbox[0]} {cropbox[1]} {cropbox[2]} {cropbox[3]}] "
            f"/Rotate {rotation} /Resources << >> /Contents 4 0 R >>"
        ).encode(),
        b"<< /Length 0 >>\nstream\nendstream",
    ]
    content = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(content))
        content.extend(f"{index} 0 obj\n".encode())
        content.extend(value)
        content.extend(b"\nendobj\n")
    xref_offset = len(content)
    content.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        content.extend(f"{offset:010d} 00000 n \n".encode())
    content.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n".encode()
    )
    return bytes(content)


def test_pdf_preflight_uses_metadata_without_png_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        replace(_config(tmp_path), ocr_render_scale=1.25),
        ocr_adapter=FakeOcrAdapter(),
    )
    content = _geometry_pdf(rotation=0, crop=(0, 0, 0, 0))

    def render_should_not_run(*_args: object, **_kwargs: object) -> bytes:
        raise AssertionError("PDF preflight must not render PNG bytes")

    monkeypatch.setattr(extractor, "_render_pdf_page", render_should_not_run)
    manifest = extractor._ocr_pdf_page_manifest(content, asyncio.Event())

    assert len(manifest) == 1
    assert (manifest[0].raster_width, manifest[0].raster_height) == (155, 71)


@pytest.mark.parametrize(
    ("rotation", "crop"),
    [
        (0, (10, 5, 20, 7)),
        (90, (10, 5, 20, 7)),
        (180, (0, 0, 0, 0)),
        (270, (10, 5, 20, 7)),
    ],
)
def test_pdf_manifest_geometry_matches_pdfium_render(
    tmp_path: Path,
    rotation: int,
    crop: tuple[float, float, float, float],
) -> None:
    import pypdfium2 as pdfium

    scale = 1.25
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        replace(_config(tmp_path), ocr_render_scale=scale),
        ocr_adapter=FakeOcrAdapter(),
    )
    content = _geometry_pdf(rotation=rotation, crop=crop)
    manifest = extractor._ocr_pdf_page_manifest(content, asyncio.Event())

    document = pdfium.PdfDocument(content)
    try:
        page = document[0]
        try:
            width, height = page.get_size()
            assert (width, height) == (page.get_width(), page.get_height())
            bitmap = page.render(scale=scale)
            try:
                rendered_dimensions = (bitmap.width, bitmap.height)
            finally:
                bitmap.close()
        finally:
            page.close()
    finally:
        document.close()

    assert (manifest[0].raster_width, manifest[0].raster_height) == rendered_dimensions


@pytest.mark.parametrize("outcome", ["success", "page-failure", "cancel"])
def test_pdf_metadata_closes_page_and_document_on_all_outcomes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
) -> None:
    import pypdfium2 as pdfium

    events: list[str] = []
    cancel_event = asyncio.Event()

    class Page:
        def get_size(self) -> tuple[float, float]:
            events.append("page-size")
            if outcome == "page-failure":
                raise ValueError("page metadata failed")
            if outcome == "cancel":
                cancel_event.set()
            return (10.5, 20.5)

        def close(self) -> None:
            events.append("page-close")

    class Document:
        def __init__(self, _source: object) -> None:
            events.append("document-open")

        def __getitem__(self, _index: int) -> Page:
            return Page()

        def close(self) -> None:
            events.append("document-close")

    monkeypatch.setattr(pdfium, "PdfDocument", Document)
    extractor = StandaloneRuntimeCaptureExtractor(SystemClock(), _config(tmp_path))

    if outcome == "success":
        assert extractor._pdf_page_raster_dimensions(b"source", cancel_event, (1,)) == (
            (10.5, 20.5),
        )
    elif outcome == "page-failure":
        with pytest.raises(ValueError, match="page metadata failed"):
            extractor._pdf_page_raster_dimensions(b"source", cancel_event, (1,))
    else:
        with pytest.raises(InterruptedError):
            extractor._pdf_page_raster_dimensions(b"source", cancel_event, (1,))

    assert events == ["document-open", "page-size", "page-close", "document-close"]


def test_pdf_render_failure_closes_native_handles_and_releases_bitmap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import pypdfium2 as pdfium

    events: list[str] = []

    class Bitmap:
        live = 0

        def __init__(self) -> None:
            self.closed = False
            type(self).live += 1

        def to_pil(self) -> None:
            raise ValueError("pixel conversion failed")

        def close(self) -> None:
            if not self.closed:
                self.closed = True
                type(self).live -= 1
                events.append("bitmap-close")

        def __del__(self) -> None:
            if not self.closed:
                type(self).live -= 1

    class Page:
        def render(self, **_kwargs: object) -> Bitmap:
            return Bitmap()

    class Document:
        def __init__(self, _source: object) -> None:
            events.append("document-open")

        def __getitem__(self, _index: int) -> Page:
            return Page()

        def close(self) -> None:
            events.append("document-close")

    monkeypatch.setattr(pdfium, "PdfDocument", Document)
    extractor = StandaloneRuntimeCaptureExtractor(SystemClock(), _config(tmp_path))

    with pytest.raises(ValueError, match="Could not render PDF page 1") as raised:
        extractor._render_pdf_page(b"source", 0)

    assert events == ["document-open", "bitmap-close", "document-close"]
    assert Bitmap.live == 0
    del raised
    gc.collect()
    assert Bitmap.live == 0


@pytest.mark.parametrize("dimensions", [(0, 100), (float("nan"), 100), (100, float("inf"))])
def test_pdf_preflight_rejects_invalid_metadata_before_engine(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    dimensions: tuple[float, float],
) -> None:
    adapter = FakeOcrAdapter()
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(), _config(tmp_path), ocr_adapter=adapter
    )
    content = b"%PDF-1.7 invalid metadata"
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 1)
    monkeypatch.setattr(
        extractor,
        "_pdf_page_raster_dimensions",
        lambda _content, _cancel_event, _page_numbers: (dimensions,),
    )

    with pytest.raises(OcrSourcePreflightError):
        asyncio.run(
            extractor.extract(
                content, _source(content, "invalid.pdf", "application/pdf"), asyncio.Event()
            )
        )
    assert adapter.images == []


class _TrackedRaster(bytes):
    live = 0
    peak = 0

    def __new__(cls, value: bytes) -> _TrackedRaster:
        raster = super().__new__(cls, value)
        cls.live += 1
        cls.peak = max(cls.peak, cls.live)
        return raster

    def __del__(self) -> None:
        type(self).live -= 1


def _reset_tracked_raster() -> None:
    gc.collect()
    assert _TrackedRaster.live == 0
    _TrackedRaster.peak = 0


def _stub_pdf_source(
    extractor: StandaloneRuntimeCaptureExtractor,
    monkeypatch: pytest.MonkeyPatch,
    page_count: int,
) -> None:
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: page_count)
    monkeypatch.setattr(
        extractor,
        "_pdf_page_raster_dimensions",
        lambda _content, _cancel_event, page_numbers: tuple((60, 40) for _ in page_numbers),
    )


def _tracked_result(text: str) -> OcrTextResult:
    return OcrTextResult(
        text=text,
        device="windowsml-dml",
        model="pp-ocrv6-medium-windowsml",
        digest=f"sha256:{'1' * 64}",
        raster_width=1,
        raster_height=1,
    )


def test_pdf_sync_raster_lifetime_is_bounded_across_success(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _reset_tracked_raster()
    calls: list[int] = []

    class RecordingAdapter:
        def extract_png(self, image_png: bytes) -> OcrTextResult:
            assert isinstance(image_png, _TrackedRaster)
            calls.append(len(calls) + 1)
            return _tracked_result(f"page {calls[-1]}")

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=RecordingAdapter(),  # type: ignore[arg-type]
    )
    _stub_pdf_source(extractor, monkeypatch, page_count=3)

    rendered: list[int] = []

    def render(_content: bytes, page: int) -> bytes:
        rendered.append(page)
        return _TrackedRaster(f"raster-{page}".encode())

    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        render,
    )
    content = b"%PDF-1.7 bounded raster success"

    extraction = asyncio.run(
        extractor.extract(
            content, _source(content, "bounded.pdf", "application/pdf"), asyncio.Event()
        )
    )
    del extraction
    gc.collect()

    assert calls == [1, 2, 3]
    assert rendered == [0, 1, 2]
    assert _TrackedRaster.peak == 1
    assert _TrackedRaster.live == 0


def test_pdf_sync_raster_lifetime_is_bounded_after_render_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _reset_tracked_raster()

    class RecordingAdapter:
        def extract_png(self, image_png: bytes) -> OcrTextResult:
            assert isinstance(image_png, _TrackedRaster)
            return _tracked_result("trusted page")

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=RecordingAdapter(),  # type: ignore[arg-type]
    )
    _stub_pdf_source(extractor, monkeypatch, page_count=2)

    def render(_content: bytes, page: int) -> bytes:
        if page == 1:
            raise ValueError("render conversion failed")
        return _TrackedRaster(b"raster")

    monkeypatch.setattr(extractor, "_render_pdf_page", render)
    content = b"%PDF-1.7 bounded raster render failure"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content, _source(content, "render-failure.pdf", "application/pdf"), asyncio.Event()
            )
        )

    projection = raised.value.projection
    assert [page.status.value for page in projection.pages] == ["recognized", "failed"]
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_protocol"
    assert _TrackedRaster.live == 0
    del raised
    gc.collect()
    assert _TrackedRaster.peak == 1
    assert _TrackedRaster.live == 0


def test_pdf_sync_raster_lifetime_is_bounded_after_inference_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _reset_tracked_raster()

    class FailingAdapter:
        calls = 0

        def extract_png(self, image_png: bytes) -> OcrTextResult:
            assert isinstance(image_png, _TrackedRaster)
            self.calls += 1
            if self.calls == 2:
                raise PaddleResultNormalizationError("inference failed")
            return _tracked_result("trusted page")

    adapter = FailingAdapter()
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=adapter,  # type: ignore[arg-type]
    )
    _stub_pdf_source(extractor, monkeypatch, page_count=2)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _page: _TrackedRaster(b"raster"),
    )
    content = b"%PDF-1.7 bounded raster inference failure"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "inference-failure.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert [page.status.value for page in projection.pages] == ["recognized", "failed"]
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_protocol"
    assert adapter.calls == 2
    assert _TrackedRaster.live == 0
    del raised
    gc.collect()
    assert _TrackedRaster.peak == 1
    assert _TrackedRaster.live == 0


def test_pdf_sync_raster_lifetime_is_bounded_after_cancellation(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _reset_tracked_raster()
    cancel_event = asyncio.Event()

    class CancellingAdapter:
        calls = 0

        def extract_png(self, image_png: bytes) -> OcrTextResult:
            assert isinstance(image_png, _TrackedRaster)
            self.calls += 1
            cancel_event.set()
            return _tracked_result("cancelled page")

    adapter = CancellingAdapter()
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=adapter,  # type: ignore[arg-type]
    )
    _stub_pdf_source(extractor, monkeypatch, page_count=2)
    rendered: list[int] = []

    def render(_content: bytes, page: int) -> bytes:
        rendered.append(page)
        return _TrackedRaster(b"raster")

    monkeypatch.setattr(extractor, "_render_pdf_page", render)
    content = b"%PDF-1.7 bounded raster cancellation"

    with pytest.raises(asyncio.CancelledError) as raised:
        asyncio.run(
            extractor.extract(
                content, _source(content, "cancelled.pdf", "application/pdf"), cancel_event
            )
        )

    assert adapter.calls == 1
    assert rendered == [0]
    assert _TrackedRaster.live == 0
    del raised
    gc.collect()
    assert _TrackedRaster.peak == 1
    assert _TrackedRaster.live == 0


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
    ).raw
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
    ).raw
    assert audio_raw.segments[0].locator.start_ms == 0
    assert audio_raw.segments[0].locator.end_ms == 900
    assert audio_raw.extraction_engine.engine == "whisper-primary"
    assert whisper.paths and not whisper.paths[0].exists()


def test_sync_ocr_all_empty_is_failed_with_readable_no_text_projection(
    tmp_path: Path,
) -> None:
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=FakeOcrAdapter("   "),
        whisper_adapter=FakeWhisperAdapter(),
    )
    image_buffer = BytesIO()
    Image.new("RGB", (2, 2), "white").save(image_buffer, format="PNG")
    image_content = image_buffer.getvalue()

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                image_content,
                _source(image_content, "empty.png", "image/png"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.status.value == "failed"
    assert projection.failure is not None
    assert projection.failure.code == "ocr_no_text"
    assert [page.status.value for page in projection.pages] == ["empty"]
    assert projection.pages[0].text == ""


def test_standalone_image_scale_adapts_to_the_pixel_limit() -> None:
    image = Image.new("RGB", (5_000, 3_000), "white")

    normalized_png = extractor_module._normalize_image_png(
        image,
        scale=2,
        max_pixels=50_000_000,
    )

    with Image.open(BytesIO(normalized_png)) as normalized:
        width, height = normalized.size
        assert width * height <= 50_000_000
        assert width > 5_000
        assert height > 3_000


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
        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="whisper-primary",
                artifact_version="0.4.2",
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
    ).raw

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


def test_worker_runtime_unavailable_preserves_complete_pdf_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class MissingRuntimeManager:
        worker_client = object()

        async def resolve_active_engine(self, _requirement_id: str) -> None:
            return None

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=MissingRuntimeManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 3)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    content = b"%PDF-1.7 runtime unavailable after manifest"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "unavailable.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.page_count == 3
    assert [page.page for page in projection.pages] == [1, 2, 3]
    assert [page.status.value for page in projection.pages] == ["failed"] * 3
    assert all(page.text == "" and page.boxes == [] for page in projection.pages)
    assert all(page.confidence is None for page in projection.pages)
    assert all(
        (page.raster.width, page.raster.height, page.raster.scale) == (120, 80, 2)
        for page in projection.pages
    )
    assert projection.failure is not None
    assert projection.failure.code == "ocr_runtime_unavailable"
    assert projection.provenance.status == "unavailable"
    assert projection.provenance.reason.value == "model_unavailable"


def test_worker_runtime_unavailable_preserves_image_manifest(
    tmp_path: Path,
) -> None:
    class MissingRuntimeManager:
        worker_client = object()

        async def resolve_active_engine(self, _requirement_id: str) -> None:
            return None

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=MissingRuntimeManager(),  # type: ignore[arg-type]
    )
    image = BytesIO()
    Image.new("RGB", (12, 8), "white").save(image, format="PNG")
    content = image.getvalue()

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "unavailable.png", "image/png"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.page_count == 1
    assert projection.pages[0].status.value == "failed"
    assert projection.pages[0].raster.width == 24
    assert projection.pages[0].raster.height == 16
    assert projection.pages[0].confidence is None
    assert projection.pages[0].boxes == []
    assert projection.failure is not None
    assert projection.failure.code == "ocr_runtime_unavailable"
    assert projection.provenance.status == "unavailable"
    assert projection.provenance.reason.value == "model_unavailable"


def test_sync_runtime_unavailable_preserves_pdf_manifest_without_adapter(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(), _config(tmp_path), ocr_adapter=None
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 3)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    content = b"%PDF-1.7 sync runtime unavailable after manifest"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "sync-unavailable.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.page_count == 3
    assert [page.status.value for page in projection.pages] == ["failed"] * 3
    assert projection.failure is not None
    assert projection.failure.code == "ocr_runtime_unavailable"
    assert projection.provenance.status == "unavailable"


def test_sync_ocr_runtime_initialization_failure_preserves_page_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FailingOcrAdapter(FakeOcrAdapter):
        def extract_png(self, _image_png: bytes) -> OcrTextResult:
            raise EngineRuntimeUnavailableError("DML initialization failed")

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(), _config(tmp_path), ocr_adapter=FailingOcrAdapter()
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 2)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    content = b"%PDF-1.7 sync OCR initialization failure"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "sync-init-failure.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.page_count == 2
    assert [page.status.value for page in projection.pages] == ["failed"] * 2
    assert projection.failure is not None
    assert projection.failure.code == "ocr_runtime_unavailable"
    assert projection.provenance.status == "unavailable"


def test_sync_malformed_paddle_result_remains_protocol_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class MalformedOcrAdapter(FakeOcrAdapter):
        def extract_png(self, _image_png: bytes) -> OcrTextResult:
            raise PaddleResultNormalizationError("malformed score")

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(), _config(tmp_path), ocr_adapter=MalformedOcrAdapter()
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 1)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    content = b"%PDF-1.7 malformed Paddle output"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "malformed-paddle.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_protocol"
    assert projection.provenance.reason.value == "protocol_failure"


def test_manifest_build_failure_is_typed_before_page_count_is_known(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(), _config(tmp_path), ocr_adapter=FakeOcrAdapter()
    )
    monkeypatch.setattr(
        extractor,
        "_ocr_pdf_page_manifest",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(ValueError("bad PDF")),
    )
    content = b"%PDF-1.7 manifest failure"

    with pytest.raises(OcrSourcePreflightError, match="OCR source preflight failed"):
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "manifest-failure.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )


def test_worker_backed_pdf_dispatches_every_page_to_ocr(tmp_path: Path) -> None:
    class RecordingWorkerClient:
        def __init__(self) -> None:
            self.options: dict[str, object] | None = None

        async def run(self, _engine: InstalledEngine, **kwargs: object) -> WorkerRunResult:
            self.options = kwargs["options"]  # type: ignore[assignment]
            return WorkerRunResult(
                segments=(WorkerSegment(0, "Rendered page one", page=1),),
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=(
                    WorkerOcrPage(
                        page=1,
                        status="recognized",
                        text="Rendered page one",
                        boxes=((2, 3, 40, 20),),
                        confidence=0.97,
                        region_confidences=(0.83,),
                        raster_width=120,
                        raster_height=80,
                        raster_scale=1,
                    ),
                    WorkerOcrPage(
                        page=2,
                        status="empty",
                        text="",
                        boxes=(),
                        confidence=None,
                        raster_width=120,
                        raster_height=80,
                        raster_scale=1,
                    ),
                ),
            )

    worker_client = RecordingWorkerClient()

    class EngineManager:
        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    manager = EngineManager()
    manager.worker_client = worker_client  # type: ignore[attr-defined]
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=manager,  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    extractor._pdf_page_count = lambda _content: 2  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]
    content = b"%PDF-1.7 embedded text must not be inspected"

    extraction = asyncio.run(
        extractor.extract(
            content,
            _source(content, "source.pdf", "application/pdf"),
            asyncio.Event(),
        )
    )
    raw = extraction.raw

    assert worker_client.options is not None
    assert worker_client.options["computePlan"] == _gpu_plan_kwargs()["execution_plan"].to_dict()
    assert {key: value for key, value in worker_client.options.items() if key != "computePlan"} == {
        "maxPages": 10,
        "renderScale": 2,
        "pageManifest": [
            {
                "page": 1,
                "raster": {
                    "width": 120,
                    "height": 80,
                    "scale": 2,
                    "coordinateSystem": "pixel",
                },
            },
            {
                "page": 2,
                "raster": {
                    "width": 120,
                    "height": 80,
                    "scale": 2,
                    "coordinateSystem": "pixel",
                },
            },
        ],
    }
    assert [segment.text for segment in raw.segments] == ["Rendered page one"]
    assert raw.source_text == extraction.ocr_projection.pages[0].text
    assert raw.extraction_engine.engine == "windowsml-ocr"
    assert extraction.ocr_projection is not None
    assert [page.status.value for page in extraction.ocr_projection.pages] == [
        "recognized",
        "empty",
    ]
    assert extraction.ocr_projection.pages[0].confidence == pytest.approx(0.83)
    assert extraction.ocr_projection.pages[0].raster.scale == 2
    assert extraction.ocr_projection.pages[0].boxes[0].width == 40


def test_worker_backed_pdf_page_scope_dispatches_only_page_one_and_records_scope(
    tmp_path: Path,
) -> None:
    class RecordingWorkerClient:
        def __init__(self) -> None:
            self.options: dict[str, object] | None = None

        async def run(self, _engine: InstalledEngine, **kwargs: object) -> WorkerRunResult:
            self.options = kwargs["options"]  # type: ignore[assignment]
            return WorkerRunResult(
                segments=(WorkerSegment(0, "Rendered page one", page=1),),
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=(
                    WorkerOcrPage(
                        page=1,
                        status="recognized",
                        text="Rendered page one",
                        boxes=((2, 3, 40, 20),),
                        confidence=0.97,
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    ),
                ),
            )

    worker_client = RecordingWorkerClient()

    class EngineManager:
        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    manager = EngineManager()
    manager.worker_client = worker_client  # type: ignore[attr-defined]
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        replace(_config(tmp_path), max_pdf_pages=46),
        engine_manager=manager,  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    rendered: list[int] = []
    extractor._pdf_page_count = lambda _content: 46  # type: ignore[method-assign]
    extractor._render_pdf_page = (  # type: ignore[method-assign]
        lambda _content, index: rendered.append(index) or page_png.getvalue()
    )
    content = b"%PDF-1.7 page-one scope"

    extraction = asyncio.run(
        extractor.extract(
            content,
            _source(content, "source.pdf", "application/pdf"),
            asyncio.Event(),
            pdf_page_numbers=(1,),
        )
    )

    assert rendered == []
    assert worker_client.options is not None
    assert worker_client.options["pageNumbers"] == [1]
    assert len(worker_client.options["pageManifest"]) == 1  # type: ignore[arg-type]
    assert extraction.raw.ocr_page_scope is not None
    assert extraction.raw.ocr_page_scope.model_dump(by_alias=True) == {
        "sourcePageCount": 46,
        "requestedPageNumbers": [1],
        "processedPageNumbers": [1],
    }


@pytest.mark.parametrize(
    ("segments", "canonical_second_page_text"),
    [
        (
            (
                WorkerSegment(0, "Worker B", page=1),
                WorkerSegment(1, "", page=2),
            ),
            "",
        ),
        (
            (
                WorkerSegment(0, "Rendered page one", page=1),
                WorkerSegment(1, "SECRET-EMPTY", page=2),
            ),
            "",
        ),
        ((WorkerSegment(0, "Rendered page one", page=1),), "Rendered page two"),
        (
            (
                WorkerSegment(0, "Rendered page one", page=1),
                WorkerSegment(1, "", page=2),
                WorkerSegment(2, "SECRET-EXTRA", page=3),
            ),
            "",
        ),
    ],
)
def test_worker_ocr_segments_must_match_canonical_projection(
    tmp_path: Path,
    segments: tuple[WorkerSegment, ...],
    canonical_second_page_text: str,
) -> None:
    class DivergingWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            return WorkerRunResult(
                segments=segments,
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=(
                    WorkerOcrPage(
                        page=1,
                        status="recognized",
                        text="Rendered page one",
                        boxes=((2, 3, 40, 20),),
                        confidence=0.97,
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    ),
                    WorkerOcrPage(
                        page=2,
                        status="recognized" if canonical_second_page_text else "empty",
                        text=canonical_second_page_text,
                        boxes=(),
                        confidence=0.91 if canonical_second_page_text else None,
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    ),
                ),
            )

    class EngineManager:
        worker_client = DivergingWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    extractor._pdf_page_count = lambda _content: 2  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]
    content = b"%PDF-1.7 canonical projection segment divergence fixture"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "segment-divergence.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_protocol"
    assert "Worker B" not in projection.model_dump_json()
    assert "SECRET" not in projection.model_dump_json()


def test_worker_ocr_projection_drives_raw_segments_for_perspective_boxes(
    tmp_path: Path,
) -> None:
    perspective_box = OcrBoxInput(
        polygon=((5.0, 4.0), (45.0, 2.0), (42.0, 22.0), (3.0, 24.0)),
        text="Perspective page one",
        confidence=0.94,
    )

    class PerspectiveWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            return WorkerRunResult(
                segments=(WorkerSegment(0, "Perspective page one", page=1),),
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=(
                    WorkerOcrPage(
                        page=1,
                        status="recognized",
                        text="Perspective page one",
                        boxes=(perspective_box,),
                        confidence=0.94,
                        region_confidences=(0.94,),
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    ),
                ),
            )

    class EngineManager:
        worker_client = PerspectiveWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    extractor._pdf_page_count = lambda _content: 1  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]
    content = b"%PDF-1.7 perspective canonical projection fixture"

    extraction = asyncio.run(
        extractor.extract(
            content,
            _source(content, "perspective.pdf", "application/pdf"),
            asyncio.Event(),
        )
    )

    assert extraction.ocr_projection is not None
    assert [segment.text for segment in extraction.raw.segments] == ["Perspective page one"]
    assert extraction.raw.source_text == extraction.ocr_projection.pages[0].text
    assert [
        (point.x, point.y) for point in extraction.ocr_projection.pages[0].boxes[0].polygon
    ] == list(perspective_box.polygon)


@pytest.mark.parametrize(
    "terminal_shape",
    (
        "extra_page",
        "extra_segment_without_page",
        "page_n_plus_one_segment",
        "duplicate_segment_page",
        "out_of_order_segment_page",
        "duplicate_terminal_page",
        "out_of_order_terminal_pages",
        "missing_terminal_page",
    ),
)
def test_worker_terminal_cardinality_is_rejected_before_raw_segments(
    tmp_path: Path,
    terminal_shape: str,
) -> None:
    def page(number: int) -> WorkerOcrPage:
        return WorkerOcrPage(
            page=number,
            status="recognized",
            text="SECRET-PREFIX" if number == 1 else f"Page {number}",
            boxes=(),
            confidence=0.5,
            raster_width=120,
            raster_height=80,
            raster_scale=2,
        )

    pages = (page(1), page(2))
    if terminal_shape == "extra_page":
        terminal_pages = (*pages, page(3))
        segments = tuple(
            WorkerSegment(
                number - 1,
                "SECRET-EXTRA" if number == 3 else f"Page {number}",
                page=number,
            )
            for number in (1, 2, 3)
        )
    elif terminal_shape == "extra_segment_without_page":
        terminal_pages = pages
        segments = (WorkerSegment(0, "SECRET-UNKNOWN", page=None),)
    elif terminal_shape == "page_n_plus_one_segment":
        terminal_pages = pages
        segments = (
            WorkerSegment(0, "Page 1", page=1),
            WorkerSegment(1, "SECRET-EXTRA", page=3),
        )
    elif terminal_shape == "duplicate_segment_page":
        terminal_pages = pages
        segments = (
            WorkerSegment(0, "Page 1", page=1),
            WorkerSegment(1, "SECRET-DUPLICATE", page=1),
        )
    elif terminal_shape == "out_of_order_segment_page":
        terminal_pages = pages
        segments = (
            WorkerSegment(0, "Page 2", page=2),
            WorkerSegment(1, "SECRET-OUT-OF-ORDER", page=1),
        )
    elif terminal_shape == "duplicate_terminal_page":
        terminal_pages = (pages[0], pages[0])
        segments = (WorkerSegment(0, "Page 1", page=1),)
    elif terminal_shape == "out_of_order_terminal_pages":
        terminal_pages = (pages[1], pages[0])
        segments = (
            WorkerSegment(0, "Page 1", page=1),
            WorkerSegment(1, "Page 2", page=2),
        )
    else:
        terminal_pages = (pages[0],)
        segments = (WorkerSegment(0, "Page 1", page=1),)

    class MalformedWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            return WorkerRunResult(
                segments=segments,
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=terminal_pages,
            )

    class EngineManager:
        worker_client = MalformedWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    extractor._pdf_page_count = lambda _content: 2  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]
    content = b"%PDF-1.7 terminal cardinality fixture"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "terminal-cardinality.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_protocol"
    assert [item.page for item in projection.pages] == [1, 2]
    assert [item.status.value for item in projection.pages] == ["failed", "failed"]
    assert all(item.text == "" for item in projection.pages)
    assert "SECRET" not in projection.model_dump_json()


@pytest.mark.parametrize(
    "cancel_check",
    (3, 4, 6),
    ids=("before-validation", "after-validation", "after-observation"),
)
def test_worker_projection_cancellation_does_not_become_success_or_protocol(
    tmp_path: Path,
    cancel_check: int,
) -> None:
    class ScriptedCancellation:
        def __init__(self) -> None:
            self.checks = 0

        def is_set(self) -> bool:
            self.checks += 1
            return self.checks >= cancel_check

    class ValidWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            return WorkerRunResult(
                segments=(WorkerSegment(0, "Rendered page one", page=1),),
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=(
                    WorkerOcrPage(
                        page=1,
                        status="recognized",
                        text="Rendered page one",
                        boxes=((2, 3, 40, 20),),
                        confidence=0.83,
                        region_confidences=(0.83,),
                        raster_width=120,
                        raster_height=80,
                        raster_scale=2,
                    ),
                ),
            )

    class EngineManager:
        worker_client = ValidWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    extractor._pdf_page_count = lambda _content: 1  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]
    content = b"%PDF-1.7 worker projection cancellation fixture"
    cancellation = ScriptedCancellation()

    with pytest.raises(InterruptedError):
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "cancelled.pdf", "application/pdf"),
                cancellation,  # type: ignore[arg-type]
            )
        )

    assert cancellation.checks == cancel_check


def test_worker_all_empty_terminal_is_failed_with_readable_no_text_projection(
    tmp_path: Path,
) -> None:
    class EmptyWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            return WorkerRunResult(
                segments=(),
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=(
                    WorkerOcrPage(
                        page=1,
                        status="empty",
                        text="",
                        boxes=(),
                        confidence=None,
                        raster_width=240,
                        raster_height=160,
                        raster_scale=2,
                    ),
                ),
            )

    class EngineManager:
        worker_client = EmptyWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    image = BytesIO()
    Image.new("RGB", (120, 80), "white").save(image, format="PNG")

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                image.getvalue(),
                _source(image.getvalue(), "empty.png", "image/png"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.failure is not None
    assert projection.failure.code == "ocr_no_text"
    assert [page.status.value for page in projection.pages] == ["empty"]


def test_worker_provenance_mismatch_discards_untrusted_progress_prefix(
    tmp_path: Path,
) -> None:
    manifest = tuple(
        WorkerOcrPage(
            page=page,
            status="empty",
            text="",
            boxes=(),
            confidence=None,
            raster_width=120,
            raster_height=80,
            raster_scale=2,
        )
        for page in (1, 2)
    )
    completed = WorkerOcrPage(
        page=1,
        status="recognized",
        text="valid prefix",
        boxes=(),
        confidence=0.8,
        raster_width=120,
        raster_height=80,
        raster_scale=2,
    )

    class MismatchedWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            return WorkerRunResult(
                segments=(WorkerSegment(0, "valid prefix", page=1),),
                engine="wrong-ocr-engine",
                model="wrong-model",
                digest=f"sha256:{'2' * 64}",
                device="cpu",
                warnings=(),
                pages=(completed,),
                ocr_progress=WorkerOcrProgress(
                    page_count=2,
                    page_manifest=manifest,
                    pages=(completed,),
                ),
            )

    class EngineManager:
        worker_client = MismatchedWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    extractor._pdf_page_count = lambda _content: 2  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]
    content = b"%PDF-1.7 provenance mismatch fixture"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "mismatch.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_protocol"
    assert [page.status.value for page in projection.pages] == ["failed", "failed"]
    assert projection.pages[0].text == ""


@pytest.mark.parametrize(
    ("kind", "with_progress", "expected_code"),
    [
        ("timeout", True, "ocr_worker_timeout"),
        ("protocol", False, "ocr_worker_protocol"),
        ("worker", True, "ocr_worker_failed"),
    ],
)
def test_worker_failure_projection_is_page_complete_and_sanitized(
    tmp_path: Path,
    kind: str,
    with_progress: bool,
    expected_code: str,
) -> None:
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    content = b"%PDF-1.7 page-count is read before worker launch"

    def page_manifest() -> WorkerOcrProgress:
        manifest = tuple(
            WorkerOcrPage(
                page=page,
                status="empty",
                text="",
                boxes=(),
                confidence=None,
                raster_width=120,
                raster_height=80,
                raster_scale=2,
            )
            for page in (1, 2)
        )
        completed = (
            manifest[0].__class__(
                page=1,
                status="recognized",
                text="completed page",
                boxes=((2, 3, 40, 20),),
                confidence=0.97,
                raster_width=120,
                raster_height=80,
                raster_scale=2,
            ),
        )
        return WorkerOcrProgress(
            page_count=2,
            page_manifest=manifest,
            provenance=_resolved_ocr_provenance(),
            pages=completed,
        )

    class FailingWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            raise OcrWorkerFailure(
                kind=kind,  # type: ignore[arg-type]
                progress=page_manifest() if with_progress else None,
            )

    class EngineManager:
        worker_client = FailingWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    extractor._pdf_page_count = lambda _content: 2  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content, _source(content, "source.pdf", "application/pdf"), asyncio.Event()
            )
        )

    projection = raised.value.projection
    assert projection.status.value == "failed"
    assert [page.page for page in projection.pages] == [1, 2]
    assert [page.status.value for page in projection.pages] == (
        ["recognized", "failed"] if with_progress else ["failed", "failed"]
    )
    assert projection.failure is not None
    assert projection.failure.code == expected_code
    assert "private" not in projection.failure.message.lower()
    assert "worker detail" not in projection.failure.message.lower()


def test_sync_ocr_manifest_raster_authority_ignores_adapter_dimensions(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class MismatchedRasterAdapter(FakeOcrAdapter):
        def extract_png(self, _image_png: bytes) -> OcrTextResult:
            return OcrTextResult(
                text="Manifest raster wins",
                device="windowsml-dml",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                regions=(
                    OcrRegion(
                        text="Manifest raster wins",
                        confidence=0.87,
                        polygon=((5, 5), (45, 5), (45, 25), (5, 25)),
                    ),
                ),
                raster_width=1,
                raster_height=1,
                raster_scale=1,
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=MismatchedRasterAdapter(),
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 1)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    content = b"%PDF-1.7 sync manifest raster authority"

    extraction = asyncio.run(
        extractor.extract(
            content,
            _source(content, "manifest-raster.pdf", "application/pdf"),
            asyncio.Event(),
        )
    )

    assert extraction.ocr_projection is not None
    page = extraction.ocr_projection.pages[0]
    assert (page.raster.width, page.raster.height, page.raster.scale) == (120, 80, 2)
    assert page.confidence == pytest.approx(0.87)
    assert [segment.text for segment in extraction.raw.segments] == ["Manifest raster wins"]


def test_sync_ocr_cancellation_after_inference_stops_before_next_page(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    cancel_event = asyncio.Event()

    class CancellingOcrAdapter(FakeOcrAdapter):
        calls = 0

        def extract_png(self, _image_png: bytes) -> OcrTextResult:
            self.calls += 1
            cancel_event.set()
            return OcrTextResult(
                text="Cancelled after inference",
                device="windowsml-dml",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                raster_width=120,
                raster_height=80,
            )

    adapter = CancellingOcrAdapter()
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=adapter,
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 2)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    content = b"%PDF-1.7 sync cancellation after inference"

    with pytest.raises(asyncio.CancelledError):
        asyncio.run(
            extractor.extract(
                content,
                _source(content, "sync-cancelled.pdf", "application/pdf"),
                cancel_event,
            )
        )

    assert adapter.calls == 1


@pytest.mark.parametrize("dimension", ("width", "height"))
def test_worker_ocr_manifest_dimensions_remain_strict(
    tmp_path: Path,
    dimension: str,
) -> None:
    dimensions = {"width": 121, "height": 81}

    class MismatchedWorkerClient:
        async def run(self, _engine: InstalledEngine, **_kwargs: object) -> WorkerRunResult:
            return WorkerRunResult(
                segments=(WorkerSegment(0, "Rendered page one", page=1),),
                engine="windowsml-ocr",
                model="pp-ocrv6-medium-windowsml",
                digest=f"sha256:{'1' * 64}",
                device="windowsml-dml",
                warnings=(),
                pages=(
                    WorkerOcrPage(
                        page=1,
                        status="recognized",
                        text="Rendered page one",
                        boxes=((2, 3, 40, 20),),
                        confidence=0.83,
                        region_confidences=(0.83,),
                        raster_width=dimensions["width"] if dimension == "width" else 120,
                        raster_height=dimensions["height"] if dimension == "height" else 80,
                        raster_scale=1,
                    ),
                ),
            )

    class EngineManager:
        worker_client = MismatchedWorkerClient()

        async def ocr_compute_selection(self, *, contract_sha256: str) -> object:
            del contract_sha256
            return _worker_ocr_plan_selection()

        async def resolve_active_engine(self, _requirement_id: str) -> InstalledEngine:
            return InstalledEngine(
                requirement_id="windowsml-ocr",
                artifact_version="0.4.2",
                executable=tmp_path / "ocr.exe",
                model_dir=tmp_path / "models",
            )

    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        engine_manager=EngineManager(),  # type: ignore[arg-type]
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    extractor._pdf_page_count = lambda _content: 1  # type: ignore[method-assign]
    extractor._render_pdf_page = lambda _content, _index: page_png.getvalue()  # type: ignore[method-assign]
    content = b"%PDF-1.7 worker raster dimensions"

    with pytest.raises(OcrExtractionFailure) as raised:
        asyncio.run(
            extractor.extract(
                content,
                _source(content, f"worker-{dimension}.pdf", "application/pdf"),
                asyncio.Event(),
            )
        )

    projection = raised.value.projection
    assert projection.failure is not None
    assert projection.failure.code == "ocr_worker_protocol"
    assert [page.status.value for page in projection.pages] == ["failed"]


def test_pdf_pages_always_use_ocr_and_preserve_page_provenance(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ocr = FakeOcrAdapter("Rendered OCR")
    extractor = StandaloneRuntimeCaptureExtractor(
        SystemClock(),
        _config(tmp_path),
        ocr_adapter=ocr,
        whisper_adapter=FakeWhisperAdapter(),
    )
    page_png = BytesIO()
    Image.new("RGB", (120, 80), "white").save(page_png, format="PNG")
    monkeypatch.setattr(extractor, "_pdf_page_count", lambda _content: 2)
    monkeypatch.setattr(
        extractor,
        "_render_pdf_page",
        lambda _content, _index: page_png.getvalue(),
    )
    content = b"%PDF-1.7 embedded text is deliberately ignored"
    raw = asyncio.run(
        extractor.extract(
            content,
            _source(content, "source.pdf", "application/pdf"),
            asyncio.Event(),
        )
    ).raw

    assert ocr.images == [page_png.getvalue(), page_png.getvalue()]
    assert [segment.text for segment in raw.segments] == ["Rendered OCR", "Rendered OCR"]
    assert [segment.locator.page for segment in raw.segments] == [1, 2]
    assert raw.extraction_engine.engine == "windowsml-ocr"
    assert raw.source_text == "Rendered OCR\nRendered OCR"


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
