"""Private semantic policy for worker stage markers.

This module is intentionally pure stdlib. Worker entrypoints import it before
optional engine dependencies, while runtime consumers use the same policy as
defense in depth before retaining a stage in diagnostics or an error message.
The generated data is owned by the private JSON policy source and checked for
byte drift by the runtime generation gate.
"""

from __future__ import annotations

import re
from typing import Final

from ._generated_worker_stage_policy import (
    EXACT_STAGES as _EXACT_STAGES,
)
from ._generated_worker_stage_policy import (
    EXCEPTION_NAMES as _EXCEPTION_NAMES,
)
from ._generated_worker_stage_policy import (
    FAMILY_PATTERNS as _FAMILY_PATTERN_SOURCES,
)
from ._generated_worker_stage_policy import (
    MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH,
    MAX_WORKER_DIAGNOSTIC_STAGES,
)
from ._generated_worker_stage_policy import (
    STAGE_BUILDER_NAMES as _STAGE_BUILDER_NAMES,
)
from ._generated_worker_stage_policy import (
    UNKNOWN_PREFIXES as _UNKNOWN_PREFIXES,
)
from ._generated_worker_stage_policy import (
    WORKER_STAGE_CRITICAL_STAGES as _CRITICAL_STAGES,
)
from ._generated_worker_stage_policy import (
    WORKER_STAGE_FAILURE_TAIL_COUNT as _FAILURE_TAIL_COUNT,
)
from ._generated_worker_stage_policy import (
    WORKER_STAGE_STARTUP_HEAD_COUNT as _STARTUP_HEAD_COUNT,
)

WORKER_STAGE_PATTERN: Final = re.compile(
    r"(?m)^capture-worker-stage:([a-z0-9]+(?:-[a-z0-9]+)*)\r?$"
)
WORKER_STAGE_NAME_PATTERN: Final = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*")
_FAMILY_PATTERNS: Final = tuple(re.compile(pattern) for pattern in _FAMILY_PATTERN_SOURCES)
_NATIVE_REASON_PRIORITY: Final = tuple((int(code), label) for code, label in (item.split(":", 1) for item in "126:dependency-missing 127:symbol-missing 193:bad-image 1114:initialization-failed 8:resource-exhausted 14:resource-exhausted 1455:resource-exhausted 5:blocked 577:blocked 14001:side-by-side".split()))  # fmt: skip  # noqa: E501
_NATIVE_COMPONENT_ALIASES: Final = dict(item.split("=", 1) for item in "onnxruntime=onnxruntime onnxruntime-directml=directml directml=directml cv2=opencv opencv=opencv opencv-python=opencv numpy=numpy pandas=pandas shapely=shapely pyclipper=pyclipper pil=pillow pillow=pillow pydantic-core=pydantic-core -pydantic-core=pydantic-core rpds=rpds rpds-py=rpds tokenizers=tokenizers chardet=chardet charset-normalizer=charset-normalizer aiohttp=aiohttp multidict=multidict yarl=yarl frozenlist=frozenlist propcache=propcache vc-runtime=vc-runtime vcruntime=vc-runtime python=python-runtime python-runtime=python-runtime paddlex=paddlex paddle=paddleocr paddleocr=paddleocr unknown=unknown".split())  # fmt: skip  # noqa: E501


def stage_builder_names() -> frozenset[str]:
    """Return the producer call names allowed by the source inventory gate."""

    return _STAGE_BUILDER_NAMES


def sanitize_worker_stage(stage: object) -> str | None:
    """Return a semantic stage safe for private/public diagnostics, or ``None``."""

    if not isinstance(stage, str) or len(stage) > MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH:
        return None
    if WORKER_STAGE_NAME_PATTERN.fullmatch(stage) is None:
        return None
    if stage in _EXACT_STAGES or any(pattern.fullmatch(stage) for pattern in _FAMILY_PATTERNS):
        return stage
    for prefix, sentinel in _UNKNOWN_PREFIXES:
        if stage.startswith(prefix):
            return sentinel
    model_failure = re.fullmatch(
        r"whisper-model-load-(?P<device>cpu|cuda)-failed-.+",
        stage,
    )
    if model_failure is not None:
        return f"whisper-model-load-{model_failure.group('device')}-failed-unknown"
    return None


