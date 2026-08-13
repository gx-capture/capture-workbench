# Capture Streaming SSE Migration Spec

Status: implementation in progress; P0-P3, local v1 engine deletion, the
post-d3bf3de hardening phase, the post-1db5624 final closeout, and the
post-695567b ingestion open-recovery phase, and the post-9e6e2b3 final
hardening phase, and the post-3b61cef security/protocol hardening phase are
complete, the post-e166174 final security hardening phase is complete, and the
post-7909eeb final lifecycle/security phase, and the post-c762e02 final
lifecycle hardening phase, and the post-f9827bf final bounded security/protocol
phase, the post-8c98a32 final hardening phase, the post-5b5aa3c final
lifecycle hardening phase, and the post-59bcbf5 final lifecycle hardening
phase are complete. The external consumer compatibility gate and final
residual cleanup remain open.

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
6. **Post-d3bf3de hardening**: completed in the containing phase commit; the
   canonical `captureId/sequence` identity now covers resync events and
   deterministic/native/client validation, ingestion load recovery repairs
   stale source offsets and enforces the configured upload ceiling, Angular
   HTTP responses validate opaque identities before URL reuse, and the real
   Ollama smoke consumes an active SSE checkpoint before reconnecting with
   `Last-Event-ID`. The external consumer gate remains unchecked.
7. **Post-1db5624 final closeout**: completed in the containing phase commit;
   finalize maps `StreamingUploadLimitError` to HTTP 413, Angular/native
   clients validate bounded non-empty consumer request IDs separately from
   opaque runtime IDs (including dotted IDs) and encode lookup path segments,
   and the real Ollama smoke verifies a nonterminal operation snapshot between
   its active SSE disconnect and `Last-Event-ID` reconnect, failing on a
   terminal race. The external consumer gate remains unchecked.
8. **Post-695567b ingestion open recovery**: completed in the containing phase
   commit; runtime exposes `GET /v2/ingestions/by-client-request/{client_request_id}`
   as the ingestion counterpart to the existing capture lookup, and Angular/
   native clients recover an uncertain lost open-ingestion response through
   that lookup. A 404 confirms the ingestion was never created and rethrows
   the original failure; an unavailable lookup preserves the original
   uncertainty without deleting a possibly committed ingestion. The existing
   bounded expiry (unreferenced ingestions expire two hours after open and are
   pruned at startup/initialize) remains the documented orphan backstop when
   the runtime is unreachable. The external consumer gate remains unchecked.
9. **Post-9e6e2b3 final hardening**: completed in the containing phase commit;
   native open-ingestion enters by-client-request recovery on any committed
   2xx response that fails semantic identity validation (missing/malformed
   `ingestionId`, wrong protocol version, or metadata identity mismatch).
   Ingestion open requests reuse the same bounded client request id as the
   capture request because the runtime idempotency maps are separate, keeping
   every request id within the 128-character contract without truncation or
   collision risk and preserving path-safe encoding. Real-media-model-smoke
   maps every v2 capture status (`created`, `waiting_input`, and the rest) to
   its own stage instead of the legacy document-stage allowlist. Declared
   capture kind is authoritative: pdf/image extraction fails closed with
   `source_kind_mismatch` before sniff-based dispatch can route mislabeled
   content to a different extractor. The external consumer gate remains
   unchecked.
10. **Post-3b61cef security/protocol hardening**: completed in the containing
    phase commit; Angular lost-open recovery correlates the recovered
    ingestion with protocol version, kind, fileName, mediaType, and totalBytes
    before any upload and fails closed on mismatch; native capture-start
    validates protocolVersion, captureId/ingestionId correlation, kind,
    status, and source metadata before persisting recovery state, and
    malformed/mismatched committed 2xx responses recover through the
    by-client-request lookup or fail closed; Angular, native, and user/probe
    SSE parsers reject an unterminated final frame at EOF instead of treating
    it as clean completion; runtime persistence enforces canonical child
    containment for ingestion descendants before load, source access, writes,
    and cleanup. The external consumer gate remains unchecked.
