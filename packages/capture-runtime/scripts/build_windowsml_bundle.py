from __future__ import annotations

import json
import os
from pathlib import Path

from capture_runtime.release import build_windowsml_bundle


def required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"{name} is required")
    return value


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    output = root / "dist" / "windowsml" / "capture-windowsml-ocr-windows-x64.zip"
    report = build_windowsml_bundle(
        source_dir=Path(required_environment("CAPTURE_WINDOWSML_BUNDLE_SOURCE_DIR")),
        output=output,
        artifact_url=required_environment("CAPTURE_WINDOWSML_BUNDLE_URL"),
    )
    report_path = output.with_suffix(".manifest.json")
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"WindowsML bundle staged: {output}")
    print(f"WindowsML bundle descriptor: {report_path}")


if __name__ == "__main__":
    main()
