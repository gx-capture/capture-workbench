# Capture Runtime 0.4.2 Phase 2 hardening TODO

Status: all implementation items below are planned and unchecked. The
[canonical SPEC](../SPECS/capture-runtime-042-p2-hardening.md) owns policy and
the [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md) owns rationale.
The [GUIDE](../GUIDES/staged-ocr-delivery-workflow.md) owns worker procedure.
Every item names an owner path/symbol, red proof, prerequisite/stop condition,
fully qualified Nx verification, rollback, and checkpoint commit.

Phase 1 is complete only at the local-probe tier: real local-package OCR passed
in Capture -> Cert -> LAW order. It is not candidate, published, or release
evidence, and does not establish an official `0.4.2` package.

## Target and ownership inventory

Before implementation, record the output of these read-only discovery commands:

```powershell
corepack pnpm nx show project capture-runtime --json
corepack pnpm nx show project capture-workbench-desktop --json
rg -n "class OcrPipeline|class OwnedRuntimeSession|VersionInventory|AcceptanceRunner" packages apps tools
```

At the 2026-09-09 checkpoint, the project files expose the runtime targets
`lint`, `typecheck`, `test-unit`, `test-integration`, `check-contracts`,
`validate-model-source-lock`, `generate-release-engine-catalog`,
`build-release-artifacts`, and `e2e-local-package-pdf-ocr`; desktop exposes
`typecheck-scripts`, `contract-consistency`, `package-qa-test`,
`smoke-real-desktop-ocr-directml`, `acceptance-real`, and
`acceptance-three-projects`. There is no `capture-runtime:version-check` or
`capture-workbench-desktop:acceptance-real-ocr-gpu-selection` target in the
checked-in project files. A missing target or unresolved symbol is a stop, not
permission to invent a command.

## Entry gates

- [ ] **Documentation commit and dynamic review binding.** Owner: Root and
  external Standards/Specification reviewers. Owner files:
  `.agents/SPECS/capture-runtime-042-p2-hardening.md`,
  `.agents/DECISIONS/capture-runtime-042-p2-hardening.md`,
  `.agents/TODOS/capture-runtime-042-p2-hardening.md`,
  `.agents/GUIDES/staged-ocr-delivery-workflow.md`, plus only the historical
  banners named below. Red proof: after the additive docs commit, each external
  report records `git rev-parse HEAD`, the four-file/banners path set, and its
  external check/PR metadata; no report may bind the remembered PR checkpoint
  SHA. Prerequisite/stop: stop if any content commit occurs after either report;
  rerun the exact-head check before proceeding. Verify:
  `corepack pnpm nx show project capture-runtime --json` and
  `corepack pnpm nx show project capture-workbench-desktop --json` (read-only),
  then `git rev-parse HEAD` and `git diff --check -- .agents/SPECS/capture-runtime-042-p2-hardening.md .agents/DECISIONS/capture-runtime-042-p2-hardening.md .agents/TODOS/capture-runtime-042-p2-hardening.md .agents/GUIDES/staged-ocr-delivery-workflow.md .agents/SPECS/gpu-ocr-directml.md .agents/DECISIONS/gpu-ocr-directml.md .agents/TODOS/capture-runtime-042-p1-ocr-compute-preflight.md`. Rollback: additive revert of this docs commit; preserve untracked `.github` files. Commit checkpoint: `docs(phase2): resolve architecture review findings`.
