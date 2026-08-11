from __future__ import annotations

import json
from copy import deepcopy
from pathlib import Path
from typing import Any


def approved_source_lock() -> tuple[dict[str, Any], dict[tuple[str, str], bytes]]:
    """Return a test-approved copy of the checked-in v2 model source lock."""

    lock_path = (
        Path(__file__).resolve().parents[1] / "model-sources" / "release-model-source-lock.json"
    )
    payload: dict[str, Any] = json.loads(lock_path.read_text(encoding="utf-8"))
    payload = deepcopy(payload)
    payload["approval"] = {
        "approvedAt": "2026-07-30T00:00:00Z",
        "approvedBy": "release-owner",
        "blockers": [],
        "status": "approved",
    }
    whisper_fixture = payload["fixtures"][1]
    whisper_fixture["expectedDevice"] = "cuda"
    whisper_fixture["expectedModel"] = "large-v3-turbo"
    whisper_fixture["preferGpu"] = True
    whisper_fixture["expectedNormalizedOutputSha256"] = "a" * 64
    return payload, {}


def pending_source_lock() -> dict[str, Any]:
    """Return the one exact pending state permitted for private preflight."""

    payload, _content = approved_source_lock()
    payload["approval"] = {
        "approvedAt": None,
        "approvedBy": None,
        "blockers": [
            "Freeze private Whisper model/device pair and normalized output digest "
            "from two identical production runs."
        ],
        "status": "blocked",
    }
    whisper_fixture = payload["fixtures"][1]
    whisper_fixture["expectedDevice"] = None
    whisper_fixture["expectedModel"] = None
    whisper_fixture["expectedNormalizedOutputSha256"] = None
    return payload
