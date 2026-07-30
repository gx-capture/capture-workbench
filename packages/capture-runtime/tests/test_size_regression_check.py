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


def valid_report() -> dict[str, object]:
    return {
        "installedBytes": 1_234,
        "installedBytesBlocker": None,
        "nsisInstaller": {"bytes": 101},
        "runtimeExecutable": {"bytes": 100},
        "startup": {
            "blocker": None,
            "coldMilliseconds": 100.25,
            "samplesMilliseconds": [100.25, 90.5],
            "warmMilliseconds": 90.5,
        },
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


@pytest.mark.parametrize("installed_bytes", [pytest.param(None, id="null"), 0, True])
def test_report_rejects_invalid_installed_bytes(installed_bytes: object) -> None:
    report = valid_report()
    report["installedBytes"] = installed_bytes

    with pytest.raises(ValueError, match="positive JSON integer"):
        size_regression_check.validate_report(report, evidence_budget())


def test_report_rejects_missing_installed_bytes() -> None:
    report = valid_report()
    del report["installedBytes"]

    with pytest.raises(ValueError, match="positive JSON integer"):
        size_regression_check.validate_report(report, evidence_budget())


def test_report_rejects_installed_size_blocker() -> None:
    report = valid_report()
    report["installedBytesBlocker"] = "Installed-size evidence is missing."

    with pytest.raises(ValueError, match="installedBytesBlocker must be null"):
        size_regression_check.validate_report(report, evidence_budget())


@pytest.mark.parametrize(
    "startup",
    [
        pytest.param("unavailable", id="non-object"),
        pytest.param({"blocker": None}, id="missing-fields"),
        pytest.param(
            {
                "blocker": None,
                "coldMilliseconds": 100.25,
                "samplesMilliseconds": [100.25, 90.5],
                "unexpected": "field",
                "warmMilliseconds": 90.5,
            },
            id="extra-field",
        ),
        pytest.param(
            {
                "blocker": "Runtime did not become ready.",
                "coldMilliseconds": None,
                "samplesMilliseconds": [],
                "warmMilliseconds": None,
            },
            id="blocked",
        ),
    ],
)
def test_report_rejects_invalid_startup(startup: object) -> None:
    report = valid_report()
    report["startup"] = startup

    with pytest.raises(ValueError, match="startup"):
        size_regression_check.validate_report(report, evidence_budget())


@pytest.mark.parametrize(
    "samples",
    [
        pytest.param([], id="empty"),
        pytest.param([100.25], id="one-sample"),
        pytest.param([100.25, 90.5, 80.0], id="three-samples"),
        pytest.param("100.25,90.5", id="non-list"),
        pytest.param([100.25, "90.5"], id="non-numeric"),
        pytest.param([100.25, float("nan")], id="nan"),
        pytest.param([100.25, float("inf")], id="infinite"),
        pytest.param([100.25, True], id="bool"),
        pytest.param([100.25, -1], id="negative"),
    ],
)
def test_report_rejects_invalid_startup_samples(samples: object) -> None:
    report = valid_report()
    startup = report["startup"]
    assert isinstance(startup, dict)
    startup["samplesMilliseconds"] = samples

    with pytest.raises(ValueError, match="exactly two finite nonnegative"):
        size_regression_check.validate_report(report, evidence_budget())


@pytest.mark.parametrize(
    ("field", "value"),
    [
        pytest.param("coldMilliseconds", None, id="cold-null"),
        pytest.param("coldMilliseconds", float("nan"), id="cold-nan"),
        pytest.param("warmMilliseconds", float("inf"), id="warm-infinite"),
        pytest.param("coldMilliseconds", True, id="cold-bool"),
        pytest.param("warmMilliseconds", -1, id="warm-negative"),
        pytest.param("warmMilliseconds", "90.5", id="warm-non-numeric"),
    ],
)
def test_report_rejects_invalid_startup_summary(field: str, value: object) -> None:
    report = valid_report()
    startup = report["startup"]
    assert isinstance(startup, dict)
    startup[field] = value

    with pytest.raises(ValueError, match=f"startup {field} must be"):
        size_regression_check.validate_report(report, evidence_budget())


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        pytest.param(
            "coldMilliseconds",
            100.5,
            "coldMilliseconds must equal the first sample",
            id="cold",
        ),
        pytest.param(
            "warmMilliseconds",
            90.75,
            "warmMilliseconds must equal the second sample",
            id="warm",
        ),
    ],
)
def test_report_rejects_mismatched_startup_summary(field: str, value: object, message: str) -> None:
    report = valid_report()
    startup = report["startup"]
    assert isinstance(startup, dict)
    startup[field] = value

    with pytest.raises(ValueError, match=message):
        size_regression_check.validate_report(report, evidence_budget())


def test_report_accepts_complete_evidence_within_artifact_budgets() -> None:
    size_regression_check.validate_report(valid_report(), evidence_budget())


def test_report_keeps_runtime_and_installer_budget_checks() -> None:
    report = valid_report()
    report["runtimeExecutable"] = {"bytes": 111}

    with pytest.raises(ValueError, match="runtimeExecutable 111 exceeds budget 110"):
        size_regression_check.validate_report(report, evidence_budget())
