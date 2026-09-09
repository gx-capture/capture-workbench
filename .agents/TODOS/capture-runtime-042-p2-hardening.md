# Capture Runtime 0.4.2 Phase 2 hardening TODO

Status: all items below are planned and unchecked. No item is claimed as
executed by this documentation checkpoint. The [canonical SPEC](../SPECS/capture-runtime-042-p2-hardening.md)
owns policy; the [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md)
owns rationale. Every item is a small vertical slice with one owner and one
checkpoint commit.

## Entry gate and shared rules

- [ ] **Exact-head design gate.** Owner: Root + fresh Luna reviewer. Red proof:
  a review record identifies `c6d2140e233de70734005713427f77f92414f415`, the
  2026-09-09 checkpoint, current missing real evidence, blocked Cert/Law, and
  unresolved findings. Owned files: the four Phase 2 docs only. Verify:
  `git diff --check -- .agents/SPECS/capture-runtime-042-p2-hardening.md .agents/DECISIONS/capture-runtime-042-p2-hardening.md .agents/TODOS/capture-runtime-042-p2-hardening.md .agents/GUIDES/staged-ocr-delivery-workflow.md`.
  Rollback: additive revert of the docs commit. Commit checkpoint: docs-only
  commit below.
- [ ] **Design-It-Twice review for OCR and session.** Owner: fresh Luna xhigh.
  Red proof: three materially different alternatives per module, compared on
  depth, locality, seam, failure, cancellation/termination, migration, and
  deletion test; no code. Owned files: DECISION/SPEC review notes. Verify:
  `rg -n "Design-It-Twice|Alternative A|Alternative B|Alternative C" .agents/SPECS/capture-runtime-042-p2-hardening.md .agents/DECISIONS/capture-runtime-042-p2-hardening.md`.
  Rollback: discard the uncommitted review note only. Commit checkpoint: the
  approved design commit, before implementation.
- [ ] **Fresh worker checkpoint.** Owner: Root. Red proof: worker records the
  approved exact HEAD and reads the four owner docs plus linked P1/PDF/
  acceptance/contract docs. Owned files: no new files. Verify read-only Git
  status and current SHA; do not run a model. Rollback: return to the approved
  checkpoint. Commit checkpoint: worker handoff note in its own slice.

## Slice 1 — canonical version identity (first implementation slice)

- [ ] **Inventory and check command.** Owner: runtime release/tooling owner. Red
  proof: a fixture with one stale runtime/client/catalog/lock value fails and a
  complete fixture reports all required identities. Owned files: existing
  version/catalog/manifest owners plus only a new command file if no owner
  fits. Verify: `corepack pnpm nx run capture-runtime:version-check --skip-nx-cache`;
  also `corepack pnpm --version` (pnpm 12), and the resolved Capture/Cert Nx
  project metadata must report Nx `23.1.2`. Rollback: revert the focused
  inventory commit; leave unrelated locks untouched. Commit checkpoint: one
  version inventory commit.
- [ ] **Upgrade mode and stale-literal guard.** Owner: same release/tooling
  owner. Red proof: explicit next-version input updates generated values only,
  refuses mixed 0.4.1/0.4.2 locks and stale hand-written literals, and check
  mode is read-only. Owned files: inventory generator, tests, generated report.
  Verify: `corepack pnpm nx run capture-runtime:version-check --skip-nx-cache`
  plus its focused test with `--skip-nx-cache`. Rollback: additive revert.
  Commit checkpoint: upgrade/check guard commit.
- [ ] **Tiered identity contract.** Owner: acceptance/release tooling. Red
  proof: local E2E distinguishes URL/port transport from contract hash,
  package boundary, provenance, and loaded executable identity; published
  checks require strict immutable download-back bytes and reject local paths/
  direct URLs. Owned files: existing acceptance manifest readers/tests. Verify:
  `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache`.
  Rollback: revert acceptance-only changes. Commit checkpoint: identity policy
  commit.

