# Capture Streaming SSE Migration Spec

Status: planning baseline; implementation has not started.

## Purpose

Remove the legacy `/v1/captures` shared `CaptureJobV1` engine for image, PDF,
and audio capture. Make the existing v2 streaming lifecycle the single Python
capture job owner, expose capture progress through authenticated SSE, and keep
Angular's public and internal asynchronous shape Observable/RxJS-based.

## Scope

- Generalize v2 ingestion and capture lifecycle to `pdf | image | audio`.
- Make Python capture progress a live, replayable, authenticated SSE stream.
- Keep upload, cancel, host-structuring commands, and result/raw queries as
  ordinary authenticated HTTP JSON requests.
- Keep Angular `CaptureClient` and workflow code Observable/RxJS-based.
- Move the Tauri desktop capture path to the v2 lifecycle for all three kinds.
- Deprecate and then delete `/v1/captures`, its job service/repository, and
  active `CaptureJobV1` consumers.

## Non-goals

- Do not remove `/v1/health/ready` or `/v1/runtime/*` in this migration.
- Do not modify sibling repositories implicitly. Their migration requires an
  explicit, separately scoped consumer task.
- Do not convert runtime installation/model-installation jobs to SSE.
- Do not use bearer tokens in URLs, EventSource query parameters, logs, or
  persisted event payloads.
- Do not require real engine-bearing OCR/Whisper smoke evidence when the
  repository's existing fixture/catalog gate is unavailable.

## Current ownership and target ownership

| Concern | Current owner | Target owner |
|---|---|---|
| v1 capture lifecycle | `CaptureService` + `CaptureRepository` | deleted |
| v2 capture lifecycle | `StreamingCaptureService` + `StreamingRepository` | sole capture owner |
| audio extraction | progressive capture processor | media-specific adapter under the v2 owner |
| PDF/image extraction | existing capture extractor | media-specific adapter under the v2 owner |
| Angular progress | polling resource | RxJS SSE event stream + reducer |
| desktop progress | v1 polling or v2 snapshot replay | v2 SSE bridge for all media |

## Wire contract

The protocol version decision must be settled before implementation:

- If the current v2 contract is still a coordinated internal contract, widen
  v2 in place.
- If v2 is already a published compatibility promise, introduce a successor
  protocol rather than silently changing its audio-only meaning.

The selected protocol must provide:

- ingestion metadata for `pdf`, `image`, and `audio`;
- bounded, ordered, checksum-verified chunk upload;
- a capture operation snapshot with status, progress, source, error, and
  terminal timestamp;
- `GET /captures/{capture_id}/events` with `Content-Type: text/event-stream`;
- monotonic SSE `id` values and `Last-Event-ID` replay;
- `accepted`, progress/checkpoint, heartbeat, `completed`, `failed`,
  `cancelled`, and `resync_required` event semantics;
- host-owned structuring candidate commit and structuring-failure paths with
  idempotency and terminal event publication;
- JSON raw/result queries that remain available after the event stream closes.

SSE is the progress transport, not a replacement for every HTTP command. A
client disconnect must not cancel the job; cancellation remains explicit.

## SSE delivery rules

- Persist an event before publishing it to live subscribers.
- Close the stream after a terminal event has been delivered.
- Send heartbeats during an otherwise idle live connection.
- Atomically bridge replay to live subscription so an event cannot be lost
  between reading the event log and subscribing.
- Reconnect with the last received sequence and suppress duplicates.
- Bound replay and queue memory; emit `resync_required` when a client falls
  behind the supported replay window.
- Detect client disconnects and release the subscriber without changing job
  state.

## Hybrid Angular boundary

Angular remains RxJS-based. The HTTP client may use `fetch` internally, but it
must parse the response `ReadableStream` into cold `Observable<CaptureEvent>`
values, abort on unsubscribe, and preserve the existing loopback validation and
late bearer-token resolution. Native `EventSource` is not allowed because the
runtime requires an Authorization header.

The workflow may use `rxResource` for one-shot readiness/installation reads and
RxJS command pipelines for capture lifecycle. Capture progress must no longer
depend on timer polling.

## Deprecation and deletion boundary

