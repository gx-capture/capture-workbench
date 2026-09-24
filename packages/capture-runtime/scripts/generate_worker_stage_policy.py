from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

RUNTIME_ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = RUNTIME_ROOT / "src" / "capture_runtime" / "assets" / "worker-stage-policy.json"
PYTHON_OUTPUT = RUNTIME_ROOT / "src" / "capture_runtime" / "_generated_worker_stage_policy.py"
TYPESCRIPT_OUTPUT = RUNTIME_ROOT.parents[1] / "tools" / "generated-worker-stage-policy.ts"


def _json_string(value: str) -> str:
    return json.dumps(value, ensure_ascii=True)


def _lines(values: list[str], indent: str = "    ") -> str:
    return "\n".join(f"{indent}{_json_string(value)}," for value in values)


def _load_policy() -> dict[str, Any]:
    value = json.loads(POLICY_PATH.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or value.get("schemaVersion") != "1":
        raise ValueError("worker stage policy schema is invalid")
    required = {
        "schemaVersion",
        "maxStages",
        "maxStageLength",
        "exactStages",
        "exceptionNames",
        "familyPatterns",
        "unknownPrefixes",
        "priority",
        "builderNames",
    }
    if set(value) != required:
        raise ValueError("worker stage policy fields are invalid")
    for field in ("maxStages", "maxStageLength"):
        if not isinstance(value[field], int) or isinstance(value[field], bool) or value[field] <= 0:
            raise ValueError("worker stage policy limits are invalid")
    for field in ("exactStages", "exceptionNames", "familyPatterns", "builderNames"):
        values = value[field]
        if (
            not isinstance(values, list)
            or not values
            or any(not isinstance(item, str) or not item for item in values)
            or len(set(values)) != len(values)
        ):
            raise ValueError(f"worker stage policy {field} are invalid")
    patterns = value["familyPatterns"]
    for pattern in patterns:
        re.compile(rf"^(?:{pattern})$")
    prefixes = value["unknownPrefixes"]
    if (
        not isinstance(prefixes, list)
        or not prefixes
        or any(
            not isinstance(pair, list)
            or len(pair) != 2
            or any(not isinstance(item, str) or not item for item in pair)
            for pair in prefixes
        )
    ):
        raise ValueError("worker stage policy unknown prefixes are invalid")
    if len({pair[0] for pair in prefixes}) != len(prefixes):
        raise ValueError("worker stage policy unknown prefixes are duplicated")
    priority = value["priority"]
    if not isinstance(priority, dict) or set(priority) != {
        "startupHeadCount",
        "failureTailCount",
        "criticalStages",
    }:
        raise ValueError("worker stage policy priority is invalid")
    startup_head = priority["startupHeadCount"]
    failure_tail = priority["failureTailCount"]
    critical = priority["criticalStages"]
    if (
        not isinstance(startup_head, int)
        or isinstance(startup_head, bool)
        or startup_head <= 0
        or not isinstance(failure_tail, int)
        or isinstance(failure_tail, bool)
        or failure_tail <= 0
        or not isinstance(critical, list)
        or not critical
        or any(not isinstance(item, str) or not item for item in critical)
        or len(set(critical)) != len(critical)
        or startup_head + failure_tail + len(critical) > value["maxStages"] - 1
    ):
        raise ValueError("worker stage policy priority limits are invalid")
    if any(item not in value["exactStages"] for item in critical):
        raise ValueError("worker stage policy critical stage is not exact")
    return value


def _render_python(policy: dict[str, Any]) -> str:
    exact = policy["exactStages"]
    exceptions = policy["exceptionNames"]
    families = policy["familyPatterns"]
    prefixes = policy["unknownPrefixes"]
    priority = policy["priority"]
    builders = policy["builderNames"]
    prefix_lines = "\n".join(
        (
            f"    ({_json_string(pair[0])}, {_json_string(pair[1])}),"
            if len(f"    ({_json_string(pair[0])}, {_json_string(pair[1])}),") <= 100
            else "    (\n"
            f"        {_json_string(pair[0])},\n"
            f"        {_json_string(pair[1])},\n"
            "    ),"
        )
        for pair in prefixes
    )
    return f'''"""Generated from worker-stage-policy.json; do not edit."""

from __future__ import annotations

from typing import Final

WORKER_STAGE_POLICY_SCHEMA_VERSION: Final = {_json_string(policy["schemaVersion"])}
MAX_WORKER_DIAGNOSTIC_STAGES: Final = {policy["maxStages"]}
MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH: Final = {policy["maxStageLength"]}
EXCEPTION_NAMES: Final[frozenset[str]] = frozenset(
    (
{_lines(exceptions, "        ")}
    )
)
EXACT_STAGES: Final[frozenset[str]] = frozenset(
    (
{_lines(exact, "        ")}
    )
)
FAMILY_PATTERNS: Final[tuple[str, ...]] = (
{_lines(families)}
)
UNKNOWN_PREFIXES: Final[tuple[tuple[str, str], ...]] = (
{prefix_lines}
)
STAGE_BUILDER_NAMES: Final[frozenset[str]] = frozenset(
    (
{_lines(builders, "        ")}
    )
)
WORKER_STAGE_STARTUP_HEAD_COUNT: Final = {priority["startupHeadCount"]}
WORKER_STAGE_FAILURE_TAIL_COUNT: Final = {priority["failureTailCount"]}
WORKER_STAGE_CRITICAL_STAGES: Final[frozenset[str]] = frozenset(
    (
{_lines(priority["criticalStages"], "        ")}
    )
)
'''


def _render_typescript(policy: dict[str, Any]) -> str:
    exact = policy["exactStages"]
    exceptions = policy["exceptionNames"]
    families = policy["familyPatterns"]
    prefixes = policy["unknownPrefixes"]
    priority = policy["priority"]
    builders = policy["builderNames"]
    prefix_lines = "\n".join(
        f"  [{_json_string(pair[0])}, {_json_string(pair[1])}] as const," for pair in prefixes
    )
    family_lines = "\n".join(f"  new RegExp(`^(?:{pattern})$`, 'u')," for pattern in families)
    return f"""/** Generated from the private worker-stage policy source; do not edit. */
export const WORKER_STAGE_POLICY_SCHEMA_VERSION = {_json_string(policy["schemaVersion"])} as const;
export const MAX_WORKER_DIAGNOSTIC_STAGES = {policy["maxStages"]} as const;
export const MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH = {policy["maxStageLength"]} as const;
export const WORKER_STAGE_EXCEPTION_NAMES = new Set<string>([
{_lines(exceptions, "  ")}
]);
export const WORKER_STAGE_EXACT_STAGES = new Set<string>([
{_lines(exact, "  ")}
]);
export const WORKER_STAGE_FAMILY_PATTERNS: readonly RegExp[] = [
{family_lines}
];
export const WORKER_STAGE_UNKNOWN_PREFIXES: readonly (readonly [string, string])[] = [
{prefix_lines}
];
export const WORKER_STAGE_BUILDER_NAMES = new Set<string>([
{_lines(builders, "  ")}
]);
export const WORKER_STAGE_STARTUP_HEAD_COUNT = {priority["startupHeadCount"]} as const;
export const WORKER_STAGE_FAILURE_TAIL_COUNT = {priority["failureTailCount"]} as const;
export const WORKER_STAGE_CRITICAL_STAGES = new Set<string>([
{_lines(priority["criticalStages"], "  ")}
]);

const workerStageNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const whisperModelFailurePattern = /^whisper-model-load-(cpu|cuda)-failed-.+$/u;

export function sanitizeWorkerStage(stage: unknown): string | null {{
  if (typeof stage !== 'string' || stage.length > MAX_WORKER_DIAGNOSTIC_STAGE_LENGTH) return null;
  if (!workerStageNamePattern.test(stage)) return null;
  if (
    WORKER_STAGE_EXACT_STAGES.has(stage) ||
    WORKER_STAGE_FAMILY_PATTERNS.some((pattern) => pattern.test(stage))
  ) return stage;
  for (const [prefix, sentinel] of WORKER_STAGE_UNKNOWN_PREFIXES) {{
    if (stage.startsWith(prefix)) return sentinel;
  }}
  const modelFailure = whisperModelFailurePattern.exec(stage);
  return modelFailure === null ? null : `whisper-model-load-${{modelFailure[1]}}-failed-unknown`;
}}

export function isAllowedWorkerStage(stage: unknown): stage is string {{
  return typeof stage === 'string' && sanitizeWorkerStage(stage) === stage;
}}

export function boundWorkerStageSequence(stages: readonly string[]): readonly string[] {{
  stages = stages.flatMap((stage) => {{
    const safeStage = sanitizeWorkerStage(stage);
    return safeStage === null ? [] : [safeStage];
  }});
  if (stages.length <= MAX_WORKER_DIAGNOSTIC_STAGES) return [...stages];
  const realCapacity = MAX_WORKER_DIAGNOSTIC_STAGES - 1;
  const selected = new Set<number>();
  for (
    let index = 0;
    index < Math.min(WORKER_STAGE_STARTUP_HEAD_COUNT, stages.length);
    index += 1
  ) {{
    selected.add(index);
  }}
  for (
    let index = Math.max(0, stages.length - WORKER_STAGE_FAILURE_TAIL_COUNT);
    index < stages.length;
    index += 1
  ) {{
    selected.add(index);
  }}
  // Represent each critical semantic kind once; repeated markers cannot
  // consume the bounded diagnostic budget.
  const firstCritical = new Set<string>();
  stages.forEach((stage, index) => {{
    if (WORKER_STAGE_CRITICAL_STAGES.has(stage) && !firstCritical.has(stage)) {{
      selected.add(index);
      firstCritical.add(stage);
    }}
  }});
  for (let index = 0; index < stages.length && selected.size < realCapacity; index += 1) {{
    selected.add(index);
  }}
  const omitted = stages.findIndex((_stage, index) => !selected.has(index));
  const bounded: string[] = [];
  let markerAdded = false;
  stages.forEach((stage, index) => {{
    if (!markerAdded && index === omitted) {{
      bounded.push('worker-stage-sequence-truncated');
      markerAdded = true;
    }}
    if (selected.has(index)) bounded.push(stage);
  }});
  if (!markerAdded) bounded.push('worker-stage-sequence-truncated');
  return bounded;
}}
"""


def _write_or_check(path: Path, content: str, check: bool) -> None:
    encoded = content.encode("utf-8")
    existing = path.read_bytes() if path.exists() else None
    if check:
        if existing != encoded:
            raise SystemExit(f"generated worker stage policy is stale: {path}")
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    policy = _load_policy()
    _write_or_check(PYTHON_OUTPUT, _render_python(policy), arguments.check)
    _write_or_check(TYPESCRIPT_OUTPUT, _render_typescript(policy), arguments.check)


if __name__ == "__main__":
    main()
