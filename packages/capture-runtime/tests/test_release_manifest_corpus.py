from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from capture_runtime.release import RuntimeReleaseManifestV1


def _materialize(case: dict[str, Any], base: dict[str, Any]) -> dict[str, Any]:
    manifest = copy.deepcopy(case.get("manifest", base))
    manifest.update(case.get("patch", {}))
    if remove := case.get("remove"):
        manifest.pop(remove, None)
    requirements = manifest["runtimeRequirements"]
    requirements.update(case.get("requirementPatch", {}))
    descriptor = requirements["windowsml-ocr"]
    descriptor.update(case.get("descriptorPatch", {}))
    if descriptor_remove := case.get("descriptorRemove"):
        descriptor.pop(descriptor_remove, None)
    return manifest


def test_release_manifest_corpus_matches_python_contract() -> None:
    corpus_path = Path(__file__).resolve().parents[3] / "tools" / "release-manifest-corpus.json"
    cases = json.loads(corpus_path.read_text(encoding="utf-8"))["cases"]
    base = next(case["manifest"] for case in cases if case["valid"])
    for case in cases:
        manifest = _materialize(case, base)
        if case["valid"]:
            RuntimeReleaseManifestV1.model_validate(manifest)
        else:
            with pytest.raises((ValidationError, ValueError), match=".+"):
                RuntimeReleaseManifestV1.model_validate(manifest)