- [ ] **Design-It-Twice for unresolved OCR and session interfaces.** Owner:
  fresh independent reviewers, with Root coordinating. Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/ocr_projection.py:OcrPipeline`,
  `apps/capture-workbench-desktop/src-tauri/src/state.rs:DesktopRuntimeState`,
  and the eventual session owner discovered by the command below. Red proof:
  at least three fresh reviewers with materially different constraints each
  publish an alternative for each module containing interface and usage,
  hidden implementation, dependency categories and production/test adapters,
  invariants/order, errors, cancellation/termination, resources, trade-offs,
  and deletion test; the comparison covers depth, locality, seam, failure,
  cancellation/termination, and migration. Prerequisite/stop: run
  `rg -n "class OcrPipeline|OwnedRuntimeSession|cleanup_session|monitor_runtime" packages/capture-runtime/src apps/capture-workbench-desktop/src-tauri/src`; stop if the session owner is unresolved. Root grills one question at a time, then the chosen contract is committed and receives fresh exact-head dual review. Verify: `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`, `corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache`. Rollback: remove only the uncommitted review record; do not edit implementation. Commit checkpoint: chosen-contract commit before code.
- [ ] **Fresh worker checkpoint.** Owner: Root. Owner paths: no new file;
  checkpoint is the exact commit and the four canonical docs. Red proof: the
  worker records the current SHA, dirty paths, review artifact identity, and
  selected TODO item, and does not run a model. Prerequisite/stop: stop if the
  worktree contains an unowned path or if a review artifact is for another
  HEAD. Verify: `git rev-parse HEAD` and
  `git status --short --branch`. Rollback: return to the recorded checkpoint
  without reset/rebase. Commit checkpoint: worker handoff is a conversation
  record, not a repository commit.

## Slice 1 - canonical version identity

- [ ] **Inventory and read-only check.** Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/constants/versions.py:RUNTIME_VERSION,API_VERSION,CAPTURE_DOCUMENT_SCHEMA_VERSION`,
  `packages/capture-runtime/src/capture_runtime/release.py:build_release_artifacts,sha256_file`,
  `packages/capture-runtime/scripts/model_source_lock.py:validate_source_lock,source_lock_sha256,release_mode`,
  and `packages/capture-runtime/project.json` for the target owner. Red proof:
  one stale runtime/client/catalog/lock fixture fails while a complete fixture
  emits all required identities. Prerequisite/stop: `version-check` is absent
  at this HEAD; stop until a release owner chooses the canonical source and
  adds/records one target in `project.json`. Do not advertise an unverified
  command. Verify existing prerequisites:
  `corepack pnpm nx run capture-runtime:validate-model-source-lock --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:python-version-check --skip-nx-cache`,
  and `corepack pnpm nx show project capture-runtime --json`. Rollback: additive
  revert of the inventory slice; leave unrelated locks untouched. Commit
  checkpoint: `feat(release): add canonical version inventory`.
- [ ] **Explicit upgrade and stale-literal guard.** Owner paths/symbols:
  `packages/capture-runtime/scripts/model_source_lock.py:validate_source_lock,load_source_lock`,
  `packages/capture-runtime/src/capture_runtime/release.py:build_release_artifacts`,
  and generated files named by the new inventory target. Red proof: check mode
  is read-only; an explicit next-version input updates generated values only;
  mixed `0.4.1`/`0.4.2` locks and hand-written stale literals fail. Prerequisite/
  stop: the inventory target and canonical source from the prior item must be
  present; stop on missing target or generated-owner ambiguity. Verify:
  `corepack pnpm nx run capture-runtime:validate-model-source-lock --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache`, and
  the new target only after `corepack pnpm nx show project capture-runtime --json`
  proves its name. Rollback: additive revert; retain the prior catalog. Commit
  checkpoint: `feat(release): guard version upgrade identity`.
- [ ] **Tiered package identity.** Owner paths/symbols:
  `packages/capture-runtime/tests/e2e/support/runtime-identity.ts:verifyRuntimePackageIdentity,parseRuntimeIdentityMode`,
  `packages/capture-runtime/tests/e2e/support/runtime-release.ts:verifyRuntimeRelease`,
  `tools/acceptance-contract.ts:readAcceptanceManifestTolerant,writeAcceptanceManifest`.
  Red proof: local mode distinguishes URL/port transport from contract,
  package-boundary, provenance, and loaded-executable identity; release mode
  requires immutable download-back bytes and rejects local paths/direct URLs.
  Prerequisite/stop: retain separate local and release modes; stop if a caller
  passes a source tree or mutable pointer. Verify:
  `corepack pnpm nx run capture-runtime:e2e-local-package-pdf-ocr --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache`,
  and `corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache`.
  Rollback: additive revert of identity changes. Commit checkpoint:
  `test(acceptance): enforce tiered package identity`.

