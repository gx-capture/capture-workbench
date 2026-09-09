# Capture Runtime 0.4.2 Phase 2 hardening decisions

Status: canonical design record, documentation-only at the 2026-09-09
checkpoint. The policy details live in the [Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md);
this record explains ownership, choices, rejected approaches, and review gates
without creating a second GPU/OCR policy.

## Checkpoint and authority

PR #39 at `c6d2140e233de70734005713427f77f92414f415` has deterministic CI green
but is not merged. Phase 1 is **complete at the local-probe tier**: all three
projects passed real local-package OCR in the ordered Capture -> Cert -> LAW
sequence. This is not published/release evidence and does not mean an official
`0.4.2` package exists. No current-HEAD Phase 2 real JPEG/PDF OCR, GPU, or
cleanup evidence is recorded here; there is no immutable candidate or `0.4.2`
publish evidence. PR #39 and current heads are engineering/release freshness
facts only and do not negate Phase 1 completion. Phase 2 entry is allowed at
documentation/design/review; implementation slices follow the approved TODO
gates. Phase 2 promotion requires architecture, version, performance, and
lifecycle hardening, then an immutable candidate, then sequential Capture ->
Cert -> LAW tests with a formal/published `0.4.2` package. Promotion waits for
all of those gates; no package or promotion is claimed here.

The current task uses existing owner files only. It does not write feature
code, alter P1/PDF/acceptance/contract files, run model-enabled acceptance, or
publish. It preserves untracked `.github/copilot-instructions.md` and
`.github/instructions/`.

## Change-mode checkpoint

```text
Change mode: mixed
Existing owner: the four existing Phase 2 SPEC/DECISION/TODO/GUIDE files
Delete candidates: old adapter-0/ordinal policy; embedded and hybrid OCR paths;
  v0.3/v0.4.1 literals; duplicate session-status/host cleanup and acceptance runners
New owner needed?: no for this documentation checkpoint; only a future slice
  may create a module/command when no existing owner fits
Token posture: compact quality
Verification floor: Markdown/relative-link read-only checks and git diff --check;
  no implementation or CI execution in this task
```

The supersession map in the SPEC is canonical. Candidates are named so a fresh
worker can remove them only after a deletion test, replacement public-seam
tests, and an additive focused commit. No broad cleanup is implied.

## Chosen decisions

1. **Phase 2 starts with version identity.** One generated inventory and one
   read-only check/explicit upgrade command own runtime `0.4.2`, API `2.0`,
   schema/contract identity, TypeScript/Python/Java/Rust clients, desktop and
   model catalogs, manifests, locks, pnpm 12, Capture/Cert Nx `23.1.2`, and
   consumer expectations. Mixed 0.4.1/0.4.2 or stale literals fail. Local E2E
   has tiered identity; release acceptance has strict immutable-byte identity.
2. **Producer owns policy.** `OcrPipeline`, `OcrComputePlan`,
   `ModelSourceSnapshot`, `OwnedRuntimeSession`, `AcceptanceRunner`, and
   `VersionInventory` are producer-owned deep modules. Hosts own adapters and
   durable domain persistence only; they do not store Paddle policy, model
   paths, process cleanup policy, or GPU indexes.
3. **OCR remains OCR-only.** PDFium rasterizes every selected page and
   PaddleOCR recognizes it. Embedded PDF text is ignored, with no hybrid or
   LLM route. Real acceptance uses private JPEG and PDF page 1, in serial
   Capture -> Cert -> Law order, with model memory and owned processes cleaned
   before the next app.
4. **Compute truth stays fail-closed.** The SPEC truth table is the one GPU
   policy: usable dGPU, usable iGPU, then noticed CPU only after affirmative
   positive-unavailable/provider-absent evidence. Indeterminate is unavailable,
   not CPU. Selected DML construction/assignment/inference failure has no CPU
   retry. Capture's RTX 4060 proof precedes the final Phase 2 Cert/Law run; the ordered
   Phase 1 local-probe acceptance does not replace the Phase 2 release gates.
5. **Deepening is replacement, not layering.** Each module has a small
   interface containing invariants, ordering, error, and performance behavior;
   private internal seams; justified production and test adapters; dependency
   categories; and a deletion test. Old shallow policy/tests are replaced by
   tests at the deep module interface.
