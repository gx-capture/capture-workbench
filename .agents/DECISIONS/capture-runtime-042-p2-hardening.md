# Capture Runtime 0.4.2 Phase 2 hardening decisions

Status: canonical rationale record, documentation-only at the 2026-09-09
checkpoint. The [Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md)
owns the detailed policy, interface records, GPU truth table, acceptance
sequence, and D0-D8 release gates. The [TODO](../TODOS/capture-runtime-042-p2-hardening.md)
owns executable slice gates; the [GUIDE](../GUIDES/staged-ocr-delivery-workflow.md)
owns fresh-worker procedure.

## Checkpoint and authority

PR #39 remains an engineering checkpoint at
`c6d2140e233de70734005713427f77f92414f415`; its deterministic CI is green but
it is not merged. Phase 1 is complete only at the local-probe tier: all three
projects passed real local-package OCR in Capture -> Cert -> LAW order. That is
not published/release evidence and does not establish an official `0.4.2`
package. No current-HEAD Phase 2 JPEG/PDF, GPU, cleanup, candidate, or
publication evidence is claimed here.

This checkpoint edits the four canonical Phase 2 documents and the narrowly
scoped historical banners listed in the TODO. It writes no feature code, does
not alter consumer/P1/PDF/acceptance/contract bodies, runs no model journey,
and preserves untracked `.github/copilot-instructions.md` and
`.github/instructions/`.

## Change-mode checkpoint

```text
Change mode: mixed, with edit-first ownership
Existing owner: the four Phase 2 SPEC/DECISION/TODO/GUIDE files
Delete candidates: obsolete adapter-0/host-override, embedded/hybrid OCR,
  stale-version, duplicate cleanup, and duplicate acceptance policy
New owner needed?: no for this documentation checkpoint; a future slice must
  stop for explicit discovery if no existing owner fits
Token posture: compact quality
Verification floor: read-only Markdown/link checks, target inventory, and
git diff --check; no feature or model execution in this task
```

## Decisions that add to the SPEC

1. The producer owns OCR, compute, model provenance, process lifecycle,
   acceptance, and version identity. Cert Prep and GX Law Prep receive semantic
   adapters and own durable domain data only.
2. Deepening is replacement: callers and tests cross the external interface;
   internal seams exist only for platform, transport, and test adapters. Every
   established module records inputs/results, invariants/order, typed errors,
   configuration, performance/resources, adapters, and a deletion test.
3. `OcrPipeline` and `OwnedRuntimeSession` have no chosen method name or type
   signature until at least three independent fresh reviewers publish
   materially different Design-It-Twice alternatives. Each alternative must
   include interface and usage, hidden implementation, dependency categories
   and adapters, trade-offs, and failure/cancellation behavior. Root grills one
   question at a time, compares depth/locality/seam/failure/cancellation/
   migration, then commits the chosen contract before exact-HEAD dual review.
4. The release state machine is D0 DocsCommitted -> D1 DesignReviewed -> D2
   ImplementationAuthorized (no handoff commit) -> D3 CandidateBuilt -> D4
   CandidateAccepted -> D5 PublishedImmutable -> D6 DownloadBackVerified ->
   D7 PublishedAccepted -> D8 StablePointerMoved. Every transition binds exact
   bytes and hashes; a failure stops, preserves evidence, and retains rollback.
5. Any content commit invalidates an earlier review artifact. D1 must record
   `git rev-parse HEAD` after the documentation commit plus external check/PR
   metadata; a remembered SHA is never a review binding.
6. Historical GPU notes remain evidence only. Their adapter-0 and host override
   text is superseded by the SPEC's sole compute truth table; the bodies remain
   unchanged so their provenance is not rewritten.

## Rejected framings

- Treating the green PR checkpoint or completed Phase 1 local probe as a
  published package or a D3-D8 result.
- Preselecting a `run`-shaped interface for either unresolved module before the
  required independent alternatives and comparison.
- Adding a coordinator around an existing shallow path instead of replacing it
  behind a deep interface and deleting superseded policy/tests.
- Letting timeout, exception, unknown hardware, or incomplete identity choose
  CPU; the SPEC truth table requires indeterminate/unavailable.
- Retrying another GPU or CPU after a selected DirectML failure.
- Letting hosts choose GPU ordinals, keep process handles, or own cleanup.
- Moving a stable pointer before published download-back and repeated
  sequential consumer acceptance.

## Review and rollback

Standards review checks repository conventions, file scope, privacy, generated
file discipline, portable links, command validity, and commit scope.
Specification review checks OCR-only semantics, public-contract compatibility,
GPU truth, lifecycle, sequence, evidence truthfulness, version identity, and
rollback. Neither report is a gate until it names the exact current HEAD after
the documentation commit and its external check/PR metadata.

Rollback is an additive revert of the named documentation or implementation
slice to its prior reviewed checkpoint. Never reset, rebase, amend, or rewrite
shared history; retain failed evidence and durable caches; never mix `0.4.1`
and `0.4.2` assets. This record claims no new Phase 2 test, model run,
candidate, release, or publication.
