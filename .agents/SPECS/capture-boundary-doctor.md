# Capture Boundary Doctor Spec

## Purpose

Provide a one-shot, read-only developer CLI in the Capture Workbench workspace
that observes the same local Capture Runtime through two boundaries at once:
Cert Prep's authenticated proxy and the runtime's authenticated direct API. It
must identify whether readiness, requirement, or correlated job-state drift is
owned by Capture Runtime, Cert Prep, or the boundary between them.

## Non-Goals

- Do not launch, install, stop, cancel, delete, or create either product or any
  runtime job.
- Do not automate the Cert Prep or Capture Workbench UI.
- Do not add a public endpoint, correlation header, database migration, or
  runtime wire-contract field.
- Do not become a daemon or collect telemetry after its bounded watch deadline.
- Do not treat deterministic or failed-job diagnostics as positive OCR/STT
  evidence.

## CLI Interface

Run through Nx:

```text
pnpm nx run capture-tools:boundary-doctor -- \
  --cert-prep-url http://127.0.0.1:8765 \
  --runtime-url http://127.0.0.1:8766 \
  [--project-id <id> --operation-id <id> --capture-id <id>] \
  [--watch-seconds <0..3600>] [--interval-ms <250..10000>] \
  [--request-timeout-ms <250..30000>] [--output <json-path>]
```

Secrets are accepted only from environment variables:

- `CAPTURE_BOUNDARY_CERT_PREP_TOKEN`
- `CAPTURE_BOUNDARY_RUNTIME_TOKEN`

Both URLs must be credential-free numeric loopback HTTP origins
(`127.0.0.1` or `[::1]`) with no path, query, or fragment. DNS names including
`localhost` are rejected to avoid rebinding ambiguity. Both services use the
standard `Authorization: Bearer <token>` header. The three correlation
identifiers are all-or-none and an incomplete group fails before any request.
A zero-second watch produces one snapshot. A positive watch polls until its
deadline or until both correlated jobs are terminal.

## Observed Contracts

- Cert Prep proxy:
  - `GET /capture-runtime/ready`
  - `GET /capture-runtime/requirements`
  - optional `GET /projects/{projectId}/document-operations/{operationId}`
- Capture Runtime direct:
  - `GET /v1/health/ready`
  - `GET /v1/runtime/requirements`
  - `GET /v2/captures/{captureId}`

The tool validates and retains only the fields needed for diagnosis. It never
copies response headers, authorization values, arbitrary raw payloads, source
content, or sidecar bearer tokens into stdout or a report.

## Report Contract

The final JSON report is versioned as `1` and contains:

- mode, sanitized loopback origins, generation time, and sample count;
- a bounded timeline of normalized readiness, requirements, operation state,
  capture state, and sanitized endpoint errors;
- one verdict with `owner`, machine-readable `code`, and human-readable
  `detail`.

Owners are `healthy`, `in-progress`, `cert-prep`, `capture-runtime`,
`boundary`, or `unknown`. A healthy or still-consistent in-progress snapshot
exits `0`; an identified or unknown fault exits `2`; invalid arguments or an
unexpected doctor failure exits `1`.

## Classification Rules

- Runtime direct unavailable while the proxy is also unavailable: Capture
  Runtime owns the failure.
- Runtime direct healthy while the Cert Prep proxy is unavailable: Cert Prep
  owns the failure.
- Both snapshots are readable but readiness identity/capability or normalized
  requirement state differs: the boundary owns the mismatch.
- Runtime capture is terminal while the Cert Prep operation remains active:
  Cert Prep owns a stuck durable state transition.
- Runtime capture failed and Cert Prep operation failed: Capture Runtime owns
  the underlying job failure; Cert Prep propagated it.
- Runtime capture completed but Cert Prep did not succeed, or Cert Prep
  succeeded while Runtime did not complete: Cert Prep owns the integrity
  mismatch.
- Cert Prep operation is terminal while the Runtime capture remains queued or
  running: Cert Prep owns an incomplete cancellation/reconciliation cleanup.
- Matching terminal success is healthy; matching active state is in progress.

## Edge Cases and Failure Modes

- Each request has its own abort timeout; a slow endpoint cannot block the
  other side's observation.
- Polling uses a deterministic injected clock/sleeper in tests and does not use
  unbounded retry loops.
- Malformed JSON, unexpected payload shapes, HTTP failures, and timeouts become
  sanitized endpoint errors instead of leaking response bodies.
- Output is canonical pretty JSON. Parent directories are not created
  implicitly, and an existing output file is replaced only when `--output` was
  explicitly supplied.
- Tokens must not appear in thrown errors, progress text, reports, or test
  snapshots.

## Acceptance Criteria

- A dedicated `capture-tools` Nx project exposes `boundary-doctor`,
  `boundary-doctor-test`, `boundary-doctor-typecheck`, and
  `boundary-doctor-lint`, plus standard `test`, `typecheck`, and `lint` aliases
  for workspace verification, without modifying the Python Runtime project's
  configuration.
- The tool concurrently observes both readiness and requirements surfaces.
- Optional correlated polling identifies a Runtime-terminal/Cert-Prep-active
  state as a Cert Prep defect.
- Requirement and readiness drift is reported as a boundary mismatch.
- Only loopback origins and environment-provided bearer tokens are accepted.
- Unit tests prove argument validation, sanitization, parity, mismatch, stuck
  operation, host-terminal/runtime-active cleanup mismatch, propagated Runtime
  failure, and terminal success behavior.
- Typecheck, lint, doctor tests, and the resolved Nx target configuration pass.

## Test Plan

- Use Node's built-in test runner and injected fake fetch/clock/sleeper
  functions; do not require either real product for deterministic tests.
- Exercise the CLI contract through exported parse/validation functions.
- Assert exact verdict owner/code pairs and that supplied token sentinels never
  occur in serialized reports or errors.
- Keep real attach usage opt-in and outside ordinary CI because it requires two
  already-running authenticated local services.
