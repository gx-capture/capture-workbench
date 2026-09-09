# Capture Runtime 0.4.2 Phase 2 hardening decisions

Status: canonical rationale record for the documentation checkpoint dated
2026-09-09. The [Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md)
owns policy, actual owner paths, interface alternatives, journal schema,
compute truth, acceptance, identity, and D0-D8 gates. The
[TODO](../TODOS/capture-runtime-042-p2-hardening.md) owns executable work; the
[GUIDE](../GUIDES/staged-ocr-delivery-workflow.md) owns fresh-worker procedure.

## Checkpoint and authority

This closure starts from expected HEAD
b7fed18bb25cdb52df02e6ccd76eb82cdc44f621. The four canonical docs and the two
active READMEs are the modified scope. Untracked
.github/copilot-instructions.md and .github/instructions/ are preserved and are
not staged. The exact resulting SHA is not embedded in this
record; the D0 handoff reports git rev-parse HEAD externally.

PR #39 remains an engineering checkpoint at
c6d2140e233de70734005713427f77f92414f415; its deterministic CI is green but
the PR is unmerged. Phase 1 is complete only at the local-probe tier: the
three-project Capture -> Cert -> LAW sequence passed with local package bytes.
That is not candidate, published, or release evidence. No current-HEAD Phase 2
real JPEG/PDF, GPU, cleanup, candidate, download-back, or publication result is
claimed. Source version 0.4.2 is not proof of a published package.

CI repair is paused and has no authority in this checkpoint. The future D5-D8
implementation slice explicitly owns publication-workflow contract edits; this
documentation task makes no workflow changes, reruns no CI, and treats no CI
result as model, GPU, cleanup, installation, publication, or stable-pointer
evidence.

## Change-mode checkpoint

~~~text
Change mode: mixed, edit-first
Existing owners: Phase 2 SPEC/DECISION/TODO/GUIDE and two active READMEs
Delete/supersede: old policy only after replacement tests and an additive commit
New coordinator: prohibited; converge existing OcrPipeline and OwnedRuntimeSession
Feature/code authority: none in this documentation checkpoint; future D5-D8
workflow-contract edits are explicitly reserved for their named owner slice
Verification floor: read-only owner/target/link/fence/diff checks
~~~

The old GPU/P1 documents already have visible historical banners. Their bodies
remain evidence and are not rewritten in this slice. A later implementation
worker may delete superseded policy only after residual scans and deletion tests.

## Decisions

1. **One producer, no second coordinator.** The producer owns OCR, compute,
   model provenance, process lifecycle, acceptance, version identity, and
   release evidence. Cert Prep and GX Law Prep receive semantic adapters and
   own durable domain data only. Runtime jobs, listeners, and run staging are
   ephemeral; durable runtime/model caches are retained.

2. **Deepening is convergence/replacement.** The implementation worker starts
   from current symbols, migrates callers through one external seam, hides
   platform/transport/test adapters, and deletes obsolete helpers after
   replacement tests. Convenience wrappers that leave policy in hosts are not
   considered a deep module.

3. **OcrPipeline alternatives and choice.** The SPEC records three materially
   different designs:
   - O1 is one terminal extract(request, engine) -> outcome operation.
   - O2 is a progressive open -> next_page -> finish page session.
   - O3 is a pure projection reducer whose callers own OCR collection.

   Choose O1. The repository already has
   packages/capture-runtime/src/capture_runtime/ocr_projection.py::OcrPipeline,
   an OcrEnginePort, producer worker/extractor adapters, and several callers.
   One terminal operation hides page order, rasterization, normalization,
   provenance, cancellation, and typed failure. Current
   normalize/serialize/failure helpers are migration/deletion surface, not
   permanent seams.

4. **OwnedRuntimeSession alternatives and choice.** The SPEC records three
   materially different designs:
   - R1 is an opaque single-root semantic facade.
   - R2 is a journal-first opaque lease/reconciler protocol.
   - R3 is a producer-owned group/session with one-root convenience.

