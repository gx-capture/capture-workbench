"""Capture Runtime command-line entry point."""

from __future__ import annotations

import argparse
from collections.abc import Sequence
from dataclasses import replace
from pathlib import Path

import uvicorn

from capture_runtime.app import create_app
from capture_runtime.config import RuntimeSettings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="capture-runtime")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="Run the loopback FastAPI sidecar")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    download = subparsers.add_parser("_download-whisper", help=argparse.SUPPRESS)
    download.add_argument("--model", required=True)
    download.add_argument("--output", required=True)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    arguments = build_parser().parse_args(argv)
    if arguments.command == "_download-whisper":
        from capture_runtime.whisper_download import download_model

        download_model(arguments.model, Path(arguments.output))
        return
    settings = RuntimeSettings.from_env()
    host = arguments.host or settings.host
    port = arguments.port or settings.port
    if host != "127.0.0.1":
        raise SystemExit("capture-runtime only permits --host 127.0.0.1")
    if not 1 <= port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    settings = replace(settings, host=host, port=port)
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        log_level="info",
        access_log=False,
        proxy_headers=False,
    )


if __name__ == "__main__":
    main()
