from __future__ import annotations

import ast
import asyncio
from pathlib import Path
from unittest.mock import MagicMock, PropertyMock

from capture_runtime.progressive_capture import _drain_stderr
from capture_runtime.worker_process import _diagnostic_stage_sequence
from capture_runtime.worker_stage_policy import (
    MAX_WORKER_DIAGNOSTIC_STAGES,
    _native_suffix,
    bound_worker_stage_sequence,
    ocr_import_failure_stage,
    ocr_import_stage,
    ocr_probe_missing_stage,
    ocr_probe_providers_stage,
    ocr_provider_evidence_stage,
    ocr_stage_failure,
    sanitize_worker_stage,
    stage_builder_names,
    whisper_import_stage,
    whisper_model_load_stage,
)

RUNTIME_ROOT = Path(__file__).parents[2]
PRODUCER_FILES = (
    RUNTIME_ROOT / "src/capture_runtime/workers/ocr_main.py",
    RUNTIME_ROOT / "src/capture_runtime/workers/whisper_main.py",
    RUNTIME_ROOT / "src/capture_runtime/engine_adapters.py",
)
_IMPORT_DETAIL = "secret-token C:\\private\\source"


def _report_stage_calls(path: Path) -> list[ast.Call]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    return [
        node
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
        and (
            (isinstance(node.func, ast.Name) and node.func.id == "_report_stage")
            or (isinstance(node.func, ast.Attribute) and node.func.attr == "_report_stage")
        )
    ]


