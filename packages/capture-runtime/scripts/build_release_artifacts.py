from __future__ import annotations

import os
from pathlib import Path

from capture_runtime.release import build_release_artifacts


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    windowsml_bundle_url = os.environ.get("CAPTURE_WINDOWSML_BUNDLE_URL", "").strip()
    windowsml_bundle_sha256 = os.environ.get("CAPTURE_WINDOWSML_BUNDLE_SHA256", "").strip()
    windowsml_bundle_bytes_text = os.environ.get("CAPTURE_WINDOWSML_BUNDLE_BYTES", "").strip()
    if not windowsml_bundle_url or not windowsml_bundle_sha256 or not windowsml_bundle_bytes_text:
        raise SystemExit(
            "Release artifacts require CAPTURE_WINDOWSML_BUNDLE_URL and "
            "CAPTURE_WINDOWSML_BUNDLE_SHA256 and CAPTURE_WINDOWSML_BUNDLE_BYTES"
        )
    try:
        windowsml_bundle_bytes = int(windowsml_bundle_bytes_text)
    except ValueError as error:
        raise SystemExit("CAPTURE_WINDOWSML_BUNDLE_BYTES must be a decimal integer") from error
    build_release_artifacts(
        executable=root / "dist" / "executable" / "capture-runtime.exe",
        schema=root / "dist" / "schema" / "capture-document-v1.schema.json",
        output_dir=root / "dist" / "release",
        windowsml_bundle_url=windowsml_bundle_url,
        windowsml_bundle_bytes=windowsml_bundle_bytes,
        windowsml_bundle_sha256=windowsml_bundle_sha256,
    )


if __name__ == "__main__":
    main()
