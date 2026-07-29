from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "size_regression_check.py"
SPEC = importlib.util.spec_from_file_location("capture_size_regression_check", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
size_regression_check = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(size_regression_check)


def evidence_budget() -> dict[str, object]:
    return {
        "budgetVersion": "1",
        "evidence": {
            "headroomBasisPoints": 1000,
            "measuredAtUtc": "2026-07-29",
            "measurementReport": "dist/size/runtime-size-report.json",
            "measurementReportSha256": "a" * 64,
            "nsisInstallerMeasuredBytes": 101,
            "runtimeExecutableMeasuredBytes": 100,
        },
        "nsisInstallerBytes": 112,
        "runtimeExecutableBytes": 110,
    }


def test_budget_requires_exact_declared_headroom() -> None:
    assert (
        size_regression_check.validate_budgets(evidence_budget())["runtimeExecutableBytes"] == 110
    )


def test_budget_rejects_untraceable_threshold() -> None:
    budget = evidence_budget()
    budget["runtimeExecutableBytes"] = 111

    with pytest.raises(ValueError, match="declared headroom"):
        size_regression_check.validate_budgets(budget)