## Slice 2 - deterministic staging and canonical acceptance

- [ ] **Candidate staging isolation.** Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/release.py:build_release_artifacts`,
  `packages/capture-runtime/scripts/build_release_artifacts.py:main`,
  `apps/capture-workbench-desktop/scripts/stage-runtime.ts`, and
  `apps/capture-workbench-desktop/scripts/assert-staged-runtime.ts`. Red proof:
  a candidate cannot import a source tree, sibling artifact, or mutable stable
  pointer; every byte has a manifest hash. Prerequisite/stop: stage roots and
  artifact owner must be explicit; stop if staging reads a source checkout or
  target output is not declared in `project.json`. Verify:
  `corepack pnpm nx run capture-runtime:build-release-artifacts --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:stage-product-runtime --skip-nx-cache`,
  and `corepack pnpm nx run capture-workbench-desktop:contract-consistency --skip-nx-cache`.
  Rollback: additive revert; retain user evidence. Commit checkpoint:
  `feat(release): isolate candidate staging`.
- [ ] **Canonical acceptance runner seam.** Owner paths/symbols:
  `tools/three-project-acceptance.ts:runAcceptanceSequence,runCaptureWorkbenchAcceptance`,
  `tools/acceptance-contract.ts:writeAcceptanceManifest,validateTerminalManifest`,
  `apps/capture-workbench-desktop/scripts/acceptance-real.ts`, and
  `apps/capture-workbench-desktop/scripts/acceptance-orchestration.test.ts`. Red
  proof: one producer-owned runner scopes build/install/events/model transport,
  closes the child journal, and terminalizes only after cleanup; Capture JPEG,
  Capture PDF page 1, Cert, and LAW are serial and stop on first failure.
  Prerequisite/stop: retain semantic consumer assertions in consumer repos;
  stop if a runner still infers ownership by process name. Verify:
  `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache`
  and `corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache`.
  Rollback: additive revert; do not edit consumers. Commit checkpoint:
  `feat(acceptance): centralize producer acceptance runner`.
- [ ] **Private evidence sanitizer.** Owner paths/symbols:
  `tools/acceptance-contract.ts:sanitizeAcceptanceDiagnostic,sanitizeAcceptanceEvidence,readOcrExecutionProof`,
  `apps/capture-workbench-desktop/scripts/real-ocr-result-assertions.ts:assertRealOcrResult`,
  and their `*.test.ts` files. Red proof: hashes, numeric CER, stable anchor
  IDs/counts, provenance, and cleanup survive; injected token, secret, raw OCR/
  truth text, local path, or machine name fails closed. Prerequisite/stop: use
  bounded fields already defined by the manifest contract; stop on an unknown
  diagnostic field. Verify `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache` and `corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache`. Rollback: additive revert of sanitizer changes. Commit checkpoint: `fix(acceptance): sanitize private evidence`.

## Slice 3 - model provenance and OCR deepening

- [ ] **ModelSourceSnapshot.** Owner paths/symbols:
  `packages/capture-runtime/scripts/model_source_lock.py:load_source_lock,source_lock_sha256,validate_source_lock`,
  `packages/capture-runtime/src/capture_runtime/engine_catalog.py:EngineCatalog,EngineRequirementDescriptor`,
  `packages/capture-runtime/src/capture_runtime/model_catalog.py:RuntimeModelOption,catalog_sha256`,
  and `packages/capture-runtime/src/capture_runtime/release.py:build_release_artifacts`.
  Red proof: runtime/worker/model/profile/catalog/contract hashes are captured
  at use; byte/catalog mismatch fails closed; durable model caches are retained.
  Prerequisite/stop: stop if any raw OCR, token, local path, or machine name is
  added to provenance. Verify:
  `corepack pnpm nx run capture-runtime:validate-model-source-lock --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:generate-release-engine-catalog --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache`.
  Rollback: additive revert; retain the prior catalog. Commit checkpoint:
  `feat(runtime): bind model source provenance`.
- [ ] **OcrPipeline replacement after Design-It-Twice.** Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/ocr_projection.py:OcrPipeline,_OcrProjectionBuilder`,
  `packages/capture-runtime/src/capture_runtime/extractors.py:StandaloneRuntimeCaptureExtractor,_WorkerOcrEngineAdapter`,
  and public-seam tests `packages/capture-runtime/tests/unit/test_ocr_projection.py`,
  `test_paddle_result_normalization.py`, and `test_ocr_worker.py`. Red proof:
  the chosen post-gate interface hides raster/page policy, worker transport,
  normalization, page ordering, typed failure, and bounded resources; old
  implementation-coupled tests and duplicate policy are deleted after public
  interface tests pass. Prerequisite/stop: the three-reviewer Design-It-Twice
  record, Root grill, chosen-contract commit, D2 authorization, and a red public
  seam test must exist; stop if a method name or signature is being selected by
  this TODO. Verify:
  `corepack pnpm nx run capture-runtime:lint --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:test-integration --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache`.
  Rollback: additive revert of the OCR slice only. Commit checkpoint:
  `feat(runtime): replace OCR pipeline behind chosen interface`.
