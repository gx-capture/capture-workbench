from __future__ import annotations

from pathlib import Path

from capture_runtime.release import build_release_artifacts


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    build_release_artifacts(
        executable=root / "dist" / "executable" / "capture-runtime.exe",
        schema=root / "dist" / "schema" / "capture-document-v2.schema.json",
        output_dir=root / "dist" / "release",
        engine_dir=root / "dist" / "engines",
        engine_catalog=root / "dist" / "catalog" / "capture-engine-catalog.json",
    )


if __name__ == "__main__":
    main()