11. **Post-e166174 final security hardening**: completed in the containing
    phase commit; the native SSE EOF path always calls `SseParser.finish` and
    rejects pending unterminated frames, and the deterministic HTTP parser
    does the same while preserving CRLF/bare-CR framing; Angular uncertain-
    create and lost-open recovery lookups propagate the caller `AbortSignal`;
    persistence rejects symlinked roots/category roots and re-checks canonical
    containment before every capture event/raw/result/partial and ingestion
    source/metadata access; native capture-start validation requires source
    metadata for every status that would persist or recover a capture identity.
    The external consumer gate remains unchecked.
12. **Post-7909eeb final lifecycle/security**: completed in the containing
    phase commit; Angular initial open-ingestion responses must correlate
    protocol, ingestionId, kind, fileName, mediaType, totalBytes, and status
    before upload and fail closed on mismatch while preserving AbortError and
    recovery-lookup semantics; persistence validates canonical leaf files and
    rejects symlinked events/metadata/raw/result/partial/source on every
    read/write/cleanup, and startup requires metadata IDs to equal the
    directory basename for ingestions and captures; the deterministic SSE
    parser rejects any incomplete final physical line including comment/unknown
    lines. Desktop cancellation propagates into active SSE streaming via
    `stream_request_id`; native upload/start remains a bounded blocking Tauri
    command without a bridge cancellation channel, so in-flight upload/start
    cancellation is bounded by per-request timeouts plus idempotent recovery.
    The external consumer gate remains unchecked.
13. **Post-c762e02 final lifecycle hardening**: completed in the containing
    phase commit; Angular and native initial/recovered ingestion decoders
    require `status == open` before upload and never delete a finalized/
    closed ingestion as uploadable; Angular cancellation before a capture id
    arrives retains the stable client request identity and recovery path
    without destructive cleanup; desktop pending-recovery lookup correlates
    ingestionId and source metadata against the durable recovery record
    before accepting; persistence validates root/category containment before
    creating directories and replay reads validate capture identity, canonical
    event id, and monotonic sequence, failing closed on corruption; the
    progressive audio oracle rejects unterminated EOF frames instead of
    flushing pending bytes. The external consumer gate remains unchecked.
14. **Post-f9827bf final bounded security/protocol**: completed in the
    containing phase commit; native SSE response size accounting counts body
    bytes already present in the header-read prefix exactly once while keeping
    the 60 MiB limit; the Tauri library rejects symlinked items/document
    ancestors and enforces canonical no-symlink containment for reads, writes,
    exports, and deletes under the library root; Angular and native SSE
    parsers require a non-empty frame id matching the sequence and fail
    closed on missing/empty ids. The external consumer gate remains unchecked.
15. **Post-8c98a32 final hardening**: completed in the containing phase
    commit; the Tauri library validates root/items before directory mutation,
    uses unique atomic temp files immune to stale symlinks, and enforces
    canonical no-symlink containment on all operations; native upload/hash
    revalidates the canonical source immediately before every reopen/read;
    runtime replay rejects sequence gaps and corrupt logs before any
    subscriber is registered; Angular parser fails closed on empty later ids
    and caps line/frame accumulation; user probe and progressive oracle
    require mandatory frame ids; the real-media evidence parser validates
    payload protocol/captureId/eventId/kind, and desktop reconnect fixtures
    use canonical captureId/sequence ids. The external consumer gate remains
    unchecked.
16. **Post-5b5aa3c final lifecycle hardening**: completed in the containing
    phase commit; native stream cancellation keeps a pending per-request
    cancellation map so a cancel observed before registration or after
    teardown cannot leave an SSE request running uncancelled; the user PDF
    probe clears every per-read deadline timer via an abortable deadline; the
    Angular SSE parser caps lines by UTF-8 byte length (including surrogate
    pairs) while preserving split CRLF/multiline framing; runtime persistence
    rejects symlink/reparse record directories and in-root aliases on load
    and before every access; startup recovery quarantines event-log sequence
    gaps instead of repairing and continuing; SSE subscription/replay/status
    setup re-reads terminal state after subscriber registration and closes on
    terminal events behind the client cursor so a terminal transition cannot
    leave an empty active heartbeat stream; the Angular capture-operation
    decoder and native/desktop recovery matching validate the full v2
    operation contract (kind, status, revisions, progress, timestamps,
    completedAt/terminal equivalence, source and error shapes) plus
    request/source correlation. The external consumer gate remains unchecked.