- [ ] **OCR semantic vertical proof.** Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/extractors.py:StandaloneRuntimeCaptureExtractor.extract,_extract_pdf,_render_pdf_page,_extract_image`,
  `packages/capture-runtime/tests/e2e/local-package/pdf-ocr.e2e.ts`,
  `apps/capture-workbench-desktop/scripts/real-ocr-result-assertions.ts:assertRealOcrResult`.
  Red proof: private JPEG and original PDF page 1 are independently rasterized
  and sent to PaddleOCR; embedded text cannot affect output; page order,
  empty/failed pages, polygons, confidence, provenance, typed failure, cleanup,
  and model release pass independently. Prerequisite/stop: D2 authorization,
  explicit fixture/anchor manifest, and current installed/local package; stop
  on missing semantic anchor or identity proof. Verify:
  `corepack pnpm nx run capture-runtime:e2e-local-package-pdf-ocr --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:smoke-real-desktop-ocr-directml --skip-nx-cache`.
  These are local evidence only. Rollback: preserve failed manifest and
  additively revert the slice. Commit checkpoint:
  `test(acceptance): prove OCR-only semantic projection`.

## Slice 4 - compute truth and lifecycle

- [ ] **OcrComputePlan replacement.** Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/ocr_preflight.py:OcrComputePlan,OcrComputeSelection,OcrGpuCapabilitySnapshot,NativeOcrGpuCapabilityProbe`,
  `packages/capture-runtime/src/capture_runtime/engine_installation.py:EngineManager.ocr_compute_selection`,
  and `packages/capture-runtime/tests/unit/test_ocr_compute_plan.py,test_ocr_preflight.py,test_ocr_selection_residuals.py`.
  Red proof: dGPU -> iGPU -> noticed CPU truth, positive-unavailable versus
  indeterminate, exact LUID join, ordinary ORT ordinal, RTX 4060 oracle, and
  selected-DML fail-closed/no CPU retry all pass through the public seam with
  one plan from readiness to session. Prerequisite/stop: the SPEC truth table
  and current contract hash are recorded; stop on host ordinal, implicit 0, or
  incomplete mapping. Verify:
  `corepack pnpm nx run capture-runtime:lint --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache`.
  Rollback: additive revert and invalidate affected evidence. Commit checkpoint:
  `feat(runtime): enforce canonical compute plan`.
