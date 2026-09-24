"""Private, fail-closed proof of one DML OCR execution.

This module is deliberately outside the public contract modules.  The proof is
an internal value carried by the worker result and, for acceptance runs only,
can be written by the file sink below.  It contains identities and execution
facts, never source bytes, OCR text, or host diagnostics.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, cast

from capture_runtime.ocr_preflight import (
    OcrExecutionPlan,
    OcrSelectedDeviceIdentityV1,
    OcrSelectionDeviceProofV1,
)
from capture_runtime.worker_process import WorkerFailureDiagnostics

if TYPE_CHECKING:
    from capture_runtime.contracts import OcrProvenanceV3
    from capture_runtime.engine_adapters import OcrExecutionEvidence


SHA256_RE = re.compile(r"[0-9a-f]{64}\Z")
PROOF_SCHEMA_VERSION = "1"
PROOF_ARTIFACT_NAME = "ocr-device-proof-v1.json"
FAILURE_PROOF_SCHEMA_VERSION = "1"
FAILURE_PROOF_ARTIFACT_NAME = "ocr-execution-failure-v1.json"
_EVIDENCE_SOURCES = frozenset({"ort-graph-assignment", "ort-profile"})


def canonical_json_bytes(value: object) -> bytes:
    """Return the restricted RFC 8785-style encoding used for proof digests."""

    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("utf-8")


def sha256_hex(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _require_sha(value: object, field: str) -> str:
    if not isinstance(value, str) or SHA256_RE.fullmatch(value) is None:
        raise ValueError(f"{field} must be a lowercase SHA-256 digest")
    return value


def _require_bounded_text(value: object, field: str, *, maximum: int = 128) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{field} must be a bounded string")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ValueError(f"{field} contains a control character")
    return value


def _require_identity_label(value: object) -> str:
    label = _require_bounded_text(value, "profile_id")
    if "/" in label or "\\" in label:
        raise ValueError("profile_id must not contain a path")
    return label


def _require_source_role(value: object) -> str:
    role = _require_bounded_text(value, "source_role", maximum=64)
    if "/" in role or "\\" in role or role in {".", ".."}:
        raise ValueError("source_role is invalid")
    return role


def _digest_without_self(value: Mapping[str, object]) -> str:
    return sha256_hex(canonical_json_bytes(dict(value)))


@dataclass(frozen=True, slots=True)
class OcrPipelineConstructionProofV1:
    """The current adapter map bracketed around synchronous pipeline creation."""

    pre_adapter_luid: str
    post_adapter_luid: str
    pre_adapter_map_sha256: str
    post_adapter_map_sha256: str
    pre_factory_current: bool
    post_factory_current: bool

    def __post_init__(self) -> None:
        for field in ("pre_adapter_luid", "post_adapter_luid"):
            value = getattr(self, field)
            if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{16}", value) is None:
                raise ValueError(f"{field} must be a lowercase 16-digit LUID")
        for field in ("pre_adapter_map_sha256", "post_adapter_map_sha256"):
            _require_sha(getattr(self, field), field)
        if not isinstance(self.pre_factory_current, bool) or not self.pre_factory_current:
            raise ValueError("pre-construction DXGI factory must be current")
        if not isinstance(self.post_factory_current, bool) or not self.post_factory_current:
            raise ValueError("post-construction DXGI factory must be current")
        if self.pre_adapter_luid != self.post_adapter_luid:
            raise ValueError("adapter LUID changed during pipeline construction")
        if self.pre_adapter_map_sha256 != self.post_adapter_map_sha256:
            raise ValueError("adapter map changed during pipeline construction")

    def to_dict(self) -> dict[str, object]:
        return {
            "pre": {
                "adapterLuid": self.pre_adapter_luid,
                "adapterMapSha256": self.pre_adapter_map_sha256,
                "factoryCurrent": self.pre_factory_current,
            },
            "post": {
                "adapterLuid": self.post_adapter_luid,
                "adapterMapSha256": self.post_adapter_map_sha256,
                "factoryCurrent": self.post_factory_current,
            },
        }

    @classmethod
    def from_dict(cls, value: object) -> OcrPipelineConstructionProofV1:
        if not isinstance(value, dict) or set(value) != {"pre", "post"}:
            raise ValueError("pipeline construction proof is invalid")
        records = []
        for name in ("pre", "post"):
            record = value[name]
            if not isinstance(record, dict) or set(record) != {
                "adapterLuid",
                "adapterMapSha256",
                "factoryCurrent",
            }:
                raise ValueError("pipeline construction proof record is invalid")
            records.append(record)
        try:
            return cls(
                pre_adapter_luid=cast(str, records[0]["adapterLuid"]),
                post_adapter_luid=cast(str, records[1]["adapterLuid"]),
                pre_adapter_map_sha256=cast(str, records[0]["adapterMapSha256"]),
                post_adapter_map_sha256=cast(str, records[1]["adapterMapSha256"]),
                pre_factory_current=cast(bool, records[0]["factoryCurrent"]),
                post_factory_current=cast(bool, records[1]["factoryCurrent"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("pipeline construction proof is invalid") from error


@dataclass(frozen=True, slots=True)
class OcrExecutionProofContextV1:
    """Identity context supplied by the owning runtime, not by a host/UI."""

    source_sha256: str
    requested_page_scope: tuple[int, ...] | None
    runtime_sha256: str
    worker_sha256: str
    model_sha256: str
    profile_id: str
    profile_spec_sha256: str
    contract_set_sha256: str

    def __post_init__(self) -> None:
        for field in (
            "source_sha256",
            "runtime_sha256",
            "worker_sha256",
            "model_sha256",
            "profile_spec_sha256",
            "contract_set_sha256",
        ):
            _require_sha(getattr(self, field), field)
        _require_identity_label(self.profile_id)
        scope = self.requested_page_scope
        if scope is not None:
            if not isinstance(scope, tuple) or not scope or len(scope) > 500:
                raise ValueError("requested page scope is invalid")
            if scope != tuple(range(1, len(scope) + 1)):
                raise ValueError("requested page scope must be an ordered prefix")
            if any(isinstance(page, bool) or not isinstance(page, int) for page in scope):
                raise ValueError("requested page scope is invalid")


@dataclass(frozen=True, slots=True)
class OcrExecutionDeviceProofV1:
    """Immutable, privacy-safe receipt for one retained-plan DML execution.

    The selection proof carries the configured adapter identity.  Individual
    session ``dmlDeviceId`` values may be null when ORT does not expose
    provider-options readback; nonzero DML execution evidence remains required.
    """

    selection_proof: OcrSelectionDeviceProofV1
    construction: OcrPipelineConstructionProofV1
    session_device_proofs: tuple[Any, ...]
    source_sha256: str
    requested_page_scope: tuple[int, ...] | None
    runtime_sha256: str
    worker_sha256: str
    model_sha256: str
    profile_id: str
    profile_spec_sha256: str
    contract_set_sha256: str
    dml_node_count: int
    execution_sha256: str

    def __post_init__(self) -> None:
        _require_sha(self.source_sha256, "source_sha256")
        _require_sha(self.runtime_sha256, "runtime_sha256")
        _require_sha(self.worker_sha256, "worker_sha256")
        _require_sha(self.model_sha256, "model_sha256")
        _require_identity_label(self.profile_id)
        _require_sha(self.profile_spec_sha256, "profile_spec_sha256")
        _require_sha(self.contract_set_sha256, "contract_set_sha256")
        _require_sha(self.execution_sha256, "execution_sha256")
        if isinstance(self.dml_node_count, bool) or not isinstance(self.dml_node_count, int):
            raise ValueError("aggregate DML node count is invalid")
        if self.dml_node_count < 1:
            raise ValueError("aggregate DML node count must be positive")
        if not isinstance(self.session_device_proofs, tuple) or not self.session_device_proofs:
            raise ValueError("execution proof has no session evidence")
        identity = self.selection_proof.identity
        if identity is not None and ("/" in identity.description or "\\" in identity.description):
            raise ValueError("execution proof identity label must not contain a path")
        for index, session in enumerate(self.session_device_proofs):
            if getattr(session, "session_index", None) != index:
                raise ValueError("execution proof session order is invalid")
            if getattr(session, "providers", None) != (
                "DmlExecutionProvider",
                "CPUExecutionProvider",
            ):
                raise ValueError("execution proof provider order is invalid")
            session_device_id = getattr(session, "dml_device_id", None)
            if (
                session_device_id is not None
                and session_device_id != self.selection_proof.dml_device_id
            ):
                raise ValueError("execution proof session device drifted")
            if getattr(session, "fallback_disabled", None) is not True:
                raise ValueError("execution proof fallback was not disabled")
            if getattr(session, "dml_node_count", 0) < 1:
                raise ValueError("execution proof session has no DML nodes")
            if getattr(session, "evidence_source", None) not in _EVIDENCE_SOURCES:
                raise ValueError("execution proof evidence source is invalid")
        if sum(item.dml_node_count for item in self.session_device_proofs) != self.dml_node_count:
            raise ValueError("execution proof aggregate node count is invalid")
        scope = self.requested_page_scope
        if scope is not None:
            if not isinstance(scope, tuple) or not scope or len(scope) > 500:
                raise ValueError("requested page scope is invalid")
            if scope != tuple(range(1, len(scope) + 1)):
                raise ValueError("requested page scope must be an ordered prefix")
            if any(isinstance(page, bool) or not isinstance(page, int) for page in scope):
                raise ValueError("requested page scope is invalid")

    @property
    def plan_sha256(self) -> str:
        return self.selection_proof.plan_sha256

    @property
    def identity_sha256(self) -> str | None:
        identity = self.selection_proof.identity
        return None if identity is None else identity.identity_sha256

    @property
    def dml_device_id(self) -> int | None:
        return self.selection_proof.dml_device_id

    def _value_without_digest(self) -> dict[str, object]:
        sessions = []
        for session in self.session_device_proofs:
            sessions.append(
                {
                    "sessionIndex": session.session_index,
                    "providerOrder": list(session.providers),
                    "dmlDeviceId": session.dml_device_id,
                    "fallbackDisabled": session.fallback_disabled,
                    "dmlNodeCount": session.dml_node_count,
                    "cpuNodeCount": session.cpu_node_count,
                    "evidenceSource": session.evidence_source,
                }
            )
        return {
            "schemaVersion": PROOF_SCHEMA_VERSION,
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
            "pipelineConstruction": self.construction.to_dict(),
            "sessionDeviceProofs": sessions,
            "sourceSha256": self.source_sha256,
            "requestedPageScope": (
                None if self.requested_page_scope is None else list(self.requested_page_scope)
            ),
            "dmlNodeCount": self.dml_node_count,
            "runtimeSha256": self.runtime_sha256,
            "workerSha256": self.worker_sha256,
            "modelSha256": self.model_sha256,
            "profileId": self.profile_id,
            "profileSpecSha256": self.profile_spec_sha256,
            "contractSetSha256": self.contract_set_sha256,
        }

    def to_dict(self) -> dict[str, object]:
        value = self._value_without_digest()
        value["executionSha256"] = self.execution_sha256
        return value

    def validate_digest(self) -> None:
        if _digest_without_self(self._value_without_digest()) != self.execution_sha256:
            raise ValueError("execution proof digest is invalid")

    def validate_against(self, plan: OcrExecutionPlan) -> None:
        proof = self.selection_proof
        if (
            proof.plan_sha256 != plan.plan_sha256
            or proof.identity != plan.identity
            or proof.high_performance_rank != plan.high_performance_rank
            or proof.dml_device_id != plan.dml_device_id
            or proof.adapter_map_sha256 != plan.adapter_map_sha256
            or self.worker_sha256 != (plan.worker_sha256 or "")
            or self.contract_set_sha256 != plan.contract_set_sha256
        ):
            raise ValueError("execution proof does not match retained OCR plan")
        if plan.identity is None:
            raise ValueError("execution proof requires a retained GPU identity")
        if self.construction.pre_adapter_luid != plan.identity.luid:
            raise ValueError("execution proof LUID does not match retained OCR plan")
        if self.construction.pre_adapter_map_sha256 != plan.adapter_map_sha256:
            raise ValueError("execution proof map does not match retained OCR plan")
        self.validate_digest()

    def validate_context(self, context: OcrExecutionProofContextV1) -> None:
        """Reject a receipt replayed with a different run identity or scope."""

        if (
            self.source_sha256 != context.source_sha256
            or self.requested_page_scope != context.requested_page_scope
            or self.runtime_sha256 != context.runtime_sha256
            or self.worker_sha256 != context.worker_sha256
            or self.model_sha256 != context.model_sha256
            or self.profile_id != context.profile_id
            or self.profile_spec_sha256 != context.profile_spec_sha256
            or self.contract_set_sha256 != context.contract_set_sha256
        ):
            raise ValueError("execution proof context does not match the retained run")
        self.validate_digest()

    @classmethod
    def from_dict(cls, value: object) -> OcrExecutionDeviceProofV1:
        if not isinstance(value, dict):
            raise ValueError("execution proof is invalid")
        expected = {
            "schemaVersion",
            "selectionProof",
            "pipelineConstruction",
            "sessionDeviceProofs",
            "sourceSha256",
            "requestedPageScope",
            "dmlNodeCount",
            "runtimeSha256",
            "workerSha256",
            "modelSha256",
            "profileId",
            "profileSpecSha256",
            "contractSetSha256",
            "executionSha256",
        }
        if set(value) != expected or value.get("schemaVersion") != PROOF_SCHEMA_VERSION:
            raise ValueError("execution proof has unexpected fields")
        try:
            selection_value = value["selectionProof"]
            if not isinstance(selection_value, dict) or set(selection_value) != {
                "identity",
                "highPerformanceRank",
                "dmlDeviceId",
                "adapterMapSha256",
                "planSha256",
            }:
                raise ValueError("execution selection proof is invalid")
            identity_value = selection_value["identity"]
            if identity_value is not None and (
                not isinstance(identity_value, dict) or "identitySha256" not in identity_value
            ):
                raise ValueError("execution selection identity digest is missing")
            identity = (
                None
                if identity_value is None
                else OcrSelectedDeviceIdentityV1.from_dict(identity_value)
            )
            selection = OcrSelectionDeviceProofV1(
                identity=identity,
                high_performance_rank=cast(int | None, selection_value["highPerformanceRank"]),
                dml_device_id=cast(int | None, selection_value["dmlDeviceId"]),
                adapter_map_sha256=cast(str | None, selection_value["adapterMapSha256"]),
                plan_sha256=cast(str, selection_value["planSha256"]),
            )
            raw_scope = value["requestedPageScope"]
            scope = None if raw_scope is None else tuple(cast(list[int], raw_scope))
            raw_sessions = value["sessionDeviceProofs"]
            if not isinstance(raw_sessions, list):
                raise ValueError("execution session evidence is invalid")
            # Importing the adapter type here avoids the engine_adapters -> proof
            # module cycle while keeping the wire parser strict and private.
            from capture_runtime.engine_adapters import OcrSessionDeviceProof

            sessions = tuple(
                OcrSessionDeviceProof(
                    session_index=cast(int, item["sessionIndex"]),
                    providers=tuple(cast(list[str], item["providerOrder"])),
                    dml_device_id=cast(int | None, item["dmlDeviceId"]),
                    fallback_disabled=cast(bool, item["fallbackDisabled"]),
                    dml_node_count=cast(int, item["dmlNodeCount"]),
                    cpu_node_count=cast(int, item["cpuNodeCount"]),
                    evidence_source=cast(str, item["evidenceSource"]),
                )
                for item in raw_sessions
                if isinstance(item, dict)
                and set(item)
                == {
                    "sessionIndex",
                    "providerOrder",
                    "dmlDeviceId",
                    "fallbackDisabled",
                    "dmlNodeCount",
                    "cpuNodeCount",
                    "evidenceSource",
                }
            )
            if len(sessions) != len(raw_sessions):
                raise ValueError("execution session evidence is invalid")
            proof = cls(
                selection_proof=selection,
                construction=OcrPipelineConstructionProofV1.from_dict(
                    value["pipelineConstruction"]
                ),
                session_device_proofs=sessions,
                source_sha256=cast(str, value["sourceSha256"]),
                requested_page_scope=scope,
                runtime_sha256=cast(str, value["runtimeSha256"]),
                worker_sha256=cast(str, value["workerSha256"]),
                model_sha256=cast(str, value["modelSha256"]),
                profile_id=cast(str, value["profileId"]),
                profile_spec_sha256=cast(str, value["profileSpecSha256"]),
                contract_set_sha256=cast(str, value["contractSetSha256"]),
                dml_node_count=cast(int, value["dmlNodeCount"]),
                execution_sha256=cast(str, value["executionSha256"]),
            )
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError("execution proof is invalid") from error
        proof.validate_digest()
        return proof

    @classmethod
    def build(
        cls,
        *,
        plan: OcrExecutionPlan,
        selection_proof: OcrSelectionDeviceProofV1,
        construction: OcrPipelineConstructionProofV1,
        evidence: OcrExecutionEvidence,
        context: OcrExecutionProofContextV1,
    ) -> OcrExecutionDeviceProofV1:
        sessions = tuple(evidence.session_device_proofs)
        proof = cls(
            selection_proof=selection_proof,
            construction=construction,
            session_device_proofs=sessions,
            source_sha256=context.source_sha256,
            requested_page_scope=context.requested_page_scope,
            runtime_sha256=context.runtime_sha256,
            worker_sha256=context.worker_sha256,
            model_sha256=context.model_sha256,
            profile_id=context.profile_id,
            profile_spec_sha256=context.profile_spec_sha256,
            contract_set_sha256=context.contract_set_sha256,
            dml_node_count=evidence.dml_node_count,
            execution_sha256="0" * 64,
        )
        value = proof._value_without_digest()
        object.__setattr__(proof, "execution_sha256", _digest_without_self(value))
        proof.validate_against(plan)
        return proof


@dataclass(frozen=True, slots=True)
class OcrExecutionEvidenceArtifact:
    relative_name: str
    bytes: int
    sha256: str

    def __post_init__(self) -> None:
        if self.relative_name not in {PROOF_ARTIFACT_NAME, FAILURE_PROOF_ARTIFACT_NAME}:
            raise ValueError("execution evidence artifact name is invalid")
        if isinstance(self.bytes, bool) or not isinstance(self.bytes, int) or self.bytes <= 0:
            raise ValueError("execution evidence artifact size is invalid")
        _require_sha(self.sha256, "execution evidence artifact digest")

    @property
    def name(self) -> str:
        return self.relative_name

    @property
    def byte_count(self) -> int:
        return self.bytes

    @property
    def artifact_sha256(self) -> str:
        return self.sha256


class OcrExecutionEvidenceSink(Protocol):
    """One private operation for ephemeral or acceptance-only proof sinks."""

    def record(
        self,
        capture_id: str,
        source_role: str,
        proof: OcrExecutionDeviceProofV1,
    ) -> OcrExecutionEvidenceArtifact | None: ...


class OcrExecutionFailureEvidenceSink(Protocol):
    """Private acceptance seam for a sanitized OCR worker failure."""

    def record_failure(
        self,
        *,
        source_sha256: str,
        source_role: str,
        diagnostics: WorkerFailureDiagnostics,
        worker_sha256: str | None = None,
        provenance: OcrProvenanceV3 | None = None,
    ) -> OcrExecutionEvidenceArtifact | None: ...


class NoopOcrExecutionEvidenceSink:
    """Default product adapter: validated proof remains ephemeral."""

    def record(
        self,
        capture_id: str,
        source_role: str,
        proof: OcrExecutionDeviceProofV1,
    ) -> None:
        del capture_id, source_role, proof
        return None

    def record_failure(
        self,
        *,
        source_sha256: str,
        source_role: str,
        diagnostics: WorkerFailureDiagnostics,
        worker_sha256: str | None = None,
        provenance: OcrProvenanceV3 | None = None,
    ) -> None:
        del source_sha256, source_role, diagnostics, worker_sha256, provenance
        return None


class InMemoryOcrExecutionEvidenceSink:
    """Behavior-test adapter; it never serializes the capture correlation key."""

    def __init__(self) -> None:
        self.proofs: list[tuple[str, str, OcrExecutionDeviceProofV1]] = []
        self.failures: list[dict[str, object]] = []

    def record(
        self,
        capture_id: str,
        source_role: str,
        proof: OcrExecutionDeviceProofV1,
    ) -> None:
        _require_bounded_text(capture_id, "capture_id", maximum=256)
        _require_source_role(source_role)
        proof.validate_digest()
        self.proofs.append((capture_id, source_role, proof))
        return None

    def record_failure(
        self,
        *,
        source_sha256: str,
        source_role: str,
        diagnostics: WorkerFailureDiagnostics,
        worker_sha256: str | None = None,
        provenance: OcrProvenanceV3 | None = None,
    ) -> None:
        _require_sha(source_sha256, "source_sha256")
        _require_source_role(source_role)
        if worker_sha256 is not None:
            _require_sha(worker_sha256, "worker_sha256")
        self.failures.append(
            {
                "sourceSha256": source_sha256,
                "sourceRole": source_role,
                "diagnostics": diagnostics,
                "workerSha256": worker_sha256,
                "provenance": provenance,
            }
        )
        return None


def _safe_identity_label(value: object, field: str, *, maximum: int = 256) -> str:
    label = _require_bounded_text(value, field, maximum=maximum)
    if "/" in label or "\\" in label:
        raise ValueError(f"{field} must not contain a path")
    return label


def _safe_ocr_provenance_payload(provenance: OcrProvenanceV3) -> dict[str, object]:
    model_dump = getattr(provenance, "model_dump", None)
    if not callable(model_dump):
        raise ValueError("OCR provenance is invalid")
    raw = model_dump(mode="json", by_alias=True)
    if not isinstance(raw, dict):
        raise ValueError("OCR provenance is invalid")
    status = raw.get("status")
    if status == "resolved":
        if set(raw) != {
            "status",
            "engine",
            "model",
            "modelDigest",
            "device",
            "profileId",
            "profileSpecSha256",
        }:
            raise ValueError("OCR provenance is invalid")
        return {
            "status": "resolved",
            "engine": _safe_identity_label(raw["engine"], "engine"),
            "model": _safe_identity_label(raw["model"], "model"),
            "modelDigest": _require_engine_digest(raw["modelDigest"], "model_digest"),
            "device": _safe_identity_label(raw["device"], "device"),
            "profileId": _safe_identity_label(raw["profileId"], "profile_id"),
            "profileSpecSha256": _require_sha(raw["profileSpecSha256"], "profile_spec_sha256"),
        }
    if status == "unavailable":
        if set(raw) != {"status", "profileId", "profileSpecSha256", "reason"}:
            raise ValueError("OCR provenance is invalid")
        return {
            "status": "unavailable",
            "profileId": _safe_identity_label(raw["profileId"], "profile_id"),
            "profileSpecSha256": _require_sha(raw["profileSpecSha256"], "profile_spec_sha256"),
            "reason": _safe_identity_label(raw["reason"], "reason", maximum=64),
        }
    raise ValueError("OCR provenance is invalid")


def _require_engine_digest(value: object, field: str) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value):
        raise ValueError(f"{field} must be a SHA-256 engine digest")
    return value


class AcceptanceOcrExecutionEvidenceSink:
    """Acceptance-only sink for one explicitly pre-authorized run directory."""

    def __init__(
        self,
        artifact_root: Path | None = None,
        *,
        run_artifact_root: Path | None = None,
        preauthorized_root: Path | None = None,
        authorized_root: Path | None = None,
        artifact_name: str = PROOF_ARTIFACT_NAME,
        runtime_sha256: str | None = None,
    ) -> None:
        if preauthorized_root is not None and authorized_root is not None:
            raise ValueError("pre-authorized root was supplied twice")
        if artifact_name != PROOF_ARTIFACT_NAME or Path(artifact_name).is_absolute():
            raise ValueError("execution evidence artifact name is invalid")
        allowed = preauthorized_root or authorized_root
        if allowed is None:
            raise ValueError("execution evidence sink requires a pre-authorized root")
        if artifact_root is not None and run_artifact_root is not None:
            raise ValueError("artifact root was supplied twice")
        selected_root = artifact_root or run_artifact_root
        if selected_root is None:
            raise ValueError("execution evidence sink requires an artifact root")
        self._root = self._safe_existing_directory(selected_root, "artifact root")
        self._allowed = self._safe_existing_directory(allowed, "pre-authorized root")
        if self._root != self._allowed:
            raise ValueError("execution evidence artifact root is outside its pre-authorized root")
        if runtime_sha256 is not None:
            _require_sha(runtime_sha256, "runtime_sha256")
        self._artifact_name = artifact_name
        self._runtime_sha256 = runtime_sha256
        self._recorded = False

    @staticmethod
    def _safe_existing_directory(value: Path, field: str) -> Path:
        path = Path(value)
        if not path.is_absolute():
            raise ValueError(f"{field} must be absolute")
        try:
            cursor = Path(path.anchor)
            for part in path.parts[1:]:
                cursor /= part
                if cursor.is_symlink():
                    raise ValueError(f"{field} must not contain a symlink")
            resolved = path.resolve(strict=True)
            if not resolved.is_dir():
                raise ValueError(f"{field} must be a directory")
            return resolved
        except (OSError, RuntimeError) as error:
            raise ValueError(f"{field} is stale or unavailable") from error

    def record(
        self,
        capture_id: str,
        source_role: str,
        proof: OcrExecutionDeviceProofV1,
    ) -> OcrExecutionEvidenceArtifact:
        _require_bounded_text(capture_id, "capture_id", maximum=256)
        _require_source_role(source_role)
        if self._recorded:
            raise ValueError("execution evidence artifact already recorded")
        proof.validate_digest()
        payload = canonical_json_bytes(proof.to_dict()) + b"\n"
        target = self._root / self._artifact_name
        if target.exists() or target.is_symlink():
            raise ValueError("execution evidence artifact collision")
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=".ocr-device-proof-",
                suffix=".tmp",
                dir=self._root,
                delete=False,
            ) as stream:
                temporary_path = Path(stream.name)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            if target.exists() or target.is_symlink():
                raise ValueError("execution evidence artifact collision")
            # A same-volume hard-link publish is atomic and, unlike
            # os.replace, cannot overwrite a concurrently-created artifact.
            # If the filesystem cannot provide that primitive, fail closed.
            os.link(temporary_path, target)
            temporary_path.unlink(missing_ok=True)
            temporary_path = None
            self._recorded = True
        except Exception:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise
        return OcrExecutionEvidenceArtifact(
            relative_name=self._artifact_name,
            bytes=len(payload),
            sha256=sha256_hex(payload),
        )

    def record_failure(
        self,
        *,
        source_sha256: str,
        source_role: str,
        diagnostics: WorkerFailureDiagnostics,
        worker_sha256: str | None = None,
        provenance: OcrProvenanceV3 | None = None,
    ) -> OcrExecutionEvidenceArtifact:
        _require_sha(source_sha256, "source_sha256")
        _require_source_role(source_role)
        if not isinstance(diagnostics, WorkerFailureDiagnostics):
            raise ValueError("worker failure diagnostics are invalid")
        if self._runtime_sha256 is None:
            raise ValueError("runtime identity is required")
        if worker_sha256 is None:
            raise ValueError("worker identity is required")
        _require_sha(worker_sha256, "worker_sha256")
        if provenance is not None:
            provenance_payload = _safe_ocr_provenance_payload(provenance)
        else:
            provenance_payload = None
        if self._recorded:
            raise ValueError("execution evidence artifact already recorded")
        payload_value: dict[str, object] = {
            "schemaVersion": FAILURE_PROOF_SCHEMA_VERSION,
            "sourceSha256": source_sha256,
            "sourceRole": source_role,
            "stageSequence": list(diagnostics.stage_sequence),
            "failureClass": diagnostics.failure_class,
        }
        if diagnostics.exit_code is not None:
            payload_value["exitCode"] = diagnostics.exit_code
        payload_value["runtimeSha256"] = self._runtime_sha256
        payload_value["workerSha256"] = worker_sha256
        if provenance_payload is not None:
            payload_value["ocrProvenance"] = provenance_payload
        payload = canonical_json_bytes(payload_value) + b"\n"
        target = self._root / FAILURE_PROOF_ARTIFACT_NAME
        if target.exists() or target.is_symlink():
            raise ValueError("execution failure evidence artifact collision")
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                prefix=".ocr-failure-",
                suffix=".tmp",
                dir=self._root,
                delete=False,
            ) as stream:
                temporary_path = Path(stream.name)
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            if target.exists() or target.is_symlink():
                raise ValueError("execution failure evidence artifact collision")
            os.link(temporary_path, target)
            temporary_path.unlink(missing_ok=True)
            temporary_path = None
            self._recorded = True
        except Exception:
            if temporary_path is not None:
                try:
                    temporary_path.unlink(missing_ok=True)
                except OSError:
                    pass
            raise
        return OcrExecutionEvidenceArtifact(
            relative_name=FAILURE_PROOF_ARTIFACT_NAME,
            bytes=len(payload),
            sha256=sha256_hex(payload),
        )


def acceptance_ocr_execution_evidence_sink_from_environment() -> OcrExecutionEvidenceSink:
    """Build the process-local sink; only an explicit acceptance run may write."""

    opt_in = os.environ.get("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN")
    if opt_in is None or not opt_in.strip():
        return NoopOcrExecutionEvidenceSink()
    if opt_in.strip() != "1":
        raise ValueError("OCR execution evidence opt-in is invalid")
    root_value = os.environ.get("CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT")
    if root_value is None or not root_value.strip():
        raise ValueError("OCR execution evidence root is unavailable")
    runtime_sha256 = acceptance_ocr_execution_runtime_sha256_from_environment()
    root = Path(root_value.strip())
    return AcceptanceOcrExecutionEvidenceSink(
        root,
        preauthorized_root=root,
        runtime_sha256=runtime_sha256,
    )


def acceptance_ocr_execution_runtime_sha256_from_environment() -> str | None:
    """Hash the loaded runtime and optionally verify the acceptance expectation."""

    opt_in = os.environ.get("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN")
    if opt_in is None or not opt_in.strip():
        return None
    if opt_in.strip() != "1":
        raise ValueError("OCR execution evidence opt-in is invalid")
    loaded_runtime = Path(sys.executable)
    if not loaded_runtime.is_absolute() or loaded_runtime.is_symlink():
        raise ValueError("OCR execution evidence loaded runtime is invalid")
    try:
        loaded_runtime = loaded_runtime.resolve(strict=True)
        if not loaded_runtime.is_file():
            raise ValueError("OCR execution evidence loaded runtime is invalid")
        digest = hashlib.sha256()
        with loaded_runtime.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        runtime_sha256 = digest.hexdigest()
    except (OSError, RuntimeError) as error:
        raise ValueError("OCR execution evidence loaded runtime is unavailable") from error
    expected = os.environ.get("CAPTURE_OCR_EXECUTION_RUNTIME_SHA256")
    if expected is not None:
        expected = expected.strip()
        if SHA256_RE.fullmatch(expected) is None:
            raise ValueError("OCR execution evidence runtime identity is invalid")
        if expected != runtime_sha256:
            raise ValueError(
                "OCR execution evidence runtime identity does not match the loaded runtime"
            )
    return runtime_sha256


__all__ = [
    "AcceptanceOcrExecutionEvidenceSink",
    "AcceptanceOcrExecutionEvidenceFileSink",
    "FileOcrExecutionEvidenceSink",
    "FAILURE_PROOF_ARTIFACT_NAME",
    "FAILURE_PROOF_SCHEMA_VERSION",
    "InMemoryOcrExecutionEvidenceSink",
    "NoopOcrExecutionEvidenceSink",
    "OcrExecutionDeviceProofV1",
    "OcrExecutionEvidenceArtifact",
    "OcrExecutionEvidenceSink",
    "OcrExecutionFailureEvidenceSink",
    "OcrExecutionProofContextV1",
    "OcrExecutionProofContext",
    "OcrPipelineConstructionProofV1",
    "PROOF_ARTIFACT_NAME",
    "canonical_json_bytes",
    "acceptance_ocr_execution_evidence_sink_from_environment",
    "acceptance_ocr_execution_runtime_sha256_from_environment",
]

# Explicit alias used by acceptance callers that want the implementation role
# in the name; both names expose the same fail-closed adapter.
AcceptanceOcrExecutionEvidenceFileSink = AcceptanceOcrExecutionEvidenceSink
FileOcrExecutionEvidenceSink = AcceptanceOcrExecutionEvidenceSink
OcrExecutionProofContext = OcrExecutionProofContextV1
