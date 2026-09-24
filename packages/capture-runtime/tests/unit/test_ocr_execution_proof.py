from __future__ import annotations

import asyncio
import hashlib
from dataclasses import replace
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest

import capture_runtime.ocr_execution_proof as ocr_execution_proof
import capture_runtime.workers.ocr_main as ocr_main
from capture_runtime.config import sanitized_child_environment
from capture_runtime.contracts import OcrProvenanceV3
from capture_runtime.engine_adapters import (
    OcrExecutionEvidence,
    OcrSessionDeviceProof,
    OcrTextResult,
)
from capture_runtime.ocr_execution_proof import (
    AcceptanceOcrExecutionEvidenceSink,
    InMemoryOcrExecutionEvidenceSink,
    NoopOcrExecutionEvidenceSink,
    OcrExecutionDeviceProofV1,
    OcrExecutionProofContextV1,
    OcrPipelineConstructionProofV1,
    acceptance_ocr_execution_evidence_sink_from_environment,
    acceptance_ocr_execution_runtime_sha256_from_environment,
)
from capture_runtime.ocr_preflight import (
    OcrAdapterClass,
    OcrComputePlan,
    OcrGpuAdapter,
    OcrGpuCapabilitySnapshot,
)
from capture_runtime.worker_client import InstalledEngine, OcrWorkerFailure, WorkerClient
from capture_runtime.worker_contracts import WorkerRequest, WorkerResponse

SHA = "a" * 64


class _Probe:
    def probe(self) -> OcrGpuCapabilitySnapshot:
        adapter = OcrGpuAdapter(
            index=1,
            adapter_class=OcrAdapterClass.DEDICATED,
            luid="00000000000000aa",
            high_performance_rank=0,
            vendor_id=0x10DE,
            pci_device_id=0x2204,
            subsystem_id=1,
            revision=1,
            description="RTX 4060",
            assessment="positive-usable",
        )
        return OcrGpuCapabilitySnapshot(
            adapters=(adapter,),
            high_performance_adapters=(adapter,),
            ordinary_adapters=(adapter,),
            dml_provider_available=True,
            ort_version="1.24.4",
        )


def _selection():
    selection = OcrComputePlan(
        contract_sha256=SHA,
        worker_sha256="b" * 64,
        capability_probe=_Probe(),
    ).select()
    assert selection is not None
    return selection


def _proof():
    selection = _selection()
    plan = selection.execution_plan
    assert plan.adapter_map_sha256 is not None
    session_proofs = (
        OcrSessionDeviceProof(
            session_index=0,
            providers=("DmlExecutionProvider", "CPUExecutionProvider"),
            dml_device_id=plan.dml_device_id,
            fallback_disabled=True,
            dml_node_count=3,
            cpu_node_count=2,
            evidence_source="ort-graph-assignment",
        ),
        OcrSessionDeviceProof(
            session_index=1,
            providers=("DmlExecutionProvider", "CPUExecutionProvider"),
            dml_device_id=plan.dml_device_id,
            fallback_disabled=True,
            dml_node_count=1,
            cpu_node_count=4,
            evidence_source="ort-profile",
        ),
    )
    evidence = OcrExecutionEvidence(
        dml_node_count=4,
        cpu_node_count=6,
        source="ort-graph-assignment",
        session_device_proofs=session_proofs,
    )
    construction = OcrPipelineConstructionProofV1(
        pre_adapter_luid="00000000000000aa",
        post_adapter_luid="00000000000000aa",
        pre_adapter_map_sha256=plan.adapter_map_sha256,
        post_adapter_map_sha256=plan.adapter_map_sha256,
        pre_factory_current=True,
        post_factory_current=True,
    )
    context = OcrExecutionProofContextV1(
        source_sha256="d" * 64,
        requested_page_scope=(1, 2),
        runtime_sha256="e" * 64,
        worker_sha256="b" * 64,
        model_sha256="f" * 64,
        profile_id="capture-workbench-ocr-test",
        profile_spec_sha256="1" * 64,
        contract_set_sha256=SHA,
    )
    proof = OcrExecutionDeviceProofV1.build(
        plan=plan,
        selection_proof=selection.selection_proof,
        construction=construction,
        evidence=evidence,
        context=context,
    )
    return proof


def test_execution_proof_round_trips_and_binds_every_session() -> None:
    proof = _proof()
    assert proof.dml_node_count == 4
    assert [item.cpu_node_count for item in proof.session_device_proofs] == [2, 4]
    assert proof.to_dict()["executionSha256"] == proof.execution_sha256
    restored = OcrExecutionDeviceProofV1.from_dict(proof.to_dict())
    assert restored == proof