17. **Post-59bcbf5 final lifecycle hardening**: completed in the containing
    phase commit; bounded native cancellation state validates request ids,
    Tauri transaction cleanup revalidates no-symlink containment, runtime
    result persistence and terminal event publication share one repository
    lock, Angular/native/probe SSE readers reject malformed UTF-8 and bounded
    segment/frame payloads, and the route drains a terminal event queued after
    the replay snapshot instead of returning an empty stream. The external
    consumer gate remains unchecked.

Each phase must have an explicit path list, its own review, and its own
verification result. Revert consumers before reverting the runtime cutover;
revert the deletion commit before reverting the deprecation/cutover phases.

## Auditable phase evidence

The phase commits below are the reviewed path groups. Every commit was created
only after `git diff --cached --name-only`, `git diff --cached --stat`, and
`git diff --cached --check` were inspected; unrelated dirty paths stayed
unstaged. The final closeout review started from `1db5624`; the containing
phase commit records the narrow fixes and final local verification below.

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

- Post-`d3bf3de` hardening (the containing phase commit) — runtime event
  identity, ingestion recovery/limits, Angular response decoding, and the
  real Ollama active-SSE smoke. The focused and full verification floor for
  that phase passed before this closeout.
- Post-`1db5624` final closeout (the containing phase commit) — finalize
  upload-limit mapping, consumer request-ID validation/recovery, and the live
  reconnect terminal-race gate. Focused verification passed: runtime finalize
  API 1 passed (20 deselected, 1 warning), Angular recovery 1 passed (95
  skipped), native request-ID validation 1 passed, and the live-reconnect
  smoke filter passed 5 tests. Full local verification passed: runtime 327
  passed/1 skipped/1 warning; Angular 96 passed; tools 21 passed; workbench
  51 passed; Tauri 47 passed; desktop package QA 201 passed/2 skipped;
  deterministic smoke and 4 Playwright E2E tests passed. Runtime contracts,
  Angular async-boundary/lint/typecheck, desktop cargo fmt/check, contract
  consistency, tools/workbench lint/typecheck, and `git diff --check` passed;
  unrelated dirty paths remain unstaged. The private engine-bearing Ollama
  smoke remains opt-in and was not synthesized for this local verification.
- Post-`695567b` ingestion open-recovery (the containing phase commit) —
  runtime by-client-request ingestion lookup, Angular/native lost-open-response
  recovery, and bounded-orphan documentation. Focused verification passed:
  runtime streaming API/repository 40 passed, Angular client suite 99 passed,
  native `runtime_client` 26 passed. Full local verification passed: runtime
  329 passed/1 skipped/1 warning; Angular 99 passed; tools 21 passed; workbench
  51 passed; Tauri 50 passed; desktop package QA 201 passed/2 skipped;
  deterministic smoke and 4 Playwright E2E tests passed. Runtime
  lint/typecheck/contracts, Angular async-boundary/lint/typecheck, desktop
  cargo fmt/check, contract consistency, tools/workbench lint/typecheck, and
  `git diff --check` passed; unrelated dirty paths remain unstaged. The private
  engine-bearing Ollama smoke remains opt-in and was not synthesized for this
  local verification.
- Post-`9e6e2b3` final hardening (the containing phase commit) —native
  committed-2xx semantic recovery, same-bounded-id ingestion requests,
  real-media-model-smoke v2 stage mapping, and authoritative source-kind
  rejection. Focused verification passed: runtime streaming API/repository 41
  passed, Angular client suite 100 passed, native `runtime_client` 30 passed,
  real-media-model-smoke plus probe 42 passed/1 skipped. Full local
  verification passed: runtime 330 passed/1 skipped/1 warning; Angular 100
  passed; tools 21 passed; workbench 51 passed; Tauri 54 passed; desktop
  package QA 203 passed/2 skipped; deterministic smoke and 4 Playwright E2E
  tests passed. Runtime lint/typecheck/contracts, Angular
  async-boundary/lint/typecheck, desktop cargo fmt/check, contract
  consistency, tools/workbench lint/typecheck, and `git diff --check` passed;
  unrelated dirty paths remain unstaged. The private engine-bearing Ollama
  smoke remains opt-in and was not synthesized for this local verification.