Choose R3 in the existing Rust owner
packages/capture-sidecar-launcher/src/process.rs::OwnedRuntimeSession.
Its native implementation may add start_one and start_root(role, spec)
capability. Capture, Cert, and candidate journeys use one root; LAW may
place Capture/Python/Java roots in one producer-owned group. That group uses
the current unnamed no-breakaway Job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; it never uses a named Job takeover and
   never weakens normal close or crash cleanup. Root leases, proofs, errors, Jobs,
   process handles, PIDs, and native diagnostics do not cross the external seam.
   The current spawn/id/try_wait API and PID-bearing RuntimeTerminationProof are
   explicit convergence/deletion surface, not a reason to add another
   coordinator.

   The addressable restart seam is the exact producer API
   `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`.
   `ReconcileRef` is an opaque journal index/address, never a PID, Job handle,
   path, process id, or takeover lease. Candidate and prior sessions each get a
   distinct ref. `ReconcileResult` is semantic and observe-only after restart:
   only exact absence/listener/staging proof may terminalize that ref;
   present, reused, unqueryable, or ambiguous observations return
   `reconcile-required` and touch nothing.

5. **Existing native exports and callers are the migration boundary.**
   src/lib.rs exports OwnedRuntimeSession and its current error/proof types;
   src/launcher.rs owns SidecarLaunchSpec, LaunchOptions, LaunchedSidecar,
   launch_sidecar, and launch_sidecar_with_observer; desktop Tauri
   src/state.rs, src/launcher.rs, and src/commands.rs are callers. The
   implementation uses those paths and the existing launcher/desktop Cargo
   targets. It does not invent a desktop process owner.

6. **RuntimeSessionJournalV1 is producer-owned cleanup state.** The journal is
   not host/domain persistence and is never created, mutated, deleted, or
   reconciled by Tauri. Its required schema includes schemaVersion, producer,
   sessionNonce, monotonic generation, state, Job binding (including a
   durably committed setup state), staging binding, root records, listener
   bindings, and semantic terminal proof. Each root records role, root nonce,
   PID, process creation identity, state, listener bindings, and start time.
   Raw command lines, paths, bearer tokens, OCR, model bytes, user names,
   machine names, and arbitrary diagnostics are forbidden. PID and creation
   identity stay in the private producer journal; evidence emits only digests
   or booleans.

7. **Reconciliation is atomic and fail-closed.** Only the producer writer may
   compare-and-swap a state/generation, flush a same-directory temporary
   record, atomically replace it, and flush the file/directory through the
   platform adapter. During a live in-memory close, the private Job handle,
   membership, root/session nonce, exact PID plus creation identity, listener
   binding nonce, and run-scoped staging nonce must match before the producer
   terminates and proves the current group. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
   remains enabled. After restart the observer has no Job handle, membership
   query, or nonce claim and is observe-only: only a trustworthy committed Job
   setup plus every root's absent exact PID/creation identity, absent listeners,
   and exact staging binding may terminalize the stale record and clean that
   staging. PID reuse, a present or unqueryable PID, root mismatch, listener
   ambiguity, missing identity, port-only evidence, access denial, malformed
   journal, or a torn write leaves all residue untouched and records
   reconcile-required. No process-name, PID-only, or port-only kill is valid.

   The journal graph is `planned -> launching -> running -> closing -> terminal`,
   plus `planned -> reconcile-required` and
   `launching|running|closing -> reconcile-required`. A direct
   `planned -> terminal` is allowed only when durable proof shows no resource
   could have existed before Job setup/root resume/listener/staging/resource
   acquisition was attempted; otherwise it is `reconcile-required`.