def test_worker_stage_policy_is_stdlib_only() -> None:
    path = RUNTIME_ROOT / "src/capture_runtime/worker_stage_policy.py"
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))

    imports = [node for node in ast.walk(tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
    assert all(
        (
            isinstance(node, ast.ImportFrom)
            and (
                (node.module or "").split(".", 1)[0] in {"__future__", "re", "typing"}
                or (node.level == 1 and node.module == "_generated_worker_stage_policy")
            )
        )
        or (
            isinstance(node, ast.Import)
            and all(alias.name.split(".", 1)[0] == "re" for alias in node.names)
        )
        for node in imports
    )


def test_all_literal_producer_stages_are_registered_and_dynamic_forms_are_builders() -> None:
    builders = stage_builder_names()
    assert builders

    for path in PRODUCER_FILES:
        for call in _report_stage_calls(path):
            assert len(call.args) == 1, f"{path}:{call.lineno} has invalid stage call"
            argument = call.args[0]
            if isinstance(argument, ast.Constant) and isinstance(argument.value, str):
                assert sanitize_worker_stage(argument.value) == argument.value, (
                    f"{path}:{call.lineno} uses an unregistered literal stage {argument.value!r}"
                )
                continue
            assert (
                isinstance(argument, ast.Call)
                and isinstance(argument.func, ast.Name)
                and argument.func.id in builders
            ), f"{path}:{call.lineno} uses an unregistered dynamic stage form"


def test_stage_builders_preserve_current_ocr_and_whisper_families() -> None:
    assert ocr_import_stage("paddleocr", "start") == "python-import-paddleocr-start"
    assert ocr_import_failure_stage("paddleocr", ModuleNotFoundError()) == (
        "python-import-paddleocr-failed-modulenotfounderror-missing-module-paddleocr"
    )
    assert ocr_probe_missing_stage("modules", 2) == "ocr-probe-modules-missing-2"
    assert ocr_probe_providers_stage(3, cpu=True, dml=False) == (
        "ocr-probe-providers-3-cpu-yes-dml-no"
    )
    assert ocr_provider_evidence_stage(5, 2) == "ocr-provider-evidence-dml-5-cpu-2"
    assert ocr_stage_failure("predict", RuntimeError()) == "ocr-predict-failed-runtimeerror"
    assert whisper_import_stage("faster_whisper", "complete") == (
        "python-import-faster-whisper-complete"
    )
    assert whisper_model_load_stage("cpu", "failed", RuntimeError()) == (
        "whisper-model-load-cpu-failed-runtimeerror"
    )


def test_ocr_import_failure_stage_classifies_typed_evidence_without_leaking_details() -> None:
    missing = ModuleNotFoundError(_IMPORT_DETAIL, name="paddlex.secret")
    native = ImportError("DLL load failed " + _IMPORT_DETAIL, name="onnxruntime.core")
    cannot = ImportError("cannot import name secret_symbol " + _IMPORT_DETAIL, name="paddlex")
    partial = ImportError(
        "cannot import secret_symbol; partially initialized; circular import " + _IMPORT_DETAIL,
        name="paddlex",
    )
    unknown = ImportError(_IMPORT_DETAIL, name="vendor.secret")
    cases = (
        ("paddleocr", "modulenotfounderror-missing-module-paddlex", missing),
        ("onnxruntime", "importerror-native-load-onnxruntime-unknown-onnxruntime", native),
        ("paddleocr", "importerror-cannot-import-symbol-paddlex", cannot),
        ("paddleocr", "importerror-partial-init-paddlex", partial),
        ("paddleocr", "importerror-other-paddleocr", unknown),
    )
    for module, suffix, error in cases:
        stage = ocr_import_failure_stage(module, error)
        assert stage == f"python-import-{module}-failed-{suffix}"
        assert sanitize_worker_stage(stage) == stage
        assert "secret-token" not in stage and "private" not in stage
        assert "secret_symbol" not in stage and "paddlex.secret" not in stage
        assert "vendor.secret" not in stage
        assert "onnxruntime.core" not in stage


def _native_error(message: str = "DLL load failed", **attributes: object) -> OSError:
    value = OSError(message)
    for name, item in attributes.items():
        setattr(value, name, item)
    return value


def _native_chain(*errors: OSError, cycle: bool = False, context: bool = False) -> OSError:
    for left, right in zip(errors, errors[1:], strict=False):
        setattr(left, "__context__" if context else "__cause__", right)
    if cycle:
        errors[-1].__cause__ = errors[0]
        assert errors[-1].__cause__ is errors[0]
    if context:
        assert errors[0].__cause__ is None and errors[0].__context__ is errors[1]
    return errors[0]


_NATIVE_CASES = (*zip((_native_error(winerror=code) for code in (126, 127, 193, 1114, 8, 14, 1455, 5, 577, 14001)), "dependency-missing-unknown symbol-missing-unknown bad-image-unknown initialization-failed-unknown resource-exhausted-unknown resource-exhausted-unknown resource-exhausted-unknown blocked-unknown blocked-unknown side-by-side-unknown".split(), strict=True), (_native_error("DLL load failed: [WinError\t127]"), "symbol-missing-unknown"), (_native_error("DLL load failed; error 126"), "unknown-unknown"), (_native_chain(ImportError("DLL load failed"), _native_error("DLL load failed: WinError 126: module not found", winerror=999)), "unknown-unknown"), (_native_chain(ImportError(r"DLL load failed while importing cv2: [WinError 126] C:\private\secret-token\cv2.dll"), _native_error(winerror=126, name="cv2")), "dependency-missing-opencv"), (_native_chain(_native_error(winerror=1455), _native_error(winerror=126)), "dependency-missing-unknown"), (_native_chain(_native_error(), _native_error(winerror=126), context=True), "dependency-missing-unknown"), (_native_chain(_native_error(), _native_error(winerror=127), cycle=True), "symbol-missing-unknown"), (_native_chain(_native_error("DLL load failed while importing PIL; C:\\x\\onnxruntime.dll", name="paddleocr"), _native_error(name="cv2")), "unknown-opencv"), (_native_error("DLL load failed while importing PIL: C:\\x\\onnxruntime.dll"), "unknown-pillow"), (_native_error("DLL load failed: C:\\x\\opencv_world490.dll"), "unknown-opencv"), (_native_error("DLL load failed: C:\\x\\onnxruntime_providers_shared.dll"), "unknown-onnxruntime"), (_native_error("DLL load failed: onnxruntime_providers_shared.dll"), "unknown-onnxruntime"), (_native_error("DLL load failed: C:\\temp\\notes-onnxruntime_providers_shared.dll.txt"), "unknown-unknown"), (_native_error("DLL load failed while importing C:\\private\\secret.dll; C:\\private\\cv2.dll", name="C:\\private\\secret"), "unknown-unknown"))  # fmt: skip  # noqa: E501


def test_native_import_failure_uses_bounded_chain_reason_and_component_evidence() -> None:
    for error, suffix in _NATIVE_CASES:
        assert sanitize_worker_stage(stage := ocr_import_failure_stage("paddleocr", error)) == stage and stage.split("-native-load-paddleocr-", 1)[1] == suffix  # fmt: skip  # noqa: E501
    left, right = MagicMock(), MagicMock()
    left.winerror, right.winerror = None, 127
    left_cause, right_cause = PropertyMock(return_value=right), PropertyMock(return_value=left)
    type(left).__cause__, type(right).__cause__ = left_cause, right_cause
    assert (_native_suffix(left), left_cause.call_count, right_cause.call_count) == ("symbol-missing-unknown", 1, 1)  # fmt: skip  # noqa: E501


def test_unknown_stage_is_not_trusted_by_the_shared_policy() -> None:
    assert sanitize_worker_stage("secret-token-abc123") is None
    assert sanitize_worker_stage("ocr-probe-assets-start") is None
    assert bound_worker_stage_sequence(["secret-token-abc123", "ocr-probe-start"]) == (
        "ocr-probe-start",
    )


def test_bounded_stage_sequence_preserves_ocr_gpu_semantics_and_failure_tail() -> None:
    stages = [
        "worker-entry-start",
        "python-import-pdfium-start",
        "python-import-pdfium-complete",
        "python-import-pillow-start",
        "python-import-pillow-complete",
        "python-import-capture-runtime-start",
        "python-import-capture-runtime-complete",
        "python-import-onnxruntime-start",
        "python-import-onnxruntime-complete",
        "python-import-paddleocr-start",
        "python-import-paddleocr-complete",
        "ocr-pdf-render-start",
        "ocr-pdf-render-complete",
        "ocr-probe-start",
        "ocr-probe-modules-start",
        "ocr-probe-modules-ready",
        "ocr-probe-assets-ready",
        "ocr-probe-providers-2-cpu-yes-dml-yes",
        "ocr-probe-complete",
        "ocr-pipeline-create-start",
        "ocr-native-map-before",
        "ocr-paddle-factory",
        "ocr-native-map-after",
        "ocr-execution-evidence-prepare",
        "ocr-dml-device-id-unobservable",
        "ocr-pipeline-create-complete",
        "ocr-predict-start",
        "ocr-predict-complete",
        "ocr-provider-evidence-start",
        "ocr-provider-evidence-dml-6-cpu-1",
    ]
    for _ in range(3):
        stages.extend(
            [
                "ocr-pdf-render-start",
                "ocr-pdf-render-complete",
                "ocr-probe-start",
                "ocr-probe-modules-start",
                "ocr-probe-modules-ready",
                "ocr-probe-assets-ready",
                "ocr-probe-providers-2-cpu-yes-dml-yes",
                "ocr-probe-complete",
                "ocr-predict-start",
                "ocr-predict-complete",
                "ocr-provider-evidence-start",
                "ocr-provider-evidence-dml-6-cpu-1",
            ]
        )
    stages.append("ocr-predict-failed-runtimeerror")

    bounded = _diagnostic_stage_sequence(
        "\n".join(f"capture-worker-stage:{stage}" for stage in stages)
    )

    assert len(stages) > MAX_WORKER_DIAGNOSTIC_STAGES
    assert len(bounded) == MAX_WORKER_DIAGNOSTIC_STAGES
    assert bounded[:16] == tuple(stages[:16])
    assert bounded[-1] == "ocr-predict-failed-runtimeerror"
    assert "worker-stage-sequence-truncated" in bounded
    for stage in (
        "ocr-native-map-before",
        "ocr-paddle-factory",
        "ocr-native-map-after",
        "ocr-execution-evidence-prepare",
        "ocr-dml-device-id-unobservable",
    ):
        assert stage in bounded
    selected = [stage for stage in bounded if stage != "worker-stage-sequence-truncated"]
    iterator = iter(stages)
    assert all(any(candidate == stage for candidate in iterator) for stage in selected)


def test_bounded_stage_sequence_is_deterministic_with_extreme_repeated_critical_stages() -> None:
    critical_stages = (
        "ocr-native-map-before",
        "ocr-paddle-factory",
        "ocr-native-map-after",
        "ocr-execution-evidence-prepare",
        "ocr-dml-device-id-unobservable",
        "ocr-dml-device-id-mismatch",
    )
    stages = tuple(stage for stage in critical_stages for _ in range(80)) + (
        "ocr-predict-failed-runtimeerror",
    )

    first = bound_worker_stage_sequence(stages)
    second = bound_worker_stage_sequence(stages)

    assert first == second
    assert len(first) == MAX_WORKER_DIAGNOSTIC_STAGES
    assert first.count("worker-stage-sequence-truncated") == 1
    for stage in critical_stages:
        assert stage in first
    assert first[-1] == "ocr-predict-failed-runtimeerror"


def test_progressive_stage_drain_uses_the_shared_policy_without_leaking_markers() -> None:
    class Stderr:
        def __init__(self) -> None:
            self._chunks = [
                b"capture-worker-stage:secret-token-abc123\n",
                b"capture-worker-stage:whisper-output-empty\n",
                b"",
            ]

        async def read(self, _size: int) -> bytes:
            return self._chunks.pop(0)

    assert asyncio.run(_drain_stderr(Stderr())) == "whisper-output-empty"