## Slice 2 — deterministic staging and canonical acceptance

- [ ] **Candidate staging isolation.** Owner: desktop/release tooling. Red proof:
  a local candidate cannot import a source tree, sibling artifact, or mutable
  stable pointer; all bytes have manifest hashes. Owned files: stage/manifest
  owner and tests. Verify: relevant desktop packaging/contract targets with
  `--skip-nx-cache`. Rollback: delete only the focused staging change and retain
  user evidence. Commit checkpoint: isolated local-candidate commit.
- [ ] **AcceptanceRunner seam.** Owner: producer acceptance owner. Red proof:
  one runner owns build/install/event scope/model transport/uninstall and
  terminalizes only after child journal close; Capture JPEG then PDF page 1,
  Cert, and Law are serial and stop on first failure. Owned files: existing
  acceptance runner plus public-seam tests. Verify:
  `corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache`
  and the focused runner tests with `--skip-nx-cache`. Rollback: additive
  revert; do not edit consumers. Commit checkpoint: runner seam commit.
- [ ] **Private evidence sanitizer.** Owner: acceptance tooling. Red proof:
  output has hashes, numeric CER, stable anchor IDs/counts, provenance, and
  cleanup only; secret/token/raw OCR/truth/path/machine-name injection fails.
  Owned files: existing manifest/proof reader and tests. Verify the focused
  privacy tests and `typecheck-scripts --skip-nx-cache`. Rollback: revert
  sanitizer change. Commit checkpoint: privacy evidence commit.

## Slice 3 — model provenance and OCR deepening

- [ ] **ModelSourceSnapshot.** Owner: runtime packaging owner. Red proof:
  runtime/worker/model/profile/catalog/contract hashes are captured at use,
  byte mismatch fails closed, and durable model caches are not deleted. Owned
  files: runtime model/catalog owner and public-seam tests. Verify runtime
  lint/typecheck/unit/integration/check-contracts, each with `--skip-nx-cache`.
  Rollback: revert snapshot commit and retain prior catalog. Commit checkpoint:
  provenance commit.
- [ ] **OcrPipeline Design-It-Twice implementation.** Owner: runtime OCR owner.
  Red proof: approved alternative becomes one deep `run` seam; production
  worker and in-memory adapters exist; old raster/planning/normalization
  policy and implementation-coupled tests are deleted after replacement tests.
  Verify red/green public-seam tests, then `corepack pnpm nx run capture-runtime:lint --skip-nx-cache`,
  `typecheck`, `test-unit`, `test-integration`, and `check-contracts` with
  `--skip-nx-cache`. Rollback: additive revert of the OCR slice only. Commit
  checkpoint: OCR replacement commit.
- [ ] **OCR semantic vertical proof.** Owner: runtime OCR + acceptance owner.
  Red proof: private JPEG and PDF page 1 are each rasterized and sent to
  PaddleOCR; embedded text cannot affect output; ordering, empty/failed pages,
  polygons, confidence, provenance, and typed failure gates pass independently.
  Verify only through the approved installed/local-real target with
  `--skip-nx-cache` after implementation entry approval. Rollback: revert the
  focused acceptance/code slice. Commit checkpoint: semantic proof commit.

## Slice 4 — compute truth and lifecycle hardening

- [ ] **OcrComputePlan replacement.** Owner: runtime compute owner. Red proof:
  dGPU -> iGPU -> noticed CPU truth table, positive-unavailable versus
  indeterminate, exact LUID join, ORT ordinary ordinal, RTX 4060 oracle,
  selected-DML fail-closed/no CPU retry, and identical plan from readiness to
  sessions all pass at the public seam. Verify runtime lint/typecheck/unit/
  integration/check-contracts with `--skip-nx-cache`; confirm API `2.0`, schema
  `3`, and contract hash are byte-identical. Rollback: additive revert and
  invalidate affected evidence. Commit checkpoint: compute-plan commit.
