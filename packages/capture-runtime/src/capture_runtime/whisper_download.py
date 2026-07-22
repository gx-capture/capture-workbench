"""Cancellable subprocess entry point for explicit Whisper model acquisition."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path

MODEL_REPOSITORIES = {
    "large-v3-turbo": "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    "small": "Systran/faster-whisper-small",
}
ALLOW_PATTERNS = (
    "config.json",
    "preprocessor_config.json",
    "model.bin",
    "tokenizer.json",
    "vocabulary.*",
)


def download_model(model: str, output: Path) -> None:
    repo_id = MODEL_REPOSITORIES.get(model)
    if repo_id is None:
        raise ValueError(f"Unsupported faster-whisper model: {model}")
    from huggingface_hub import snapshot_download

    output.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id,
        local_dir=output,
        allow_patterns=list(ALLOW_PATTERNS),
        max_workers=1,
    )


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="capture-runtime-whisper-download")
    parser.add_argument("--model", required=True, choices=sorted(MODEL_REPOSITORIES))
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args(argv)
    download_model(arguments.model, arguments.output)


if __name__ == "__main__":
    main()
