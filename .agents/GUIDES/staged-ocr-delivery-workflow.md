# Staged OCR delivery workflow (Phase 2 canonical guide)

This is the fresh-worker execution guide for Capture Runtime 0.4.2 Phase 2.
The [Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md) is the only
policy source; the [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md)
records why. P1, PDF, acceptance, and contract details remain linked context:
[P1 OCR](../SPECS/capture-runtime-042-p1-ocr-and-lifecycle.md),
[PDF OCR-only](../SPECS/pdf-ocr-only-extraction.md),
[real OCR acceptance](../SPECS/real-ocr-result-acceptance.md), and
[contract set](../SPECS/runtime-contract-set-client-sdks-hard-cut.md).

## Checkpoint first: 2026-09-09

PR #39 is deterministic-CI green at `c6d2140e233de70734005713427f77f92414f415`,
but unmerged. Phase 1 is **complete at the local-probe tier**: all three
projects passed real local-package OCR in the ordered Capture -> Cert -> LAW
sequence. This is not published/release evidence and does not mean an official
`0.4.2` package exists. No current-HEAD Phase 2 real JPEG/PDF OCR, GPU, or
cleanup evidence is recorded here. No immutable candidate or published `0.4.2`
exists. PR #39 and current heads are engineering/release freshness facts only;
they do not negate Phase 1 completion. Phase 2 entry is allowed at
documentation/design/review; implementation slices follow the approved TODO
gates. Do not infer release evidence from a green CI job, older manifest, local
package, or a consumer's historical evidence.

This documentation checkpoint preserves untracked `.github/copilot-instructions.md`
and `.github/instructions/`. It does not edit other docs, code, CI, consumers,
candidate bytes, release pointers, or published artifacts.

## Fresh worker start

1. Confirm the exact HEAD and read [AGENTS.md](../../AGENTS.md), this guide, the
   SPEC/DECISION/TODO, then only the linked P1/PDF/acceptance/contract docs
   relevant to the slice.
2. Inspect ownership and dirty state. Preserve unrelated changes; stage no
   broad path. A tracked line-ending status or unknown artifact is not a
   deletion authorization.
3. State the slice's owner, public interface, red proof, owned files, verify
   command, rollback, and checkpoint commit before touching code.
4. If `OcrPipeline` or `OwnedRuntimeSession` is involved, complete the
   three-alternative Design-It-Twice record and serious grill/review first.
5. Phase 2 entry is permitted for documentation, design, and review. For an
   implementation slice, stop unless its approved TODO gate, exact-HEAD review,
   and required real artifact are present; ask Root for a new bounded
   authorization when any is missing.

## Change mode: mixed

Edit the four existing Phase 2 owner files when their design is stale. Delete
or supersede only the named old adapter-0/embedded/hybrid/v0.3/session-status
candidates after a replacement seam and deletion test prove they are obsolete.
Create a file only when an existing owner cannot hold the new lifecycle or
test seam. The supersession map in the SPEC is the checklist; it is not a
license to edit every linked historical document.

The producer owns OCR/compute/model provenance/process lifecycle/acceptance/
version identity. Hosts own adapters and durable domain data only. No host may
save Paddle policy, model paths, cleanup policy, or GPU index.

## Delivery flow

Use this order for every non-trivial vertical slice:

```text
design docs
  -> serious grill, then Standards + Specification review
  -> approved exact-HEAD slice
  -> sprint backlog
  -> TDD red test at public seam
  -> smallest implementation and delete/supersede old path
  -> two review axes at exact HEAD
  -> local staging / local-real proof
  -> immutable candidate
  -> published release only after consumer gates
```

Phase 2 promotion requires architecture, version, performance, and lifecycle
hardening first; then an immutable candidate is built; then Capture -> Cert ->
LAW are tested sequentially with a formal/published `0.4.2` package. This is a
future release gate, not a claim that the package exists at this checkpoint.

Every slice has one observable outcome. Tests cross the module interface and
survive implementation replacement. Internal seams are injectable only for
platform/transport/test adapters; they are not a second public contract.

## Required Phase 2 order

1. **Version-first:** implement the one `VersionInventory` and its one
   `corepack pnpm nx run capture-runtime:version-check --skip-nx-cache`
   entrypoint (read-only check by default; explicit reviewable upgrade mode is
   a mode of the same command).
   Cover runtime/API/schema, TypeScript/Python/Java/Rust, desktop/catalog/
   manifests, locks, pnpm 12, Capture/Cert Nx 23.1.2, and consumer identity.
2. **Deterministic staging:** isolate local candidate/package boundary and
   enforce tiered local identity; release checks remain strict immutable bytes.
3. **Canonical runner:** put build/install/event scope/model transport,
   terminalization, cleanup, and serial semaphore in producer-owned
   `AcceptanceRunner`.
