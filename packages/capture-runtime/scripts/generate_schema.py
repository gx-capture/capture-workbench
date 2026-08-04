from __future__ import annotations

import argparse
from pathlib import Path

from capture_runtime.release import write_capture_document_schema


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    write_capture_document_schema(arguments.output)


if __name__ == "__main__":
    main()