8. **Contract identity remains fixed.** API 2.0, raw/structured schema 2,
   CaptureOcrProjectionV3 schema 3, and contract hash
   d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40 remain
   the floor. The first implementation slice upgrades Nx 23.1.0 to 23.1.2 in
   package.json and pnpm-lock.yaml and extends
   tools/release/version-sources.ts plus its existing
   capture-tools:release-version-test regression test. It enumerates runtime,
   document/projection schema, TS/Python/Java clients, Rust launcher/crate,
   Workbench packages/assets, manifests/locks/catalogs, and npm, PyPI, Maven,
   crates.io, and GitHub channels. A missing target such as
   capture-runtime:version-check is discovery-and-stop, not a new target.

   The compute real-proof owner is
   `packages/capture-runtime/src/capture_runtime/ocr_preflight.py:OcrComputePlan.select`
   with `OcrGpuCapabilitySnapshot`. Its focused regression is
   `packages/capture-runtime/tests/unit/test_ocr_compute_plan.py:test_positive_unavailable_dgpu_selects_usable_igpu`:
   a positively unavailable dGPU plus a usable mapped iGPU selects the iGPU
   DirectML mapping, not CPU; an indeterminate dGPU remains fail-closed. The
   existing full verification is
   `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`.

9. **Acceptance is per fixture and serial.** Every real scanned PDF page 1
   must have CER <= 1%; every real private JPEG must have CER <= 3%; no
   critical-anchor omissions are allowed; CER is never averaged. The producer
   owns proposed `AcceptanceChildWireV1`, `ProducerChildInvocationV1`, and
   private `PrivateOcrTruthOracleV1`; canonical compact UTF-8 JSON excludes
   each self digest, hashes exact raw media/artifact bytes, and exports truth
   digests only. `nfkc-whitespace-v1` is NFKC then newline/Unicode-whitespace
   collapse to ASCII space and trim, preserving case/punctuation and
   traditional/simplified characters; distance is code-point Levenshtein v1.
   D4 consumes only D3 candidate bytes and runs four unique legs:
   `(1, capture-private-jpeg, capture-private-jpeg-v1)`,
   `(2, capture-scanned-pdf-page1, capture-scanned-pdf-page1-v1)`,
   `(3, cert, cert-v1)`, `(4, law, law-v1)`, each with unique childId/root/
   artifactId and cleanup proof before the next. D7 consumes only D6
   download-back bytes and repeats that sequence. Model memory and
   journal/process/listener/staging cleanup must be proven before each next
   child. Cert and LAW adapter migration paths are named in the SPEC; the
   standalone real-JPEG coordinator is migrated/deleted in favor of the sole
   `tools/three-project-acceptance.ts:runAcceptanceSequence` runner.

10. **Release gates do not collapse.** D0 DocsCommitted is the current docs
    commit and has no self-hash. D1 is pending exact-head review. D2 is
    authorization only. D2/D2.5 are design/contract/red infrastructure and do
    not require an installed candidate. D3 builds one immutable byte ledger.
    D4 accepts only externally supplied D3 root/id/digests through the future
    `capture-workbench-desktop:acceptance-d3-candidate` target owned by
    `apps/capture-workbench-desktop/scripts/acceptance-d3-candidate.ts:runD3CandidateAcceptance`;
    that target never stages/builds, imports source, or follows a mutable URL.
    The current `capture-workbench-desktop:acceptance-real` remains non-D4. D5
    publishes every D3 byte after D4 and removes the current direct stable
    pointer edge from `.github/workflows/release-promote.yml`. D6 fresh-downloads
    those public bytes. D7 accepts only D6 and runs the same serial journey.
    D8 is a separate protected dispatch consuming the D7 digest chain and a
    current-pointer CAS guard, then invokes the producer
    `.github/workflows/_publish-stable-pointer.yml` adapter and
    `tools/update-release-index.ts`. A worker, host, Tauri, or local script has
    no pointer authority.

## Future D5-D8 workflow slice

