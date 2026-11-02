"""Download progress a runtime-requirement install reports while it runs."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass


@dataclass(frozen=True)
class DownloadedBytes:
    """Bytes downloaded so far out of everything the install downloads."""

    done: int
    total: int


# Installs that download nothing the runtime can size (winget, a unit that is
# already present) never call it; the overall fraction still goes through
# report_progress.
DownloadProgress = Callable[[DownloadedBytes], None]
