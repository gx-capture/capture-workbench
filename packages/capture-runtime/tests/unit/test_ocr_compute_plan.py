from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace

import pytest

from capture_runtime import engine_adapters
from capture_runtime.contracts import OcrAdapterClass, OcrComputeMode
from capture_runtime.ocr_preflight import (
    OcrComputePlan,
    OcrExecutionPlan,
    OcrGpuAdapter,
    OcrGpuCapabilitySnapshot,
)

CONTRACT_SHA256 = "a" * 64
WORKER_SHA256 = "b" * 64


class StaticProbe:
    def __init__(self, snapshot: OcrGpuCapabilitySnapshot) -> None:
        self.snapshot = snapshot

    def probe(self) -> OcrGpuCapabilitySnapshot:
        return self.snapshot


def _adapter(
    *,
    index: int,
    adapter_class: OcrAdapterClass,
    luid: str,
    rank: int,
    assessment: str = "positive-usable",
) -> OcrGpuAdapter:
    return OcrGpuAdapter(
        index=index,
        adapter_class=adapter_class,
        luid=luid,
        high_performance_rank=rank,
        vendor_id=0x10DE,
        pci_device_id=0x1000 + int(luid[-2:], 16),
        subsystem_id=0x2000 + int(luid[-2:], 16),
        revision=1,
        description=f"adapter-{index}",
        assessment=assessment,
    )


def _snapshot(
    *,
    high: tuple[OcrGpuAdapter, ...],
    ordinary: tuple[OcrGpuAdapter, ...],
    provider: bool = True,
    version: str | None = "1.24.4",
) -> OcrGpuCapabilitySnapshot:
    return OcrGpuCapabilitySnapshot(
        high_performance_adapters=high,
        ordinary_adapters=ordinary,
        dml_provider_available=provider,
        ort_version=version,
    )


def _plan(snapshot: OcrGpuCapabilitySnapshot, **kwargs: object):
    return OcrComputePlan(
        contract_sha256=CONTRACT_SHA256,
        worker_sha256=WORKER_SHA256,
        capability_probe=StaticProbe(snapshot),
        **kwargs,
    ).select()


def test_ordinary_ordinal_is_ort_device_id_when_preference_ranks_are_reversed() -> None:
    luid_igpu = "00000000000000aa"
    luid_dgpu = "00000000000000bb"
    high = (
        _adapter(
            index=0,
            adapter_class=OcrAdapterClass.DEDICATED,
            luid=luid_dgpu,
            rank=0,
        ),
        _adapter(
            index=1,
            adapter_class=OcrAdapterClass.INTEGRATED,
            luid=luid_igpu,
            rank=1,
        ),
    )
    ordinary = (
        _adapter(
            index=0,
            adapter_class=OcrAdapterClass.INTEGRATED,
            luid=luid_igpu,
            rank=1,
        ),
        _adapter(
            index=1,
            adapter_class=OcrAdapterClass.DEDICATED,
            luid=luid_dgpu,
            rank=0,
        ),
    )

    selection = _plan(_snapshot(high=high, ordinary=ordinary))

    assert selection is not None
    assert selection.execution_plan.mode is OcrComputeMode.GPU_DML
    assert selection.execution_plan.dml_device_id == 1
    assert selection.execution_plan.high_performance_rank == 0
    assert selection.execution_plan.identity is not None
    assert selection.execution_plan.identity.luid == luid_dgpu


def test_indeterminate_dedicated_adapter_blocks_integrated_selection() -> None:
    dgpu = _adapter(
        index=1,
        adapter_class=OcrAdapterClass.DEDICATED,
        luid="00000000000000bb",
        rank=0,
        assessment="indeterminate",
    )
    igpu = _adapter(
        index=0,
        adapter_class=OcrAdapterClass.INTEGRATED,
        luid="00000000000000aa",
        rank=1,
    )

    assert _plan(_snapshot(high=(dgpu, igpu), ordinary=(igpu, dgpu))) is None