4. **Model provenance:** deepen `ModelSourceSnapshot` and reject byte/catalog/
   contract drift without exposing private paths or text.
5. **Design twice, then deepen OCR:** only after review implement `OcrPipeline`
   by replacement. PDFium raster -> PaddleOCR; embedded text ignored; JPEG and
   original PDF page 1 are the fast real fixtures.
6. **Compute proof:** apply the SPEC's sole GPU truth. Prove Capture Workbench
   automatic RTX 4060 first. `indeterminate` is unavailable; selected DML
   failure never retries CPU.
7. **Baseline, then optimize:** per-fixture memory/latency/raster/model-init/
   serialized-inference/cleanup measurement precedes one-metric changes.
8. **Design twice, then deepen session:** `OwnedRuntimeSession` owns every
   launch/Job/descendant/close/crash/retry/reconciliation fact. Preserve
   durable caches and baseline processes; never name-kill.
9. **Consumer/release last:** only after the producer gate, run same-byte
   Capture JPEG -> Capture PDF page 1 -> Cert -> Law serially; publish only
   after strict candidate/download-back/release gates.

## OCR-only real journey

Every PDF page is rasterized and sent to PaddleOCR. Embedded text is ignored:
it is never read, returned, or used to reject an input. The order accepted for
Phase 1 local-probe and required again for the Phase 2 final gate is exactly:

```text
Capture Workbench: private JPEG
  -> semantic result + cleanup + model release
Capture Workbench: original private PDF page 1
  -> semantic result + cleanup + model release
Cert Prep: same candidate bytes
  -> cleanup + model release
GX Law Prep: same candidate bytes
```

Do not parallelize model runs. Stop on the first failure. A local/unit/fake
result is not this journey. Full PDF runs are targeted only at page-order,
accumulation, or memory risks.

## GPU and lifecycle guardrails

Use the canonical table and proof fields in the SPEC; do not reproduce or
invent another policy. Review every implementation for these hard guards:

- usable dGPU before usable iGPU; noticed CPU only with affirmative
  positive-unavailable/no-hardware or provider-absent evidence;
- unknown/timeout/exception/incomplete mapping is unavailable, never CPU;
- DML selected-session construction, identity, assignment, graph proof, or
  inference failure fails closed with no other GPU/CPU retry;
- `highPerformanceRank` is not ORT's ordinary `EnumAdapters1` device id;
  exact LUID joins are required; no implicit 0 or host ordinal remains;
- Capture's automatic NVIDIA GeForce RTX 4060 proof precedes Cert/Law;
- normal close, startup/readiness failure, root crash, host termination,
  app child-process/descendant cleanup, and next-start reconciliation all
  produce one terminal
  proof; baseline process survives and durable caches remain;
- cleanup never uses process names and never declares a clean manifest before
  exact app/sidecar/CDP/temp-data/PID/listener/worker checks pass.

## Evidence and privacy gate

Record only artifact/HEAD/model/profile/worker/contract hashes, numeric CER,
stable anchor IDs/counts, page/provenance categories, timings/memory, and
cleanup booleans. Never record raw OCR/truth text, bearer tokens, local paths,
user/machine names, or unbounded diagnostics. Mask screenshots and inspect them
as secondary evidence.

Local E2E identity is tiered: URL/port identify transport, while contract,
package boundary, provenance, and loaded executable identity prove what ran.
Published acceptance requires strict immutable artifact/version/hash/lock
identity and download-back comparison; local direct URLs are not release proof.

OCR execution proof is private and terminal at the OCR checkpoint after raw and
OCR projection persistence plus `awaiting_structuring`. It is not host LLM,
candidate, release, or publication success. Host domain commit is separate.

## Verification and handoff

Use Nx for repository targets and `--skip-nx-cache` for final confidence. The
exact commands depend on the approved slice, but the planned floor is:

```powershell
corepack pnpm nx run capture-runtime:version-check --skip-nx-cache
corepack pnpm nx run capture-runtime:lint --skip-nx-cache
corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache
corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache
corepack pnpm nx run capture-runtime:test-integration --skip-nx-cache
corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
```

Do not run a command merely to make this docs checkpoint look complete; these
commands are TODO verification, not claims. After checks and two reviews,
stage only explicit owned paths, inspect cached names and `git diff --cached
--check`, commit the slice, and report SHA/diffstat/evidence tier/rollback.
Never push, merge, publish, or stage `.github` unknown files here.

## Escalation

Sol Ultra is allowed only after the *same blocker* causes more than three
consecutive Luna failures. Sol's work is read-only diagnosis/options/tests;
Sol never edits, commits, pushes, publishes, or owns the implementation. Root
records each attempt and decides whether a bounded fix is accepted. Different
findings have separate counters.
