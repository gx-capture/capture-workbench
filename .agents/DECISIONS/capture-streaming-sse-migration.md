# Capture Streaming SSE Migration Decisions

## Decision status

P0 planning baseline. Runtime implementation and traffic cutover are not yet
authorized by this document alone.

## Change mode checkpoint

```text
Change mode: mixed
Existing owner: StreamingCaptureService/StreamingRepository for the successor;
                CaptureService/CaptureRepository for the legacy path
Delete candidates: /v1/captures routes, CaptureService, CaptureRepository,
                  CaptureJobV1 capture types, polling clients and fixtures
New owner needed?: no for the job lifecycle; yes for the live SSE subscriber
                   boundary because the current route only replays a snapshot
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

Generalize the existing v2 owner and prove live/replayable SSE while v1 remains
available. Then move Angular and desktop consumers, deprecate v1, and delete it
last. This creates the clearest review and rollback seams.

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

- Decide whether the existing v2 wire contract can be widened in place or a
  successor protocol version is required.
- Define the exact event payload for page-based PDF/image progress and
  time-based audio progress.
- Define the host structuring commit/failure idempotency and terminal-event
  semantics.
- Define the deprecation release window and public package version impact.
- Inventory and coordinate known external consumers before deleting the public
  contract. Current evidence includes `C:\software-dev\cert-prep` and
  `C:\software-dev\gx.law-prep`; do not edit either repository implicitly.
- Choose the Tauri live-event bridge; the current synchronous `read_to_end`
  parser is not sufficient for an unbounded live stream.

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
  recorded or an explicit breaking-release owner approves the removal.

## Review rule

Before every commit, inspect `git diff --cached --name-only` and ensure every
path is part of that phase's ownership list. A passing test cannot validate an
incorrect staged artifact.
