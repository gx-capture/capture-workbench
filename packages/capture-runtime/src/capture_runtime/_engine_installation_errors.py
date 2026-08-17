"""Internal exception definitions for the engine installation facade."""

from __future__ import annotations


class EngineInstallationError(RuntimeError):
    """Raised when an optional engine cannot be safely installed."""


class EngineInstallBusyError(EngineInstallationError):
    """Raised when another process owns the same requirement install lock."""


class EngineResolutionTimeoutError(TimeoutError):
    """Raised when active-engine verification does not finish within its deadline."""


# Preserve the established public module path for tracebacks, reprs, and
# consumers that inspect these exception types.
EngineInstallationError.__module__ = "capture_runtime.engine_installation"
EngineInstallBusyError.__module__ = "capture_runtime.engine_installation"
EngineResolutionTimeoutError.__module__ = "capture_runtime.engine_installation"


__all__ = [
    "EngineInstallBusyError",
    "EngineInstallationError",
    "EngineResolutionTimeoutError",
]
