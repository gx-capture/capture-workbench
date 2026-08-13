# Capture Streaming SSE Migration Decisions

## Decision status

Complete. P0-P5, the subsequent lifecycle/security hardening, the Cert Prep and
Law Prep consumer cutovers, host partial provenance hardening in `e65e92f`, and
behavior-preserving Ruff normalization in `39422f8`, and the producer
compatibility-contract deletion have all passed their phase-specific review
and verification gates.

## Change mode checkpoint

```text
Change mode: mixed
Existing owner: StreamingCaptureService/StreamingRepository for the capture
                lifecycle and live SSE boundary
Delete candidates: completed locally for /v1/captures routes, CaptureService,
                   CaptureRepository, native v1 commands, and first-party v1 path
                   usage; retired public job types and schemas are also deleted
New owner needed?: no; the v2 owner now owns all capture kinds and live SSE
Token posture: compact quality
Verification floor: contract generation/check, focused backend tests, Angular
                     RxJS/async-boundary tests, Tauri tests, deterministic parity,
                     and E2E before deletion
```

## Options considered

### Contract-first only

Freeze a broad v2 contract before proving the runtime behavior. This gives
consumers early types but risks locking event semantics that the backend cannot
actually deliver.

### Backend-first with a deprecation window — selected

Generalize the existing v2 owner and prove live/replayable SSE, then move
Angular and desktop consumers before deleting the local v1 engine. Route
removal superseded a live header because no first-party caller remained; public
types stay deprecated until external consumers complete their migration.

### Consumer-first dual transport

Add Angular SSE and retain v1 polling for a long period. This appears to reduce
short-term risk but maximizes duplicate lifecycle code and makes it easy to
claim SSE migration before Python can guarantee live delivery.

## Locked decisions

1. The v2 streaming owner is edited and generalized before any legacy owner is
   deleted.
2. Python progress is live SSE plus durable replay; a finite snapshot response
   is not accepted as the final implementation.
3. Angular remains Observable/RxJS. Authentication stays in headers, so native
   EventSource and query-string tokens are rejected.
4. The capture engine is unified at lifecycle/state/storage level. Media-
   specific extraction adapters are allowed and are not a second job engine.
5. Runtime installation and model-installation routes are outside this scope.
6. Every implementation phase is independently reviewable and revertible; no
   broad `git add .` or mixed release-candidate staging is allowed.

## Gates that must be resolved before P1

- The v2 contract widening, media-neutral event semantics, host handoff
  idempotency, and authenticated Tauri bridge were resolved in the P0-P3
  phase commits.
- The known external-consumer gate closed through separately reviewed Cert Prep
  commit `6801c0c` and Law Prep commit `4a0182a` before producer deletion.
- The desktop bridge uses the bounded terminal v2 SSE response required by the
  current native command boundary; Python and Angular retain the live SSE
  contract.

## Rollback rules

- P1 must leave `/v1/captures` operational.
- P2 must not remove the old consumer seam until v2 client tests and parity
  evidence pass.
- P3 is reverted before P1 when desktop cutover fails.
- P5 is reverted before any earlier phase when a consumer compatibility issue is
  discovered.
- Existing dirty files are never reverted, reformatted, or staged as part of
  this work.
- Producer deletion is blocked until external consumer migration evidence is
  recorded or an explicit breaking-release owner approves the removal. This
  gate closed with Cert Prep `6801c0c` and Law Prep `4a0182a`.

## Review rule

Before every commit, inspect `git diff --cached --name-only` and ensure every
path is part of that phase's ownership list. A passing test cannot validate an
incorrect staged artifact.
