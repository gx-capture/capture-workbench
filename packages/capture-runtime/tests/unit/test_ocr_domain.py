"""Unit tests for Document OCR domain models, invariants, and application use cases."""

from __future__ import annotations

from unittest.mock import Mock

import pytest

from capture_runtime.ocr.application.use_cases import (
    ExtractPageText,
    OrderPageRegions,
    SelectComputePlan,
    VerifyExecutionEvidence,
)
from capture_runtime.ocr.domain import (
    BoundingBox,
    ComputePlanPolicy,
    ComputePlanSelection,
    DirectMlExecutionEvidence,
    OcrPage,
    PageReadingOrder,
    PageRegion,
    SessionDeviceProof,
)
from capture_runtime.ocr.domain.compute_plan import ComputeCandidate
from capture_runtime.ocr.infrastructure.ocr_page_result import (
    OcrRegion,
    OcrTextResult,
)


def test_compute_plan_invariants_and_policy() -> None:
    plan = ComputePlanSelection(
        compute_mode="gpu-dml",
        adapter_class="dedicated",
        device_name="RTX 4090",
        device_id=0,
    )
    assert plan.compute_mode == "gpu-dml"
    assert plan.adapter_class == "dedicated"

    with pytest.raises(ValueError, match="invalid compute mode"):
        ComputePlanSelection(compute_mode="invalid", adapter_class="dedicated")

    with pytest.raises(ValueError, match="invalid adapter class"):
        ComputePlanSelection(compute_mode="gpu-dml", adapter_class="invalid")

    with pytest.raises(ValueError, match="device id must be non-negative"):
        ComputePlanSelection(
            compute_mode="gpu-dml",
            adapter_class="dedicated",
            device_id=-1,
        )

    with pytest.raises(ValueError, match="cpu fallback requires an explanatory reason"):
        ComputePlanSelection(
            compute_mode="cpu-fallback",
            adapter_class="dedicated",
            reason=None,
        )

    policy = ComputePlanPolicy()
    gpu = ComputeCandidate(0, "dedicated", "positive-usable", True)
    gpu_plan = policy.evaluate((gpu,), dml_available=True, require_identity=True)
    assert gpu_plan.compute_mode == "gpu-dml"
    assert gpu_plan.device_id == 0
    assert policy.evaluate((), dml_available=False).reason == "no_compatible_gpu"
    unavailable = ComputeCandidate(0, "dedicated", "positive-unavailable", True)
    assert policy.evaluate((unavailable,), dml_available=False).reason == "dml_provider_unavailable"
    unknown = ComputeCandidate(1, "unknown", "indeterminate", False)
    assert policy.evaluate((unknown, gpu), dml_available=True) is None
    assert (
        policy.evaluate(
            (ComputeCandidate(0, "dedicated", "positive-usable", False),),
            dml_available=True,
            require_identity=True,
        )
        is None
    )


def test_bounding_box_invariants() -> None:
    box = BoundingBox(left=10, top=20, width=100, height=50)
    assert box.right == 110
    assert box.bottom == 70

    with pytest.raises(ValueError, match="bounding box coordinates must be non-negative"):
        BoundingBox(left=-1, top=0, width=10, height=10)

    with pytest.raises(ValueError, match="bounding box coordinates must be non-negative"):
        BoundingBox(left=0, top=-1, width=10, height=10)

    with pytest.raises(ValueError, match="bounding box dimensions must be positive"):
        BoundingBox(left=0, top=0, width=0, height=10)

    with pytest.raises(ValueError, match="bounding box dimensions must be positive"):
        BoundingBox(left=0, top=0, width=10, height=0)


def test_page_region_invariants_and_box() -> None:
    region = PageRegion(
        text="Hello",
        confidence=0.95,
        polygon=((10.2, 20.1), (50.8, 20.1), (50.8, 40.5), (10.2, 40.5)),
    )
    assert region.confidence == 0.95
    assert region.box == (10, 20, 41, 21)

    empty_poly = PageRegion(text="Empty", confidence=0.5, polygon=())
    assert empty_poly.box is None

    with pytest.raises(ValueError, match="confidence must be between 0.0 and 1.0"):
        PageRegion(text="Invalid", confidence=1.5)

    with pytest.raises(ValueError, match="confidence must be between 0.0 and 1.0"):
        PageRegion(text="Invalid", confidence=-0.1)


def test_page_reading_order() -> None:
    left = PageRegion(
        text="\u5de6", polygon=((10.0, 0.0), (20.0, 0.0), (20.0, 150.0), (10.0, 150.0))
    )
    right = PageRegion(
        text="\u53f3", polygon=((50.0, 0.0), (60.0, 0.0), (60.0, 150.0), (50.0, 150.0))
    )
    plan = PageReadingOrder().plan((left, right))
    assert plan.order == (1, 0)
    assert plan.applied
    assert OrderPageRegions().execute((left, right)) == plan
    assert PageReadingOrder().plan(()).order == ()