- [ ] **Capture GPU real proof.** Owner: Capture Workbench acceptance owner.
  Red proof: current candidate-installed Capture Workbench proves automatic
  NVIDIA GeForce RTX 4060 on JPEG first, original PDF page 1 second, with
  private device proof, semantic anchors, cleanup, and model release. Verify:
  `corepack pnpm nx run capture-workbench-desktop:acceptance-real-ocr-gpu-selection --skip-nx-cache`.
  Rollback: preserve failed manifest and revert only tooling/code slice. Commit
  checkpoint: GPU acceptance commit; no Cert/Law start before it.
- [ ] **OwnedRuntimeSession implementation.** Owner: Rust sidecar owner. Red
  proof: suspended assign-before-resume/no-breakaway, normal/window close,
  startup/readiness failure, root crash, host terminate, descendants, cleanup
  retry, and baseline survival pass through the semantic interface. Verify the
  Rust and desktop lifecycle targets with `--skip-nx-cache`. Rollback: additive
  revert to prior reviewed launcher. Commit checkpoint: session ownership
  commit.
- [ ] **Next-start reconciliation.** Owner: desktop lifecycle owner. Red proof:
  failure injection removes only identity-proven stale PIDs/listeners/run
  state/staging, retains durable runtime/model caches, and never name-kills.
  Verify lifecycle/reconciliation tests and all relevant Nx targets with
  `--skip-nx-cache`. Rollback: revert reconciliation commit; preserve durable
  caches. Commit checkpoint: reconciliation commit.

## Slice 5 — evidence-led performance

- [ ] **Baseline only.** Owner: runtime performance owner. Red proof: per-fixture
  memory, latency, raster, model init, serialized inference, first-page, and
  cleanup measurements are recorded as bounded numeric/hash evidence with no
  behavior change. Verify the approved local-real JPEG/PDF page-1 lane with
  `--skip-nx-cache`. Rollback: remove only run-scoped measurement artifacts;
  retain no raw OCR. Commit checkpoint: baseline tooling commit.
- [ ] **One-metric optimization.** Owner: fresh worker per metric. Red proof:
  comparison/noise rule is recorded before code, target metric improves without
  semantic/provenance/cleanup regression, and no average hides a fixture fail.
  Verify affected runtime and acceptance targets with `--skip-nx-cache`.
  Rollback: additive revert to the baseline commit. Commit checkpoint: one
  metric per commit.

## Slice 6 — consumer and release gates (last)

- [ ] **Sequential consumer acceptance.** Owner: Root/coordinators in the three
  repositories. Red proof: same immutable candidate bytes run Capture JPEG ->
  Capture PDF page 1 -> Cert -> Law; each child cleans up and releases model
  memory before the next. Verify the producer-owned three-project target with
  `--skip-nx-cache`; do not claim from old evidence. Rollback: stop sequence,
  retain failed evidence, and revert only the affected repository slice.
  Commit checkpoint: per-repository acceptance commits.
- [ ] **Immutable candidate/release.** Owner: release owner. Red proof: exact
  source HEAD, artifact bytes, manifests, contract/model/profile/worker hashes,
  frozen locks, download-back bytes, and consumer package boundaries match;
  stable pointer remains unmoved until every gate is green. Verify release
  targets and SHA-specific CI with `--skip-nx-cache`/approved CI commands.
  Rollback: additive revert or pin prior reviewed 0.4.1 train consistently;
  never mix versions. Commit checkpoint: candidate then publication commits.

## Documentation checkpoint (this task)

- [ ] **Documentation checkpoint audit.** Owner: docs worker + Root. Red proof:
  the canonical design is limited to the four owner files and the read-only
  Markdown/relative-link checks plus `git diff --check` are recorded. This item
  does not claim implementation, model acceptance, candidate, or release.
- [ ] Obtain Standards and Specification review on the exact documentation
  commit. Owner: Root. Red proof: both reports identify current SHA and no
  unapproved scope. Rollback: additive docs revert. Commit checkpoint: the
  docs commit `docs(phase2): consolidate capture hardening design`.
