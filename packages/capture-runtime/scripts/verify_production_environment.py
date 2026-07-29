from __future__ import annotations

import importlib.metadata
import json
import platform
import sys


def _normalized_distribution_name(name: str) -> str:
    return name.lower().replace("_", "-").replace(".", "-")


def main() -> None:
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("capture-runtime production dependencies require Python 3.12")
    if platform.system() != "Windows" or platform.machine().lower() not in {"amd64", "x86_64"}:
        raise SystemExit("capture-runtime production dependencies are Windows x64 only")

    try:
        import onnxruntime
    except ImportError as error:
        raise SystemExit(
            "The ONNX Runtime namespace is incomplete. Run the "
            "capture-runtime:prepare-production-environment Nx target."
        ) from error

    distributions = sorted(
        {
            _normalized_distribution_name(distribution.metadata["Name"])
            for distribution in importlib.metadata.distributions()
            if _normalized_distribution_name(distribution.metadata["Name"]).startswith(
                "onnxruntime"
            )
        }
    )
    if distributions != ["onnxruntime-directml"]:
        raise SystemExit(
            "Windows production must contain only onnxruntime-directml; found "
            + ", ".join(distributions or ["none"])
        )

    owners = sorted(
        {
            _normalized_distribution_name(owner)
            for owner in importlib.metadata.packages_distributions().get("onnxruntime", [])
        }
    )
    if owners != ["onnxruntime-directml"]:
        raise SystemExit(
            "The onnxruntime import must be owned only by onnxruntime-directml; found "
            + ", ".join(owners or ["none"])
        )

    distribution_version = importlib.metadata.version("onnxruntime-directml")
    if onnxruntime.__version__ != distribution_version:
        raise SystemExit(
            "The onnxruntime import version does not match onnxruntime-directml metadata: "
            f"{onnxruntime.__version__} != {distribution_version}"
        )

    providers = onnxruntime.get_available_providers()
    missing_providers = [
        provider
        for provider in ("DmlExecutionProvider", "CPUExecutionProvider")
        if provider not in providers
    ]
    if missing_providers:
        raise SystemExit(
            "Windows production ONNX Runtime is missing providers: " + ", ".join(missing_providers)
        )

    print(
        json.dumps(
            {
                "onnxruntimeVersion": distribution_version,
                "distributionOwners": owners,
                "providers": providers,
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
