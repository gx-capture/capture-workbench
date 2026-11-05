"""Unit tests for structuring domain models, policies, and use cases."""

from __future__ import annotations

from unittest.mock import AsyncMock, Mock

import pytest

from capture_runtime.contracts import (
    RuntimeModelInstallationV2,
    StructuringBatchStatus,
    StructuringSessionStatus,
)
from capture_runtime.structuring.application.use_cases import (
    CancelModelInstallation,
    GetModelInstallation,
    InstallModelOption,
)
from capture_runtime.structuring.domain.session import (
    BatchPlanningPolicy,
    StructuringBatch,
    StructuringSemanticBlock,
    StructuringSession,
)


def test_structuring_semantic_block_invariants() -> None:
    block = StructuringSemanticBlock(
        source_segment_id="seg-1",
        type="paragraph",
        target_text="Structured paragraph text.",
    )
    assert block.source_segment_id == "seg-1"
    assert block.type == "paragraph"
    assert block.target_text == "Structured paragraph text."
    assert block.dump() == {
        "sourceSegmentId": "seg-1",
        "type": "paragraph",
        "targetText": "Structured paragraph text.",
    }

    # Empty source_segment_id raises ValueError
    with pytest.raises(ValueError, match="source_segment_id cannot be empty"):
        StructuringSemanticBlock(source_segment_id="", type="paragraph")

    # Invalid type raises ValueError
    with pytest.raises(ValueError, match="type must be one of"):
        StructuringSemanticBlock(source_segment_id="seg-1", type="invalid-type")


def test_structuring_batch_invariants() -> None:
    batch = StructuringBatch(
        session_id="sess-1",
        capture_id="cap-1",
        batch_index=0,
        batch_count=2,
        source_segment_ids=("seg-1", "seg-2"),
        provider_prompt="Extract structure",
        batch_digest="sha256:abc",
        status=StructuringBatchStatus.READY,
    )
    assert batch.batch_index == 0
    assert batch.batch_count == 2

    # batch_count < 1
    with pytest.raises(ValueError, match="batch_count must be >= 1"):
        StructuringBatch(
            session_id="sess-1",
            capture_id="cap-1",
            batch_index=0,
            batch_count=0,
            source_segment_ids=("seg-1",),
            provider_prompt="p",
        )

    # batch_index out of range
    with pytest.raises(ValueError, match="batch_index 2 out of range"):
        StructuringBatch(
            session_id="sess-1",
            capture_id="cap-1",
            batch_index=2,
            batch_count=2,
            source_segment_ids=("seg-1",),
            provider_prompt="p",
        )

    # empty source_segment_ids
    with pytest.raises(ValueError, match="source_segment_ids cannot be empty"):
        StructuringBatch(
            session_id="sess-1",
            capture_id="cap-1",
            batch_index=0,
            batch_count=1,
            source_segment_ids=(),
            provider_prompt="p",
        )


def test_structuring_session_invariants() -> None:
    session = StructuringSession(
        session_id="sess-1",
        capture_id="cap-1",
        raw_source_sha256="raw_sha",
        contract_set_sha256="contract_sha",
        schema_dialect="v2",
        batch_count=2,
        next_batch_index=0,
        status=StructuringSessionStatus.OPEN,
    )
    assert session.session_id == "sess-1"
    assert session.batch_count == 2
    assert session.status == StructuringSessionStatus.OPEN

    # batch_count < 1
    with pytest.raises(ValueError, match="batch_count must be >= 1"):
        StructuringSession(
            session_id="sess-1",
            capture_id="cap-1",
            raw_source_sha256="raw_sha",
            contract_set_sha256="contract_sha",
            schema_dialect="v2",
            batch_count=0,
        )

    # next_batch_index out of range
    with pytest.raises(ValueError, match="next_batch_index 3 out of range"):
        StructuringSession(
            session_id="sess-1",
            capture_id="cap-1",
            raw_source_sha256="raw_sha",
            contract_set_sha256="contract_sha",
            schema_dialect="v2",
            batch_count=2,
            next_batch_index=3,
        )

    # empty session_id
    with pytest.raises(ValueError, match="session_id cannot be empty"):
        StructuringSession(
            session_id="",
            capture_id="cap-1",
            raw_source_sha256="raw_sha",
            contract_set_sha256="contract_sha",
            schema_dialect="v2",
            batch_count=1,
        )

    # empty capture_id
    with pytest.raises(ValueError, match="capture_id cannot be empty"):
        StructuringSession(
            session_id="sess-1",
            capture_id="",
            raw_source_sha256="raw_sha",
            contract_set_sha256="contract_sha",
            schema_dialect="v2",
            batch_count=1,
        )


def test_batch_planning_policy() -> None:
    policy = BatchPlanningPolicy(max_context_tokens=4096, target_language="en")
    assert policy.max_context_tokens == 4096
    assert policy.target_language == "en"

    with pytest.raises(ValueError, match="max_context_tokens must be >= 1"):
        BatchPlanningPolicy(max_context_tokens=0)


@pytest.mark.anyio
async def test_model_installation_use_cases() -> None:
    mock_installation_service = Mock()

    # 4. InstallModelOption
    mock_job = Mock(spec=RuntimeModelInstallationV2)
    mock_installation_service.create.return_value = mock_job
    install_uc = InstallModelOption(mock_installation_service)
    assert (
        install_uc.execute(idempotency_key="k", request_fingerprint="fp", option_id="opt")
        is mock_job
    )
    mock_installation_service.create.assert_called_once_with(
        idempotency_key="k", request_fingerprint="fp", option_id="opt"
    )

    # 5. CancelModelInstallation
    mock_installation_service.cancel = AsyncMock(return_value=mock_job)
    cancel_uc = CancelModelInstallation(mock_installation_service)
    assert await cancel_uc.execute("job-1") is mock_job
    mock_installation_service.cancel.assert_awaited_once_with("job-1")

    # 6. GetModelInstallation
    mock_installation_service.get.return_value = mock_job
    get_job_uc = GetModelInstallation(mock_installation_service)
    assert get_job_uc.execute("job-1") is mock_job
    mock_installation_service.get.assert_called_once_with("job-1")


def test_session_aggregate_accepts_batches_only_in_order_and_stops_at_completion() -> None:
    from capture_runtime.structuring.domain.session.models import SessionTransitionError

    session = StructuringSession(
        session_id="s",
        capture_id="c",
        raw_source_sha256="a" * 64,
        contract_set_sha256="b" * 64,
        schema_dialect="v2",
        batch_count=2,
    )
    with pytest.raises(SessionTransitionError, match="in order"):
        session.accept_batch(1)
    accepted = session.accept_batch(0)
    assert accepted.next_batch_index == 1
    assert session.next_batch_index == 0
    with pytest.raises(SessionTransitionError, match="in order"):
        accepted.accept_batch(0)
    completed = accepted.accept_batch(1)
    assert completed.status is StructuringSessionStatus.COMPLETED
    with pytest.raises(SessionTransitionError, match="not open"):
        completed.accept_batch(2)
