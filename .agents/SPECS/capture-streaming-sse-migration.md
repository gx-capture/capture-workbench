# Capture Streaming SSE Migration Spec

Status: implementation in progress; P0-P3 and local v1 engine deletion are
complete. The external consumer compatibility gate and final residual cleanup
remain open.

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

The v2 path is now the only first-party capture path. The local `/v1/captures`
route and engine were removed in the P5 deletion commit after the desktop and
Angular cutovers; route removal superseded a live deprecation header. Public
compatibility contract types remain temporarily annotated as deprecated while
known external consumers migrate.

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

1. **P0 contract/spec**: completed in `a93d294` and `5c36463`.
2. **P1 Python runtime**: completed in `78b2bab`; v2 is generalized, live,
   replayable, authenticated SSE for all supported media.
3. **P2 Angular transport**: completed in `529f3f1` and
   `812d54e`; Angular remains Observable/RxJS and the fetch-stream parser
   aborts on unsubscribe.
4. **P3 desktop cutover**: completed in `8a0811f` and `37f023b`; production
   desktop capture uses v2 for every media kind, including deterministic and
   opt-in real smoke harnesses.
5. **P4/P5 local removal**: completed in `ac44030`, `779d06b`, and
   `84f71f6`; `/v1/captures`, its service/repository, and native commands are
   gone, with resync/token hardening added. External contract/consumer
   migration remains a separate gate.

Each phase must have an explicit path list, its own review, and its own
verification result. Revert consumers before reverting the runtime cutover;
revert the deletion commit before reverting the deprecation/cutover phases.

## Auditable phase evidence

The phase commits below are the reviewed path groups. Every commit was created
only after `git diff --cached --name-only`, `git diff --cached --stat`, and
`git diff --cached --check` were inspected; unrelated dirty paths stayed
unstaged. The final independent review was rerun against `ac44030` at the
post-phase HEAD, with the follow-up recovery findings fixed in `5c11304`.

- `812d54e` — Angular package paths under
  `packages/capture-angular/`, plus generated contract metadata and the
  contract generator. Verified with capture-angular typecheck, lint,
  async-boundary, and tests; the final rerun covered 81 tests.
- `37f023b` — desktop renderer/native bridge paths under
  `apps/capture-workbench/` and `apps/capture-workbench-desktop/`, including
  deterministic and real smoke harnesses. Verified with Tauri fmt/check/tests,
  contract consistency, deterministic smoke, and package QA (183 passed, 2
  skipped).
- `779d06b` — `tools/capture-boundary-doctor*`,
  `tools/clean-angular-consumer-smoke.ts`,
  `tools/runtime-web-component-e2e.ts`, and `tools/user-pdf-ocr-probe.mts`.
  Verified with tools typecheck/lint/tests and desktop package QA.
- `84f71f6` — runtime SSE route/repository and `test_streaming_api.py`.
  Verified with runtime lint/typecheck/contract check and the full runtime
  suite (301 passed, 1 skipped).
- `5c11304` — runtime overflow handling, Angular/desktop reconnect consumers,
  snapshot cursor recovery, and their regression specs. Focused verification
  passed (runtime 14, Angular 81, desktop 46); the full floor was rerun after
  the preceding phases.
- `464df03`, `5e860eb` — migration decision/spec/TODO evidence and the related
  boundary-doctor documentation. Verified by the same final residual scan and
  HEAD-bound two-axis review.

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
- First-party desktop and Angular production paths use v2 for all capture kinds;
  deterministic/real smoke harnesses and probes are also v2-only. Real
  engine-bearing execution remains an opt-in release gate.
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