- [ ] **Capture automatic GPU proof.** Owner paths/symbols:
  `apps/capture-workbench-desktop/scripts/real-desktop-ocr-smoke.ts:main`,
  `apps/capture-workbench-desktop/scripts/real-ocr-result-assertions.ts:assertRealOcrResult`,
  `packages/capture-runtime/tests/e2e/local-package/pdf-ocr.e2e.ts`, and the
  target declaration in `apps/capture-workbench-desktop/project.json`. Red
  proof: a current candidate-installed Capture Workbench proves automatic
  NVIDIA GeForce RTX 4060 on JPEG first and original PDF page 1 second, with
  private device proof, semantic anchors, cleanup, and model release.
  Prerequisite/stop: the existing `smoke-real-desktop-ocr-directml` target is
  not named as a two-fixture proof; `acceptance-real-ocr-gpu-selection` is
  absent. Run `rg -n "smoke-real-desktop-ocr|expected-ocr-device|gpu-selection" apps/capture-workbench-desktop packages/capture-runtime`; stop until a named owner and target are recorded in `project.json`. Verify the existing one-fixture target only as a diagnostic:
  `corepack pnpm nx run capture-workbench-desktop:smoke-real-desktop-ocr-directml --skip-nx-cache`.
  Rollback: preserve failed device evidence and revert tooling only. Commit
  checkpoint: `test(acceptance): prove automatic GPU fixture order`.
- [ ] **OwnedRuntimeSession implementation after Design-It-Twice.** Owner
  paths/symbols currently responsible for the lifecycle:
  `apps/capture-workbench-desktop/src-tauri/src/state.rs:DesktopRuntimeState::{begin_launch,accept_launched,cleanup_session,monitor_runtime,poll_runtime_exit,record_cleanup_failure}`;
  `apps/capture-workbench-desktop/src-tauri/src/launcher.rs:launch_runtime`; and
  lifecycle tests in `apps/capture-workbench-desktop/src-tauri/src/state.rs`.
  Red proof: the chosen interface owns suspended creation, assign-before-resume,
  no-breakaway, normal/window close, startup/readiness failure, root crash,
  host termination, descendants, retry, baseline survival, and one terminal
  proof without exposing OS handles or identifiers. Prerequisite/stop: complete
  the three-reviewer gate and record the chosen session owner; stop if a new
  `OwnedRuntimeSession` path is not resolved by discovery. Verify:
  `corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:cargo-check --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache`.
  Rollback: additive revert to the prior launcher; retain failed cleanup proof.
  Commit checkpoint: `feat(desktop): own runtime session lifecycle`.
- [ ] **Next-start reconciliation.** Owner paths/symbols:
  `apps/capture-workbench-desktop/src-tauri/src/state.rs:DesktopRuntimeState::{cleanup_identities,cleanup_session,cleanup_failure_status}`,
  `apps/capture-workbench-desktop/src-tauri/src/launcher.rs:prepare_isolated_directories`,
  and corresponding Rust state tests. Red proof: injected failure removes only
  identity-proven stale PIDs/listeners/run staging, retains durable runtime/model
  caches, preserves baseline processes, and never name-kills. Prerequisite/stop:
  the chosen session contract and exact ownership identity must exist; stop on a
  PID/name-only cleanup rule. Verify:
  `corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:cargo-check --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache`.
  Rollback: additive revert; preserve durable caches. Commit checkpoint:
  `fix(desktop): reconcile only owned runtime residue`.

## Slice 5 - evidence-led performance

