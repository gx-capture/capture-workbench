# Staged OCR delivery workflow (Phase 2 worker guide)

This is the fresh-worker procedure for Capture Runtime 0.4.2 Phase 2. The
[Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md) is the sole policy
source. The [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md) records
rationale, and the [TODO](../TODOS/capture-runtime-042-p2-hardening.md) is the
executable slice checklist. P1/PDF/acceptance/contract documents are linked
context, not alternate Phase 2 policy.

## Checkpoint first: 2026-09-09

PR #39 at `c6d2140e233de70734005713427f77f92414f415` is a green deterministic-CI
engineering checkpoint and remains unmerged. Phase 1 is complete only at the
local-probe tier: Capture -> Cert -> LAW passed real local-package OCR in that
order. This is not published/release evidence and does not establish an
official `0.4.2` package. No current-HEAD Phase 2 JPEG/PDF, GPU, cleanup,
candidate, or publication result is claimed.

This documentation checkpoint preserves untracked
`.github/copilot-instructions.md` and `.github/instructions/`. It does not edit
code, consumers, CI, candidate bytes, release pointers, or published artifacts.

## Fresh-worker procedure

1. Confirm `git rev-parse HEAD`, read [AGENTS.md](../../AGENTS.md), this guide,
   and the SPEC/DECISION/TODO. Read linked P1/PDF/acceptance/contract files
   only when the named slice requires them.
2. Inspect ownership and dirty state. Preserve unrelated changes and stage no
   broad path. An `M` status, unknown artifact, or line-ending difference is
   not deletion authority.
3. Before editing code, write down the slice owner paths/symbols, external
   interface, red proof, prerequisites, stop condition, exact Nx commands,
   rollback, and commit message from the TODO.
4. For `OcrPipeline` or `OwnedRuntimeSession`, stop until three independent
   fresh Design-It-Twice alternatives, Root's grill, the comparison, and the
   chosen-contract commit exist. Their interface shape is not predetermined.
5. For any missing owner, symbol, or Nx target, run the TODO discovery command
   and stop. Do not invent a path, silently broaden scope, or claim a gate.
6. A content commit invalidates all prior exact-HEAD review artifacts. D1 must
   rerun `git rev-parse HEAD` after the new commit and attach external review/
   PR metadata.

## Delivery order

Every implementation slice follows this order:

```text
named design record
  -> Root grill, one question at a time
  -> Standards + Specification review at exact HEAD
  -> D2 bounded authorization (no handoff commit)
  -> public-interface TDD red proof
  -> smallest implementation and replacement deletion test
  -> exact Nx --skip-nx-cache verification
  -> fresh dual-axis review at exact HEAD
  -> local/private evidence
  -> D3-D4 candidate build and acceptance
  -> D5-D7 publish/download-back/repeated acceptance
  -> D8 stable pointer move
```

The D0-D8 transition definitions, hashes, byte identity, serial order, and
fail-closed behavior are in the SPEC. A failed transition stops later work,
preserves evidence and rollback, and never becomes a success through an exit
code, screenshot, old manifest, or local package.

## Required real OCR order

The producer rasterizes every PDF page through PDFium and sends the raster to
PaddleOCR. Embedded text is ignored. For the final same-byte acceptance run
exactly this serial sequence, releasing model memory and proving cleanup after
each child:

```text
Capture Workbench JPEG
  -> Capture Workbench original PDF page 1
  -> Cert Prep
  -> GX Law Prep
```

Stop on the first semantic, identity, process, listener, or cleanup failure.
The completed Phase 1 local-probe result is not candidate or published proof.

## Verification floor

These are existing Nx targets in `packages/capture-runtime/project.json` and
`apps/capture-workbench-desktop/project.json`; append
`--skip-nx-cache` to every invocation:

```powershell
corepack pnpm nx run capture-runtime:lint --skip-nx-cache
corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache
corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache
corepack pnpm nx run capture-runtime:test-integration --skip-nx-cache
corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:contract-consistency --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
```

Slice-specific real targets remain opt-in and do not turn local evidence into
release proof:

```powershell
corepack pnpm nx run capture-runtime:e2e-local-package-pdf-ocr --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:smoke-real-desktop-ocr-directml --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:acceptance-real --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:acceptance-three-projects --skip-nx-cache
```

Before using a target, confirm it with
`corepack pnpm nx show project <project> --json`. At this checkpoint,
`capture-runtime:version-check` and
`capture-workbench-desktop:acceptance-real-ocr-gpu-selection` are not present
in the checked-in project files; the TODO requires discovery and a stop before
either command can be advertised as an implementation gate.

## Handoff and escalation

Commit only the named slice paths after cached-name and whitespace checks. The
documentation fix uses the additive message
`docs(phase2): resolve architecture review findings`; it is local-only and is
not pushed here. Record exact paths, commit SHA, verification output, evidence
tier, and rollback. Do not stage `.github` unknown files.

Sol Ultra is a read-only second opinion only after the same blocker has caused
more than three consecutive Luna failures. It may return diagnosis, options,
or tests; it never edits, commits, pushes, publishes, or owns the slice.
