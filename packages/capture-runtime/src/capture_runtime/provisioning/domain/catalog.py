"""Engine catalog value objects and descriptors."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field


@dataclass(slots=True, frozen=True)
class EngineRequirementDescriptor:
    """Descriptor of an engine requirement in the catalog."""

    requirement_id: str
    display_name: str
    artifacts: tuple[str, ...] = field(default_factory=tuple)
    model_files: tuple[str, ...] = field(default_factory=tuple)


@dataclass(slots=True)
class EngineCatalog:
    """Domain model of the engine catalog."""

    requirements: Mapping[str, EngineRequirementDescriptor] = field(default_factory=dict)

    def get(self, requirement_id: str) -> EngineRequirementDescriptor | None:
        return self.requirements.get(requirement_id)
