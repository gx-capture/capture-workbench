from __future__ import annotations

from pathlib import Path

from capture_runtime.release import build_release_artifacts


def main() -> None:
    """Build only the three artifacts allowed in the initial NSIS package."""

    root = Path(__file__).resolve().parents[1]
    build_release_artifacts(
        executable=root / "dist" / "executable" / "capture-runtime.exe",
        schema=root / "dist" / "schema" / "capture-document-v1.schema.json",
        output_dir=root / "dist" / "core-release",
    )


if __name__ == "__main__":
    main()