The workflow files are existing producer owners, not untouchable CI files. A
future D2-authorized slice owns the contract correction across
`.github/workflows/release-promote.yml`,
`.github/workflows/_publish-stable-pointer.yml`,
`.github/workflows/_publish-promotion-ledger.yml`,
`.github/workflows/_publish-github-release.yml`, and
`.github/workflows/_verify-registries.yml`,
`.github/workflows/_publish-runtime-github-release.yml` for the existing
runtime-release lane where applicable,
`tools/create-promotion-ledger.ts`, `tools/update-release-index.ts`,
`tools/three-project-acceptance.ts`, and `tools/acceptance-contract.ts`. The
existing symbols are `parseArguments`/`main`, `updateReleaseIndex`/`main`,
`runAcceptanceSequence`/`runCaptureWorkbenchAcceptance` and the three
manifest validators, plus `writeAcceptanceManifest`/
`readAcceptanceManifestTolerant`. D5 must consume D4, publish every exact D3
artifact through the registry and GitHub Release jobs, write its publication
ledger, and remove the direct stable-pointer call/edge; no D5 path may invoke it
transitively. A single-lane retry cannot terminalize D5 or dispatch D6 until all
required lanes pass. D6 must be a fresh public
download-back dispatch. D7 must be a separate
downloaded-byte acceptance dispatch that runs the existing serial Capture ->
Cert -> LAW owner. D8 must be a separate protected dispatch that consumes the
D7 chain and expected pointer generation / digest, checks CAS, and only then
invokes the stable-pointer adapter.

No D6/D7 workflow-contract target or separate D8 dispatch exists in the current
checkout. Their target/file creation is a discovery task in D2: inspect the
resolved `capture-tools` project, create or assign the owner, then add focused
contract tests before marking the slice GREEN. Existing publication, manifest,
registry, and release-index tests are supporting checks, not proof that the
future dispatch contracts already exist.

## Rejected framings

- Treating a green deterministic PR or completed local-probe Phase 1 as
  published/release proof.
- Choosing a run-shaped OcrPipeline or single-root lifecycle API without the
  three alternatives, comparison, and current-owner migration.
- Adding a coordinator around desktop state instead of converging
  OwnedRuntimeSession and its launcher exports/callers.
- Letting a timeout, exception, unknown adapter, or incomplete identity guess
  CPU; or retrying CPU/another GPU after selected DirectML failure.
- Persisting tokens, OCR, source/model paths, raw process diagnostics, or host
  process handles.
- Treating a PID, parent process, executable name, port, or directory name as
  ownership proof.
- Naming a Job for restart takeover, adopting a Job after restart, or weakening
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` to make recovery easier.
- Treating D2/D2.5 as an installed-candidate gate, or letting D4 call
  `stage-product-runtime`, a build/source path, or a mutable URL. The future
  D4 target must accept externally supplied D3 root/id/digests; the existing
  `acceptance-real` target is non-D4.
- Keeping `apps/capture-workbench-desktop/scripts/real-jpeg-acceptance-coordinator.ts`
  as a parallel producer; its `runRealJpegAcceptance`/CLI migrates into the
  sole `tools/three-project-acceptance.ts:runAcceptanceSequence` runner and is
  deleted only after residual and async-boundary checks.
- Rebuilding or republishing between D3/D4/D5, accepting a local candidate in
  D7, or moving the stable pointer before D7.

## Review and rollback

Standards review checks repository conventions, exact current-code paths,
target validity, links/anchors/fences, privacy, active README portability,
generated-file discipline, and staged scope. Specification review checks
interface depth, OCR-only behavior, compute truth, journal/reconciler
semantics, identity tiers, acceptance thresholds/order, release channels,
publication byte equality, and rollback. Neither report is a gate until it
names the exact post-D0 HEAD and external check/PR metadata.

A failed gate stops later work and preserves sanitized evidence, journals,
ledgers, and rollback references. Before publication, retain the failed
candidate and stop. After publication, rollback is producer supersession only:
publish a corrected successor through the immutable candidate/D5-D8 chain and
mark the defective release superseded through the protected producer index
operation. Never overwrite published `0.4.2` bytes or directly revert the
stable pointer; never reset, rebase, amend, or broad-delete. Any later content
commit invalidates D1 and requires a fresh exact-head review. This record claims
no feature code, model run, candidate, publication, download-back, published
acceptance, or stable-pointer mutation.