def test_ocr_page_invariants() -> None:
    region = PageRegion(text="text", polygon=((0.0, 0.0), (10.0, 10.0)))
    page = OcrPage(
        page_number=1,
        regions=(region,),
        text="text",
        confidence=0.9,
        raster_width=800,
        raster_height=600,
        raster_scale=1.5,
    )
    assert page.page_number == 1
    assert page.raster_scale == 1.5

    with pytest.raises(ValueError, match="page number must be >= 1"):
        OcrPage(page_number=0, regions=(), text="")

    with pytest.raises(ValueError, match="raster scale must be positive"):
        OcrPage(page_number=1, regions=(), text="", raster_scale=0)

    with pytest.raises(ValueError, match="raster width must be positive"):
        OcrPage(page_number=1, regions=(), text="", raster_width=0)

    with pytest.raises(ValueError, match="raster height must be positive"):
        OcrPage(page_number=1, regions=(), text="", raster_height=0)

    with pytest.raises(ValueError, match="confidence must be between 0.0 and 1.0"):
        OcrPage(page_number=1, regions=(), text="", confidence=1.2)


def test_execution_evidence_invariants() -> None:
    proof0 = SessionDeviceProof(
        session_index=0,
        dml_node_count=10,
        cpu_node_count=0,
        dml_device_id=0,
        fallback_disabled=True,
    )
    proof1 = SessionDeviceProof(
        session_index=1,
        dml_node_count=5,
        cpu_node_count=0,
        dml_device_id=0,
        fallback_disabled=True,
    )
    evidence = DirectMlExecutionEvidence(
        dml_node_count=15,
        cpu_node_count=0,
        source="ort-profile",
        session_device_proofs=(proof0, proof1),
    )
    assert VerifyExecutionEvidence().execute(evidence)

    with pytest.raises(ValueError, match="session index must be a non-negative integer"):
        SessionDeviceProof(session_index=-1, dml_node_count=5)

    with pytest.raises(ValueError, match="session DML node count must be positive"):
        SessionDeviceProof(session_index=0, dml_node_count=0)

    with pytest.raises(ValueError, match="session CPU node count must be non-negative"):
        SessionDeviceProof(session_index=0, dml_node_count=1, cpu_node_count=-1)

    with pytest.raises(ValueError, match="session fallback must be disabled"):
        SessionDeviceProof(session_index=0, dml_node_count=1, fallback_disabled=False)

    with pytest.raises(ValueError, match="must be a non-negative integer"):
        DirectMlExecutionEvidence(dml_node_count=-1)

    with pytest.raises(ValueError, match="execution evidence source must be non-empty"):
        DirectMlExecutionEvidence(dml_node_count=1, source="  ")

    with pytest.raises(ValueError, match="execution evidence session order is invalid"):
        DirectMlExecutionEvidence(
            dml_node_count=15,
            session_device_proofs=(proof1, proof0),
        )

    with pytest.raises(ValueError, match="execution evidence DML count does not match sessions"):
        DirectMlExecutionEvidence(
            dml_node_count=20,
            session_device_proofs=(proof0, proof1),
        )


def test_use_cases() -> None:
    # 1. SelectComputePlan
    uc_plan = SelectComputePlan()
    plan = uc_plan.execute(
        (ComputeCandidate(0, "dedicated", "positive-usable", True),), dml_available=True
    )
    assert plan.compute_mode == "gpu-dml"

    # 2. ExtractPageText
    mock_adapter = Mock()
    mock_adapter.extract_png.return_value = OcrTextResult(
        text="Extracted text",
        device="cuda",
        model="windowsml",
        digest="sha256-digest",
        regions=(
            OcrRegion(
                text="Extracted text",
                confidence=0.9,
                polygon=((0.0, 0.0), (100.0, 0.0), (100.0, 30.0), (0.0, 30.0)),
            ),
        ),
        raster_width=1000,
        raster_height=800,
        raster_scale=1.0,
    )
    uc_extract = ExtractPageText(mock_adapter)
    extracted = uc_extract.execute(b"fake_png", page_number=2)
    page = extracted.domain_page
    assert extracted.result is mock_adapter.extract_png.return_value
    assert page.page_number == 2
    assert page.text == "Extracted text"
    assert len(page.regions) == 1

    # 4. VerifyExecutionEvidence
    uc_evidence = VerifyExecutionEvidence()
    proof = SessionDeviceProof(session_index=0, dml_node_count=8)
    ev = DirectMlExecutionEvidence(dml_node_count=8, session_device_proofs=(proof,))
    assert uc_evidence.execute(ev) is True


def test_execution_evidence_retains_cpu_bookkeeping_but_requires_real_dml_work() -> None:
    verify = VerifyExecutionEvidence()
    assert verify.execute(DirectMlExecutionEvidence(dml_node_count=4, cpu_node_count=2))
    assert not verify.execute(DirectMlExecutionEvidence(dml_node_count=0, cpu_node_count=8))