6. **Design-It-Twice precedes implementation.** `OcrPipeline` and
   `OwnedRuntimeSession` each require three materially different alternatives,
   comparison on depth/locality/seam/failure/cancellation/migration, and
   exact-HEAD review before actual implementation.
7. **Session lifecycle has one owner.** One `OwnedRuntimeSession` owns one
   launch attempt, suspended root, no-breakaway Job, monitoring, normal close,
   startup failure, root crash, host termination, descendants, retries, and
   terminal proof. Baseline processes survive. Next-start reconciliation
   retains durable caches and removes only identity-proven stale state. No
   name-kill exists.
8. **Measure first.** A no-behavior-change baseline records per-fixture
   memory, latency, raster, model init, serialized inference, first-page, and
   cleanup numbers. Later optimization changes one metric at a time and each
   fixture must pass independently; averages cannot hide failure.
9. **Proof is private and sanitized.** Manifests/proofs include hashes, CER
   numbers, stable anchor IDs/counts, provenance, and cleanup. They exclude raw
   OCR/truth text, tokens, local paths, user/machine names, and arbitrary
   diagnostics. OCR execution proof and host structuring success are separate
   terminals.
10. **Release identity is immutable.** A producer creates a candidate without
    moving a stable pointer. Consumers verify the same bytes before
    publication; published consumers download back and verify exact bytes,
    versions, manifests, locks, and hashes. The current checkpoint has no
    candidate or publication authorization.
11. **Review is a delivery gate.** Design docs -> serious grill -> approved
    slice -> sprint backlog -> TDD -> two independent review axes -> local
    staging -> candidate/release. A new commit invalidates prior exact-HEAD
    approvals. Sol Ultra is read-only and only for the same blocker after more
    than three consecutive failures.

## Rejected decisions

- **Confusing local-probe completion with release:** Phase 1 is complete at the
  local-probe tier, but deterministic CI/current-head facts are not published
  real OCR/GPU/cleanup evidence; no immutable candidate or publish exists.
- **Host-side GPU selection or default ordinal 0:** policy can diverge from
  actual inference. The producer's `OcrComputePlan` owns dGPU -> iGPU -> CPU.
- **Treating timeout/exception/unknown as unavailable:** absence of evidence is
  not affirmative unavailability; unresolved evidence blocks readiness.
- **Retrying another GPU or CPU after selected DML failure:** it hides a broken
  selected path and falsifies provenance.
- **Passing high-performance rank as ORT device id:** the preference order and
  ordinary `EnumAdapters1` order differ; exact LUID joins them and ORT receives
  the ordinary ordinal only.
- **Embedding device identity in API `2.0` or OCR schema `3`:** a private,
  sanitized proof gives the required acceptance evidence without SDK churn.
- **Adding another OCR coordinator/session-status or acceptance runner:** it
  fails the deletion test and spreads policy. Deepen the existing owner by
  replacement.
- **Keeping embedded/hybrid/v0.3 paths as compatibility fallbacks:** they
  violate OCR-only truth or version identity. Retire them through the map in
  the SPEC after replacement proof.
- **Name-killing or deleting all caches on startup:** it can terminate baseline
  processes and destroy durable assets. Reconcile exact identity only.
- **Optimizing from intuition or aggregate averages:** first capture a
  reproducible per-fixture baseline and preserve semantic gates.

## Review and rollback

Standards review must check repository conventions, file scope, security and
privacy, generated-file discipline, markdown links, commands, and commit
scope. Specification review must check OCR-only semantics, public-contract
compatibility, GPU truth, lifecycle matrix, sequence, evidence truthfulness,
version identity, and rollback. Grill findings are handled one question at a
time. Neither review is approval until tied to the exact documentation commit.

Rollback is an additive revert of the focused slice to the prior reviewed
checkpoint. Never reset/checkout shared work, rewrite historical evidence, or
mix 0.4.1 and 0.4.2 identities. This decision record claims no new Phase 2
test/model run, candidate, release, or publication; it records the completed
Phase 1 local-probe result without promoting it to release evidence.