def test_execution_proof_roundtrips_unobservable_session_device_readback() -> None:
    original = _proof()
    selection = _selection()
    plan = selection.execution_plan
    sessions = tuple(replace(item, dml_device_id=None) for item in original.session_device_proofs)
    evidence = OcrExecutionEvidence(
        dml_node_count=original.dml_node_count,
        cpu_node_count=sum(item.cpu_node_count for item in sessions),
        source="ort-profile",
        session_device_proofs=sessions,
    )
    context = OcrExecutionProofContextV1(
        source_sha256=original.source_sha256,
        requested_page_scope=original.requested_page_scope,
        runtime_sha256=original.runtime_sha256,
        worker_sha256=original.worker_sha256,
        model_sha256=original.model_sha256,
        profile_id=original.profile_id,
        profile_spec_sha256=original.profile_spec_sha256,
        contract_set_sha256=original.contract_set_sha256,
    )

    proof = OcrExecutionDeviceProofV1.build(
        plan=plan,
        selection_proof=original.selection_proof,
        construction=original.construction,
        evidence=evidence,
        context=context,
    )
    restored = OcrExecutionDeviceProofV1.from_dict(proof.to_dict())

    assert [item.dml_device_id for item in restored.session_device_proofs] == [None, None]


def test_execution_proof_parser_rejects_malformed_private_session() -> None:
    value = _proof().to_dict()
    value["sessionDeviceProofs"] = [{}]

    with pytest.raises(ValueError, match="execution proof"):
        OcrExecutionDeviceProofV1.from_dict(value)


def test_failed_worker_capture_does_not_record_a_success_proof(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    model_path = tmp_path / "model"
    model_path.mkdir()
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"proof-test-source")
    proof = _proof()
    instances: list[object] = []

    class FailingAdapter:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            self.calls = 0
            self.record_calls = 0
            instances.append(self)

        def extract_png(self, _image: bytes) -> OcrTextResult:
            self.calls += 1
            if self.calls == 2:
                raise RuntimeError("synthetic page failure")
            return OcrTextResult(
                text="page one",
                model="test-model",
                digest="1" * 64,
                device="windowsml-dml",
                raster_width=1,
                raster_height=1,
                provenance=OcrProvenanceV3(
                    status="resolved",
                    engine="windowsml-ocr",
                    model="test-model",
                    model_digest="sha256:" + "1" * 64,
                    device="windowsml-dml",
                    profile_id="capture-workbench-ocr-pipeline-v1",
                    profile_spec_sha256="c" * 64,
                ),
            )

        def execution_proof(self) -> OcrExecutionDeviceProofV1:
            return proof

        def record_execution_proof(self) -> None:
            self.record_calls += 1

    monkeypatch.setattr(ocr_main, "WindowsMLOcrAdapter", FailingAdapter)
    monkeypatch.setattr(
        ocr_main,
        "_pdf_page_images",
        lambda *_args: iter([(1, b"page-one"), (2, b"page-two")]),
    )
    request = WorkerRequest(
        request_id="proof-failure-test",
        operation="run",
        payload={
            "requirementId": "windowsml-ocr",
            "artifactVersion": "0.4.2",
            "modelPath": str(model_path),
            "sourcePath": str(source_path),
            "mediaType": "application/pdf",
            "options": {
                "computePlan": _selection().execution_plan.to_dict(),
                "maxPages": 2,
                "renderScale": 1,
                "pageManifest": [
                    {
                        "page": 1,
                        "raster": {
                            "width": 1,
                            "height": 1,
                            "scale": 1,
                            "coordinateSystem": "pixel",
                        },
                    },
                    {
                        "page": 2,
                        "raster": {
                            "width": 1,
                            "height": 1,
                            "scale": 1,
                            "coordinateSystem": "pixel",
                        },
                    },
                ],
            },
        },
    )

    with pytest.raises(RuntimeError, match="synthetic page failure"):
        ocr_main._run(request, Event())

    assert len(instances) == 1
    adapter = instances[0]
    assert isinstance(adapter, FailingAdapter)
    assert adapter.record_calls == 0
    assert not (tmp_path / "ocr-device-proof-v1.json").exists()


