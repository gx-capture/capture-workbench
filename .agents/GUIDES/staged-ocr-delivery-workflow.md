# Staged OCR delivery workflow (Phase 2 worker guide)

This is the fresh-worker procedure for Capture Runtime 0.4.2 Phase 2. The
[Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md) is the sole policy
source. The [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md)
records rationale, and the [TODO](../TODOS/capture-runtime-042-p2-hardening.md)
is the executable checklist. P1/PDF/acceptance/contract documents are context,
not alternate Phase 2 policy.

## Checkpoint first: 2026-09-09

The documentation correction starts from
1df7eecccd4097c172c9338a7f584f9489e5ae78. D0 is complete for the documentation
commit, but its SHA is intentionally external: record git rev-parse HEAD after
commit. D1 is pending fresh Standards and Specification review at that exact
head. Preserve untracked .github/copilot-instructions.md and
.github/instructions/; stage no unrelated path.

PR #39 at c6d2140e233de70734005713427f77f92414f415 is a green deterministic-CI
engineering checkpoint and remains unmerged. Phase 1 is complete only at the
local-probe tier: Capture -> Cert -> LAW passed real local-package OCR in that
order. This is not candidate, published, or release evidence. No current-HEAD
Phase 2 JPEG/PDF, GPU, cleanup, candidate, download-back, or publication result
is claimed.

CI repair is paused and has no authority in this workflow. Do not edit,
rerun/retry, or reconfigure CI, and do not treat deterministic CI as real OCR,
GPU, cleanup, installation, publication, or pointer proof.

## Fresh-worker procedure

1. Confirm git rev-parse HEAD and the clean/dirty boundary. Read
   [AGENTS.md](../../AGENTS.md), this GUIDE, the SPEC, the DECISION, and the
   TODO. Read linked policy only when the named slice requires it.
2. Confirm the current owner before editing. Use the actual symbols:
   packages/capture-runtime/src/capture_runtime/ocr_projection.py::OcrPipeline;
   packages/capture-sidecar-launcher/src/process.rs::OwnedRuntimeSession,
   OwnedRuntimeSessionState, RuntimeTerminationProof, and
   RuntimeCleanupError; src/lib.rs exports; src/launcher.rs launchers; desktop
   Tauri src/state.rs, src/launcher.rs, and src/commands.rs callers.
3. Run the read-only project discovery before choosing a target:
   corepack pnpm nx show project capture-runtime --json;
   corepack pnpm nx show project capture-sidecar-launcher --json;
   corepack pnpm nx show project capture-tools --json; and
   corepack pnpm nx show project capture-workbench-desktop --json. A missing
   target or owner is discovery-and-stop; do not invent one.
4. For OcrPipeline and OwnedRuntimeSession, read all three Design-It-Twice
   alternatives in the SPEC. A new implementation requires the chosen seam,
   usage, hidden implementation, dependency/adapters, trade-offs, deletion
   surface, and focused tests to be recorded before code. No second
   coordinator is allowed.
5. Write a slice record containing owner paths/symbols, external interface, red
   proof, prerequisites, stop condition, exact Nx commands, rollback, and
   commit message. Use edit-first ownership and delete/supersede only after
   residual scans, replacement tests, and an additive commit.
6. A content commit invalidates all prior D1 review artifacts. Rerun
   git rev-parse HEAD and obtain fresh external review metadata after the new
   commit. Do not reuse a remembered SHA.

## Delivery order

The only permitted state progression is:

~~~text
D0 DocsCommitted
  -> D1 DesignReviewed
  -> D2 ImplementationAuthorized
  -> D3 CandidateBuilt
  -> D4 CandidateAccepted
  -> D5 PublishedImmutable
  -> D6 DownloadBackVerified
  -> D7 PublishedAccepted
  -> D8 StablePointerMoved
~~~

Each is a separate item and evidence/commit checkpoint. A failed state stops
later work. D4 consumes only D3 candidate bytes. D5 publishes identical D3
bytes. D6 downloads back D5 public bytes. D7 repeats acceptance using D6
downloads only. D8 is producer-only stable-pointer mutation by the existing
publish workflow/tool. Never combine D4 and D7 identity ledgers or make a
self-dependent gate.

## First implementation slice

After D1 review and D2 authorization, the first code slice owns the existing
version sources and lock:

- Upgrade Nx 23.1.0 to 23.1.2 in root package.json and pnpm-lock.yaml.
- Extend tools/release/version-sources.ts and its existing
  tools/release/version-sources.test.ts. Verify with
  corepack pnpm nx run capture-tools:release-version-test --skip-nx-cache.