- Post-`3b61cef` security/protocol hardening (the containing phase commit) —
  Angular recovered-ingestion correlation, native capture-start semantic
  validation/recovery, unterminated-final-SSE rejection, and canonical
  persistence containment. Focused verification passed: runtime streaming
  API/repository 42 passed/3 symlink skips, Angular client suite 102 passed,
  native `runtime_client` 33 passed, probe/real-media parser tests 19 passed.
  Full local verification passed: runtime 331 passed/4 skipped/1 warning;
  Angular 102 passed; tools 21 passed; workbench 51 passed; Tauri 57 passed;
  desktop package QA 203 passed/2 skipped; deterministic smoke and 4 Playwright
  E2E tests passed. Runtime lint/typecheck/contracts, Angular
  async-boundary/lint/typecheck, desktop cargo fmt/check, contract
  consistency, tools/workbench lint/typecheck, and `git diff --check` passed;
  unrelated dirty paths remain unstaged. Symlink regression tests skip when
  the Windows environment cannot create symlinks; the canonical containment
  guard itself is covered by a platform-independent test. The private
  engine-bearing Ollama smoke remains opt-in and was not synthesized for this
  local verification.
- Post-`e166174` final security hardening (the containing phase commit) —
  native/deterministic SSE EOF termination, Angular recovery abort-signal
  propagation, root/category persistence containment, and required native
  capture-start source metadata. Focused verification passed: runtime streaming
  API/repository 42 passed/6 symlink skips, Angular client suite 104 passed,
  native `runtime_client` 34 passed, deterministic/probe/real-media parser
  tests 22 passed. Full local verification passed (final rerun): runtime 331
  passed/7 skipped/1 warning; Angular 104 passed; tools 21 passed; workbench 51
  passed; Tauri 58 passed; desktop package QA 205 passed/2 skipped;
  deterministic smoke and 4 Playwright E2E tests passed. Runtime
  lint/typecheck/contracts, Angular async-boundary/lint/typecheck, desktop
  cargo fmt/check, contract consistency, tools/workbench lint/typecheck, and
  `git diff --check` passed; unrelated dirty paths remain unstaged. One
  unrelated host-structuring API test showed a load-timing provenance flake in
  the first full run and passed in isolation and in the final full rerun.
  Symlink regression tests skip when the Windows environment cannot create
  symlinks; the canonical containment guards are covered by platform-
  independent tests. The private engine-bearing Ollama smoke remains opt-in and
  was not synthesized for this local verification.

- Post-`7909eeb` final lifecycle/security (the containing phase commit) —
  reviewed path groups: `packages/capture-angular/src/lib/http-capture-client.ts`
  and `.spec.ts` (initial open correlation, AbortError preservation);
  `packages/capture-runtime/src/capture_runtime/storage/streaming_repository.py`
  and `tests/test_streaming_repository.py` (leaf-file containment, metadata-ID
  startup validation); `apps/capture-workbench-desktop/scripts/deterministic-http.ts`
  and `.test.ts` (incomplete-final-physical-line rejection);
  `.agents/SPECS`, `.agents/TODOS`, `.agents/DECISIONS` (evidence).
  Focused verification passed: runtime streaming API/repository 44 passed/8
  symlink skips, Angular client suite 107 passed, deterministic/probe/
  real-media parser tests 25 passed. Full local verification passed: runtime
  333 passed/9 skipped/1 warning; Angular 107 passed; tools 21 passed;
  workbench 51 passed; Tauri 58 passed; desktop package QA 208 passed/2
  skipped; deterministic smoke and 4 Playwright E2E tests passed. Runtime
  lint/typecheck/contracts, Angular async-boundary/lint/typecheck, desktop
  cargo fmt/check, contract consistency, tools/workbench lint/typecheck, and
  `git diff --check` passed; unrelated dirty paths remain unstaged. Symlink
  regression tests skip when the Windows environment cannot create symlinks;
  metadata-ID startup validation is platform-independent. Desktop cancellation
  into native upload/start is documented as bounded by timeouts plus idempotent
  recovery because the Tauri bridge has no upload/start cancellation channel.
  The private engine-bearing Ollama smoke remains opt-in and was not
  synthesized for this local verification.

