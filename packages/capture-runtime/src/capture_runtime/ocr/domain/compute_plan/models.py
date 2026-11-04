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
class ComputePlanPolicy:
    """Policy for evaluating hardware capability and choosing execution plan."""

    def evaluate(
        self,
        has_compatible_gpu: bool,
        dml_available: bool,
        adapter_class: str = "dedicated",
        device_name: str | None = None,
        device_id: int | None = None,
    ) -> ComputePlanSelection:
        if has_compatible_gpu and dml_available:
            return ComputePlanSelection(
                compute_mode="gpu-dml",
                adapter_class=adapter_class,
                device_name=device_name,
                device_id=device_id,
            )
        reason = "no_compatible_gpu" if not has_compatible_gpu else "dml_provider_unavailable"
        return ComputePlanSelection(
            compute_mode="cpu-fallback",
            adapter_class=adapter_class if has_compatible_gpu else "unknown",
            device_name=device_name if has_compatible_gpu else None,
            device_id=device_id if has_compatible_gpu else None,
            reason=reason,
            notices=("ocr_cpu_fallback",),
        )
