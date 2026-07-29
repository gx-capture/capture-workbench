from __future__ import annotations

import argparse
import json
from pathlib import Path


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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--budgets", type=Path, required=True)
    arguments = parser.parse_args()
    report = json.loads(arguments.report.read_text(encoding="utf-8"))
    try:
        budgets = validate_budgets(json.loads(arguments.budgets.read_text(encoding="utf-8")))
    except ValueError as error:
        raise SystemExit(str(error)) from error
    checks = (
        ("runtimeExecutable", "runtimeExecutableBytes"),
        ("nsisInstaller", "nsisInstallerBytes"),
    )
    failures = []
    for report_name, budget_name in checks:
        artifact = report.get(report_name)
        if not isinstance(artifact, dict) or not isinstance(artifact.get("bytes"), int):
            failures.append(f"{report_name} measurement is unavailable")
            continue
        if artifact["bytes"] > budgets[budget_name]:
            failures.append(
                f"{report_name} {artifact['bytes']} exceeds budget {budgets[budget_name]}"
            )
    if failures:
        raise SystemExit("; ".join(failures))


if __name__ == "__main__":
    main()
