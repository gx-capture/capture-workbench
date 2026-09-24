from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

from capture_runtime.worker_stage_policy import sanitize_worker_stage

RUNTIME_ROOT = Path(__file__).parents[2]
POLICY_PATH = RUNTIME_ROOT / "src" / "capture_runtime" / "assets" / "worker-stage-policy.json"
CORPUS_PATH = (
    RUNTIME_ROOT / "src" / "capture_runtime" / "assets" / "worker-stage-policy-corpus.json"
)
GENERATOR = RUNTIME_ROOT / "scripts" / "generate_worker_stage_policy.py"


def test_generated_stage_policy_is_current_and_matches_python_corpus() -> None:
    subprocess.run([sys.executable, str(GENERATOR), "--check"], cwd=RUNTIME_ROOT, check=True)
    policy = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    assert policy["schemaVersion"] == "1"
    corpus = json.loads(CORPUS_PATH.read_text(encoding="utf-8"))
    for case in corpus:
        assert sanitize_worker_stage(case["input"]) == case["expected"]