def sanitize_worker_stage_sequence(
    stages: tuple[str, ...] | list[str],
    *,
    reject_unknown: bool,
) -> tuple[str, ...]:
    sanitized: list[str] = []
    for stage in stages:
        safe_stage = sanitize_worker_stage(stage)
        if safe_stage is None:
            if reject_unknown:
                raise ValueError("worker diagnostic stage is not allowlisted")
            continue
        sanitized.append(safe_stage)
    return tuple(sanitized)


def bound_worker_stage_sequence(stages: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """Bound stages while retaining startup, critical OCR, and terminal evidence."""

    stages = tuple(
        safe_stage for stage in stages if (safe_stage := sanitize_worker_stage(stage)) is not None
    )
    if len(stages) <= MAX_WORKER_DIAGNOSTIC_STAGES:
        return tuple(stages)
    real_capacity = MAX_WORKER_DIAGNOSTIC_STAGES - 1
    selected = set(range(min(_STARTUP_HEAD_COUNT, len(stages))))
    selected.update(
        range(
            max(0, len(stages) - _FAILURE_TAIL_COUNT),
            len(stages),
        )
    )
    # Represent each critical semantic kind once; repeated markers cannot
    # consume the bounded diagnostic budget.
    first_critical: set[str] = set()
    for index, stage in enumerate(stages):
        if stage in _CRITICAL_STAGES and stage not in first_critical:
            selected.add(index)
            first_critical.add(stage)
    for index in range(len(stages)):
        if len(selected) >= real_capacity:
            break
        selected.add(index)
    omitted = next(index for index in range(len(stages)) if index not in selected)
    bounded: list[str] = []
    marker_added = False
    for index, stage in enumerate(stages):
        if not marker_added and index == omitted:
            bounded.append("worker-stage-sequence-truncated")
            marker_added = True
        if index in selected:
            bounded.append(stage)
    if not marker_added:
        bounded.append("worker-stage-sequence-truncated")
    return tuple(bounded)


def _exception_name(error: object) -> str:
    name = type(error).__name__.casefold()
    return name if name in _EXCEPTION_NAMES else "unknown"


def _bounded_count(value: object, maximum: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= maximum:
        return None
    return value


def ocr_import_stage(module: str, phase: str) -> str:
    if module not in {"onnxruntime", "paddleocr"} or phase not in {"start", "complete"}:
        return "python-import-paddleocr-failed-unknown"
    return f"python-import-{module}-{phase}"


def ocr_import_failure_stage(module: str, error: object) -> str:
    if module not in {"onnxruntime", "paddleocr"}:
        return "python-import-paddleocr-failed-unknown"
    kind = _ocr_import_failure_kind(error)
    return (
        f"python-import-{module}-failed-{_exception_name(error)}-"
        f"{kind}-{_ocr_import_family(module, error)}"
        + (f"-{_native_suffix(error)}" if kind == "native-load" else "")
    )


def _ocr_import_failure_kind(error: object) -> str:
    if isinstance(error, ModuleNotFoundError):
        return "missing-module"
    message = str(error).casefold()
    return (
        "native-load"
        if "dll load failed" in message
        else "partial-init"
        if "partially initialized" in message or "circular import" in message
        else "cannot-import-symbol"
        if "cannot import" in message
        else "other"
    )


def _ocr_import_family(module: str, error: object) -> str:
    name = getattr(error, "name", None)
    if isinstance(name, str):
        folded_name = name.casefold()
        return next(
            (
                family
                for family in ("onnxruntime", "paddleocr", "paddlex")
                if folded_name == family or folded_name.startswith(f"{family}.")
            ),
            module,
        )
    return module if module in {"onnxruntime", "paddleocr"} else "unknown"


# fmt: off
_NATIVE_IMPORT_TOKEN_PATTERN = re.compile(r"(?<![a-z0-9_.-])while\s+importing\s+([a-z_][a-z0-9_.-]*)(?![a-z0-9_.-]|[\\/]|:(?=[\\/]))")  # noqa: E501
_NATIVE_DLL_PATTERN = re.compile(r"(?<![a-z0-9_.-])(?:(?P<directml>onnxruntime_providers_(?:directml|dml)|directml)(?:[_-][0-9.]+)?|(?P<onnxruntime>onnxruntime_providers_shared|onnxruntime)(?:[_-][0-9.]+)?|(?P<opencv>opencv(?:_world)?[0-9]*)|(?P<numpy>(?:mkl_rt|openblas|libiomp5md)(?:[-_.][a-z0-9.]+)*)|(?P<paddleocr>paddleocr(?:[-_.][0-9.]+)*)|(?P<paddlex>paddle(?:_inference|ocr|x)?(?:[-_.][0-9.]+)*)|(?P<pydantic_core>pydantic[_-]core(?:[-_.][0-9.]+)*)|(?P<python_runtime>python3?[0-9]*)|(?P<vc_runtime>(?:msvcp|vcruntime)[0-9_]+)|(?P<pillow>(?:libjpeg|libpng|freetype|tiff)(?:[-_.][a-z0-9.]+)*))\.dll(?![a-z0-9_.-])")  # fmt: skip  # noqa: E501
_WINERROR_PATTERN = re.compile(r"\bwinerror\s+([0-9]{1,5})\b")


def _native_suffix(error: object) -> str:
    def component(value: object) -> str | None:
        if not isinstance(value, str) or re.fullmatch(r"[a-z_][a-z0-9_.-]*", value.casefold()) is None:  # noqa: E501
            return None
        return _NATIVE_COMPONENT_ALIASES.get(value.casefold().split(".", 1)[0].replace("_", "-"))

    def reason(values: tuple[object, ...]) -> str | None:
        return next((label for code, label in _NATIVE_REASON_PRIORITY if any(
            isinstance(value, int) and not isinstance(value, bool) and value == code for value in values  # noqa: E501
        )), None)

    chain: list[object] = []
    seen: set[int] = set()
    for _ in range(4):
        if error is None or id(error) in seen:
            break
        seen.add(id(error))
        chain.append(error)
        cause = getattr(error, "__cause__", None)
        error = cause if cause is not None else getattr(error, "__context__", None)
    messages = tuple(re.sub(r"\s+", " ", str(node)).casefold() for node in chain)
    winerrors = tuple(getattr(node, "winerror", None) for node in reversed(chain))
    has_exact_winerror = any(isinstance(value, int) and not isinstance(value, bool) for value in winerrors)  # noqa: E501
    phrase_winerrors = tuple(int(match.group(1)) for message in reversed(messages) for match in _WINERROR_PATTERN.finditer(message))  # noqa: E501
    native_reason = reason(winerrors) if has_exact_winerror else reason(phrase_winerrors)
    native_component = None
    for values in (
        (getattr(node, "name", None) for node in reversed(chain)),
        (
            match.group(1)
            for message in reversed(messages)
            for match in _NATIVE_IMPORT_TOKEN_PATTERN.finditer(message)
        ),
        (
            value.replace("_", "-")
            for message in reversed(messages)
            for match in _NATIVE_DLL_PATTERN.finditer(message)
            for value, matched in match.groupdict().items()
            if matched
        ),
    ):
        native_component = next((mapped for value in values if (mapped := component(value))), None)  # fmt: skip  # noqa: E501
        if native_component:
            break
    return f"{native_reason or 'unknown'}-{native_component or 'unknown'}"
# fmt: on


def ocr_probe_missing_stage(kind: str, count: int) -> str:
    maximum = 999 if kind == "modules" else 9_999 if kind == "assets" else -1
    bounded = _bounded_count(count, maximum)
    if bounded is None:
        if kind in {"modules", "assets"}:
            return f"ocr-probe-{kind}-missing-unknown"
        return "ocr-probe-modules-missing-unknown"
    return f"ocr-probe-{kind}-missing-{bounded}"


def ocr_probe_readiness_stage(kind: str, count: int) -> str:
    if kind not in {"modules", "assets"}:
        return "ocr-probe-modules-missing-unknown"
    if count == 0:
        return f"ocr-probe-{kind}-ready"
    return ocr_probe_missing_stage(kind, count)


def ocr_probe_providers_stage(count: int, *, cpu: bool, dml: bool) -> str:
    bounded = _bounded_count(count, 999_999)
    if bounded is None or not isinstance(cpu, bool) or not isinstance(dml, bool):
        return "ocr-probe-providers-unknown"
    cpu_value = "yes" if cpu else "no"
    dml_value = "yes" if dml else "no"
    return f"ocr-probe-providers-{bounded}-cpu-{cpu_value}-dml-{dml_value}"


def ocr_provider_evidence_stage(dml_count: int, cpu_count: int) -> str:
    dml = _bounded_count(dml_count, 999_999)
    cpu = _bounded_count(cpu_count, 999_999)
    if dml is None or cpu is None:
        return "ocr-provider-evidence-unknown"
    return f"ocr-provider-evidence-dml-{dml}-cpu-{cpu}"


def ocr_stage_failure(stage: str, error: object) -> str:
    if stage not in {"pipeline-create", "predict", "provider-evidence"}:
        return "ocr-predict-failed-unknown"
    return f"ocr-{stage}-failed-{_exception_name(error)}"


def whisper_import_stage(module: str, phase: str) -> str:
    module_name = {
        "ctranslate2": "ctranslate",
        "av": "av",
        "faster_whisper": "faster-whisper",
    }.get(module)
    if module_name is None or phase not in {"start", "complete"}:
        return "python-import-faster-whisper-failed-unknown"
    return f"python-import-{module_name}-{phase}"


def whisper_import_os_failure_stage(module: str, error: object) -> str:
    if module not in {"engine-adapters", "worker-contracts", "worker-server"}:
        return "python-import-engine-adapters-os-failed-winerror-unknown"
    winerror = getattr(error, "winerror", None)
    if isinstance(winerror, int) and not isinstance(winerror, bool) and 0 <= winerror <= 65_535:
        return f"python-import-{module}-os-failed-winerror-{winerror}"
    return f"python-import-{module}-os-failed"


def whisper_stage(stage: str) -> str:
    if stage not in {
        "assets-probe-start",
        "assets-probe-complete",
        "device-probe-start",
        "device-probe-complete",
        "gpu-fallback",
        "model-load-cpu-fallback-float32",
        "transcription-call-start",
        "transcription-call-complete",
        "transcription-iteration-start",
        "output-empty",
        "output-empty-window",
        "transcription-complete",
    }:
        return "whisper-output-empty"
    return f"whisper-{stage}"


def whisper_output_stage(has_output: bool) -> str:
    return whisper_stage("transcription-complete" if has_output else "output-empty-window")


def whisper_model_load_stage(device: str, phase: str, error: object | None = None) -> str:
    if device not in {"cpu", "cuda"}:
        return "whisper-model-load-cpu-failed-unknown"
    if phase == "failed":
        return f"whisper-model-load-{device}-failed-{_exception_name(error)}"
    if phase in {"start", "complete", "reused"}:
        return f"whisper-model-load-{device}-{phase}"
    return f"whisper-model-load-{device}-failed-unknown"


__all__ = [
    "MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH",
    "MAX_WORKER_DIAGNOSTIC_STAGES",
    "WORKER_STAGE_PATTERN",
    "ocr_import_failure_stage",
    "ocr_import_stage",
    "ocr_probe_missing_stage",
    "ocr_probe_readiness_stage",
    "ocr_probe_providers_stage",
    "ocr_provider_evidence_stage",
    "ocr_stage_failure",
    "bound_worker_stage_sequence",
    "sanitize_worker_stage",
    "sanitize_worker_stage_sequence",
    "stage_builder_names",
    "whisper_import_os_failure_stage",
    "whisper_import_stage",
    "whisper_model_load_stage",
    "whisper_output_stage",
    "whisper_stage",
]
