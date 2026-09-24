"""Canonical PaddleOCR profile and the only seam that applies it.

The profile is deliberately a packaged, canonical JSON document.  Hosts do not
choose an OCR language or pass arbitrary Paddle kwargs: this module validates
the document, derives its identity from its bytes, verifies the installed
artifacts, and constructs the small PaddleX configuration accepted by the
runtime adapter.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from capture_runtime.constants import RUNTIME_VERSION

CANONICAL_PROFILE_PATH = Path(__file__).resolve().parent / "assets" / "ocr-profile.json"
PROFILE_ALGORITHM = "capture-workbench-ocr-profile-v2"
PROFILE_ID_PREFIX = "capture-workbench-ocr"
MODEL_ARTIFACT_PATHS = (
    "det/inference.onnx",
    "det/inference.yml",
    "rec/inference.onnx",
    "rec/inference.yml",
    "rec/ppocrv6_dict.txt",
)
EXPECTED_DET_REVISION = "61323801669c338b7891481ec7bac61ce31b576a"
EXPECTED_REC_REVISION = "50c7eacafc52fa7bcf4194e8cd08e46f8558504b"
EXPECTED_DICTIONARY_REVISION = "b03f46425e8ff4442b268ce449e3eef758146cd4"


class EngineRuntimeUnavailableError(RuntimeError):
    """Raised when the canonical OCR profile or its local assets are invalid."""


def canonical_json_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def canonical_profile_bytes(path: Path = CANONICAL_PROFILE_PATH) -> bytes:
    try:
        payload = path.read_bytes()
        parsed = json.loads(payload)
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError) as error:
        raise EngineRuntimeUnavailableError("OCR canonical profile is unreadable.") from error
    canonical = canonical_json_bytes(parsed)
    if payload != canonical:
        raise EngineRuntimeUnavailableError(
            "OCR canonical profile must use canonical UTF-8 JSON bytes."
        )
    return canonical


@dataclass(frozen=True, slots=True)
class OcrModelArtifact:
    path: str
    bytes: int
    sha256: str


@dataclass(frozen=True, slots=True)
class OcrProfileSpec:
    """Validated profile plus derived identities and application behaviour."""

    document: dict[str, Any]
    profile_id: str
    profile_spec_sha256: str
    model_artifacts: tuple[OcrModelArtifact, ...]

    @property
    def model(self) -> str:
        return cast(str, self.document["model"])

    @property
    def orientation(self) -> dict[str, bool]:
        return cast(dict[str, bool], self.document["orientation"])

    @property
    def preprocessing(self) -> dict[str, Any]:
        return cast(dict[str, Any], self.document["preprocessing"])

    def paddle_kwargs(
        self,
        *,
        model_dir: Path | None = None,
        device_id: int | None = None,
        use_dml: bool = True,
        profile_file_prefix: str | None = None,
    ) -> dict[str, Any]:
        """Return exactly the PaddleOCR/PaddleX accepted constructor kwargs.

        ``targetLanguage`` intentionally has no parameter here.  It belongs to
        structuring, never to OCR model selection or preprocessing.
        """

        if use_dml and (
            isinstance(device_id, bool) or not isinstance(device_id, int) or device_id < 0
        ):
            raise EngineRuntimeUnavailableError("OCR device id is invalid.")
        base = Path(".") if model_dir is None else model_dir
        models = self.document["models"]
        orientation = self.orientation
        directml = self.document["directml"]
        if use_dml and not profile_file_prefix:
            raise EngineRuntimeUnavailableError(
                "DML OCR configuration requires a profile file prefix."
            )
        providers = ["CPUExecutionProvider"]
        provider_options: list[dict[str, Any]] = [{}]
        engine_config: dict[str, Any] = {
            "providers": providers,
            "provider_options": provider_options,
            "enable_mem_pattern": directml["enableMemPattern"],
            "execution_mode": directml["executionMode"],
        }
        if use_dml:
            assert device_id is not None
            providers.insert(0, directml["preferredProvider"])
            provider_options.insert(0, {"device_id": device_id})
            engine_config["session_options"] = {
                "enable_profiling": True,
                "profile_file_prefix": profile_file_prefix,
            }
        return {
            "text_detection_model_name": models["det"]["modelName"],
            "text_detection_model_dir": str(base / models["det"]["modelDir"]),
            "text_recognition_model_name": models["rec"]["modelName"],
            "text_recognition_model_dir": str(base / models["rec"]["modelDir"]),
            "use_doc_orientation_classify": orientation["useDocOrientationClassify"],
            "use_doc_unwarping": orientation["useDocUnwarping"],
            "use_textline_orientation": orientation["useTextlineOrientation"],
            "engine": self.document["paddle"]["engine"],
            "engine_config": engine_config,
        }

    def verify_paddle_kwargs(
        self,
        kwargs: dict[str, Any],
        *,
        model_dir: Path,
        device_id: int | None,
        use_dml: bool,
        profile_file_prefix: str | None,
    ) -> None:
        """Check the exact constructor payload immediately before Paddle sees it."""

        expected = self.paddle_kwargs(
            model_dir=model_dir,
            device_id=device_id,
            use_dml=use_dml,
            profile_file_prefix=profile_file_prefix,
        )
        if kwargs != expected:
            raise EngineRuntimeUnavailableError(
                "PaddleOCR constructor configuration does not match canonical profile."
            )
        forbidden = {"targetLanguage", "ocrLanguage", "ocr_language"}
        if forbidden.intersection(kwargs):
            raise EngineRuntimeUnavailableError(
                "host-specific OCR language configuration is forbidden."
            )


def derive_profile_id(algorithm: object, profile_spec_sha256: str) -> str:
    if not isinstance(algorithm, str) or algorithm != PROFILE_ALGORITHM:
        raise EngineRuntimeUnavailableError("OCR profile algorithm is not canonical.")
    if len(profile_spec_sha256) != 64 or any(
        character not in "0123456789abcdef" for character in profile_spec_sha256
    ):
        raise EngineRuntimeUnavailableError("OCR profile hash is invalid.")
    return f"{PROFILE_ID_PREFIX}-{profile_spec_sha256[:16]}"


def _expect_dict(value: object, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise EngineRuntimeUnavailableError(f"OCR profile {label} is invalid.")
    return value


def _expect_sha(value: object, label: str) -> str:
    if (
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
    ):
        raise EngineRuntimeUnavailableError(f"OCR profile {label} sha256 is invalid.")
    return value


def _validate_document(document: object) -> dict[str, Any]:
    profile = _expect_dict(document, "document")
    expected = {
        "algorithm",
        "cpuFallback",
        "device",
        "dictionary",
        "directml",
        "failClosedOnDmlError",
        "model",
        "models",
        "orientation",
        "preprocessing",
        "paddle",
        "releaseVersion",
        "schemaVersion",
        "artifacts",
    }
    if set(profile) != expected:
        raise EngineRuntimeUnavailableError(
            "OCR canonical profile fields drifted: "
            f"expected {sorted(expected)}, found {sorted(profile)}."
        )
    if profile["algorithm"] != PROFILE_ALGORITHM:
        raise EngineRuntimeUnavailableError("OCR profile algorithm is not canonical.")
    if profile["schemaVersion"] != "2":
        raise EngineRuntimeUnavailableError("OCR profile schema version is unsupported.")
    if profile["releaseVersion"] != RUNTIME_VERSION:
        raise EngineRuntimeUnavailableError("OCR profile release version is unsynchronized.")
    if profile["model"] != "pp-ocrv6-medium-windowsml":
        raise EngineRuntimeUnavailableError("OCR profile model is not PP-OCRv6.")
    if profile["device"] != "windowsml-dml":
        raise EngineRuntimeUnavailableError("OCR profile device policy is invalid.")
    if profile["cpuFallback"] != "provider-missing-only":
        raise EngineRuntimeUnavailableError("OCR profile CPU fallback policy is invalid.")
    if profile["failClosedOnDmlError"] is not True:
        raise EngineRuntimeUnavailableError("OCR profile must fail closed on DML errors.")

    orientation = _expect_dict(profile["orientation"], "orientation")
    if orientation != {
        "useDocOrientationClassify": False,
        "useDocUnwarping": False,
        "useTextlineOrientation": False,
    }:
        raise EngineRuntimeUnavailableError("OCR orientation settings drifted.")

    directml = _expect_dict(profile["directml"], "directml")
    if directml != {
        "enableMemPattern": False,
        "executionMode": "sequential",
        "fallbackProvider": "CPUExecutionProvider",
        "preferredProvider": "DmlExecutionProvider",
        "providerOrder": ["DmlExecutionProvider", "CPUExecutionProvider"],
        "requireExecutionEvidence": True,
    }:
        raise EngineRuntimeUnavailableError("OCR DirectML settings drifted.")

    preprocessing = _expect_dict(profile["preprocessing"], "preprocessing")
    if preprocessing != {
        "owner": "capture-runtime",
        "render": {"pdf": "pdfium", "image": "pillow", "colorMode": "RGB"},
        "deskew": {"enabled": False, "owner": "none"},
        "contrast": {"enabled": False, "owner": "none"},
        "normalization": {
            "exifTranspose": True,
            "alphaComposite": "white",
            "resize": "bounded-lanczos",
        },
    }:
        raise EngineRuntimeUnavailableError("OCR preprocessing ownership/settings drifted.")

    dictionary = _expect_dict(profile["dictionary"], "dictionary")
    if (
        dictionary.get("path") != "rec/ppocrv6_dict.txt"
        or dictionary.get("languageCoverage") != "traditional-chinese-multilingual"
        or not isinstance(dictionary.get("revision"), str)
    ):
        raise EngineRuntimeUnavailableError("OCR dictionary coverage/settings are invalid.")
    _expect_sha(dictionary.get("sha256"), "dictionary")

    models = _expect_dict(profile["models"], "models")
    for key, expected_model, expected_dir, expected_revision, expected_source in (
        (
            "det",
            "PP-OCRv6_medium_det",
            "det",
            EXPECTED_DET_REVISION,
            "PaddlePaddle/PP-OCRv6_medium_det_onnx",
        ),
        (
            "rec",
            "PP-OCRv6_medium_rec",
            "rec",
            EXPECTED_REC_REVISION,
            "PaddlePaddle/PP-OCRv6_medium_rec_onnx",
        ),
    ):
        model = _expect_dict(models.get(key), f"models.{key}")
        if (
            model.get("modelName") != expected_model
            or model.get("modelDir") != expected_dir
            or model.get("revision") != expected_revision
            or model.get("source") != expected_source
        ):
            raise EngineRuntimeUnavailableError(f"OCR {key} model identity is invalid.")

    paddle = _expect_dict(profile["paddle"], "paddle")
    if paddle != {
        "engine": "onnxruntime",
        "acceptedOrientationKwargs": [
            "use_doc_orientation_classify",
            "use_doc_unwarping",
            "use_textline_orientation",
        ],
    }:
        raise EngineRuntimeUnavailableError("OCR PaddleX accepted configuration drifted.")

    artifacts = profile["artifacts"]
    if not isinstance(artifacts, list) or len(artifacts) != len(MODEL_ARTIFACT_PATHS):
        raise EngineRuntimeUnavailableError("OCR model artifact identity is invalid.")
    paths: list[str] = []
    for index, raw in enumerate(artifacts):
        item = _expect_dict(raw, f"artifacts[{index}]")
        path = item.get("path")
        size = item.get("bytes")
        if path not in MODEL_ARTIFACT_PATHS or path in paths:
            raise EngineRuntimeUnavailableError("OCR model artifact paths are invalid.")
        if isinstance(size, bool) or not isinstance(size, int) or size < 1:
            raise EngineRuntimeUnavailableError("OCR model artifact byte count is invalid.")
        _expect_sha(item.get("sha256"), f"artifacts[{index}]")
        paths.append(path)
    if tuple(paths) != MODEL_ARTIFACT_PATHS:
        raise EngineRuntimeUnavailableError(
            "OCR model artifact paths must be canonical and ordered."
        )
    dictionary_artifact = next(item for item in artifacts if item["path"] == dictionary["path"])
    if dictionary_artifact["sha256"] != dictionary["sha256"]:
        raise EngineRuntimeUnavailableError("OCR dictionary artifact identity drifted.")
    if dictionary["revision"] != EXPECTED_DICTIONARY_REVISION:
        raise EngineRuntimeUnavailableError("OCR dictionary revision drifted.")
    return profile


def load_profile_spec(path: Path = CANONICAL_PROFILE_PATH) -> OcrProfileSpec:
    profile_bytes = canonical_profile_bytes(path)
    try:
        document = json.loads(profile_bytes)
    except (ValueError, json.JSONDecodeError) as error:
        raise EngineRuntimeUnavailableError("OCR canonical profile is invalid.") from error
    document = _validate_document(document)
    digest = hashlib.sha256(profile_bytes).hexdigest()
    profile_id = derive_profile_id(document["algorithm"], digest)
    artifacts = tuple(
        OcrModelArtifact(path=item["path"], bytes=item["bytes"], sha256=item["sha256"])
        for item in document["artifacts"]
    )
    return OcrProfileSpec(
        document=document,
        profile_id=profile_id,
        profile_spec_sha256=digest,
        model_artifacts=artifacts,
    )


def validate_model_artifacts(model_dir: Path, profile: OcrProfileSpec) -> None:
    """Verify the bytes actually present in the model directory."""

    try:
        profile_path = model_dir / "pipeline.json"
        profile_bytes = profile_path.read_bytes()
        if profile_bytes != canonical_profile_bytes(profile_path):
            raise EngineRuntimeUnavailableError("OCR pipeline profile bytes are not canonical.")
        if hashlib.sha256(profile_bytes).hexdigest() != profile.profile_spec_sha256:
            raise EngineRuntimeUnavailableError("OCR pipeline profile identity mismatch.")
    except OSError as error:
        raise EngineRuntimeUnavailableError("OCR pipeline profile is unavailable.") from error
    for artifact in profile.model_artifacts:
        path = model_dir / artifact.path
        try:
            data = path.read_bytes()
        except OSError as error:
            raise EngineRuntimeUnavailableError(
                f"OCR model artifact is unavailable: {artifact.path}."
            ) from error
        if len(data) != artifact.bytes or hashlib.sha256(data).hexdigest() != artifact.sha256:
            raise EngineRuntimeUnavailableError(
                f"OCR model artifact identity mismatch: {artifact.path}."
            )


__all__ = [
    "CANONICAL_PROFILE_PATH",
    "EngineRuntimeUnavailableError",
    "MODEL_ARTIFACT_PATHS",
    "OcrModelArtifact",
    "OcrProfileSpec",
    "canonical_json_bytes",
    "canonical_profile_bytes",
    "derive_profile_id",
    "load_profile_spec",
    "validate_model_artifacts",
]