- Post-`c762e02` final lifecycle hardening (the containing phase commit) —
  reviewed path groups: `packages/capture-angular/src/lib/http-capture-client.ts`
  and `.spec.ts` (open-status decoding, cancellation-before-id recovery);
  `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs`
  (native open-status validation); `apps/capture-workbench/src/app/services/
  desktop-workspace.store.ts` and `.spec.ts` (durable recovery correlation);
  `packages/capture-runtime/src/capture_runtime/storage/streaming_repository.py`
  and `tests/test_streaming_repository.py` (initialize ordering, replay
  validation); `apps/capture-workbench-desktop/scripts/progressive-audio-oracle.ts`
  and `.test.ts` (EOF rejection); `.agents/SPECS`, `.agents/TODOS`,
  `.agents/DECISIONS` (evidence). Focused verification passed: runtime
  streaming API/repository 47 passed/8 symlink skips, Angular client suite 109
  passed, workbench 54 passed, native `runtime_client` 36 passed,
  oracle/deterministic/probe/real-media parser tests 29 passed. Full local
  verification passed: runtime 336 passed/9 skipped/1 warning; Angular 109
  passed; tools 21 passed; workbench 54 passed; Tauri 60 passed; desktop
  package QA 209 passed/2 skipped; deterministic smoke and 4 Playwright E2E
  tests passed. Runtime lint/typecheck/contracts, Angular
  async-boundary/lint/typecheck, desktop cargo fmt/check, contract
  consistency, tools/workbench lint/typecheck, and `git diff --check` passed;
  unrelated dirty paths remain unstaged. Symlink regression tests skip when
  the Windows environment cannot create symlinks. The private engine-bearing
  Ollama smoke remains opt-in and was not synthesized for this local
  verification.

- Post-`f9827bf` final bounded security/protocol (the containing phase commit)
  —reviewed path groups: `apps/capture-workbench-desktop/src-tauri/src/
  runtime_client.rs` (SSE size accounting, required frame id);
  `apps/capture-workbench-desktop/src-tauri/src/library.rs` (canonical
  no-symlink containment for document reads/writes/exports/deletes);
  `packages/capture-angular/src/lib/sse-capture-event-stream.ts` and
  `.spec.ts` (required frame id); `.agents/SPECS`, `.agents/TODOS`,
  `.agents/DECISIONS` (evidence). Focused verification passed: native/library
  lib tests 68 passed, Angular client suite 110 passed. Full local verification
  passed: runtime 336 passed/9 skipped/1 warning; Angular 110 passed; tools 21
  passed; workbench 54 passed; Tauri 68 passed; desktop package QA 209
  passed/2 skipped; deterministic smoke and 4 Playwright E2E tests passed.
  Runtime lint/typecheck/contracts, Angular async-boundary/lint/typecheck,
  desktop cargo fmt/check, contract consistency, tools/workbench
  lint/typecheck, and `git diff --check` passed; unrelated dirty paths remain
  unstaged. Symlink-specific Tauri/library tests run when the OS permits
  symlink creation; the canonical containment guards are platform-independent.
  The private engine-bearing Ollama smoke remains opt-in and was not
  synthesized for this local verification.

