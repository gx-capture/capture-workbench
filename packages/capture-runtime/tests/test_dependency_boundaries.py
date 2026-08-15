from __future__ import annotations

import re
import subprocess
import sys
import tomllib
from pathlib import Path

import pytest

PYPROJECT = Path(__file__).resolve().parents[1] / "pyproject.toml"
OCR_SPEC = Path(__file__).resolve().parents[1] / "pyinstaller" / "capture-engine-ocr.spec"
RUNTIME_SPEC = Path(__file__).resolve().parents[1] / "pyinstaller" / "capture-runtime.spec"
REQUIREMENT_NAME = re.compile(
    r"^(?P<name>[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?=\s*(?:@|\[|[<>=!~;]|$))"
)
OCR_TEST_DEPENDENCIES = {
    "pillow": "pillow>=11.0.0,<13.0.0",
    "pypdfium2": "pypdfium2>=5.0.0,<6.0.0",
}
PRODUCTION_ONLY_DEPENDENCIES = {
    "ctranslate2",
    "faster-whisper",
    "huggingface-hub",
    "onnxruntime-directml",
    "paddleocr",
    "paddlex",
}

WHISPER_EXACT_DEPENDENCIES = {
    "ctranslate2": "ctranslate2==4.8.1",
    "faster-whisper": "faster-whisper==1.2.1",
}


def _dependency_name(requirement: str) -> str:
    match = REQUIREMENT_NAME.match(requirement)
    if match is None:
        raise ValueError(f"unparseable requirement: {requirement!r}")
    return re.sub(r"[-_.]+", "-", match.group("name")).lower()


def _requirements_named(requirements: list[str], name: str) -> list[str]:
    return [item for item in requirements if _dependency_name(item) == name]


def test_default_dev_dependencies_cover_ocr_typecheck_without_entering_core() -> None:
    project = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))
    base = project["project"]["dependencies"]
    windowsml = project["project"]["optional-dependencies"]["windowsml"]
    dev = project["dependency-groups"]["dev"]

    for name, exact_requirement in OCR_TEST_DEPENDENCIES.items():
        assert _requirements_named(dev, name) == [exact_requirement]
        assert _requirements_named(windowsml, name) == [exact_requirement]
        assert _requirements_named(base, name) == []
    for name in PRODUCTION_ONLY_DEPENDENCIES:
        assert _requirements_named(dev, name) == []
    whisper = project["project"]["optional-dependencies"]["whisper"]
    for name, exact_requirement in WHISPER_EXACT_DEPENDENCIES.items():
        assert _requirements_named(whisper, name) == [exact_requirement]


def test_ocr_bundle_collects_pypdfium2_runtime_metadata() -> None:
    spec = OCR_SPEC.read_text(encoding="utf-8")

    assert 'collect_data_files("pypdfium2")' in spec
    assert "copy_metadata" in spec
    for distribution in (
        "imagesize",
        "opencv-contrib-python",
        "pyclipper",
        "pypdfium2",
        "python-bidi",
        "shapely",
    ):
        assert f'"{distribution}"' in spec


def test_core_runtime_does_not_collect_public_capture_contract_package_data() -> None:
    spec = RUNTIME_SPEC.read_text(encoding="utf-8")

    retired_package = "capture_" + "contracts"
    assert f'collect_data_files("{retired_package}")' not in spec


def test_worker_module_import_does_not_bootstrap_http_application() -> None:
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; "
                "import capture_runtime.engine_adapters; "
                "assert 'capture_runtime.app' not in sys.modules"
            ),
        ],
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        shell=False,
        check=False,
    )

    assert result.returncode == 0, result.stderr


def test_exact_dependency_ownership_rejects_duplicate_or_broader_entries() -> None:
    exact = OCR_TEST_DEPENDENCIES["pillow"]
    invalid_requirements = (
        [exact, exact],
        [exact, "pillow>=10.0.0"],
        [exact, "pillow>=11.0.0,<13.0.0; sys_platform == 'win32'"],
        [exact, "Pillow>=11.0.0,<13.0.0"],
    )

    for requirements in invalid_requirements:
        assert _requirements_named(requirements, "pillow") != [exact]


def test_canonical_names_catch_alternate_spellings_and_direct_references() -> None:
    dev = [
        "faster_whisper>=1.2.0",
        "onnxruntime_directml==1.24.4",
        "huggingface.hub>=1.18.0",
    ]
    base = [
        "pillow @ https://example.invalid/pillow.whl",
        "pypdfium2 @ https://example.invalid/pypdfium2.whl",
    ]

    for name in ("faster-whisper", "onnxruntime-directml", "huggingface-hub"):
        assert len(_requirements_named(dev, name)) == 1
    assert _requirements_named(base, "pillow") == [base[0]]
    assert _requirements_named(base, "pypdfium2") == [base[1]]

    with pytest.raises(ValueError, match="unparseable requirement"):
        _dependency_name("not a requirement")