def test_all_positive_unavailable_adapters_select_cpu_with_notice() -> None:
    dgpu = _adapter(
        index=1,
        adapter_class=OcrAdapterClass.DEDICATED,
        luid="00000000000000bb",
        rank=0,
        assessment="positive-unavailable",
    )
    igpu = _adapter(
        index=0,
        adapter_class=OcrAdapterClass.INTEGRATED,
        luid="00000000000000aa",
        rank=1,
        assessment="positive-unavailable",
    )

    selection = _plan(_snapshot(high=(dgpu, igpu), ordinary=(igpu, dgpu)))

    assert selection is not None
    assert selection.execution_plan.mode is OcrComputeMode.CPU_FALLBACK
    assert selection.readiness.user_notice_required is True
    assert selection.execution_plan.dml_device_id is None


def test_authoritative_software_only_inventory_selects_cpu() -> None:
    software_high = replace(
        _adapter(
            index=0,
            adapter_class=OcrAdapterClass.UNKNOWN,
            luid="00000000000000aa",
            rank=0,
            assessment="positive-unavailable",
        ),
        is_software=True,
    )
    software_ordinary = software_high
    selection = _plan(_snapshot(high=(software_high,), ordinary=(software_ordinary,)))

    # The native table join retains software records for completeness, but
    # they never enter the hardware candidate set.
    assert selection is not None
    assert selection.execution_plan.mode is OcrComputeMode.CPU_FALLBACK


def test_incomplete_or_duplicate_luid_tables_are_unavailable() -> None:
    gpu = _adapter(
        index=0,
        adapter_class=OcrAdapterClass.DEDICATED,
        luid="00000000000000aa",
        rank=0,
    )
    assert _plan(_snapshot(high=(gpu,), ordinary=())) is None
    duplicate = replace(gpu, index=1)
    assert _plan(_snapshot(high=(gpu, duplicate), ordinary=(gpu,))) is None


def test_plan_round_trip_rejects_map_and_ort_version_drift() -> None:
    gpu = _adapter(
        index=1,
        adapter_class=OcrAdapterClass.DEDICATED,
        luid="00000000000000aa",
        rank=0,
    )
    selection = _plan(_snapshot(high=(gpu,), ordinary=(gpu,)))
    assert selection is not None
    restored = OcrExecutionPlan.from_dict(selection.execution_plan.to_dict())
    assert restored == selection.execution_plan
    changed = selection.execution_plan.to_dict()
    changed["dmlDeviceId"] = 0
    try:
        OcrExecutionPlan.from_dict(changed)
    except ValueError as error:
        assert "invalid" in str(error)
    else:
        raise AssertionError("changed retained plan must fail closed")
    assert _plan(_snapshot(high=(gpu,), ordinary=(gpu,), version="1.25.0")) is None


def test_ordinal_override_is_rejected_at_the_canonical_plan_boundary() -> None:
    gpu = _adapter(
        index=1,
        adapter_class=OcrAdapterClass.DEDICATED,
        luid="00000000000000aa",
        rank=0,
    )
    integrated = _adapter(
        index=0,
        adapter_class=OcrAdapterClass.INTEGRATED,
        luid="00000000000000bb",
        rank=1,
    )
    with pytest.raises(TypeError):
        OcrComputePlan(
            contract_sha256=CONTRACT_SHA256,
            capability_probe=StaticProbe(
                _snapshot(high=(gpu, integrated), ordinary=(integrated, gpu))
            ),
            operator_override=0,
        )


def _pipeline_for_session(session: object) -> SimpleNamespace:
    return SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=session))
        )
    )