def test_worker_proof_validation_failure_does_not_leave_acceptance_artifact(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "acceptance-run"
    root.mkdir()
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN", "1")
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT", str(root))
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_RUNTIME_SHA256", "e" * 64)

    model_path = tmp_path / "model"
    model_path.mkdir()
    source_path = tmp_path / "source.pdf"
    source_path.write_bytes(b"proof-validation-source")
    proof = _proof()
    instances: list[object] = []

    class SuccessfulAdapter:
        def __init__(self, *_args: object, **_kwargs: object) -> None:
            self.record_calls = 0
            self._sink = _kwargs.get("evidence_sink")
            instances.append(self)

        def extract_png(self, _image: bytes) -> OcrTextResult:
            return OcrTextResult(
                text="page",
                model="test-model",
                digest="1" * 64,
                device="windowsml-dml",
                raster_width=1,
                raster_height=1,
                provenance=OcrProvenanceV3(
                    status="resolved",
                    engine="windowsml-ocr",
                    model="test-model",
                    model_digest="sha256:" + "1" * 64,
                    device="windowsml-dml",
                    profile_id="capture-workbench-ocr-pipeline-v1",
                    profile_spec_sha256="c" * 64,
                ),
            )

        def execution_proof(self) -> OcrExecutionDeviceProofV1:
            return proof

        def record_execution_proof(self) -> None:
            self.record_calls += 1
            if isinstance(self._sink, AcceptanceOcrExecutionEvidenceSink):
                self._sink.record("private-capture", "pdf", proof)

    monkeypatch.setattr(ocr_main, "WindowsMLOcrAdapter", SuccessfulAdapter)
    monkeypatch.setattr(
        ocr_main,
        "_pdf_page_images",
        lambda *_args: iter([(1, b"page-one"), (2, b"page-two")]),
    )

    class WorkerBackedByPrivateEntrypoint:
        async def request(
            self,
            _executable: Path,
            _operation: str,
            payload: dict[str, object],
            *,
            cancel_event: asyncio.Event | None = None,
            progress_handler=None,
            timeout_seconds: float,
        ) -> WorkerResponse:
            del cancel_event, progress_handler, timeout_seconds
            worker_payload = ocr_main._run(
                WorkerRequest(
                    request_id="worker-proof-validation",
                    operation="run",
                    payload=payload,
                ),
                Event(),
            )
            return WorkerResponse(
                request_id="worker-proof-validation",
                ok=True,
                result=worker_payload,
                error=None,
            )

    client = WorkerClient(process=WorkerBackedByPrivateEntrypoint())  # type: ignore[arg-type]

    async def run() -> None:
        with pytest.raises(OcrWorkerFailure) as raised:
            await client.run(
                InstalledEngine(
                    requirement_id="windowsml-ocr",
                    artifact_version="0.4.2",
                    executable=tmp_path / "ocr.exe",
                    model_dir=model_path,
                ),
                source_path=source_path,
                media_type="application/pdf",
                options={
                    "computePlan": _selection().execution_plan.to_dict(),
                    "maxPages": 2,
                    "renderScale": 1,
                    "pageManifest": [
                        {
                            "page": page,
                            "raster": {
                                "width": 1,
                                "height": 1,
                                "scale": 1,
                                "coordinateSystem": "pixel",
                            },
                        }
                        for page in (1, 2)
                    ],
                },
                cancel_event=asyncio.Event(),
            )
        assert raised.value.kind == "protocol"

    asyncio.run(run())
    assert len(instances) == 1
    assert isinstance(instances[0], SuccessfulAdapter)
    assert instances[0].record_calls == 0
    assert not (root / "ocr-device-proof-v1.json").exists()


def test_acceptance_opt_in_does_not_construct_a_worker_sink(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "acceptance-run"
    root.mkdir()
    executable = tmp_path / "loaded-runtime.exe"
    executable.write_bytes(b"loaded-runtime")
    runtime_sha256 = hashlib.sha256(executable.read_bytes()).hexdigest()
    monkeypatch.setattr(ocr_execution_proof.sys, "executable", str(executable))
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN", "1")
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT", str(root))
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_RUNTIME_SHA256", runtime_sha256)

    sink = acceptance_ocr_execution_evidence_sink_from_environment()
    assert isinstance(sink, AcceptanceOcrExecutionEvidenceSink)
    assert acceptance_ocr_execution_runtime_sha256_from_environment() == runtime_sha256
    assert runtime_sha256 == hashlib.sha256(executable.read_bytes()).hexdigest()
    assert list(root.iterdir()) == []


def test_acceptance_runtime_identity_is_hashed_from_loaded_executable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    executable = tmp_path / "loaded-runtime.exe"
    executable.write_bytes(b"loaded-runtime")
    actual = hashlib.sha256(executable.read_bytes()).hexdigest()
    monkeypatch.setattr(ocr_execution_proof.sys, "executable", str(executable))
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN", "1")
    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_RUNTIME_SHA256", actual)

    assert acceptance_ocr_execution_runtime_sha256_from_environment() == actual

    monkeypatch.setenv("CAPTURE_OCR_EXECUTION_RUNTIME_SHA256", "0" * 64)
    with pytest.raises(ValueError, match="does not match the loaded runtime"):
        acceptance_ocr_execution_runtime_sha256_from_environment()


def test_ordinary_worker_construction_has_no_acceptance_sink(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN",
        "CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT",
        "CAPTURE_OCR_EXECUTION_RUNTIME_SHA256",
    ):
        monkeypatch.delenv(name, raising=False)

    assert not hasattr(ocr_main, "_acceptance_execution_evidence")


def test_worker_environment_does_not_forward_acceptance_evidence_names() -> None:
    environment = sanitized_child_environment(
        {
            "CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN": "1",
            "CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT": "C:/run",
            "CAPTURE_OCR_EXECUTION_RUNTIME_SHA256": "a" * 64,
            "CAPTURE_API_TOKEN": "must-not-forward",
        }
    )

    assert "CAPTURE_OCR_EXECUTION_EVIDENCE_OPT_IN" not in environment
    assert "CAPTURE_OCR_EXECUTION_EVIDENCE_ROOT" not in environment
    assert "CAPTURE_OCR_EXECUTION_RUNTIME_SHA256" not in environment
    assert "CAPTURE_API_TOKEN" not in environment


def test_execution_evidence_keeps_same_session_graph_counts(tmp_path: Path) -> None:
    class Assignment:
        def __init__(self, provider: str, count: int) -> None:
            self.ep_name = provider
            self._count = count

        def get_nodes(self) -> list[object]:
            return [object() for _ in range(self._count)]

    class Session:
        def __init__(self, index: int) -> None:
            self.index = index

        def get_providers(self) -> list[str]:
            return ["DmlExecutionProvider", "CPUExecutionProvider"]

        def get_provider_options(self) -> dict[str, dict[str, int]]:
            return {"DmlExecutionProvider": {"device_id": 1}}

        def disable_fallback(self) -> None:
            return None

        def get_provider_graph_assignment_info(self) -> list[Assignment]:
            return [
                Assignment("DmlExecutionProvider", self.index + 1),
                Assignment("CPUExecutionProvider", 2),
            ]

        def end_profiling(self) -> str:
            path = tmp_path / f"profile_{self.index}.json"
            path.write_text("[]", encoding="utf-8")
            return str(path)

    from capture_runtime.engine_adapters import _PaddleOcrExecutionEvidenceAdapter

    sessions = (Session(0), Session(1))
    pipeline = SimpleNamespace(
        paddlex_pipeline=SimpleNamespace(
            text_det_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[0])),
            text_rec_model=SimpleNamespace(runner=SimpleNamespace(session=sessions[1])),
        )
    )
    adapter = _PaddleOcrExecutionEvidenceAdapter(tmp_path / "profile")
    adapter.prepare(pipeline, expected_device_id=1)
    evidence = adapter.finalize(pipeline)
    assert [
        (item.dml_node_count, item.cpu_node_count) for item in evidence.session_device_proofs
    ] == [
        (1, 2),
        (2, 2),
    ]


