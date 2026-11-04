"""Runtime requirement entity."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class RuntimeRequirement:
    """A requirement provided or needed by the runtime."""

    requirement_id: str
    display_name: str
    status: str
    error: str | None = None
    version: str | None = None
    size_bytes: int | None = None
