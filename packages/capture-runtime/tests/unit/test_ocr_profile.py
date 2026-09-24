import hashlib
import json
from pathlib import Path

import pytest

from capture_runtime.engine_adapters import EngineRuntimeUnavailableError
from capture_runtime.ocr_profile import (
    CANONICAL_PROFILE_PATH,
    canonical_profile_bytes,
    derive_profile_id,
    load_profile_spec,
    validate_model_artifacts,
)


def test_packaged_profile_identity_is_derived_from_canonical_bytes() -> None:
    profile_bytes = canonical_profile_bytes(CANONICAL_PROFILE_PATH)
    profile = load_profile_spec(CANONICAL_PROFILE_PATH)
    digest = hashlib.sha256(profile_bytes).hexdigest()

    assert profile.profile_spec_sha256 == digest
    assert profile.profile_id == derive_profile_id(profile.document["algorithm"], digest)
    assert profile.document["orientation"] == {
        "useDocOrientationClassify": False,
        "useDocUnwarping": False,
        "useTextlineOrientation": False,
    }
    assert profile.document["dictionary"]["languageCoverage"] == (
        "traditional-chinese-multilingual"
    )
    assert "targetLanguage" not in json.dumps(profile.document)
    assert "ocrLanguage" not in json.dumps(profile.document)


def test_profile_declares_runtime_preprocessing_and_accepted_paddle_switches() -> None:
    profile = load_profile_spec(CANONICAL_PROFILE_PATH)

    kwargs = profile.paddle_kwargs(use_dml=False)
    assert kwargs["text_detection_model_name"] == ("PP-OCRv6_medium_det")
    assert kwargs["text_recognition_model_name"] == ("PP-OCRv6_medium_rec")
    assert kwargs["use_doc_orientation_classify"] is False
    assert kwargs["use_doc_unwarping"] is False
    assert kwargs["use_textline_orientation"] is False
    assert profile.document["preprocessing"] == {
        "owner": "capture-runtime",
        "render": {"pdf": "pdfium", "image": "pillow", "colorMode": "RGB"},
        "deskew": {"enabled": False, "owner": "none"},
        "contrast": {"enabled": False, "owner": "none"},
        "normalization": {
            "exifTranspose": True,
            "alphaComposite": "white",
            "resize": "bounded-lanczos",
        },
    }


def test_profile_application_is_exact_and_target_language_is_not_an_ocr_input() -> None:
    profile = load_profile_spec(CANONICAL_PROFILE_PATH)
    model_dir = Path("C:/models/ocr")
    kwargs = profile.paddle_kwargs(model_dir=model_dir, use_dml=False)
    profile.verify_paddle_kwargs(
        kwargs,
        model_dir=model_dir,
        device_id=None,
        use_dml=False,
        profile_file_prefix=None,
    )
    assert "targetLanguage" not in kwargs
    assert "ocrLanguage" not in kwargs

    kwargs["use_textline_orientation"] = True
    with pytest.raises(EngineRuntimeUnavailableError, match="constructor configuration"):
        profile.verify_paddle_kwargs(
            kwargs,
            model_dir=model_dir,
            device_id=None,
            use_dml=False,
            profile_file_prefix=None,
        )


def test_model_lock_and_packaged_profile_share_one_byte_identity() -> None:
    package_root = Path(__file__).resolve().parents[2]
    source = package_root / "model-sources" / "commit-a" / "model" / "pipeline.json"
    lock = json.loads(
        (package_root / "model-sources" / "release-model-source-lock.json").read_text(
            encoding="utf-8"
        )
    )
    entry = next(
        item
        for item in next(
            requirement
            for requirement in lock["requirements"]
            if requirement["requirementId"] == "windowsml-ocr"
        )["files"]
        if item["path"] == "model/pipeline.json"
    )
    source_bytes = source.read_bytes()
    assert source_bytes == CANONICAL_PROFILE_PATH.read_bytes()
    assert entry["bytes"] == len(source_bytes)
    assert entry["sha256"] == hashlib.sha256(source_bytes).hexdigest()


def test_profile_rejects_settings_drift_before_runtime_use(tmp_path: Path) -> None:
    source = json.loads(CANONICAL_PROFILE_PATH.read_text(encoding="utf-8"))
    source["orientation"]["useTextlineOrientation"] = True
    drifted = tmp_path / "pipeline.json"
    drifted.write_text(json.dumps(source, ensure_ascii=False, indent=2, sort_keys=True) + "\n")

    with pytest.raises(EngineRuntimeUnavailableError, match="profile"):
        load_profile_spec(drifted)


def test_model_artifact_identity_is_verified_from_loaded_bytes(tmp_path: Path) -> None:
    profile = load_profile_spec(CANONICAL_PROFILE_PATH)
    (tmp_path / "pipeline.json").write_bytes(CANONICAL_PROFILE_PATH.read_bytes())
    for artifact in profile.model_artifacts:
        path = tmp_path / artifact.path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"actual loaded bytes")

    with pytest.raises(EngineRuntimeUnavailableError, match="artifact"):
        validate_model_artifacts(tmp_path, profile)