The deprecation phase applies only to `/v1/captures`. During the migration
window it remains operational with an explicit deprecation signal and the v2
path is the only path used by first-party consumers. Deletion is permitted only
after all consumers and parity tests have moved.

The final deletion must remove active references to:

- `/v1/captures`;
- `CaptureJobV1`, `CaptureJobStatus`, and `CaptureJobStage` where they are
  capture-engine types;
- `CaptureService`, `CaptureRepository`, and v1 route registration;
- Angular capture polling and v1 client methods;
- desktop v1 capture commands and deterministic fixtures.

Deletion is also blocked while known external consumers still depend on the
legacy contract. The current inventory includes Cert Prep's Capture Workbench
client/backend tests and Law Prep's generated/validated `CaptureJobV1` contract.
Those repositories need a coordinated migration or an explicitly approved
compatibility release before this producer can delete the public type.

## Phase and commit boundaries

1. **P0 contract/spec**: this spec, decision record, active TODO, contract
   tests, and generated contract updates. No traffic cutover.
2. **P1 Python runtime**: generalized v2 lifecycle, live SSE, replay,
   host-structuring handoff, cancellation, recovery, and media parity. Keep v1.
3. **P2 Angular transport**: authenticated fetch-stream parser, RxJS API,
   event reducer, upload pipeline, and client tests. Keep v1 fallback only as
   a temporary rollback seam.
4. **P3 desktop cutover**: Tauri bridge and Workbench store use v2 for all
   media; remove audio-only branching; run deterministic parity evidence.
5. **P4 deprecation**: mark `/v1/captures` deprecated, update documentation
   and coordinated consumers, and prove no first-party v1 traffic remains.
6. **P5 deletion**: delete the v1 engine and its generated/consumer residue in
   a dedicated removal commit.

Each phase must have an explicit path list, its own review, and its own
verification result. Revert consumers before reverting the runtime cutover;
revert the deletion commit before reverting the deprecation/cutover phases.

## Acceptance criteria

- PDF, image, and audio each complete the same v2 lifecycle and produce
  equivalent raw/result semantics to the legacy path.
- Every capture emits an ordered accepted-to-terminal event sequence.
- Reconnect with `Last-Event-ID` produces no missing or duplicate events within
  the replay window.
- A disconnected client does not cancel or corrupt a running capture.
- Host structuring can commit a valid candidate or publish a sanitized terminal
  failure through v2.
- Angular public APIs remain Observable/RxJS-based and pass the async-boundary
  check.
- No bearer token appears in URLs, event data, logs, or reports.
- First-party desktop, Angular, deterministic, and E2E paths use v2 for all
  capture kinds before v1 deletion.
- Known external consumers have migrated from `CaptureJobV1`/`/v1/captures`, or
  a release owner has explicitly approved the breaking removal.
- After P5, an active-source residual scan finds no `/v1/captures` or
  `CaptureJobV1` capture-engine references.

## Test plan

- Python contract, route, repository, live subscriber, replay, reconnect,
  cancellation, cleanup, host-structuring, and all-media integration tests.
- Angular SSE frame parser, chunk upload, abort/unsubscribe, reconnect,
  reducer, workflow, and consumer smoke tests.
- Rust/Tauri request, authorization, cursor, event bridge, and all-media
  deterministic fixture tests.
- End-to-end tests for PDF, image, audio, runtime failure, cancellation, and
  host structuring.

## Verification floor

```text
pnpm nx run capture-runtime:lint --skip-nx-cache
pnpm nx run capture-runtime:typecheck --skip-nx-cache
pnpm nx run capture-runtime:test --skip-nx-cache
pnpm nx run capture-runtime:check-contracts --skip-nx-cache
pnpm nx run capture-angular:async-boundary-check --skip-nx-cache
pnpm nx run capture-angular:lint --skip-nx-cache
pnpm nx run capture-angular:typecheck --skip-nx-cache
pnpm nx run capture-angular:test --skip-nx-cache
pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache
pnpm nx run capture-workbench-desktop:contract-consistency --skip-nx-cache
pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
pnpm nx run capture-workbench-desktop:smoke-deterministic --skip-nx-cache
pnpm nx run capture-workbench-e2e:e2e --skip-nx-cache
git diff --check
```
