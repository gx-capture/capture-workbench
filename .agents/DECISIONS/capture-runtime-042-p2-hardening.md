# Capture Runtime 0.4.2 Phase 2 hardening decisions

Status: canonical rationale record for the documentation checkpoint dated
2026-09-09. The [Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md)
owns policy, actual owner paths, interface alternatives, journal schema,
compute truth, acceptance, identity, and D0-D8 gates. The
[TODO](../TODOS/capture-runtime-042-p2-hardening.md) owns executable work; the
[GUIDE](../GUIDES/staged-ocr-delivery-workflow.md) owns fresh-worker procedure.

## Checkpoint and authority

The documentation correction starts from
1df7eecccd4097c172c9338a7f584f9489e5ae78. The four canonical docs, the UI
README banner, and the desktop README fixture example are the owned edit scope.
Untracked .github/copilot-instructions.md and .github/instructions/ are
preserved and are not staged. The exact resulting SHA is not embedded in this
record; the D0 handoff reports git rev-parse HEAD externally.

PR #39 remains an engineering checkpoint at
c6d2140e233de70734005713427f77f92414f415; its deterministic CI is green but
the PR is unmerged. Phase 1 is complete only at the local-probe tier: the
three-project Capture -> Cert -> LAW sequence passed with local package bytes.
That is not candidate, published, or release evidence. No current-HEAD Phase 2
real JPEG/PDF, GPU, cleanup, candidate, download-back, or publication result is
claimed. Source version 0.4.2 is not proof of a published package.

CI repair is paused and has no authority in this checkpoint. This task does not
edit workflows, rerun or retry CI, or treat CI as model, GPU, cleanup,
installation, publication, or stable-pointer evidence.

## Change-mode checkpoint

~~~text
Change mode: mixed, edit-first
Existing owners: Phase 2 SPEC/DECISION/TODO/GUIDE and two active READMEs
Delete/supersede: old policy only after replacement tests and an additive commit
New coordinator: prohibited; converge existing OcrPipeline and OwnedRuntimeSession
Feature/code authority: none in this documentation checkpoint
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
   place Capture/Python/Java roots in one producer-owned Job/group. Root leases,
   proofs, errors, Jobs, process handles, PIDs, and native diagnostics do not
   cross the external seam. The current spawn/id/try_wait API and PID-bearing
   RuntimeTerminationProof are explicit convergence/deletion surface, not a
   reason to add another coordinator.

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
   sessionNonce, monotonic generation, state, timestamps, Job binding, staging
   binding, root records, listener bindings, and semantic terminal proof.
   Each root records role, root nonce, PID, process creation identity, state,
   listener bindings, and start time. Raw command lines, paths, bearer tokens,
   OCR, model bytes, user names, machine names, and arbitrary diagnostics are
   forbidden. PID and creation identity stay in the private producer journal;
   evidence emits only digests or booleans.

7. **Reconciliation is atomic and fail-closed.** Only the producer writer may
   compare-and-swap a state/generation, flush a same-directory temporary
   record, atomically replace it, and flush the file/directory through the
   platform adapter. A reconciler may terminate or delete only after exact
   PID plus creation identity, root/session nonce, producer Job membership,
   listener binding nonce, and run-scoped staging nonce all match. PID reuse,
   missing identity, port-only evidence, ambiguity, access denial, malformed
   journal, or a torn write leaves residue and records
   reconcile-required. The current launcher cannot yet prove every listener
   binding, so implementation must reduce the claim to unknown ownership and
   no kill/delete until it can.

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

9. **Acceptance is per fixture and serial.** Every real scanned PDF page 1
   must have CER <= 1%; every real private JPEG must have CER <= 3%; zero
   critical-anchor omissions are allowed; CER is never averaged. D4 consumes
   only D3 candidate bytes and runs Capture JPEG -> cleanup -> Capture original
   PDF page 1 -> cleanup -> Cert -> cleanup -> LAW -> cleanup. D7 consumes only
   D6 download-back bytes and repeats that same sequence. Model memory and
   journal/process/listener/staging cleanup must be proven before each next
   child.

10. **Release gates do not collapse.** D0 DocsCommitted is the current docs
    commit and has no self-hash. D1 is pending exact-head review. D2 is
    authorization only. D3 builds one candidate. D4 accepts only D3. D5
    publishes identical D3 bytes. D6 downloads those public bytes back. D7
    accepts only D6. D8 permits only the existing producer
    .github/workflows/_publish-stable-pointer.yml and
    tools/update-release-index.ts to mutate the stable pointer. A worker,
    host, Tauri, or local script has no pointer authority.

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
ledgers, and rollback references. Rollback is additive: revert the named
slice or use the producer release-index revert procedure; never reset, rebase,
amend, broad-delete, or overwrite an immutable artifact. Any later content
commit invalidates D1 and requires a fresh exact-head review. This record
claims no feature code, model run, candidate, publication, download-back,
published acceptance, or stable-pointer mutation.
