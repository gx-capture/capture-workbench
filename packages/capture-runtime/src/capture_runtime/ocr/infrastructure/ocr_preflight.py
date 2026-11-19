"""Runtime-owned pre-OCR GPU capability decision.

The public result is deliberately small.  Hardware enumeration and ORT
provider discovery live behind one injectable capability seam so hosts do not
duplicate platform policy and tests do not need a GPU, DirectML, or OCR model.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import sys
import unicodedata
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import Literal, Protocol, cast

from capture_runtime.contracts import (
    OcrAdapterClass,
    OcrComputeMode,
    OcrComputeNoticeCode,
    OcrComputeReasonCode,
)
from capture_runtime.contracts import (
    OcrComputePreflight as OcrComputePreflightContract,
)
from capture_runtime.gpu_inventory import DxgiAdapterLease, GpuAdapter, GpuAdapterClass
from capture_runtime.ocr.application.use_cases import SelectComputePlan
from capture_runtime.ocr.domain.compute_plan.models import ComputeCandidate

_ASSESSMENTS = frozenset({"positive-usable", "positive-unavailable", "indeterminate"})
ORT_DIRECTML_MAPPING_CONTRACT = "ort-directml-1.24.4-enumadapters1-v1"
_PLAN_POLICY_VERSION = "1"
_SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")


def _canonical_json(value: object) -> bytes:
    """Encode the private values with one deterministic JSON representation."""

    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")


def _digest(value: object) -> str:
    return hashlib.sha256(_canonical_json(value)).hexdigest()


def _hex(value: object, width: int, field: str) -> str:
    if isinstance(value, bool):
        raise ValueError(f"{field} must be hexadecimal")
    if isinstance(value, int):
        if value < 0 or value >= 1 << (width * 4):
            raise ValueError(f"{field} is out of range")
        return f"{value:0{width}x}"
    if not isinstance(value, str) or re.fullmatch(rf"[0-9a-fA-F]{{{width}}}", value) is None:
        raise ValueError(f"{field} must be {width} lowercase hexadecimal digits")
    return value.lower()


def _description(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("GPU description must be a string")
    normalized = unicodedata.normalize("NFKC", value)
    normalized = " ".join(normalized.split())
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in normalized):
        raise ValueError("GPU description contains a control character")
    return normalized[:128]


@dataclass(frozen=True, slots=True)
class OcrSelectedDeviceIdentityV1:
    """Sanitized run-scoped identity; labels are observational only."""

    adapter_class: OcrAdapterClass
    luid: str
    vendor_id: str
    device_id: str
    subsystem_id: str
    revision: str
    description: str

    def __post_init__(self) -> None:
        if self.adapter_class not in {OcrAdapterClass.DEDICATED, OcrAdapterClass.INTEGRATED}:
            raise ValueError("selected GPU identity requires a known hardware class")
        object.__setattr__(self, "luid", _hex(self.luid, 16, "adapter LUID"))
        object.__setattr__(self, "vendor_id", _hex(self.vendor_id, 4, "vendor id"))
        object.__setattr__(self, "device_id", _hex(self.device_id, 4, "device id"))
        object.__setattr__(self, "subsystem_id", _hex(self.subsystem_id, 8, "subsystem id"))
        object.__setattr__(self, "revision", _hex(self.revision, 2, "revision"))
        object.__setattr__(self, "description", _description(self.description))

    @property
    def adapter_luid(self) -> str:
        return self.luid

    @property
    def identity_sha256(self) -> str:
        return _digest(self.to_dict(include_digest=False))

    def to_dict(self, *, include_digest: bool = True) -> dict[str, object]:
        value: dict[str, object] = {
            "adapterClass": self.adapter_class.value,
            "adapterLuid": self.luid,
            "vendorId": self.vendor_id,
            "deviceId": self.device_id,
            "subsystemId": self.subsystem_id,
            "revision": self.revision,
            "description": self.description,
        }
        if include_digest:
            value["identitySha256"] = self.identity_sha256
        return value

    @classmethod
    def from_dict(cls, value: object) -> OcrSelectedDeviceIdentityV1:
        if not isinstance(value, dict):
            raise ValueError("selection identity is invalid")
        try:
            identity = cls(
                adapter_class=OcrAdapterClass(value["adapterClass"]),
                luid=cast(str, value["adapterLuid"]),
                vendor_id=cast(str, value["vendorId"]),
                device_id=cast(str, value["deviceId"]),
                subsystem_id=cast(str, value["subsystemId"]),
                revision=cast(str, value["revision"]),
                description=cast(str, value["description"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("selection identity is invalid") from error
        expected = value.get("identitySha256")
        if expected is not None and expected != identity.identity_sha256:
            raise ValueError("selection identity digest is invalid")
        return identity


@dataclass(frozen=True, slots=True)
class OcrGpuAdapter:
    """One adapter record from the ordinary and preference-ordered tables.

    ``index`` remains the ordinary ``EnumAdapters1`` ordinal for compatibility
    with the old in-memory adapter.  New native records additionally carry the
    exact LUID, preference rank, PCI identity, and closed assessment.
    """

    index: int
    adapter_class: OcrAdapterClass
    is_software: bool = False
    luid: str | None = None
    high_performance_rank: int | None = None
    vendor_id: int | str = 0
    pci_device_id: int | str = 0
    subsystem_id: int | str = 0
    revision: int | str = 0
    description: str = ""
    assessment: str | None = None

    def __post_init__(self) -> None:
        if isinstance(self.index, bool) or not isinstance(self.index, int) or self.index < 0:
            raise ValueError("GPU adapter index must be a non-negative integer")
        if not isinstance(self.adapter_class, OcrAdapterClass):
            raise ValueError("GPU adapter class is invalid")
        if not isinstance(self.is_software, bool):
            raise ValueError("GPU software flag must be boolean")
        if self.high_performance_rank is not None and (
            isinstance(self.high_performance_rank, bool)
            or not isinstance(self.high_performance_rank, int)
            or self.high_performance_rank < 0
        ):
            raise ValueError("GPU preference rank must be a non-negative integer")
        if self.luid is not None:
            object.__setattr__(self, "luid", _hex(self.luid, 16, "adapter LUID"))
        if not isinstance(self.description, str):
            raise ValueError("GPU description must be a string")
        if self.assessment is not None and self.assessment not in _ASSESSMENTS:
            raise ValueError("GPU assessment is invalid")

    @property
    def adapter_luid(self) -> str | None:
        return self.luid

    @property
    def dml_device_id(self) -> int:
        return self.index

    def identity(self) -> OcrSelectedDeviceIdentityV1:
        if self.luid is None:
            raise ValueError("GPU adapter has no LUID")
        return OcrSelectedDeviceIdentityV1(
            adapter_class=self.adapter_class,
            luid=self.luid,
            vendor_id=cast(str, self.vendor_id),
            device_id=cast(str, self.pci_device_id),
            subsystem_id=cast(str, self.subsystem_id),
            revision=cast(str, self.revision),
            description=self.description,
        )


@dataclass(frozen=True, slots=True)
class OcrGpuCapabilitySnapshot:
    """One authoritative native/provider observation for ``OcrComputePlan``."""

    adapters: tuple[OcrGpuAdapter, ...] = ()
    dml_provider_available: bool = False
    high_performance_adapters: tuple[OcrGpuAdapter, ...] = ()
    ordinary_adapters: tuple[OcrGpuAdapter, ...] = ()
    enumeration_complete: bool = True
    provider_discovery_complete: bool = True
    ort_version: str | None = None
    tables_authoritative: bool = False

    def __post_init__(self) -> None:
        for name in ("adapters", "high_performance_adapters", "ordinary_adapters"):
            value = getattr(self, name)
            if not isinstance(value, tuple):
                raise ValueError(f"GPU {name} must be a tuple")
        if not isinstance(self.dml_provider_available, bool):
            raise ValueError("DML provider availability must be boolean")
        if not isinstance(self.enumeration_complete, bool) or not isinstance(
            self.provider_discovery_complete, bool
        ):
            raise ValueError("GPU snapshot completeness must be boolean")
        if not isinstance(self.tables_authoritative, bool):
            raise ValueError("GPU table authority must be boolean")
        indexes = [adapter.index for adapter in self.adapters]
        if len(indexes) != len(set(indexes)):
            raise ValueError("GPU adapter indexes must be unique")
        for name in ("high_performance_adapters", "ordinary_adapters"):
            records = getattr(self, name)
            record_indexes = [adapter.index for adapter in records]
            if len(record_indexes) != len(set(record_indexes)):
                raise ValueError(f"GPU {name} indexes must be unique")

    @property
    def is_structurally_invalid(self) -> bool:
        return not self.enumeration_complete or not self.provider_discovery_complete

    @property
    def has_join_tables(self) -> bool:
        return self.tables_authoritative or bool(
            self.high_performance_adapters or self.ordinary_adapters
        )

    def joined_adapters(self) -> tuple[OcrGpuAdapter, ...] | None:
        """Join complete tables exclusively by exact LUID.

        ``None`` is a structural failure, distinct from an empty authoritative
        hardware inventory.  Legacy in-memory records without LUIDs are kept
        usable for older tests; production/native records always take the join.
        """

        if not self.has_join_tables:
            return self.adapters
        if not self.high_performance_adapters and not self.ordinary_adapters:
            return () if self.tables_authoritative else None
        if not self.high_performance_adapters or not self.ordinary_adapters:
            return None
        high = self.high_performance_adapters
        ordinary = self.ordinary_adapters
        high_luids = [item.luid for item in high]
        ordinary_luids = [item.luid for item in ordinary]
        if (
            any(luid is None for luid in high_luids + ordinary_luids)
            or len(high_luids) != len(set(high_luids))
            or len(ordinary_luids) != len(set(ordinary_luids))
            or set(high_luids) != set(ordinary_luids)
        ):
            return None
        ranks = [item.high_performance_rank for item in high]
        if any(rank is None for rank in ranks) or len(ranks) != len(set(ranks)):
            return None
        by_luid = {cast(str, item.luid): item for item in ordinary}
        joined: list[OcrGpuAdapter] = []
        for preference in high:
            ordinary_item = by_luid[cast(str, preference.luid)]
            if preference.high_performance_rank is None:
                return None
            if ordinary_item.high_performance_rank not in (None, preference.high_performance_rank):
                return None
            if preference.adapter_class != ordinary_item.adapter_class or (
                preference.is_software != ordinary_item.is_software
            ):
                return None
            if (
                preference.vendor_id != ordinary_item.vendor_id
                or preference.pci_device_id != ordinary_item.pci_device_id
                or preference.subsystem_id != ordinary_item.subsystem_id
                or preference.revision != ordinary_item.revision
                or (
                    preference.assessment is not None
                    and ordinary_item.assessment is not None
                    and preference.assessment != ordinary_item.assessment
                )
            ):
                return None
            joined.append(
                OcrGpuAdapter(
                    index=ordinary_item.index,
                    adapter_class=ordinary_item.adapter_class,
                    is_software=ordinary_item.is_software,
                    luid=cast(str, preference.luid),
                    high_performance_rank=preference.high_performance_rank,
                    vendor_id=ordinary_item.vendor_id,
                    pci_device_id=ordinary_item.pci_device_id,
                    subsystem_id=ordinary_item.subsystem_id,
                    revision=ordinary_item.revision,
                    description=ordinary_item.description or preference.description,
                    assessment=ordinary_item.assessment or preference.assessment,
                )
            )
        return tuple(joined)


@dataclass(frozen=True, slots=True)
class OcrExecutionPlan:
    """Immutable private plan retained from readiness through session creation."""

    mode: OcrComputeMode
    selection_source: Literal["automatic", "cpu-fallback"]
    adapter_class: OcrAdapterClass
    identity: OcrSelectedDeviceIdentityV1 | None
    high_performance_rank: int | None
    dml_device_id: int | None
    adapter_map_sha256: str | None
    ort_mapping_contract: str
    worker_sha256: str | None
    contract_set_sha256: str
    plan_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.mode, OcrComputeMode):
            raise ValueError("OCR plan mode is invalid")
        if self.selection_source not in {"automatic", "cpu-fallback"}:
            raise ValueError("OCR plan selection source is invalid")
        if not isinstance(self.adapter_class, OcrAdapterClass):
            raise ValueError("OCR plan adapter class is invalid")
        if self.ort_mapping_contract != ORT_DIRECTML_MAPPING_CONTRACT:
            raise ValueError("unsupported ORT DirectML mapping contract")
        if not _SHA256_RE.fullmatch(self.contract_set_sha256):
            raise ValueError("contract set digest is invalid")
        if self.worker_sha256 is not None and not _SHA256_RE.fullmatch(self.worker_sha256):
            raise ValueError("worker digest is invalid")
        if self.adapter_map_sha256 is not None and not _SHA256_RE.fullmatch(
            self.adapter_map_sha256
        ):
            raise ValueError("adapter map digest is invalid")
        if not _SHA256_RE.fullmatch(self.plan_sha256):
            raise ValueError("plan digest is invalid")
        gpu = self.mode is OcrComputeMode.GPU
        if gpu != (self.identity is not None):
            raise ValueError("GPU plan identity does not match mode")
        if (
            gpu
            and self.identity is not None
            and self.adapter_class is not self.identity.adapter_class
        ):
            raise ValueError("GPU plan class does not match identity")
        if gpu and (
            self.high_performance_rank is None
            or self.dml_device_id is None
            or self.adapter_map_sha256 is None
            or self.selection_source != "automatic"
        ):
            raise ValueError("GPU plan is incomplete")
        for name, value in (
            ("high-performance rank", self.high_performance_rank),
            ("DML device id", self.dml_device_id),
        ):
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 0
            ):
                raise ValueError(f"OCR plan {name} is invalid")
        if not gpu and any(
            value is not None
            for value in (self.high_performance_rank, self.dml_device_id, self.adapter_map_sha256)
        ):
            raise ValueError("CPU plan cannot carry GPU coordinates")
        expected = _digest(self._digest_value())
        if expected != self.plan_sha256:
            raise ValueError("OCR execution plan digest is invalid")

    def _digest_value(self) -> dict[str, object]:
        return {
            "policyVersion": _PLAN_POLICY_VERSION,
            "mode": self.mode.value,
            "selectionSource": self.selection_source,
            "identitySha256": None if self.identity is None else self.identity.identity_sha256,
            "highPerformanceRank": self.high_performance_rank,
            "dmlDeviceId": self.dml_device_id,
            "adapterMapSha256": self.adapter_map_sha256,
            "ortMappingContract": self.ort_mapping_contract,
            "workerSha256": self.worker_sha256,
            "contractSetSha256": self.contract_set_sha256,
        }

    def to_dict(self) -> dict[str, object]:
        return {
            **self._digest_value(),
            "identity": None if self.identity is None else self.identity.to_dict(),
            "planSha256": self.plan_sha256,
        }

    @classmethod
    def from_dict(cls, value: object) -> OcrExecutionPlan:
        if not isinstance(value, dict):
            raise ValueError("OCR execution plan is invalid")
        if value.get("policyVersion") != _PLAN_POLICY_VERSION:
            raise ValueError("OCR execution plan policy version is invalid")
        try:
            identity_value = value.get("identity")
            identity = (
                None
                if identity_value is None
                else OcrSelectedDeviceIdentityV1.from_dict(identity_value)
            )
            plan = cls(
                mode=OcrComputeMode(value["mode"]),
                selection_source=cast(
                    Literal["automatic", "cpu-fallback"], value["selectionSource"]
                ),
                adapter_class=OcrAdapterClass(value["adapterClass"])
                if "adapterClass" in value
                else (OcrAdapterClass.UNKNOWN if identity is None else identity.adapter_class),
                identity=identity,
                high_performance_rank=cast(int | None, value.get("highPerformanceRank")),
                dml_device_id=cast(int | None, value.get("dmlDeviceId")),
                adapter_map_sha256=cast(str | None, value.get("adapterMapSha256")),
                ort_mapping_contract=cast(str, value["ortMappingContract"]),
                worker_sha256=cast(str | None, value.get("workerSha256")),
                contract_set_sha256=cast(str, value["contractSetSha256"]),
                plan_sha256=cast(str, value["planSha256"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("OCR execution plan is invalid") from error
        if plan.mode is OcrComputeMode.GPU and plan.identity is not None:
            if plan.identity.identity_sha256 != value.get("identitySha256"):
                raise ValueError("OCR execution plan identity digest is invalid")
        elif value.get("identitySha256") is not None:
            raise ValueError("CPU execution plan identity digest is invalid")
        return plan


@dataclass(frozen=True, slots=True)
class OcrSelectionDeviceProofV1:
    identity: OcrSelectedDeviceIdentityV1 | None
    high_performance_rank: int | None
    dml_device_id: int | None
    adapter_map_sha256: str | None
    plan_sha256: str

    def __post_init__(self) -> None:
        if not _SHA256_RE.fullmatch(self.plan_sha256):
            raise ValueError("selection proof plan digest is invalid")
        if self.adapter_map_sha256 is not None and not _SHA256_RE.fullmatch(
            self.adapter_map_sha256
        ):
            raise ValueError("selection proof adapter map digest is invalid")
        for name, value in (
            ("high-performance rank", self.high_performance_rank),
            ("DML device id", self.dml_device_id),
        ):
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int) or value < 0
            ):
                raise ValueError(f"selection proof {name} is invalid")
        gpu = self.identity is not None
        if gpu != (self.high_performance_rank is not None and self.dml_device_id is not None):
            raise ValueError("selection proof coordinates do not match identity")
        if gpu and self.adapter_map_sha256 is None:
            raise ValueError("GPU selection proof lacks adapter map digest")
        if not gpu and self.adapter_map_sha256 is not None:
            raise ValueError("CPU selection proof cannot carry adapter map digest")


@dataclass(frozen=True, slots=True)
class OcrComputeSelection:
    """The one decision projected to readiness, execution, and private proof."""

    execution_plan: OcrExecutionPlan
    readiness: OcrComputePreflightContract
    selection_proof: OcrSelectionDeviceProofV1

    def __post_init__(self) -> None:
        plan = self.execution_plan
        if self.readiness.contract_set_sha256 != plan.contract_set_sha256:
            raise ValueError("OCR readiness contract does not match execution plan")
        if self.readiness.worker_sha256 != plan.worker_sha256:
            raise ValueError("OCR readiness worker does not match execution plan")
        if self.readiness.mode is not plan.mode:
            raise ValueError("OCR readiness mode does not match execution plan")
        if self.readiness.adapter_class is not plan.adapter_class:
            raise ValueError("OCR readiness class does not match execution plan")
        proof = self.selection_proof
        if (
            proof.plan_sha256 != plan.plan_sha256
            or proof.identity != plan.identity
            or proof.high_performance_rank != plan.high_performance_rank
            or proof.dml_device_id != plan.dml_device_id
            or proof.adapter_map_sha256 != plan.adapter_map_sha256
        ):
            raise ValueError("OCR selection proof does not match execution plan")

    @property
    def plan(self) -> OcrExecutionPlan:
        return self.execution_plan

    def to_dict(self) -> dict[str, object]:
        return {
            "readiness": self.readiness.model_dump(mode="json", by_alias=True),
            "executionPlan": self.execution_plan.to_dict(),
            "selectionProof": {
                "identity": (
                    None
                    if self.selection_proof.identity is None
                    else self.selection_proof.identity.to_dict()
                ),
                "highPerformanceRank": self.selection_proof.high_performance_rank,
                "dmlDeviceId": self.selection_proof.dml_device_id,
                "adapterMapSha256": self.selection_proof.adapter_map_sha256,
                "planSha256": self.selection_proof.plan_sha256,
            },
        }

    @classmethod
    def from_dict(cls, value: object) -> OcrComputeSelection:
        if not isinstance(value, dict):
            raise ValueError("OCR compute selection is invalid")
        try:
            plan = OcrExecutionPlan.from_dict(value["executionPlan"])
            readiness = OcrComputePreflightContract.model_validate(value["readiness"])
            proof_value = value["selectionProof"]
            if not isinstance(proof_value, dict):
                raise ValueError("selection proof is invalid")
            proof_identity = proof_value.get("identity")
            proof = OcrSelectionDeviceProofV1(
                identity=(
                    None
                    if proof_identity is None
                    else OcrSelectedDeviceIdentityV1.from_dict(proof_identity)
                ),
                high_performance_rank=cast(int | None, proof_value.get("highPerformanceRank")),
                dml_device_id=cast(int | None, proof_value.get("dmlDeviceId")),
                adapter_map_sha256=cast(str | None, proof_value.get("adapterMapSha256")),
                plan_sha256=cast(str, proof_value["planSha256"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("OCR compute selection is invalid") from error
        if (
            proof.plan_sha256 != plan.plan_sha256
            or proof.identity != plan.identity
            or proof.dml_device_id != plan.dml_device_id
            or proof.high_performance_rank != plan.high_performance_rank
            or proof.adapter_map_sha256 != plan.adapter_map_sha256
        ):
            raise ValueError("OCR selection proof does not match execution plan")
        return cls(plan, readiness, proof)


class OcrComputePlan:
    """Select one immutable plan from one native/provider snapshot.

    This is the runtime-owned decision module.  The injected capability probe
    is the only external seam; hosts never rank adapters or pass an ordinal.
    """

    def __init__(
        self,
        *,
        contract_set_sha256: str,
        worker_sha256: str | None = None,
        capability_probe: OcrGpuCapabilityProbe | None = None,
    ) -> None:
        if not _SHA256_RE.fullmatch(contract_set_sha256):
            raise ValueError("contract set digest is invalid")
        if worker_sha256 is not None and not _SHA256_RE.fullmatch(worker_sha256):
            raise ValueError("worker digest is invalid")
        self._contract_set_sha256 = contract_set_sha256
        self._worker_sha256 = worker_sha256
        self._capability_probe = capability_probe or NativeOcrGpuCapabilityProbe()

    def select(self) -> OcrComputeSelection | None:
        """Return a plan, or ``None`` when evidence cannot support a decision."""

        try:
            snapshot = self._capability_probe.probe()
        except Exception:
            return None
        if not isinstance(snapshot, OcrGpuCapabilitySnapshot) or snapshot.is_structurally_invalid:
            return None
        joined = snapshot.joined_adapters()
        if joined is None:
            return None
        structured = snapshot.has_join_tables
        if structured and snapshot.ort_version != "1.24.4":
            return None
        adapters = tuple(joined)
        hardware = tuple(item for item in adapters if not item.is_software)
        try:
            map_digest = (
                _adapter_map_digest(adapters)
                if structured
                else _legacy_adapter_map_digest(adapters)
            )
        except (TypeError, ValueError):
            return None
        ordered = sorted(hardware, key=_adapter_sort_key)
        decision = SelectComputePlan().execute(
            tuple(
                ComputeCandidate(
                    item.index,
                    item.adapter_class.value,
                    self._assessment(item, snapshot),
                    item.luid is not None,
                )
                for item in ordered
            ),
            dml_available=snapshot.dml_provider_available,
            require_identity=structured,
        )
        if decision is None:
            return None
        if decision.compute_mode == "gpu":
            candidate = next(item for item in hardware if item.index == decision.device_id)
            try:
                return self._selection(
                    candidate,
                    snapshot,
                    selection_source="automatic",
                    adapter_map_sha256=map_digest,
                    structured=structured,
                )
            except (TypeError, ValueError):
                return None
        return self._cpu_selection(
            snapshot,
            OcrComputeReasonCode(decision.reason or "no_compatible_gpu"),
            map_digest,
            adapter_class=OcrAdapterClass(decision.adapter_class),
        )

    def _assessment(
        self,
        adapter: OcrGpuAdapter,
        snapshot: OcrGpuCapabilitySnapshot,
    ) -> str:
        if adapter.is_software:
            return "positive-unavailable"
        # Provider discovery is a global prerequisite.  Even a stale or
        # contradictory per-adapter usable marker cannot turn an unavailable
        # DML provider into a GPU selection.
        if not snapshot.dml_provider_available:
            return "positive-unavailable"
        if adapter.assessment is not None:
            return adapter.assessment
        if adapter.adapter_class is OcrAdapterClass.UNKNOWN:
            return "indeterminate"
        # A structured record must contain a LUID and both coordinates.  The
        # legacy record is accepted solely for compatibility with old tests.
        if snapshot.has_join_tables and (
            adapter.luid is None or adapter.high_performance_rank is None
        ):
            return "indeterminate"
        return "positive-usable"

    def _selection(
        self,
        adapter: OcrGpuAdapter,
        snapshot: OcrGpuCapabilitySnapshot,
        *,
        selection_source: Literal["automatic"],
        adapter_map_sha256: str,
        structured: bool,
    ) -> OcrComputeSelection:
        if adapter.luid is None:
            # Compatibility snapshots have no native identity.  They still
            # receive a deterministic private plan but cannot claim a native
            # selection proof until a real LUID is observed.
            identity = (
                None
                if structured
                else OcrSelectedDeviceIdentityV1(
                    adapter_class=adapter.adapter_class,
                    luid=f"{adapter.index:016x}",
                    vendor_id=cast(str, 0),
                    device_id=cast(str, 0),
                    subsystem_id=cast(str, 0),
                    revision=cast(str, 0),
                    description="legacy test adapter",
                )
            )
        else:
            identity = adapter.identity()
        if structured and identity is None:
            raise ValueError("structured GPU selection lacks a native identity")
        effective_rank = (
            adapter.high_performance_rank
            if adapter.high_performance_rank is not None
            else adapter.index
        )
        plan_values: dict[str, object] = {
            "policyVersion": _PLAN_POLICY_VERSION,
            "mode": OcrComputeMode.GPU.value,
            "selectionSource": selection_source,
            "identitySha256": None if identity is None else identity.identity_sha256,
            "highPerformanceRank": effective_rank,
            "dmlDeviceId": adapter.index,
            "adapterMapSha256": adapter_map_sha256,
            "ortMappingContract": ORT_DIRECTML_MAPPING_CONTRACT,
            "workerSha256": self._worker_sha256,
            "contractSetSha256": self._contract_set_sha256,
        }
        plan = OcrExecutionPlan(
            mode=OcrComputeMode.GPU,
            selection_source=selection_source,
            adapter_class=adapter.adapter_class,
            identity=identity,
            high_performance_rank=effective_rank,
            dml_device_id=adapter.index,
            adapter_map_sha256=adapter_map_sha256,
            ort_mapping_contract=ORT_DIRECTML_MAPPING_CONTRACT,
            worker_sha256=self._worker_sha256,
            contract_set_sha256=self._contract_set_sha256,
            plan_sha256=_digest(plan_values),
        )
        readiness = OcrComputePreflightContract(
            contract_set_sha256=self._contract_set_sha256,
            worker_sha256=self._worker_sha256,
            mode=OcrComputeMode.GPU,
            adapter_class=adapter.adapter_class,
            user_notice_required=False,
        )
        proof = OcrSelectionDeviceProofV1(
            identity=identity,
            high_performance_rank=plan.high_performance_rank,
            dml_device_id=plan.dml_device_id,
            adapter_map_sha256=plan.adapter_map_sha256,
            plan_sha256=plan.plan_sha256,
        )
        return OcrComputeSelection(plan, readiness, proof)

    def _cpu_selection(
        self,
        snapshot: OcrGpuCapabilitySnapshot,
        reason: OcrComputeReasonCode,
        adapter_map_sha256: str,
        *,
        adapter_class: OcrAdapterClass = OcrAdapterClass.UNKNOWN,
    ) -> OcrComputeSelection:
        del snapshot, adapter_map_sha256
        plan_values = {
            "policyVersion": _PLAN_POLICY_VERSION,
            "mode": OcrComputeMode.CPU_FALLBACK.value,
            "selectionSource": "cpu-fallback",
            "identitySha256": None,
            "highPerformanceRank": None,
            "dmlDeviceId": None,
            "adapterMapSha256": None,
            "ortMappingContract": ORT_DIRECTML_MAPPING_CONTRACT,
            "workerSha256": self._worker_sha256,
            "contractSetSha256": self._contract_set_sha256,
        }
        plan = OcrExecutionPlan(
            mode=OcrComputeMode.CPU_FALLBACK,
            selection_source="cpu-fallback",
            adapter_class=adapter_class,
            identity=None,
            high_performance_rank=None,
            dml_device_id=None,
            adapter_map_sha256=None,
            ort_mapping_contract=ORT_DIRECTML_MAPPING_CONTRACT,
            worker_sha256=self._worker_sha256,
            contract_set_sha256=self._contract_set_sha256,
            plan_sha256=_digest(plan_values),
        )
        readiness = OcrComputePreflightContract(
            contract_set_sha256=self._contract_set_sha256,
            worker_sha256=self._worker_sha256,
            mode=OcrComputeMode.CPU_FALLBACK,
            adapter_class=adapter_class,
            reason_code=reason,
            user_notice_required=True,
            notice_code=OcrComputeNoticeCode.CPU_FALLBACK,
        )
        return OcrComputeSelection(
            plan,
            readiness,
            OcrSelectionDeviceProofV1(None, None, None, None, plan.plan_sha256),
        )


def _adapter_sort_key(adapter: OcrGpuAdapter) -> tuple[int, int, int, int, int, int, str]:
    # Unknown hardware may be a dedicated adapter, so it must be considered
    # before a known integrated adapter.  If it cannot be positively assessed,
    # the plan fails closed instead of silently falling back to the iGPU/CPU.
    class_rank = 1 if adapter.adapter_class is OcrAdapterClass.INTEGRATED else 0
    rank = (
        adapter.high_performance_rank
        if adapter.high_performance_rank is not None
        else adapter.index
    )
    return (
        class_rank,
        rank,
        int(adapter.vendor_id, 16) if isinstance(adapter.vendor_id, str) else adapter.vendor_id,
        int(adapter.pci_device_id, 16)
        if isinstance(adapter.pci_device_id, str)
        else adapter.pci_device_id,
        int(adapter.subsystem_id, 16)
        if isinstance(adapter.subsystem_id, str)
        else adapter.subsystem_id,
        int(adapter.revision, 16) if isinstance(adapter.revision, str) else adapter.revision,
        adapter.luid or f"{adapter.index:016x}",
    )


def _adapter_map_digest(adapters: tuple[OcrGpuAdapter, ...]) -> str:
    high_entries = []
    ordinary_entries = []
    for adapter in sorted(adapters, key=lambda item: item.luid or ""):
        if adapter.is_software:
            continue
        if adapter.luid is None:
            raise ValueError("adapter map contains an adapter without a LUID")
        identity = adapter.identity()
        ordinary_entries.append(
            {
                "adapterClass": identity.adapter_class.value,
                "adapterLuid": identity.luid,
                "vendorId": identity.vendor_id,
                "deviceId": identity.device_id,
                "subsystemId": identity.subsystem_id,
                "revision": identity.revision,
                "dmlDeviceId": adapter.index,
            }
        )
        high_entries.append(
            {
                "adapterClass": identity.adapter_class.value,
                "adapterLuid": identity.luid,
                "vendorId": identity.vendor_id,
                "deviceId": identity.device_id,
                "subsystemId": identity.subsystem_id,
                "revision": identity.revision,
                "highPerformanceRank": adapter.high_performance_rank,
            }
        )
    return _digest({"highPerformance": high_entries, "ordinary": ordinary_entries})


def _legacy_adapter_map_digest(adapters: tuple[OcrGpuAdapter, ...]) -> str:
    return _digest(
        [
            {
                "adapterClass": adapter.adapter_class.value,
                "index": adapter.index,
                "software": adapter.is_software,
            }
            for adapter in adapters
        ]
    )


class OcrGpuCapabilityProbe(Protocol):
    """Injectable seam for native adapter and ORT capability discovery."""

    def probe(self) -> OcrGpuCapabilitySnapshot: ...


class NativeOcrGpuCapabilityProbe:
    """Read-only native/ORT capability adapter used by production runtime."""

    def __init__(
        self,
        *,
        provider_resolver: Callable[[], Sequence[str]] | None = None,
        adapter_enumerator: Callable[[], Sequence[OcrGpuAdapter]] | None = None,
        table_enumerator: Callable[[], tuple[Sequence[OcrGpuAdapter], Sequence[OcrGpuAdapter]]]
        | None = None,
        version_resolver: Callable[[], str | None] | None = None,
    ) -> None:
        self._provider_resolver = provider_resolver or _ort_provider_resolver
        self._adapter_enumerator = adapter_enumerator
        self._table_enumerator = table_enumerator or (
            _native_adapter_tables if adapter_enumerator is None else None
        )
        self._version_resolver = version_resolver or _ort_version_resolver

    def probe(self) -> OcrGpuCapabilitySnapshot:
        provider_ok = True
        enumeration_ok = True
        tables_authoritative = False
        try:
            providers = tuple(self._provider_resolver())
        except Exception:
            providers = ()
            provider_ok = False
        if self._table_enumerator is not None:
            tables_authoritative = True
            try:
                high, ordinary = self._table_enumerator()
                high_adapters = tuple(high)
                ordinary_adapters = tuple(ordinary)
                adapters = ordinary_adapters
            except Exception:
                adapters = ()
                high_adapters = ()
                ordinary_adapters = ()
                enumeration_ok = False
        else:
            try:
                assert self._adapter_enumerator is not None
                adapters = tuple(self._adapter_enumerator())
            except Exception:
                adapters = ()
                high_adapters = ()
                ordinary_adapters = ()
                enumeration_ok = False
        try:
            ort_version = self._version_resolver()
        except Exception:
            ort_version = None
            provider_ok = False
        return OcrGpuCapabilitySnapshot(
            adapters=adapters,
            dml_provider_available="DmlExecutionProvider" in providers,
            high_performance_adapters=high_adapters,
            ordinary_adapters=ordinary_adapters,
            enumeration_complete=enumeration_ok,
            provider_discovery_complete=provider_ok,
            ort_version=ort_version,
            tables_authoritative=tables_authoritative,
        )


class OcrComputePreflight:
    """Deep module translating capability evidence into a safe OCR mode."""

    def __init__(
        self,
        *,
        contract_set_sha256: str,
        capability_probe: OcrGpuCapabilityProbe | None = None,
        worker_probe: Callable[[], Awaitable[object]] | None = None,
    ) -> None:
        self._contract_set_sha256 = contract_set_sha256
        self._capability_probe = capability_probe or NativeOcrGpuCapabilityProbe()
        self._worker_probe = worker_probe

    def decide(self) -> OcrComputePreflightContract | None:
        """Return the public projection of one immutable runtime selection."""

        selection = OcrComputePlan(
            contract_set_sha256=self._contract_set_sha256,
            capability_probe=self._capability_probe,
        ).select()
        return None if selection is None else selection.readiness

    async def decide_async(self) -> OcrComputePreflightContract | None:
        """Resolve production capability through the installed worker boundary.

        The synchronous decision remains available for hermetic capability
        tests and worker-side use.  Runtime readiness supplies ``worker_probe``
        so the core process never needs the optional ONNX Runtime dependency.
        Any missing, malformed, or failed worker result is unavailable rather
        than an invented CPU fallback.
        """

        if self._worker_probe is None:
            return await asyncio.to_thread(self.decide)
        try:
            value = await self._worker_probe()
            if isinstance(value, OcrComputeSelection):
                decision = value.readiness
            elif isinstance(value, OcrComputePreflightContract):
                decision = OcrComputePreflightContract.model_validate(
                    value.model_dump(mode="json", by_alias=True)
                )
            elif isinstance(value, dict):
                if "readiness" in value and "executionPlan" in value:
                    decision = OcrComputeSelection.from_dict(value).readiness
                else:
                    decision = OcrComputePreflightContract.model_validate(value)
            else:
                return None
        except Exception:
            return None
        if decision.contract_set_sha256 != self._contract_set_sha256:
            return None
        return decision


def _ort_provider_resolver() -> tuple[str, ...]:
    if sys.platform != "win32":
        return ()
    try:
        import onnxruntime as ort

        providers = ort.get_available_providers()
    except Exception:
        return ()
    return tuple(provider for provider in providers if isinstance(provider, str))


def _ort_version_resolver() -> str | None:
    if sys.platform != "win32":
        return None
    try:
        import onnxruntime as ort

        value = getattr(ort, "__version__", None)
    except Exception:
        return None
    return value if isinstance(value, str) else None


def _ocr_adapter_table(
    adapters: tuple[GpuAdapter, ...], *, high_performance: bool
) -> tuple[OcrGpuAdapter, ...]:
    return tuple(
        OcrGpuAdapter(
            index=index,
            adapter_class=(
                OcrAdapterClass.UNKNOWN
                if adapter.adapter_class is GpuAdapterClass.SOFTWARE
                else OcrAdapterClass(adapter.adapter_class.value)
            ),
            is_software=adapter.adapter_class is GpuAdapterClass.SOFTWARE,
            luid=adapter.luid,
            high_performance_rank=index if high_performance else None,
            vendor_id=adapter.vendor_id,
            pci_device_id=adapter.device_id,
            subsystem_id=adapter.subsystem_id,
            revision=adapter.revision,
            description=adapter.description,
        )
        for index, adapter in enumerate(adapters)
    )


class NativeOcrAdapterMapLease(DxgiAdapterLease):
    """Map the native tables to DirectML ordinals within one factory lease."""

    def __init__(self) -> None:
        super().__init__(include_high_performance=True)

    def enumerate_tables(self) -> tuple[tuple[OcrGpuAdapter, ...], tuple[OcrGpuAdapter, ...]]:
        ordinary = self.enumerate_adapters()
        high = self.enumerate_adapters(high_performance=True)
        return (
            _ocr_adapter_table(high, high_performance=True),
            _ocr_adapter_table(ordinary, high_performance=False),
        )

    def adapter_map(self) -> tuple[str, tuple[OcrGpuAdapter, ...]]:
        """Return the joined map digest and ordinary-ordinal map from this lease."""

        high, ordinary = self.enumerate_tables()
        snapshot = OcrGpuCapabilitySnapshot(
            adapters=ordinary,
            high_performance_adapters=high,
            ordinary_adapters=ordinary,
            tables_authoritative=True,
        )
        joined = snapshot.joined_adapters()
        if joined is None:
            raise RuntimeError("native OCR adapter map is incomplete")
        return _adapter_map_digest(joined), joined


def _native_adapter_tables() -> tuple[tuple[OcrGpuAdapter, ...], tuple[OcrGpuAdapter, ...]]:
    """Enumerate ordinary and HIGH_PERFORMANCE tables for one capability probe."""

    lease = NativeOcrAdapterMapLease()
    try:
        if not lease.is_current():
            raise RuntimeError("DXGI factory became stale before adapter enumeration")
        high, ordinary = lease.enumerate_tables()
        if not lease.is_current():
            raise RuntimeError("DXGI factory became stale during adapter enumeration")
        return high, ordinary
    finally:
        lease.close()


__all__ = [
    "NativeOcrAdapterMapLease",
    "NativeOcrGpuCapabilityProbe",
    "OcrComputePlan",
    "OcrComputePreflight",
    "OcrComputeSelection",
    "OcrExecutionPlan",
    "OcrGpuAdapter",
    "OcrGpuCapabilityProbe",
    "OcrGpuCapabilitySnapshot",
    "OcrSelectedDeviceIdentityV1",
    "OcrSelectionDeviceProofV1",
    "ORT_DIRECTML_MAPPING_CONTRACT",
]