@pytest.mark.parametrize(
    "field, replacement",
    [
        ("source_sha256", "0" * 64),
        ("runtime_sha256", "0" * 64),
        ("model_sha256", "0" * 64),
        ("execution_sha256", "0" * 64),
    ],
)
def test_execution_proof_rejects_changed_digest_bound_fields(field: str, replacement: str) -> None:
    proof = _proof()
    changed = replace(proof, **{field: replacement})
    with pytest.raises(ValueError):
        changed.validate_digest()


def test_execution_proof_rejects_swapped_source_scope_or_identity_context() -> None:
    proof = _proof()
    context = OcrExecutionProofContextV1(
        source_sha256="0" * 64,
        requested_page_scope=(1,),
        runtime_sha256=proof.runtime_sha256,
        worker_sha256=proof.worker_sha256,
        model_sha256=proof.model_sha256,
        profile_id=proof.profile_id,
        profile_spec_sha256=proof.profile_spec_sha256,
        contract_set_sha256=proof.contract_set_sha256,
    )
    with pytest.raises(ValueError, match="context"):
        proof.validate_context(context)


def test_execution_proof_rejects_zero_or_cross_session_evidence() -> None:
    proof = _proof()
    sessions = list(proof.session_device_proofs)
    sessions[1] = OcrSessionDeviceProof(
        session_index=1,
        providers=sessions[0].providers,
        dml_device_id=0,
        fallback_disabled=True,
        dml_node_count=1,
        cpu_node_count=4,
        evidence_source="ort-profile",
    )
    with pytest.raises(ValueError):
        replace(proof, session_device_proofs=tuple(sessions)).validate_digest()