- Post-`8c98a32` final hardening (the containing phase commit) —reviewed
  path groups: `apps/capture-workbench-desktop/src-tauri/src/library.rs`
  (pre-mutation root validation, unique atomic temp writes, containment);
  `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs`
  (source reopen/read TOCTOU guard); `packages/capture-runtime/src/capture_runtime/
  storage/streaming_repository.py` and `tests/test_streaming_repository.py`
  (replay gap rejection, subscriber registration order); `packages/capture-angular/
  src/lib/sse-capture-event-stream.ts` and `.spec.ts` (empty-later-id, caps);
  `tools/user-pdf-ocr-probe.mts` and `.test.ts`, `apps/capture-workbench-desktop/
  scripts/progressive-audio-oracle.ts` and `.test.ts` (mandatory frame ids);
  `apps/capture-workbench-desktop/scripts/real-media-smoke.ts` and `.test.ts`
  (payload identity validation); `apps/capture-workbench/src/app/services/
  desktop-workspace.store.spec.ts` (canonical reconnect fixtures);
  `.agents/SPECS`, `.agents/TODOS`, `.agents/DECISIONS` (evidence). Focused
  verification passed: native/library lib tests 69 passed, Angular client
  suite 113 passed, workbench 54 passed, runtime repository 26 passed/8
  symlink skips, node parser/probe/oracle/real-media tests 32 passed. Full
  local verification passed: runtime 338 passed/9 skipped/1 warning; Angular
  113 passed; tools 22 passed; workbench 54 passed; Tauri 69 passed; desktop
  package QA 212 passed/2 skipped; deterministic smoke and 4 Playwright E2E
  tests passed. Runtime lint/typecheck/contracts, Angular
  async-boundary/lint/typecheck, desktop cargo fmt/check, contract
  consistency, tools/workbench lint/typecheck, and `git diff --check` passed;
  unrelated dirty paths remain unstaged. Symlink-specific tests run when the
  OS permits symlink creation; canonical containment and replay-corruption
  guards are platform-independent. The private engine-bearing Ollama smoke
  remains opt-in and was not synthesized for this local verification.

- Post-`5b5aa3c` final lifecycle hardening (the containing phase commit) —
  reviewed path groups: `apps/capture-workbench-desktop/src-tauri/src/state.rs`
  (pending-cancellation preservation and race tests);
  `apps/capture-workbench-desktop/src-tauri/src/runtime_client.rs` (full v2
  operation contract validation for start/recovery/by-client-request/get
  paths); `tools/user-pdf-ocr-probe.mts` and `.test.ts` (per-read
  deadline-timer cleanup); `packages/capture-angular/src/lib/
  sse-capture-event-stream.ts` and `.spec.ts` (UTF-8 byte line caps);
  `packages/capture-angular/src/lib/http-capture-client.ts` and `.spec.ts`
  (full v2 operation contract and request/source correlation);
  `apps/capture-workbench/src/app/services/desktop-workspace.store.ts` and
  `.spec.ts` (desktop recovery full-contract matching);
  `packages/capture-runtime/src/capture_runtime/storage/streaming_repository.py`,
  `packages/capture-runtime/src/capture_runtime/routes/streaming.py`,
  `packages/capture-runtime/tests/test_streaming_repository.py`, and
  `packages/capture-runtime/tests/test_streaming_api.py` (record-directory
  symlink/alias rejection, startup gap quarantine, terminal-race-safe SSE
  setup); `.agents/SPECS`, `.agents/TODOS`, `.agents/DECISIONS` (evidence).
  Focused verification passed: runtime streaming API/repository 52 passed/10
  symlink skips, Angular client suite 120 passed, workbench 56 passed, native
  state/runtime-client lib tests 73 passed, tools probe tests 11 passed. Full
  local verification passed: runtime 341 passed/11 skipped/1 warning; Angular
  120 passed; tools 24 passed; workbench 56 passed; Tauri 73 passed; desktop
  package QA 214 passed/2 skipped; deterministic smoke and 4 Playwright E2E
  tests passed. Runtime lint/typecheck/contracts, Angular
  async-boundary/lint/typecheck, desktop cargo fmt/check, contract
  consistency, tools/workbench lint/typecheck, and `git diff --check` passed;
  unrelated dirty paths remain unstaged. Symlink regression tests skip when
  the Windows environment cannot create symlinks; canonical containment and
  gap-quarantine guards are platform-independent. The private engine-bearing
  Ollama smoke remains opt-in and was not synthesized for this local
  verification.

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
- After the final local closeout, an active-source residual scan finds no
  `/v1/captures` or
  `CaptureJobV1` capture-engine references.
