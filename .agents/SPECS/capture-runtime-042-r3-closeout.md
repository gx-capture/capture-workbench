# Capture Runtime 0.4.2 public R3 closeout

## Scope and baseline (2026-09-21)

Continue the existing producer implementation before migrating Cert Prep or
LAW to it. The source baseline is
`12fe94c60970876413628d619b732c59fae67585` on
`docs/capture-runtime-042-phase2`, including the pre-existing dirty R3 work in
`packages/capture-sidecar-launcher/src/{journal_store,lib,prepare,process,staging}.rs`,
`tests/fixtures/activation-probe/src/main.rs`, and
`tests/public_r3_lifecycle.rs` (paths relative to that package).
Preserve those changes; this slice repairs and verifies them rather than
attributing the entire diff to this continuation.

The canonical [Phase 2 specification](capture-runtime-042-p2-hardening.md)
still owns R3 policy. Historical D0/D1 records do not approve this HEAD or
working tree. Fresh bounded specification and standards reviews precede
repairs, followed by fresh implementation reviewers. These records do not
constitute full D1 approval or advance D3-D8.

## Interface and acceptance

Keep producer ownership behind `prepare_group`, `activate_group`, `observe`,
and `close`. A successful activation owns the complete group. Failed
activation or close retains the exact native/staging/journal cleanup owner;
ambiguous or late CAS results must retain the complete candidate for exact
read-back and bounded retry. No error, cancellation, or drop may fabricate a
Terminal proof. Cleanup must preserve unrelated processes and foreign files.

Tests must cover journal contention, cancellation before commit, expiry after
durable read-back, successful one-root and multi-root public activation and
close, failed activation cleanup, and public retry ownership. Fix tests only
when the test injects a nondeterministic or obsolete assumption; do not weaken
the expected ownership, durable state, or proof assertions.

The initial uncached launcher suite has 311 passing and two failing tests:
`running_pre_cas_cancellation_under_lock_keeps_launching_owner` and
`running_deadline_after_durable_readback_retains_candidate_and_native_owner`.
The first panics at `launcher.rs:6654` with Running journal CAS failure; the
second at `process.rs:11218` expecting a retained candidate after cleanup.
Diagnosis must establish whether each is an implementation or fixture defect.

Fresh bounded reviews approved proceeding with repairs and identified three
additional blockers: failed readiness must invalidate live authority;
ambiguous reconciliation with the exact predecessor must remain retryable;
confirmed late Closing/Terminal commits must reject predecessor replay. Keep
candidate disposition with the complete candidate across every retained error.
The old cancellation test asserts an obsolete diagnostic string; authorize
`src/launcher.rs` solely for replacing that assertion with typed outcome and
unchanged-journal/ownership checks. The fixture listener must span lifecycle
assertions through an explicit bounded hold or gate rather than an idle timer.

The first post-repair review found an additional state-transition defect:
an ambiguous candidate adopted by exact durable read-back must immediately
become confirmed in retained owner context, before a later timeout or other
fallible operation. A timeout after adoption must never enable predecessor
replay. Cover Terminal, Closing, and Reconcile adoption paths explicitly.
The public fixture's exact-handle/authorization wait also needs reproducible
synchronization; a successful isolated retry is not enough. The Nx
`packages/capture-sidecar-launcher/project.json` cargo-test environment is an
authorized test-owner extension for a reviewed concurrency bound, preserving
every test, internal race scenario, deadline, and proof assertion.

## Exclusions and consumer dependencies

Do not migrate desktop hosts, implement a substitute RequestRef operation,
change contracts/version pins, construct a candidate, publish, move a stable
pointer, or repair CI in this slice. The committed RequestRef implementation
is a private metadata codec, not `start_or_get` or an authenticated SDK.

Cert Prep baseline `948f875a91ac032b3e7dfda0e0d9bc3de9a63b07` has schema-3
mapping and candidate guards but active 0.4.1 pins. Its consumer migration
requires delivered public SDKs and an immutable D3 candidate/ledger.
LAW baseline `3c2c3c97d074d760577f99039ec795ded3c7e47e` has durable receipt and
maintenance foundations but its live Python OCR adapter still uses capture
IDs. Its next orchestration slice requires the exact public RequestRef SDK.
Python owns producer projection validation/mapping; Java owns mapped LAW
envelope/domain validation. Neither consumer may invent a replacement API.

## Verification

Use the resolved Nx targets in the [slice TODO](../TODOS/capture-runtime-042-r3-closeout.md).
Unit/native fixture and compatibility results remain local implementation
evidence; they prove neither installed OCR nor release readiness.
