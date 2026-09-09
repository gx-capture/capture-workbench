# Capture Runtime 0.4.2 Phase 2 hardening (executable TODO)

The [canonical SPEC](../SPECS/capture-runtime-042-p2-hardening.md) owns policy
and the [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md) owns
rationale. The [GUIDE](../GUIDES/staged-ocr-delivery-workflow.md) owns fresh
worker procedure. This file is the only executable Phase 2 checklist.

## Gate status and non-negotiable rules

The state machine is strictly linear:

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

The documentation commit completes D0 without embedding its own SHA. The
external handoff records git rev-parse HEAD after commit. D1 is pending until
fresh Standards and Specification reports review that exact head. Each gate is
a separate item and commit/evidence checkpoint. A gate consumes only the
preceding gate's record; it never consumes itself, a later gate, or a combined
future ledger.

CI repair is explicitly paused and has no authority here. This checklist does
not edit, repair, rerun, retry, or reconfigure workflows. A deterministic CI
result is not real OCR, GPU, cleanup, installation, publication, or pointer
evidence.

The expected documentation base is
1df7eecccd4097c172c9338a7f584f9489e5ae78. Preserve unrelated untracked
.github/copilot-instructions.md and .github/instructions/; never stage them.

## D0 — DocsCommitted

- [x] **Commit the canonical policy and active banners.** Owner paths are
  .agents/SPECS/capture-runtime-042-p2-hardening.md,
  .agents/DECISIONS/capture-runtime-042-p2-hardening.md,
  .agents/TODOS/capture-runtime-042-p2-hardening.md,
  .agents/GUIDES/staged-ocr-delivery-workflow.md,
  packages/capture-workbench-ui/README.md, and
  apps/capture-workbench-desktop/README.md. The historical GPU and P1
  banners are already present and remain unchanged. Red proof: the canonical
  documents state D0 complete, D1 pending, the exact D0-D8 order, no self
  dependency, CI pause, owner paths, thresholds, and release identity rules;
  the active READMEs make no published 0.4.2 claim and contain no concrete
  machine-specific fixture path. The SHA is deliberately not stored in the
  documents; report it externally with git rev-parse HEAD after the commit.
  Prerequisite/stop: confirm the expected base and preserve unrelated changes.
  Verify relative links, anchors, fenced blocks, stale/absolute wording, and
  git diff --check before staging. Rollback: additive docs revert only.
  Commit checkpoint: docs(phase2): resolve architecture review findings.

## D1 — DesignReviewed

- [ ] **Fresh exact-head dual review.** Consume D0 only. Standards review must
  check repository conventions, actual paths/symbols, target validity, links,
  privacy, generated-file discipline, portable README examples, and staged
  scope. Specification review must check OcrPipeline and OwnedRuntimeSession
  alternatives/choices, OCR-only semantics, compute truth, journal/reconcile
  fail-closed rules, public schema identity, serial acceptance, version
  channels, publication ordering, and rollback. Each report must name the
  post-D0 git rev-parse HEAD, exact path set, and external check/PR metadata.
  No report from the prior head is reusable. Stop on any finding; a content
  correction returns to D1 after a new D0 commit. This gate has no
  implementation commit; review artifacts are external.

## D2 — ImplementationAuthorized

