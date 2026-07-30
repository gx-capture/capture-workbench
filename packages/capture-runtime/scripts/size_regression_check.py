from __future__ import annotations

import argparse
import json
import math
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


def validate_report(report: object, budgets: dict[str, object]) -> None:
    if not isinstance(report, dict):
        raise ValueError("size report must be a JSON object")
    failures = []
    installed_bytes = report.get("installedBytes")
    if (
        isinstance(installed_bytes, bool)
        or not isinstance(installed_bytes, int)
        or installed_bytes < 1
    ):
        failures.append("installedBytes must be a positive JSON integer")
    if "installedBytesBlocker" not in report or report["installedBytesBlocker"] is not None:
        failures.append("installedBytesBlocker must be null")
    startup = report.get("startup")
    if not isinstance(startup, dict):
        failures.append("startup measurement must be an object")
    elif set(startup) != {
        "blocker",
        "coldMilliseconds",
        "samplesMilliseconds",
        "warmMilliseconds",
    }:
        failures.append("startup measurement fields are invalid")
    else:
        if startup["blocker"] is not None:
            failures.append("startup blocker must be null")
        samples = startup["samplesMilliseconds"]
        valid_samples = (
            isinstance(samples, list)
            and len(samples) == 2
            and all(_finite_nonnegative_number(sample) for sample in samples)
        )
        if not valid_samples:
            failures.append(
                "startup samples must contain exactly two finite nonnegative JSON numbers"
            )
        cold = startup["coldMilliseconds"]
        warm = startup["warmMilliseconds"]
        valid_cold = _finite_nonnegative_number(cold)
        valid_warm = _finite_nonnegative_number(warm)
        if not valid_cold:
            failures.append("startup coldMilliseconds must be a finite nonnegative JSON number")
        if not valid_warm:
            failures.append("startup warmMilliseconds must be a finite nonnegative JSON number")
        if valid_samples and valid_cold and cold != samples[0]:
            failures.append("startup coldMilliseconds must equal the first sample")
        if valid_samples and valid_warm and warm != samples[1]:
            failures.append("startup warmMilliseconds must equal the second sample")
    checks = (
        ("runtimeExecutable", "runtimeExecutableBytes"),
        ("nsisInstaller", "nsisInstallerBytes"),
    )
    for report_name, budget_name in checks:
        artifact = report.get(report_name)
        if (
            not isinstance(artifact, dict)
            or isinstance(artifact.get("bytes"), bool)
            or not isinstance(artifact.get("bytes"), int)
        ):
            failures.append(f"{report_name} measurement is unavailable")
            continue
        if artifact["bytes"] > budgets[budget_name]:
            failures.append(
                f"{report_name} {artifact['bytes']} exceeds budget {budgets[budget_name]}"
            )
    if failures:
        raise ValueError("; ".join(failures))


def _finite_nonnegative_number(value: object) -> bool:
    return (
        not isinstance(value, bool)
        and isinstance(value, int | float)
        and math.isfinite(value)
        and value >= 0
    )


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