- Enumerate runtime 0.4.2, API 2.0, document schema 2, projection schema 3,
  contract hash d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40,
  TS/Python/Java clients, Rust launcher/crate, Workbench packages/assets,
  desktop staging, generated schemas/manifests/catalogs/model locks, and npm,
  PyPI, Maven, crates.io, and GitHub channels.
- Do not advertise capture-runtime:version-check: it is absent. If a required
  target is missing, record discovery-and-stop.

The next authorized commits converge OcrPipeline and OwnedRuntimeSession in
their existing owners, add the producer-owned RuntimeSessionJournalV1 and
reconciler, then extend the existing acceptance runner. The native design may
add an opaque multi-root group so LAW can put Capture/Python/Java roots in one
producer Job; Capture/Cert/candidate single-root calls remain supported. Tauri
never owns or mutates a journal or Job.

## Real OCR acceptance

The producer rasterizes every requested PDF page with PDFium and sends the
raster to PaddleOCR. Embedded text is ignored. Acceptance is per fixture, not
an average:

- Each real scanned PDF page-1 result must have CER <= 1%.
- Each real private JPEG result must have CER <= 3%.
- Every critical anchor must be present; one omission fails.
- CER is normalized edit distance per fixture/page. Never average pages,
  fixtures, products, or thresholds.

For both D4 and D7, use the same serial journey, releasing model memory and
proving journal/process/listener/staging cleanup after each child:

~~~text
Capture Workbench private JPEG
  -> cleanup proof
Capture Workbench original scanned PDF page 1
  -> cleanup proof
Cert Prep
  -> cleanup proof
GX Law Prep
  -> cleanup proof
~~~

Stop at the first semantic, identity, process, listener, or cleanup failure.
The completed local-probe Phase 1 result does not satisfy D3-D8.

## Journal and lifecycle boundary

RuntimeSessionJournalV1 is producer-owned durable cleanup state, not host
domain persistence. Only the producer may write atomic
state/generation transitions, retain PID plus process creation identity/nonce,
and bind the producer Job, run staging, and listener nonce. Never persist raw
tokens, OCR, source/model paths, command lines, or machine names. A PID, port,
parent process, executable name, or directory name alone is not ownership proof.

The producer reconciler may kill/delete only after every identity binding matches.
Ambiguity, PID reuse, malformed/torn journal, access denial, or an unproven
listener records reconcile-required and leaves residue. Retry is bounded and
identity-scoped; do not launch a replacement root while cleanup is unresolved.
Tauri can request close and receive semantic proof, but cannot write/mutate the
journal or Job.

## Verification floor

Confirm every target with Nx project metadata, then append
--skip-nx-cache to each invocation. Existing targets to select as applicable
include:

~~~powershell
corepack pnpm nx run capture-runtime:lint --skip-nx-cache
corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache
corepack pnpm nx run capture-runtime:python-version-check --skip-nx-cache
corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache
corepack pnpm nx run capture-runtime:test-integration --skip-nx-cache
corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache
corepack pnpm nx run capture-sidecar-launcher:cargo-fmt-check --skip-nx-cache
corepack pnpm nx run capture-sidecar-launcher:cargo-check --skip-nx-cache
corepack pnpm nx run capture-sidecar-launcher:cargo-test --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:cargo-check --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:contract-consistency --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
~~~

Real installed-boundary targets are opt-in and still do not prove publication:

~~~powershell
corepack pnpm nx run capture-runtime:e2e-local-package-pdf-ocr --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:smoke-real-desktop-ocr-directml --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:acceptance-real --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:acceptance-three-projects --skip-nx-cache
~~~

The target capture-workbench-desktop:acceptance-real-ocr-gpu-selection is
absent; do not invent it. Package QA and local package evidence remain
supplementary until the installed/public boundary and identity requirements are
met.

## Publication and handoff

D3 creates one immutable candidate ledger. D4 accepts only that ledger. D5 uses
the existing producer workflows for npm/GitHub Packages, PyPI,
Maven/GitHub Packages, crates.io, and GitHub Releases and publishes identical
bytes. D6 obtains fresh public downloads and compares every hash. D7 repeats
the serial journey using D6 downloads only. D8 may mutate the stable pointer
only through .github/workflows/_publish-stable-pointer.yml invoking
tools/update-release-index.ts. No worker, host, Tauri process, local script,
or source-tree command may mutate release-index/stable.json.

Commit only explicitly named paths after git diff --cached --check and
git diff --cached --name-only. Record SHA, paths, commands/results, evidence
tier, unresolved gates, and rollback. Never push from this workflow.
