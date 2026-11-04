"""Execution evidence value objects and invariants for DirectML hardware proof."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class SessionDeviceProof:
    """Proof that one ONNX Runtime session bound DirectML with fallback disabled."""

    session_index: int
    dml_node_count: int
    cpu_node_count: int = 0
    dml_device_id: int | None = None
    fallback_disabled: bool = True

    def __post_init__(self) -> None:
        if self.session_index < 0:
            raise ValueError("session index must be a non-negative integer")
        if self.dml_node_count < 1:
            raise ValueError("session DML node count must be positive")
        if self.cpu_node_count < 0:
            raise ValueError("session CPU node count must be non-negative")
        if not self.fallback_disabled:
            raise ValueError("session fallback must be disabled")


@dataclass(frozen=True, slots=True)
class DirectMlExecutionEvidence:
    """Aggregate evidence confirming that DirectML nodes executed on hardware."""

    dml_node_count: int
    cpu_node_count: int = 0
    source: str = "ort-profile"
    session_device_proofs: tuple[SessionDeviceProof, ...] = ()

    def __post_init__(self) -> None:
        if self.dml_node_count < 0 or self.cpu_node_count < 0:
            raise ValueError("node counts must be non-negative")
        if not self.source.strip():
            raise ValueError("execution evidence source must be non-empty")
        if self.session_device_proofs:
            indices = tuple(p.session_index for p in self.session_device_proofs)
            if indices != tuple(range(len(self.session_device_proofs))):
                raise ValueError("execution evidence session order is invalid")
            if sum(p.dml_node_count for p in self.session_device_proofs) != self.dml_node_count:
                raise ValueError("execution evidence DML count does not match sessions")
            if sum(p.cpu_node_count for p in self.session_device_proofs) != self.cpu_node_count:
                raise ValueError("execution evidence CPU count does not match sessions")

    @property
    def is_pure_dml(self) -> bool:
        return self.dml_node_count > 0 and self.cpu_node_count == 0