- [ ] **Authorize one bounded implementation queue after D1.** Consume only the
  approved D1 head. Root records explicit owner paths, symbols, red proof, stop
  condition, Nx commands, rollback, and commit messages before any code change.
  A missing owner, symbol, or target is discovery-and-stop; do not invent a
  second coordinator or a new target. D2 itself has no handoff commit.

  Required discovery, all read-only:

  ~~~powershell
  corepack pnpm nx show project capture-runtime --json
  corepack pnpm nx show project capture-sidecar-launcher --json
  corepack pnpm nx show project capture-tools --json
  corepack pnpm nx show project capture-workbench-desktop --json
  rg -n "class OcrPipeline|OwnedRuntimeSession|RuntimeTerminationProof|launch_sidecar_with_observer|collectReleaseVersionEntries|runAcceptanceSequence" packages apps tools
  ~~~

  The implementation queue is separate, ordered commits, all completed before
  D3:

  1. **Version/inventory first slice.** Own root package.json and
     pnpm-lock.yaml to upgrade Nx 23.1.0 to 23.1.2. Extend the actual
     tools/release/version-sources.ts collector and its existing
     tools/release/version-sources.test.ts; verify with the existing target
     corepack pnpm nx run capture-tools:release-version-test --skip-nx-cache.
     Enumerate and reject drift across runtime, release 0.4.2, API 2.0,
     document schema 2, projection schema 3, contract hash
     d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40,
     TypeScript clients, Python client/runtime, Java client, Rust launcher and
     crate, Workbench packages/assets/desktop staging, manifests, catalogs,
     model/source locks, and all npm, PyPI, Maven, crates.io, and GitHub
     channels. capture-runtime:python-version-check exists, but
     capture-runtime:version-check does not; use discovery and stop rather than
     inventing a target.
  2. **OcrPipeline convergence.** Own
     packages/capture-runtime/src/capture_runtime/ocr_projection.py::OcrPipeline
     and migrate the extractor, streaming service, OCR worker, and existing
     projection/failure tests through the chosen terminal interface. The SPEC
     records three complete alternatives and chooses O1. Preserve the public
     schema floor; make normalization/serialization/failure helpers private or
     delete them after callers cross the seam. Add deletion tests proving page,
     provenance, cancellation, and failure policy is not duplicated.
  3. **OwnedRuntimeSession convergence.** Own
     packages/capture-sidecar-launcher/src/process.rs::OwnedRuntimeSession,
     OwnedRuntimeSessionState, RuntimeTerminationProof, and
     RuntimeCleanupError. Migrate the actual exports in src/lib.rs, launch
     adapters in src/launcher.rs, and desktop callers in Tauri src/state.rs,
     src/launcher.rs, and src/commands.rs. The SPEC records three complete
     alternatives and chooses the producer-owned group/session design. It may
     add multi-root group capability without raw Job handles so LAW can place
     Capture/Python/Java roots in one producer Job; Capture/Cert/candidate
     single-root calls remain supported. The current PID-bearing proof and
     id/try_wait surface are replacement/deletion surface, not a second
     coordinator. Preserve and migrate the current src/lib.rs re-exports of
     OwnedRuntimeSession, OwnedSidecarProcess, RuntimeCleanupError,
     RuntimeCleanupErrorKind, RuntimeTerminationProof, and the launcher
     exports generate_bearer_token, launch_sidecar,
     launch_sidecar_with_observer, reserve_distinct_loopback_port,
     reserve_loopback_port, LaunchOptions, LaunchedSidecar, and
     SidecarLaunchSpec.
  4. **RuntimeSessionJournalV1 and reconciler.** Add this capability only under
     the existing producer lifecycle owner. Implement the exact schema,
     producer-only atomic transitions, PID plus creation identity and nonce,
     Job/staging/listener bindings, privacy, bounded identity-scoped retry, and
     fail-closed proof rules in the SPEC. Tauri never writes the journal or
     owns/mutates a Job. If a listener binding cannot be proven, record unknown
     ownership and do not kill/delete; do not claim more than the native seam
     can verify.
  5. **Acceptance evidence and measured baseline.** Extend the existing
     tools/three-project-acceptance.ts and tools/acceptance-contract.ts
     owners only after a code authorization. Record every real scanned PDF
     page-1 CER <= 1%, every real private JPEG CER <= 3%, and zero critical
     anchor omissions; no averaging. The exact serial journey is Capture JPEG
     -> cleanup -> Capture original PDF page 1 -> cleanup -> Cert -> cleanup ->
     LAW -> cleanup. Each child must close its journal and release model memory
     before the next. Record numeric memory/latency/resource evidence before
     any one-metric optimization; never change two metrics in one commit.
  6. **Native verification.** Use only discovered targets. At minimum, run the
     relevant launcher and desktop Cargo format/check/test targets, runtime unit
     and integration targets, contract checks, and desktop script/acceptance
     targets with --skip-nx-cache. A target named
     capture-workbench-desktop:acceptance-real-ocr-gpu-selection is absent;
     discovery-and-stop rather than inventing it.

  Every queue item gets its own red proof, focused tests, uncached Nx output,
  cached-name/whitespace check, and additive commit. No candidate or release
  action occurs in D2.

## D3 — CandidateBuilt

- [ ] **Build one immutable candidate.** Consume D2 authorization and the exact
  implementation source only. Owner paths are the existing runtime/package
  builders, release manifests, source locks, and candidate ledgers discovered
  in D2; publication workflows are not edited. Red proof: every candidate byte
  has a SHA-256, and the manifest binds source HEAD, release 0.4.2, API/schema
  values, projection schema 3, contract hash, runtime/worker/model/profile/
  catalog identity, package/channel, and build provenance. No mutable URL, local
  source path, or stale version passes. Verify with the resolved
  capture-runtime:build-release-artifacts, desktop staging/package targets,
  contract consistency, and the version regression target, all uncached. Stop
  if any required target or identity is absent. Rollback: retain the failed
  candidate ledger and revert only the implementation slice. Commit checkpoint:
  candidate artifact/ledger commit is separate from D4 evidence.

## D4 — CandidateAccepted

