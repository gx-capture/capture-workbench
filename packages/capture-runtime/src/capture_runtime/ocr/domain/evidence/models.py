"""Validated DirectML session observations, independent of ONNX Runtime IO."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class DirectMlExecutionEvidence:
    """Provider assignment observed from an ONNX Runtime execution profile.

    The configured provider list is only a request.  DML provenance is
    resolved from this evidence after the first prediction, so a session that
    silently assigned every node to CPU cannot be labelled as DML.
    """

    dml_node_count: int
    cpu_node_count: int = 0
    source: str = "ort-profile"
    session_device_proofs: tuple[SessionDeviceProof, ...] = ()

    def __post_init__(self) -> None:
        for name in ("dml_node_count", "cpu_node_count"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer")
        if not self.source.strip():
            raise ValueError("execution evidence source must be non-empty")
        if self.session_device_proofs:
            if tuple(item.session_index for item in self.session_device_proofs) != tuple(
                range(len(self.session_device_proofs))
            ):
                raise ValueError("execution evidence session order is invalid")
            if (
                sum(item.dml_node_count for item in self.session_device_proofs)
                != self.dml_node_count
            ):
                raise ValueError("execution evidence DML count does not match sessions")
            if (
                sum(item.cpu_node_count for item in self.session_device_proofs)
                != self.cpu_node_count
            ):
                raise ValueError("execution evidence CPU count does not match sessions")


@dataclass(frozen=True, slots=True)
class SessionDeviceProof:
    """Provider/node evidence tied to one returned ORT session.

    ``dml_device_id`` is the optional provider-options readback.  A value of
    ``None`` means that ORT did not expose that readback; the configured
    adapter identity remains bound by the retained execution plan and native
    map construction proof.
    """

    session_index: int
    providers: tuple[str, ...] = ("DmlExecutionProvider", "CPUExecutionProvider")
    dml_device_id: int | None = None
    fallback_disabled: bool = True
    dml_node_count: int = 1
    evidence_source: str = "ort-profile"
    cpu_node_count: int = 0

    def __post_init__(self) -> None:
        if (
            isinstance(self.session_index, bool)
            or not isinstance(self.session_index, int)
            or self.session_index < 0
        ):
            raise ValueError("session index must be a non-negative integer")
        if not isinstance(self.providers, tuple) or self.providers != (
            "DmlExecutionProvider",
            "CPUExecutionProvider",
        ):
            raise ValueError("session provider order is invalid")
        if self.dml_device_id is not None and (
            isinstance(self.dml_device_id, bool)
            or not isinstance(self.dml_device_id, int)
            or self.dml_device_id < 0
        ):
            raise ValueError("session DML device id is invalid")
        if not isinstance(self.fallback_disabled, bool) or not self.fallback_disabled:
            raise ValueError("session fallback must be disabled")
        if (
            isinstance(self.dml_node_count, bool)
            or not isinstance(self.dml_node_count, int)
            or self.dml_node_count < 1
        ):
            raise ValueError("session DML node count must be positive")
        if (
            isinstance(self.cpu_node_count, bool)
            or not isinstance(self.cpu_node_count, int)
            or self.cpu_node_count < 0
        ):
            raise ValueError("session CPU node count must be non-negative")
        if not isinstance(self.evidence_source, str) or not self.evidence_source.strip():
            raise ValueError("session evidence source must be non-empty")


def has_dml_execution(evidence: DirectMlExecutionEvidence) -> bool:
    """Keep the shipping rule: CPU bookkeeping nodes do not erase observed DML work."""
    return evidence.dml_node_count > 0
