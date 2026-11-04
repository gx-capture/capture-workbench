"""Unit tests for the provisioning domain model and invariants."""

from __future__ import annotations

from datetime import UTC, datetime

from capture_runtime.provisioning.domain.catalog import (
    EngineCatalog,
    EngineRequirementDescriptor,
)
from capture_runtime.provisioning.domain.installation import (
    InstallationJob,
    InstallationStatus,
)
from capture_runtime.provisioning.domain.requirement import RuntimeRequirement


def test_installation_job_initial_state() -> None:
    job = InstallationJob(
        installation_id="job-1",
        requirement_id="req-1",
    )
    assert job.status == InstallationStatus.QUEUED
    assert job.progress == 0.0
    assert not job.is_terminal
    assert job.completed_at is None


def test_installation_job_transitions_to_running() -> None:
    job = InstallationJob(installation_id="job-1", requirement_id="req-1")
    now = datetime.now(UTC)
    job.mark_running(now)
    assert job.status == InstallationStatus.RUNNING
    assert job.progress == 0.05
    assert job.updated_at == now
    assert not job.is_terminal


def test_installation_job_progress_and_download_clamping() -> None:
    job = InstallationJob(installation_id="job-1", requirement_id="req-1")
    now = datetime.now(UTC)
    job.mark_running(now)

    job.update_progress(0.42, now)
    assert job.progress == 0.42

    # Clamping
    job.update_progress(1.5, now)
    assert job.progress == 1.0
    job.update_progress(-0.5, now)
    assert job.progress == 0.0

    # Download bytes clamping
    job.update_download(downloaded=150, total=100, now=now)
    assert job.download_bytes == 100
    assert job.downloaded_bytes == 100

    job.update_download(downloaded=-10, total=100, now=now)
    assert job.downloaded_bytes == 0


def test_installation_job_completion_locks_state() -> None:
    job = InstallationJob(installation_id="job-1", requirement_id="req-1")
    now = datetime.now(UTC)
    job.mark_running(now)
    job.mark_completed(now)

    assert job.status == InstallationStatus.COMPLETED
    assert job.progress == 1.0
    assert job.is_terminal
    assert job.completed_at == now

    # Invariant: terminal jobs reject further progress/transitions
    later = datetime.now(UTC)
    job.update_progress(0.5, later)
    assert job.progress == 1.0
    job.mark_cancelled(later)
    assert job.status == InstallationStatus.COMPLETED


def test_installation_job_failure_and_cancellation() -> None:
    job_failed = InstallationJob(installation_id="job-fail", requirement_id="req-1")
    now = datetime.now(UTC)
    job_failed.mark_failed("probe_failed", "Probe crashed", retryable=True, now=now)
    assert job_failed.status == InstallationStatus.FAILED
    assert job_failed.failure_code == "probe_failed"
    assert job_failed.failure_message == "Probe crashed"
    assert job_failed.retryable is True
    assert job_failed.is_terminal

    job_cancel = InstallationJob(installation_id="job-cancel", requirement_id="req-1")
    job_cancel.mark_cancelled(now)
    assert job_cancel.status == InstallationStatus.CANCELLED
    assert job_cancel.is_terminal


def test_catalog_and_requirement_domain_entities() -> None:
    req = RuntimeRequirement(
        requirement_id="ocr-req",
        display_name="OCR Engine",
        status="ready",
    )
    assert req.requirement_id == "ocr-req"

    desc = EngineRequirementDescriptor(
        requirement_id="ocr-req",
        display_name="OCR Engine",
        artifacts=("worker.zip",),
    )
    catalog = EngineCatalog(requirements={"ocr-req": desc})
    assert catalog.get("ocr-req") == desc
    assert catalog.get("unknown") is None