- [ ] **Accept only the D3 candidate bytes.** Do not rebuild, reinstall from a
  source tree, or consume a future D6 ledger. Owner paths are the existing
  installed-boundary acceptance runner and manifest validator. Red proof: the
  same D3 byte hashes drive the exact serial sequence below; each child has
  semantic results, per-fixture CER, critical-anchor checks, model-memory
  release, journal terminal proof, listener/staging proof, and cleanup before
  the next child:

  ~~~text
  Capture Workbench private JPEG (each CER <= 3%)
    -> cleanup proof
  Capture Workbench original scanned PDF page 1 (each CER <= 1%)
    -> cleanup proof
  Cert Prep
    -> cleanup proof
  GX Law Prep
    -> cleanup proof
  ~~~

  Every fixture/page is evaluated independently; there is no averaging. Any
  critical-anchor omission or unknown cleanup fails D4. Stop on the first
  semantic, identity, process, listener, or cleanup failure and preserve the
  failed child manifest. Verify the discovered desktop
  acceptance-three-projects, script typecheck, and package-QA targets plus
  consumer assertion adapters. Rollback: stop the chain and retain the D3
  candidate/failed evidence. Commit checkpoint: D4 acceptance ledger is
  separate from D3 candidate bytes and D5 publication.

## D5 — PublishedImmutable

- [ ] **Publish byte-for-byte identical artifacts.** Consume D4 success only.
  Existing producer workflows own publication: _publish-npm.yml,
  _publish-pypi.yml, _publish-maven.yml, _publish-crates.yml,
  _publish-github-release.yml, and _publish-runtime-github-release.yml.
  Publish the exact D3 bytes and manifest to the enumerated npm/GitHub
  Packages, PyPI, Maven/GitHub Packages, crates.io, and GitHub Release
  channels. Red proof: public immutable references and hashes equal D3, with
  no rebuild, version rewrite, or stable-pointer mutation. Stop on any channel
  mismatch or missing artifact. Rollback: stop promotion, retain ledgers, and
  use the additive supersede/release procedure; never overwrite bytes. Commit
  checkpoint: publication ledger is separate from D4 acceptance.

## D6 — DownloadBackVerified

- [ ] **Download back every D5 public artifact.** Consume D5 URLs/metadata only.
  Fresh downloads must be made through each public channel, compared byte-for-
  byte with the D3 candidate and D5 publication ledger, and checked against
  the manifest/schema/contract identity. A local cache, source package, or
  semantic version is not download-back proof. The stable pointer remains
  unmoved. Red proof: all channel hashes match and the manifest is retrievable
  from the public immutable reference. Stop on any redirect ambiguity,
  missing channel, hash mismatch, or inaccessible manifest. Rollback: do not
  accept or promote; retain D5 and failed D6 ledgers. Commit checkpoint:
  download-back evidence is separate from D5 publication.

## D7 — PublishedAccepted

- [ ] **Repeat the D4 journey using only D6 downloads.** Consume D6 and nothing
  local. Use the exact serial order Capture JPEG -> cleanup -> Capture original
  PDF page 1 -> cleanup -> Cert -> cleanup -> LAW -> cleanup. Require each real
  private JPEG CER <= 3%, each real scanned PDF page-1 CER <= 1%, zero
  critical-anchor omissions, no averaging, exact release hard identity, and
  terminal journal/process/listener/staging cleanup after every child. Stop at
  the first failure; retain the published/downloaded child manifest. Do not
  rebuild, republish, or repair CI as part of D7. Verify the discovered installed
  acceptance target and consumer assertions. Rollback: block D8 and retain
  D6/D7 ledgers. Commit checkpoint: published acceptance evidence is separate
  from D6 downloads.

## D8 — StablePointerMoved

- [ ] **Move the stable pointer only through the existing producer workflow.**
  Consume D7 terminal success only. The sole mutation owner is
  .github/workflows/_publish-stable-pointer.yml, which invokes the existing
  tools/update-release-index.ts against the protected release-index branch.
  A local worker, Tauri, host, or ad hoc script may not edit
  release-index/stable.json. Red proof: D3-D7 manifests, hashes, cleanup
  proofs, and rollback references are retained before the additive pointer
  commit; the prior pointer and immutable release remain available. Stop on
  any missing D7 proof or non-producer mutation. Rollback: additive
  release-index revert through the same producer owner; never rewrite history.
  Commit checkpoint: stable-pointer promotion is owned by release automation,
  not this docs repository commit.

## Documentation handoff and verification

The docs worker stages only the six D0 paths listed above. Before commit:

~~~powershell
git diff --check -- .agents/SPECS/capture-runtime-042-p2-hardening.md .agents/DECISIONS/capture-runtime-042-p2-hardening.md .agents/TODOS/capture-runtime-042-p2-hardening.md .agents/GUIDES/staged-ocr-delivery-workflow.md packages/capture-workbench-ui/README.md apps/capture-workbench-desktop/README.md
git diff --name-only
git status --short
~~~

Validate relative link targets and anchors, balanced Markdown fences, actual
owner paths/symbols, resolved Nx target names, absence of repository-specific
absolute fixture paths in active docs, and absence of a published-version
claim or concrete registry install in the UI README. Stage explicit
paths only, run git diff --cached --check, and commit
docs(phase2): resolve architecture review findings. After commit, report the
new git rev-parse HEAD, exact staged/committed names, checks and unresolved D1
review/CI/evidence gates. Never push.