@pytest.mark.parametrize("reported_device_id", [0, "0", "01", True, None])
def test_plan_evidence_rejects_a_session_with_wrong_or_noncanonical_device_id(
    tmp_path, reported_device_id: object
) -> None:
    stages: list[str] = []

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, object]]:
            return {"DmlExecutionProvider": {"device_id": reported_device_id}}

        def disable_fallback(self) -> None:
            return None

    adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(
        tmp_path / "ocr-profile", stage_reporter=stages.append
    )
    with pytest.raises(engine_adapters.EngineRuntimeUnavailableError):
        adapter.prepare(_pipeline_for_session(Session()), expected_device_id=1)
    assert "ocr-dml-device-id-mismatch" in stages


@pytest.mark.parametrize(
    "provider_options",
    [{}, {"DmlExecutionProvider": {}}],
    ids=["empty-provider-options", "missing-device-id"],
)
def test_plan_evidence_allows_unobservable_dml_device_id_readback(
    tmp_path, provider_options: dict[str, dict[str, object]]
) -> None:
    class Session:
        disabled = False

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, object]]:
            return provider_options

        def disable_fallback(self) -> None:
            self.disabled = True

    session = Session()
    adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")

    adapter.prepare(_pipeline_for_session(session), expected_device_id=1)

    assert session.disabled is True


def test_plan_evidence_keeps_configured_identity_separate_from_unobservable_readback(
    tmp_path,
) -> None:
    class Assignment:
        ep_name = "DmlExecutionProvider"

        def get_nodes(self) -> list[object]:
            return [object()]

    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text("[]", encoding="utf-8")

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, object]]:
            return {}

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[Assignment]:
            return [Assignment()]

        def end_profiling(self) -> str:
            return str(profile_path)

    adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    adapter.prepare(_pipeline_for_session(Session()), expected_device_id=1)
    evidence = adapter.finalize(_pipeline_for_session(Session()))

    assert evidence.dml_node_count == 1
    assert evidence.session_device_proofs[0].dml_device_id is None


def test_plan_evidence_requires_fallback_disable_and_keeps_same_session_proof(tmp_path) -> None:
    profile_path = tmp_path / "ocr-profile_1.json"
    profile_path.write_text("[]", encoding="utf-8")

    class Assignment:
        ep_name = "DmlExecutionProvider"

        def get_nodes(self) -> list[object]:
            return [object(), object()]

    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, object]]:
            return {"DmlExecutionProvider": {"device_id": "1"}}

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[Assignment]:
            return [Assignment()]

        def end_profiling(self) -> str:
            return str(profile_path)

    session = Session()
    adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    adapter.prepare(_pipeline_for_session(session), expected_device_id=1)
    evidence = adapter.finalize(_pipeline_for_session(session))
    assert evidence.dml_node_count == 2
    assert evidence.session_device_proofs == (
        engine_adapters.OcrSessionDeviceProof(
            session_index=0,
            providers=("DmlExecutionProvider", "CPUExecutionProvider"),
            dml_device_id=1,
            fallback_disabled=True,
            dml_node_count=2,
            evidence_source="ort-graph-assignment",
        ),
    )


def test_plan_evidence_rejects_fallback_disable_failure(tmp_path) -> None:
    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, object]]:
            return {"DmlExecutionProvider": {"device_id": 1}}

        def disable_fallback(self) -> None:
            raise RuntimeError("fallback control failed")

    adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "ocr-profile")
    with pytest.raises(
        engine_adapters.EngineRuntimeUnavailableError,
        match="could not disable ONNX Runtime fallback",
    ):
        adapter.prepare(_pipeline_for_session(Session()), expected_device_id=1)


def test_plan_evidence_rejects_missing_fallback_disable(tmp_path) -> None:
    class Session:
        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, object]]:
            return {"DmlExecutionProvider": {"device_id": 1}}

    adapter = engine_adapters._PaddleOcrExecutionEvidenceAdapter(tmp_path / "profile")
    with pytest.raises(engine_adapters.EngineRuntimeUnavailableError):
        adapter.prepare(_pipeline_for_session(Session()), expected_device_id=1)
