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
        "arch": "x86_64",
        "installedBytes": 1_234,
        "installedBytesBlocker": None,
        "nsisInstaller": {
            "bytes": 101,
            "fileName": "Capture Workbench_0.3.5_x64-setup.exe",
            "path": "dist/Capture Workbench_0.3.5_x64-setup.exe",
            "sha256": "b" * 64,
        },
        "platform": "windows",
        "pyinstaller": {
            "blocker": None,
            "categories": {
                "core": 0,
                "ocr": 0,
                "other": 0,
                "pdf": 0,
                "whisper": 0,
            },
            "files": [],
            "topFiles": [],
        },
        "pythonVersion": "3.12.12",
        "reportVersion": "2",
        "runtimeExecutable": {
            "bytes": 100,
            "fileName": "capture-runtime.exe",
            "path": "dist/capture-runtime.exe",
            "sha256": "a" * 64,
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


@pytest.mark.parametrize("installed_bytes", [pytest.param(None, id="null"), 0])
def test_report_rejects_invalid_installed_bytes(installed_bytes: object) -> None:
    report = valid_report()
    report["installedBytes"] = installed_bytes

    with pytest.raises(ValueError, match="positive safe JSON integer"):
        size_regression_check.validate_report(report, evidence_budget())


@pytest.mark.parametrize(
    ("installed_bytes", "accepted"),
    [
        pytest.param(2**53 - 1, True, id="max-safe"),
        pytest.param(2**53, False, id="above-max-safe"),
        pytest.param(True, False, id="boolean"),
    ],
)
def test_report_enforces_json_safe_integer_boundary(
    installed_bytes: object,
    accepted: bool,
) -> None:
    report = valid_report()
    report["installedBytes"] = installed_bytes

    if accepted:
        size_regression_check.validate_report(report, evidence_budget())
    else:
        with pytest.raises(ValueError, match="positive safe JSON integer"):
            size_regression_check.validate_report(report, evidence_budget())


def test_report_rejects_missing_installed_bytes() -> None:
    report = valid_report()
    del report["installedBytes"]

    with pytest.raises(ValueError, match="size report fields are invalid"):
        size_regression_check.validate_report(report, evidence_budget())


def test_report_rejects_installed_size_blocker() -> None:
    report = valid_report()
    report["installedBytesBlocker"] = "Installed-size evidence is missing."

    with pytest.raises(ValueError, match="installedBytesBlocker must be null"):
        size_regression_check.validate_report(report, evidence_budget())


def test_report_accepts_complete_evidence_within_artifact_budgets() -> None:
    size_regression_check.validate_report(valid_report(), evidence_budget())


def test_report_keeps_runtime_and_installer_budget_checks() -> None:
    report = valid_report()
    runtime_executable = report["runtimeExecutable"]
    assert isinstance(runtime_executable, dict)
    runtime_executable["bytes"] = 111

    with pytest.raises(ValueError, match="runtimeExecutable 111 exceeds budget 110"):
        size_regression_check.validate_report(report, evidence_budget())


@pytest.mark.parametrize(
    "case",
    [
        pytest.param("legacy-version", id="legacy-version"),
        pytest.param("legacy-startup", id="legacy-startup"),
        pytest.param("unknown-top-level", id="unknown-top-level"),
        pytest.param("partial-artifact", id="partial-artifact"),
        pytest.param("unknown-artifact", id="unknown-artifact"),
    ],
)
def test_report_rejects_noncanonical_v2_schema(case: str) -> None:
    report = valid_report()
    expected = "fields are invalid"
    if case == "legacy-version":
        report["reportVersion"] = "1"
        expected = "version is unsupported"
    elif case == "legacy-startup":
        report["startup"] = {"blocker": None}
    elif case == "unknown-top-level":
        report["unexpected"] = True
    else:
        installer = report["nsisInstaller"]
        assert isinstance(installer, dict)
        if case == "partial-artifact":
            del installer["sha256"]
        else:
            installer["unexpected"] = True

    with pytest.raises(ValueError, match=expected):
        size_regression_check.validate_report(report, evidence_budget())
