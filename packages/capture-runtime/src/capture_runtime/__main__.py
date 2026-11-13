"""Capture Runtime command-line entry point."""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from dataclasses import replace

import uvicorn

from capture_runtime._frozen_extraction_residue import start_stale_extraction_sweep
from capture_runtime.app import create_app
from capture_runtime.config import RuntimeSettings
from capture_runtime.storage.app_data_lock import AppDataDirectoryLock, AppDataInUseError

EXIT_APP_DATA_IN_USE = 10
# A host that restarts the runtime (a changed setting) may start it before Windows has
# released the stopped runtime's lock; a second live runtime still fails after this wait.
APP_DATA_LOCK_WAIT_SECONDS = 10.0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="capture-runtime")
    subparsers = parser.add_subparsers(dest="command", required=True)
    serve = subparsers.add_parser("serve", help="Run the loopback FastAPI sidecar")
    serve.add_argument("--host", default=None)
    serve.add_argument("--port", type=int, default=None)
    return parser


def main(argv: Sequence[str] | None = None) -> None:
    arguments = build_parser().parse_args(argv)
    settings = RuntimeSettings.from_env()
    host = arguments.host or settings.host
    port = arguments.port or settings.port
    if host != "127.0.0.1":
        raise SystemExit("capture-runtime only permits --host 127.0.0.1")
    if not 1 <= port <= 65535:
        raise SystemExit("--port must be between 1 and 65535")
    settings = replace(settings, host=host, port=port)
    try:
        lock = AppDataDirectoryLock.acquire(
            settings.app_data_dir, wait_seconds=APP_DATA_LOCK_WAIT_SECONDS
        )
    except AppDataInUseError:
        print(
            "capture-runtime: the app data directory is in use by another Capture Runtime.",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(EXIT_APP_DATA_IN_USE) from None
    with lock:
        start_stale_extraction_sweep()
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