- [ ] **No-behavior-change baseline.** Owner paths/symbols:
  `apps/capture-workbench-desktop/scripts/real-desktop-ocr-smoke.ts:main`,
  `apps/capture-workbench-desktop/scripts/acceptance-real.ts`,
  `packages/capture-runtime/src/capture_runtime/ocr_execution_proof.py`, and
  `tools/acceptance-contract.ts:writeAcceptanceManifest`. Red proof: each
  private JPEG/PDF page-1 fixture records bounded numeric memory, latency,
  raster, model-init, serialized-inference, first-page, cleanup, and exact
  identity data without behavior change or raw OCR. Prerequisite/stop: run the
  discovery `rg -n "memory|latency|elapsed|cleanup|ocr.*proof" apps/capture-workbench-desktop/scripts packages/capture-runtime/src tools`; stop if no existing evidence owner can store the bounded fields. Verify:
  `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:lint --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`.
  Rollback: remove run-scoped measurement artifacts only; retain no raw OCR.
  Commit checkpoint: `test(acceptance): record OCR baseline evidence`.
- [ ] **One-metric optimization.** Owner paths/symbols: the baseline owner
  selected above plus the single implementation symbol named by the metric
  record. Red proof: the comparison cohort and noise rule are recorded before
  code; one metric improves without semantic, provenance, cleanup, or resource
  regression; every fixture passes independently. Prerequisite/stop: a baseline
  artifact and exact metric owner must exist; stop when the change affects two
  metrics or lacks a rollback threshold. Verify the affected existing targets,
  each fully qualified and uncached, at minimum:
  `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`,
  `corepack pnpm nx run capture-runtime:test-integration --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache`.
  Rollback: additive revert to the baseline commit. Commit checkpoint:
  `perf(runtime): improve one measured OCR metric`.

## Slice 6 - consumer and release gates

