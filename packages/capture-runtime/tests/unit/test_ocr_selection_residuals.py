from __future__ import annotations

import re
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
_ORDINAL_OVERRIDE = re.compile(r"CAPTURE_WINDOWSML_DEVICE_ID|\bdeviceId\b")


def test_product_and_candidate_tooling_have_no_ordinal_selection_residual() -> None:
    smoke = (
        REPOSITORY_ROOT / "apps" / "capture-workbench-desktop" / "scripts" / "real-media-smoke.ts"
    ).read_text(encoding="utf-8")
    candidate = (
        REPOSITORY_ROOT
        / "packages"
        / "capture-runtime"
        / "scripts"
        / "verify_release_model_candidate.py"
    ).read_text(encoding="utf-8")

    assert _ORDINAL_OVERRIDE.search(smoke) is None
    assert _ORDINAL_OVERRIDE.search(candidate) is None
    assert "manager.ocr_compute_selection" in candidate
    assert '"computePlan": selection.execution_plan.to_dict()' in candidate
