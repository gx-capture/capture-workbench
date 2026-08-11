# Capture Streaming SSE Migration TODO

This TODO is active-only. Completed evidence belongs in the spec/decision
records or in the eventual phase commit notes.

## P0 — contract and planning gate

- [ ] Decide v2 widening versus successor protocol version.
  Verify: decision record names the selected version and compatibility impact.

- [ ] Define the media-neutral event/state machine, including host structuring,
      cancel, failure, terminal, heartbeat, replay, and resync semantics.
  Verify: contract tests cover every event type and invalid transition.

- [ ] Generate and check synchronized Python/TypeScript contracts and manifest.
  Verify: `pnpm nx run capture-runtime:generate-contracts` followed by
  `pnpm nx run capture-runtime:check-contracts --skip-nx-cache`.

## P1 — Python runtime

- [ ] Generalize ingestion validation and the v2 capture owner to PDF, image,
      and audio while preserving media-specific extractor adapters.
  Verify: focused streaming repository/service/API tests for all three kinds.

- [ ] Implement live authenticated SSE with durable replay, heartbeat,
      disconnect cleanup, bounded queues, and `Last-Event-ID` deduplication.
  Verify: live subscriber, reconnect, replay-gap, ordering, and cancellation
      tests; no snapshot-only implementation remains.

- [ ] Add v2 host-structuring commit/failure handoff and terminal events.
  Verify: valid candidate, invalid candidate, idempotency retry, and failure
      reconciliation tests.

## P2 — Angular hybrid client

- [ ] Add a fetch-stream SSE parser that returns cold RxJS Observables and
      aborts on unsubscribe.
  Verify: parser framing, malformed input, authorization, teardown, and async
      boundary tests.

- [ ] Replace capture progress polling with event reduction while retaining
      RxJS/rxResource boundaries for existing one-shot flows.
  Verify: Angular workflow/store tests prove no timer polling is needed for
      capture progress.

- [ ] Update package, framework-neutral consumer, and documentation contracts.
  Verify: `pnpm nx run capture-angular:clean-consumer-smoke --skip-nx-cache`.

## P3 — Tauri and desktop cutover

- [ ] Route PDF, image, and audio capture through v2 and select a live event
      bridge compatible with the Angular RxJS layer.
  Verify: `pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache` and
      deterministic all-media contract tests.

- [ ] Remove the desktop audio-only branch and update fixtures/tools/e2e.
  Verify: `pnpm nx run capture-workbench-desktop:smoke-deterministic --skip-nx-cache`
      and `pnpm nx run capture-workbench-e2e:e2e --skip-nx-cache`.

## P4 — deprecation

- [ ] Add an explicit `/v1/captures` deprecation signal and migration note.
  Verify: route/header tests and a first-party residual scan show no v1 caller.

- [ ] Coordinate public package and sibling-consumer migration before selecting
      the sunset release.
  Verify: `rg -n -i '(/v1/captures|CaptureJobV1)' C:\\software-dev\\cert-prep C:\\software-dev\\gx.law-prep`
      is clean for active consumers, or an explicit breaking-release approval
      is recorded before deletion approval. Do not edit sibling repositories in
      this task without renewed authorization.

## P5 — deletion

- [ ] Delete the v1 capture routes, service, repository, types, generated
      residue, polling resource, desktop commands, fixtures, and obsolete tests.
  Verify: active-source `rg` finds no `/v1/captures` or `CaptureJobV1` capture
      references.

- [ ] Run the final proportional verification floor and independent deletion
      review.
  Verify: all commands listed in the migration spec pass with
      `--skip-nx-cache`, plus `git diff --check` and cached-path inspection.

## Explicitly blocked evidence

- Real engine-bearing OCR/Whisper smoke remains opt-in and depends on the
  existing approved catalog and private fixture gates. Do not synthesize missing
  fixtures or make that unrelated release gate part of ordinary P0-P5 CI.