- [ ] **D3 CandidateBuilt and D5/D6 publication identity.** Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/release.py:build_release_artifacts,sha256_file`,
  `packages/capture-runtime/tests/e2e/support/runtime-release.ts:verifyRuntimeRelease`,
  `packages/capture-runtime/tests/e2e/support/runtime-identity.ts:verifyRuntimePackageIdentity`,
  `tools/record-candidate-verification.ts`, and the publication workflows under
  `.github/workflows/` only after release authorization. Red proof: exact source
  HEAD, runtime/worker/model/profile/contract hashes, artifact bytes, manifests,
  frozen locks, and download-back bytes are equal; stable pointer is unmoved
  through D6. Prerequisite/stop: D0-D2 and all hardening slices are terminal
  success; stop on any missing hash, mutable URL, or target absent from
  `project.json`. Verify local build/identity prerequisites:
  `corepack pnpm nx run capture-runtime:build-release-artifacts --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:stage-product-runtime --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:build-nsis --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:contract-consistency --skip-nx-cache`.
  Rollback: stop promotion, retain candidate/failed ledgers, and pin the prior
  release consistently; never mix versions. Commit checkpoint: candidate and
  publication commits recorded separately by the release owner.
- [ ] **D4/D7 sequential consumer acceptance.** Owner paths/symbols:
  `tools/three-project-acceptance.ts:runAcceptanceSequence,runCaptureWorkbenchAcceptance,validateChildManifest,validateTerminalManifest`,
  `tools/acceptance-contract.ts:writeAcceptanceManifest`, and consumer-side
  assertion adapters named by the cross-repo acceptance manifest. Red proof:
  identical immutable candidate/download-back bytes run Capture JPEG -> Capture
  PDF page 1 -> Cert -> LAW serially; each child persists semantic evidence,
  cleans up, closes its journal, and releases model memory before the next.
  Prerequisite/stop: D3 candidate and D4/D6 identity ledgers must exist; stop on
  the first child failure and preserve its evidence. Verify:
  `corepack pnpm nx run capture-workbench-desktop:acceptance-three-projects --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache`,
  `corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache`.
  Rollback: stop the sequence, retain failed manifests, and revert only the
  affected repository slice. Commit checkpoint: per-repository acceptance
  commits, with no stable pointer move until D8.
- [ ] **D8 StablePointerMoved.** Owner paths/symbols:
  `.github/workflows/_publish-stable-pointer.yml`,
  `tools/update-release-index.ts`, and release-index ledgers named by that
  workflow. Red proof: D7 is terminal-success and all D3-D7 hashes, ledgers,
  cleanup proofs, and rollback references are retained before the pointer moves.
  Prerequisite/stop: D7 only; stop on any missing download-back or consumer
  manifest. Verify only the release-owner workflow's documented SHA-specific
  command after external authorization; no local pointer mutation in this
  task. Rollback: use the release-index additive revert procedure; retain the
  prior pointer and immutable release. Commit checkpoint: stable-pointer
  promotion commit owned by release automation.

## Documentation-only checkpoint in this task

- [ ] **Historical GPU banners.** Owner files:
  `.agents/SPECS/gpu-ocr-directml.md` and
  `.agents/DECISIONS/gpu-ocr-directml.md`. Red proof: each file has a visible
  historical/superseded banner stating that adapter `0`,
  `CAPTURE_WINDOWSML_DEVICE_ID`, and host override text are obsolete and
  linking to the canonical Phase 2 SPEC; the historical body is unchanged.
  Verify: `git diff -- .agents/SPECS/gpu-ocr-directml.md .agents/DECISIONS/gpu-ocr-directml.md`.
  Rollback: additive docs revert. Commit checkpoint: same docs commit below.
- [ ] **P1 TODO stale-status banner.** Owner file:
  `.agents/TODOS/capture-runtime-042-p1-ocr-compute-preflight.md`. Red proof:
  its completed local-probe status is marked historical and points to the
  canonical Phase 2 compute truth; no P1 body is rewritten. Verify:
  `git diff -- .agents/TODOS/capture-runtime-042-p1-ocr-compute-preflight.md`.
  Rollback: additive docs revert. Commit checkpoint: same docs commit below.
- [ ] **Docs checks and local commit.** Owner: docs worker + Root. Red proof:
  only the four canonical docs and three named banners are changed; relative
  links/anchors resolve, Markdown fences are balanced, vague TODO placeholders
  are absent, old GPU claims are banner-scoped, and whitespace is clean. Verify:
  `rg -n -i "$VAGUE_TERMS" .agents/TODOS/capture-runtime-042-p2-hardening.md` (must return no lines), `rg -n "$STALE_REVIEW_MARKER" .agents/SPECS/capture-runtime-042-p2-hardening.md .agents/DECISIONS/capture-runtime-042-p2-hardening.md .agents/TODOS/capture-runtime-042-p2-hardening.md .agents/GUIDES/staged-ocr-delivery-workflow.md` (must return no lines), `git diff --check -- .agents/SPECS/capture-runtime-042-p2-hardening.md .agents/DECISIONS/capture-runtime-042-p2-hardening.md .agents/TODOS/capture-runtime-042-p2-hardening.md .agents/GUIDES/staged-ocr-delivery-workflow.md .agents/SPECS/gpu-ocr-directml.md .agents/DECISIONS/gpu-ocr-directml.md .agents/TODOS/capture-runtime-042-p1-ocr-compute-preflight.md`, and a repository-local relative-link/fence checker if present. Prerequisite/stop: do not stage `.github` untracked files or any path outside this list; stop if a link target is missing. Rollback: additive revert. Commit checkpoint: `docs(phase2): resolve architecture review findings`.
- [ ] **Fresh exact-head dual review after this commit.** Owner: Root and
  external Standards/Specification reviewers. Red proof: both reports identify
  the new `git rev-parse HEAD`, exact path set, and external check/PR metadata;
  no report is reused from the prior docs SHA. Prerequisite/stop: any later
  content commit returns to D1. Verify: `git rev-parse HEAD` and the two
  reviewer artifacts. Rollback: additive docs revert; preserve reviewer
  records. Commit checkpoint: review artifacts are external, not a handoff
  commit.
