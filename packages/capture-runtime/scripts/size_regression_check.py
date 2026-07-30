from __future__ import annotations

import argparse
import json
from pathlib import Path

REPORT_FIELDS = {
    "arch",
    "installedBytes",
    "installedBytesBlocker",
    "nsisInstaller",
    "platform",
    "pyinstaller",
    "pythonVersion",
    "reportVersion",
    "runtimeExecutable",
}
ARTIFACT_FIELDS = {"bytes", "fileName", "path", "sha256"}
PYINSTALLER_FIELDS = {"blocker", "categories", "files", "topFiles"}
PYINSTALLER_CATEGORY_FIELDS = {"core", "ocr", "other", "pdf", "whisper"}
PYINSTALLER_FILE_FIELDS = {"bytes", "path"}
MAX_SAFE_JSON_INTEGER = 2**53 - 1


def _json_integer(value: object, *, minimum: int = 0) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int)
        and minimum <= value <= MAX_SAFE_JSON_INTEGER
    )


def _sha256(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _canonical_artifact(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == ARTIFACT_FIELDS
        and isinstance(value["path"], str)
        and bool(value["path"])
        and isinstance(value["fileName"], str)
        and bool(value["fileName"])
        and Path(value["path"]).name == value["fileName"]
        and _json_integer(value["bytes"], minimum=1)
        and _sha256(value["sha256"])
    )


def _canonical_pyinstaller_file(value: object) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == PYINSTALLER_FILE_FIELDS
        and isinstance(value["path"], str)
        and bool(value["path"])
        and _json_integer(value["bytes"])
    )


def _canonical_pyinstaller(value: object) -> bool:
    if not isinstance(value, dict) or set(value) != PYINSTALLER_FIELDS:
        return False
    categories = value["categories"]
    return (
        isinstance(value["files"], list)
        and all(_canonical_pyinstaller_file(item) for item in value["files"])
        and isinstance(value["topFiles"], list)
        and all(_canonical_pyinstaller_file(item) for item in value["topFiles"])
        and isinstance(categories, dict)
        and set(categories) == PYINSTALLER_CATEGORY_FIELDS
        and all(_json_integer(item) for item in categories.values())
        and (value["blocker"] is None or isinstance(value["blocker"], str))
    )


def validate_budgets(budgets: object) -> dict[str, object]:
    if not isinstance(budgets, dict):
        raise ValueError("size budgets must be a JSON object")
    expected_fields = {
        "budgetVersion",
        "evidence",
        "runtimeExecutableBytes",
        "nsisInstallerBytes",
    }
    if set(budgets) != expected_fields:
        raise ValueError("size budget fields are invalid")
    if budgets["budgetVersion"] != "1":
        raise ValueError("size budget version is unsupported")
    evidence = budgets["evidence"]
    if not isinstance(evidence, dict) or set(evidence) != {
        "headroomBasisPoints",
        "measuredAtUtc",
        "measurementReport",
        "measurementReportSha256",
        "nsisInstallerMeasuredBytes",
        "runtimeExecutableMeasuredBytes",
    }:
        raise ValueError("size budget evidence fields are invalid")
    basis_points = evidence["headroomBasisPoints"]
    if not isinstance(basis_points, int) or not 0 <= basis_points <= 5_000:
        raise ValueError("headroomBasisPoints must be an integer from 0 through 5000")
    if (
        not isinstance(evidence["measurementReport"], str)
        or not evidence["measurementReport"]
        or not isinstance(evidence["measuredAtUtc"], str)
        or not evidence["measuredAtUtc"]
        or not isinstance(evidence["measurementReportSha256"], str)
        or len(evidence["measurementReportSha256"]) != 64
    ):
        raise ValueError("size budget measurement provenance is invalid")
    pairs = (
        ("runtimeExecutableMeasuredBytes", "runtimeExecutableBytes"),
        ("nsisInstallerMeasuredBytes", "nsisInstallerBytes"),
    )
    for measured_name, budget_name in pairs:
        measured = evidence[measured_name]
        budget = budgets[budget_name]
        if not isinstance(measured, int) or measured < 1:
            raise ValueError(f"{measured_name} must be a positive integer")
        expected = (measured * (10_000 + basis_points) + 9_999) // 10_000
        if budget != expected:
            raise ValueError(f"{budget_name} must equal measured bytes plus the declared headroom")
    return budgets


def validate_report(report: object, budgets: dict[str, object]) -> None:
    if not isinstance(report, dict):
        raise ValueError("size report must be a JSON object")
    if set(report) != REPORT_FIELDS:
        raise ValueError("size report fields are invalid")
    if report["reportVersion"] != "2":
        raise ValueError("size report version is unsupported")
    if not all(
        isinstance(report[field], str) and bool(report[field])
        for field in ("arch", "platform", "pythonVersion")
    ):
        raise ValueError("size report platform metadata is invalid")
    if not _canonical_pyinstaller(report["pyinstaller"]):
        raise ValueError("size report PyInstaller fields are invalid")
    failures = []
    installed_bytes = report["installedBytes"]
    if not _json_integer(installed_bytes, minimum=1):
        failures.append("installedBytes must be a positive safe JSON integer")
    if report["installedBytesBlocker"] is not None:
        failures.append("installedBytesBlocker must be null")
    checks = (
        ("runtimeExecutable", "runtimeExecutableBytes"),
        ("nsisInstaller", "nsisInstallerBytes"),
    )
    for report_name, budget_name in checks:
        artifact = report[report_name]
        if not _canonical_artifact(artifact):
            failures.append(f"{report_name} fields are invalid")
            continue
        if artifact["bytes"] > budgets[budget_name]:
            failures.append(
                f"{report_name} {artifact['bytes']} exceeds budget {budgets[budget_name]}"
            )
    if failures:
        raise ValueError("; ".join(failures))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--budgets", type=Path, required=True)
    arguments = parser.parse_args()
    try:
        report = json.loads(arguments.report.read_text(encoding="utf-8"))
        budgets = validate_budgets(json.loads(arguments.budgets.read_text(encoding="utf-8")))
        validate_report(report, budgets)
    except ValueError as error:
        raise SystemExit(str(error)) from error


if __name__ == "__main__":
    main()
