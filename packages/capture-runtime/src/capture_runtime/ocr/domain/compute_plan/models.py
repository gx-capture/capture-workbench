"""Compute plan selection domain models and evaluation policy."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ComputePlanSelection:
    """Selected OCR execution hardware and fallback reason."""

    compute_mode: str
    adapter_class: str
    device_name: str | None = None
    device_id: int | None = None
    reason: str | None = None
    notices: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        if self.compute_mode not in ("gpu-dml", "cpu-fallback"):
            raise ValueError(f"invalid compute mode: {self.compute_mode}")
        if self.adapter_class not in ("dedicated", "integrated", "unknown"):
            raise ValueError(f"invalid adapter class: {self.adapter_class}")
        if self.device_id is not None and self.device_id < 0:
            raise ValueError("device id must be non-negative")
        if self.compute_mode == "cpu-fallback" and not self.reason:
            raise ValueError("cpu fallback requires an explanatory reason")


@dataclass(frozen=True, slots=True)
class ComputeCandidate:
    """One already-ranked hardware candidate with an observed assessment."""

    device_id: int
    adapter_class: str
    assessment: str
    has_identity: bool


@dataclass(frozen=True, slots=True)
class ComputePlanPolicy:
    """Choose only after every higher-ranked candidate is positively assessed."""

    def evaluate(
        self,
        candidates: tuple[ComputeCandidate, ...],
        *,
        dml_available: bool,
        require_identity: bool = False,
    ) -> ComputePlanSelection | None:
        for candidate in candidates:
            if candidate.assessment == "indeterminate":
                return None
            if candidate.assessment == "positive-usable":
                if require_identity and not candidate.has_identity:
                    return None
                return ComputePlanSelection(
                    compute_mode="gpu-dml",
                    adapter_class=candidate.adapter_class,
                    device_id=candidate.device_id,
                )
        return ComputePlanSelection(
            compute_mode="cpu-fallback",
            adapter_class=candidates[0].adapter_class if len(candidates) == 1 else "unknown",
            reason="dml_provider_unavailable"
            if candidates and not dml_available
            else "no_compatible_gpu",
            notices=("ocr_cpu_fallback",),
        )
