from __future__ import annotations

import pytest

from capture_runtime.capture.domain.size_policy import (
    DOCUMENT_MAX_UPLOAD_BYTES,
    SourceSizePolicy,
)
from capture_runtime.contracts import CaptureSourceKind

FIFTY_MIB = 50 * 1024 * 1024
TWENTY_MIB = 20 * 1024 * 1024
ONE_HUNDRED_MIB = 100 * 1024 * 1024


def test_document_max_upload_bytes_constant_matches_fifty_mib() -> None:
    assert DOCUMENT_MAX_UPLOAD_BYTES == 52_428_800


@pytest.mark.parametrize(
    ("max_upload_bytes", "kind", "expected_limit"),
    [
        # Below 50 MiB
        (TWENTY_MIB, CaptureSourceKind.AUDIO, TWENTY_MIB),
        (TWENTY_MIB, CaptureSourceKind.PDF, TWENTY_MIB),
        (TWENTY_MIB, CaptureSourceKind.IMAGE, TWENTY_MIB),
        # Exactly 50 MiB
        (FIFTY_MIB, CaptureSourceKind.AUDIO, FIFTY_MIB),
        (FIFTY_MIB, CaptureSourceKind.PDF, FIFTY_MIB),
        (FIFTY_MIB, CaptureSourceKind.IMAGE, FIFTY_MIB),
        # Above 50 MiB
        (ONE_HUNDRED_MIB, CaptureSourceKind.AUDIO, ONE_HUNDRED_MIB),
        (ONE_HUNDRED_MIB, CaptureSourceKind.PDF, FIFTY_MIB),
        (ONE_HUNDRED_MIB, CaptureSourceKind.IMAGE, FIFTY_MIB),
    ],
)
def test_source_size_policy_limits_and_boundaries_by_kind_and_configured_ceiling(
    max_upload_bytes: int,
    kind: CaptureSourceKind,
    expected_limit: int,
) -> None:
    policy = SourceSizePolicy(max_upload_bytes)
    assert policy.limit_for(kind) == expected_limit

    # Exactly at limit: allowed
    assert policy.is_allowed(kind, expected_limit) is True

    # At limit + 1: rejected
    assert policy.is_allowed(kind, expected_limit + 1) is False

    # Positive smaller size: allowed
    assert policy.is_allowed(kind, 1) is True

    # Zero or negative sizes: rejected
    assert policy.is_allowed(kind, 0) is False
    assert policy.is_allowed(kind, -1) is False


@pytest.mark.parametrize(
    ("kind", "declared_total_bytes", "expected"),
    [
        (CaptureSourceKind.AUDIO, FIFTY_MIB, False),
        (CaptureSourceKind.AUDIO, FIFTY_MIB + 1, True),
        (CaptureSourceKind.AUDIO, ONE_HUNDRED_MIB, True),
        (CaptureSourceKind.PDF, FIFTY_MIB + 1, False),
        (CaptureSourceKind.PDF, ONE_HUNDRED_MIB, False),
        (CaptureSourceKind.IMAGE, FIFTY_MIB + 1, False),
        (CaptureSourceKind.IMAGE, ONE_HUNDRED_MIB, False),
    ],
)
def test_source_size_policy_needs_recording_signature_only_for_audio_above_document_ceiling(
    kind: CaptureSourceKind,
    declared_total_bytes: int,
    expected: bool,
) -> None:
    policy = SourceSizePolicy(ONE_HUNDRED_MIB)
    assert policy.needs_recording_signature(kind, declared_total_bytes) is expected