- A lost open-ingestion response can be recovered through the by-client-request
  ingestion lookup; unreferenced ingestions remain bounded by the existing
  two-hour expiry/prune backstop.
- Declared capture kind is authoritative; content that sniffs as a different
  kind fails closed with `source_kind_mismatch` instead of being routed
  silently through a different extractor.
- Lost-open recovery and capture-start responses are correlated against the
  original request before upload or recovery-state persistence.
- SSE parsers reject an unterminated final frame at EOF; persistence rejects
  symlinked ingestion descendants outside the canonical persistence root.
- Native capture-start responses require source metadata for any status that
  would persist or recover a capture identity.
- Angular recovery lookups carry the caller AbortSignal.
- Initial open-ingestion responses must correlate protocol, identity,
  metadata, and status before upload.
- Persistence rejects symlinked leaf files and metadata IDs that do not match
  their directory basename.
- SSE parsers reject incomplete final physical lines, including comments.
- Initial and recovered ingestion responses must be `open` before upload;
  finalized/closed ingestions fail closed and are never deleted as uploadable.
- Pending desktop recovery accepts only captures whose ingestionId and source
  metadata match the durable recovery record.
- Replay reads validate capture identity, canonical event id, and monotonic
  sequence, failing closed on corruption.
- Native SSE size accounting counts header-prefix body bytes exactly once
  against the 60 MiB limit.
- Tauri library document access rejects symlinked items/document ancestors and
  enforces canonical containment for reads, writes, exports, and deletes.
- Angular and native SSE parsers require a non-empty frame id matching the
  event sequence.
- Tauri library validates roots before mutation and uses unique atomic temp
  files; native source reopen/read revalidates canonical containment.
- Runtime replay rejects sequence gaps and registers subscribers only after a
  clean replay load.
- Real-media evidence parsing validates payload protocol, captureId, eventId,
  and kind.
- Native SSE cancellation is preserved across begin/finish races so teardown
  cannot leave an SSE request running.
- Probe per-read deadline timers are always cleared.
- Angular SSE line caps use UTF-8 byte length while preserving framing.
- Runtime load/access rejects symlink/reparse record directories and in-root
  aliases.
- Startup recovery quarantines event-log sequence gaps instead of continuing
  at the next sequence.
- Terminal transitions cannot leave an empty active heartbeat SSE stream.
- Angular/native/desktop operation decoders validate the full v2 operation
  contract and request/source correlation.

## Test plan

- Python contract, route, repository, live subscriber, replay, reconnect,
  cancellation, cleanup, host-structuring, and all-media integration tests.
- Ingestion lookup by client request, including recovery, confirmed-absence,
  and unavailable-lookup outcomes.
- Native committed-2xx semantic recovery, 128-character request-id bounds, v2
  status/stage mapping, and source-kind/content mismatch rejection.
- Angular/native/probe unterminated-final-SSE rejection and canonical
  persistence containment (load, source access, writes, cleanup).
- Native/deterministic SSE EOF termination, recovery abort-signal propagation,
  and root/category persistence containment.
- Initial open-ingestion correlation/status, leaf-file containment, metadata-ID
  startup validation, and incomplete-final-physical-line rejection.
- Open-status decoding, cancellation-before-id recovery, durable recovery
  correlation, initialize-before-create containment ordering, replay
  validation, and progressive-audio oracle EOF rejection.
- SSE size-accounting boundary tests, Tauri library containment guards, and
  required frame-id regressions.
- Pre-mutation root validation, unique atomic temp writes, source TOCTOU
  guards, replay gap/subscriber-order tests, parser caps, mandatory probe/
  oracle ids, and real-media payload identity tests.
- Native cancellation race, probe deadline-timer cleanup, UTF-8 line caps,
  record-directory alias rejection, startup gap quarantine, terminal-race SSE
  tests, and full v2 operation contract/correlation regressions.
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