def test_execution_proof_rejects_zero_or_missing_dml_evidence() -> None:
    selection = _selection()
    plan = selection.execution_plan
    assert plan.adapter_map_sha256 is not None
    construction = OcrPipelineConstructionProofV1(
        pre_adapter_luid=plan.identity.luid,
        post_adapter_luid=plan.identity.luid,
        pre_adapter_map_sha256=plan.adapter_map_sha256,
        post_adapter_map_sha256=plan.adapter_map_sha256,
        pre_factory_current=True,
        post_factory_current=True,
    )
    context = OcrExecutionProofContextV1(
        source_sha256="d" * 64,
        requested_page_scope=(1,),
        runtime_sha256="e" * 64,
        worker_sha256="b" * 64,
        model_sha256="f" * 64,
        profile_id="profile",
        profile_spec_sha256="1" * 64,
        contract_set_sha256=SHA,
    )
    with pytest.raises(ValueError, match="DML"):
        OcrExecutionDeviceProofV1.build(
            plan=plan,
            selection_proof=selection.selection_proof,
            construction=construction,
            evidence=OcrExecutionEvidence(dml_node_count=0, cpu_node_count=0),
            context=context,
        )
    with pytest.raises(ValueError, match="session"):
        OcrExecutionDeviceProofV1.build(
            plan=plan,
            selection_proof=selection.selection_proof,
            construction=construction,
            evidence=OcrExecutionEvidence(dml_node_count=1, cpu_node_count=0),
            context=context,
        )


def test_ordinary_and_memory_sinks_do_not_serialize_capture_id() -> None:
    proof = _proof()
    sink = InMemoryOcrExecutionEvidenceSink()
    assert sink.record("secret-capture-id", "image", proof) is None
    assert sink.proofs[0][2] == proof
    assert "captureId" not in str(proof.to_dict())
    assert NoopOcrExecutionEvidenceSink().record("id", "image", proof) is None


def test_acceptance_sink_is_atomic_private_and_rejects_collisions(tmp_path: Path) -> None:
    run_root = tmp_path / "run-1"
    run_root.mkdir()
    sink = AcceptanceOcrExecutionEvidenceSink(run_root, preauthorized_root=run_root)
    artifact = sink.record("private-capture", "pdf", _proof())
    path = run_root / artifact.relative_name
    assert path.is_file()
    content = path.read_bytes()
    assert artifact.bytes == len(content)
    assert artifact.sha256 == hashlib.sha256(content).hexdigest()
    assert b"private-capture" not in content
    assert b"captureId" not in content
    assert not tuple(run_root.glob(".ocr-device-proof-*.tmp"))
    with pytest.raises(ValueError, match="already recorded"):
        sink.record("private-capture-2", "pdf", _proof())


def test_acceptance_sink_rejects_unapproved_stale_and_colliding_roots(tmp_path: Path) -> None:
    approved = tmp_path / "approved"
    approved.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    with pytest.raises(ValueError):
        AcceptanceOcrExecutionEvidenceSink(outside, preauthorized_root=approved)
    with pytest.raises(ValueError):
        AcceptanceOcrExecutionEvidenceSink(tmp_path / "missing", preauthorized_root=approved)
    target = approved / "ocr-device-proof-v1.json"
    target.write_text("collision", encoding="utf-8")
    sink = AcceptanceOcrExecutionEvidenceSink(approved, preauthorized_root=approved)
    with pytest.raises(ValueError, match="collision"):
        sink.record("capture", "image", _proof())


def test_execution_proof_rejects_path_bearing_identity_labels() -> None:
    proof = _proof()
    identity = proof.selection_proof.identity
    assert identity is not None
    changed_identity = replace(identity, description="C:\\Users\\machine")
    changed_selection = replace(proof.selection_proof, identity=changed_identity)
    with pytest.raises(ValueError, match="path"):
        OcrExecutionDeviceProofV1(
            selection_proof=changed_selection,
            construction=proof.construction,
            session_device_proofs=proof.session_device_proofs,
            source_sha256=proof.source_sha256,
            requested_page_scope=proof.requested_page_scope,
            runtime_sha256=proof.runtime_sha256,
            worker_sha256=proof.worker_sha256,
            model_sha256=proof.model_sha256,
            profile_id=proof.profile_id,
            profile_spec_sha256=proof.profile_spec_sha256,
            contract_set_sha256=proof.contract_set_sha256,
            dml_node_count=proof.dml_node_count,
            execution_sha256=proof.execution_sha256,
        )
