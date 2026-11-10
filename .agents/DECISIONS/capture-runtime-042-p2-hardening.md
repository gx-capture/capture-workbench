# Capture Runtime Phase 2 hardening decisions

Status: accepted 2026-09-10; first shipped in 0.4.2. The
[Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md) owns policy,
owner paths, journal schema, compute truth, acceptance and identity. The
open work is [#246](https://github.com/gx-capture/capture-workbench/issues/246) and [#247](https://github.com/gx-capture/capture-workbench/issues/247); the
[release runbook](../GUIDES/release-runbook.md) owns the release procedure.

## Implementation status (2026-11-01)

Live R3 journal CAS (Running/Closing/Terminal and activation-failure
reconciliation) is implemented. Restart reconciliation (automatic attempts
within 60 s, third-failure manual review, authorized recovery, and proof-backed
stale-record terminalization or staging release) is specified but not wired
into production. No host uses the R3 lifecycle yet: desktop, cert-prep and LAW
launch via the legacy path with native Windows Job containment
(`KILL_ON_JOB_CLOSE`). See [#246](https://github.com/gx-capture/capture-workbench/issues/246).

## Decisions

1. **One producer, no second coordinator.** The producer owns OCR, compute,
   model provenance, process lifecycle, version identity, and release evidence.
   Each consumer runs its own acceptance gate and writes its own manifest.
   Cert Prep and GX Law Prep receive semantic adapters and own durable domain
   data only. Runtime jobs, listeners, and run staging are ephemeral; durable
   runtime/model caches are retained.

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
   packages/capture-runtime/src/capture_runtime/ocr/infrastructure/ocr_projection.py::OcrPipeline,
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
Its native implementation may retain a private size-one `start_one` helper
that delegates to the group path. Capture, Cert, and candidate journeys use one
root (target R3 host path; migration pending — see status banner); LAW may
place Capture/Python/Java roots in one producer-owned group. That group uses
the current unnamed no-breakaway Job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; it never uses a named Job takeover and
never weakens normal close or crash cleanup. Root leases, proofs, errors, Jobs,
process handles, PIDs, and native diagnostics do not cross the external seam.
The current spawn/id/try_wait API and PID-bearing RuntimeTerminationProof are
explicit convergence/deletion surface, not a reason to add another
coordinator.

R3 is a whole-group protocol with a required `ReconcileRefSink`. The only
public R3 lifecycle interface (legacy launch interfaces remain public and used —
see status banner) is
`prepare_group(plan, sink) -> PreparedGroup` followed by
`activate_group(PreparedGroup) -> GroupLease`. `PreparedGroup` is opaque,
move-only, and nonserializable; it contains exactly one producer-private
`ActivationPermitV1`, so the host cannot construct, inspect, persist, replay, or
pass a permit. `GroupLease` is opaque, move-only, and one-use. There is no
public permit parameter or per-root activation operation.

`prepare_group` first journals `planned_unbound` with the complete immutable
plan identity and an `unbound` binding. It creates a fresh `bindingAttemptId`
and asks the sink to `persist` the complete group/root binding, `read_back` by
that id, and `verify` the read-back against the complete expected tuple. The
tuple binds the plan digest, group ref, immutable group generation, every
ordered root ref/role/ordinal, immutable root generation/spec digest, reserved
listener identity, and receipt digest. Only after persist/read-back/verify does
the producer write `prepared_bound` with the complete `bound` binding and put
one private permit inside `PreparedGroup`. A missing, stale, forged, partial,
or mismatched binding fails closed.

`activate_group(prepared)` consumes the prepared value. It assigns and verifies
every root suspended, then CASes `ready -> launching` using `journalRevision`
and the complete binding before resuming any root. The reserved listener
identity before resume is distinct from live listener readiness after resume.
A failed or partial assignment, partial resume, or listener-readiness failure
closes the entire Job, issues no lease, and marks/reconciles the whole group;
it never continues one root independently. Single-root convenience is group
size one and uses the same path (target host path; migration pending — see
status banner). Restart reconciliation returns semantic cleanup and
`proofSha256` (specified; not yet wired in production — see status banner),
never native identifiers. Focused red/green cases cover
unbound-binding absence, sink persist/read-back/verify failure, every binding
identity mismatch, stale prepared values, partial assignment with zero resumes,
listener readiness failure after partial resume, and one CAS activation winner.
The returned `GroupLease` carries a private live lease token that is invalidated
on close, cancel, readiness failure, or drop; replay or a second close is
rejected.

   The addressable restart seam is the specified producer API (not yet exported
   or wired in production — see status banner)
   `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`.
   `ReconcileRef` is an opaque journal index/address, never a PID, Job handle,
   path, process id, or takeover lease. Candidate and prior sessions each get a
   distinct ref. `ReconcileResult` is semantic and observe-only after restart
   (specified; not yet wired in production — see status banner):
   only exact full absence/listener/staging proof may terminalize that ref;
   present, reused, unqueryable, or ambiguous observations return
   `reconcile-required` and touch nothing. Candidate and prior refs are
   distinct. For `prior=null`, both the prior ref and predecessor proof digest
   are null and no cleanup proof is implied; a non-null prior requires its
   exact proof digest and generation.

5. **Existing native exports and callers are the migration boundary.**
   src/lib.rs exports OwnedRuntimeSession and its current error/proof types;
   src/launcher/ owns SidecarLaunchSpec, LaunchOptions, LaunchedSidecar,
   launch_sidecar, and launch_sidecar_with_observer; desktop Tauri
   src/state.rs, src/launcher.rs, and src/commands.rs are callers. The
   implementation uses those paths and the existing launcher/desktop Cargo
   targets. It does not invent a desktop process owner.

6. **RuntimeSessionJournalV1 is producer-owned cleanup state.** The journal is
   not host/domain persistence and is never created, mutated, deleted, or
   reconciled by Tauri. Its state-discriminated schema includes
   `planned_unbound` with an `unbound` binding (plan identity only, no receipt,
   group/root refs, or generations) and `prepared_bound` plus each
   resource-bearing descendant with one complete `bound` binding. A
   `reconcile-required` record reached directly from `planned_unbound` may
   remain unbound when no resource was attempted; one reached from a bound
   state retains its complete bound binding. The binding union is exactly
   `unbound | bound`:
   immutable group/root generations and `bindingAttemptId` identify the
   producer binding; mutable `journalRevision` is the CAS revision and never a
   generation counter. Every bound state retains the complete ordered
   group/root tuple and verified receipt. Required base fields include
   schemaVersion, producer, sessionNonce, plan digest, state, timestamps,
   `journalRevision`, recovery epoch, and bounded attempt counter; bound states
   add Job/staging bindings, root records, reserved/live listener identities,
   and semantic terminal proof. Each bound root records role, root nonce, PID,
   process creation identity, state, listener identities, and start time;
   `ready` means every root is assigned and verified suspended. Raw command
   lines, paths, bearer tokens, OCR, model bytes, user names, machine names,
   and arbitrary diagnostics are forbidden. PID and creation identity stay in
   the private producer journal; evidence emits only digests or booleans.

7. **Reconciliation is atomic and fail-closed.** Only the producer writer may
    compare-and-swap expected state, `journalRevision`, attempt, and recovery epoch,
   flush a same-directory temporary
   record, atomically replace it, and flush the file/directory through the
   platform adapter. During a live in-memory close, the private Job handle,
   membership, root/session nonce, exact PID plus creation identity, listener
   binding nonce, and run-scoped staging nonce must match before the producer
   terminates and proves the current group. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
   remains enabled. After restart the specified observer (not yet wired in
   production — see status banner) has no Job handle, membership
   query, or nonce claim and is observe-only: only a trustworthy committed Job
   setup plus every root's absent exact PID/creation identity, absent listeners,
   and exact staging binding may terminalize the stale record and clean that
   staging (specified; not yet wired in production — see status banner). PID
   reuse, a present or unqueryable PID, root mismatch, listener
   ambiguity, missing identity, port-only evidence, access denial, malformed
   journal, or a torn write leaves all residue untouched and records
   reconcile-required (specified; not yet wired in production — see status
   banner). No process-name, PID-only, or port-only kill is valid.

   The exhaustive specified journal graph (restart and no-resource recovery
   transitions are not yet wired in production — see status banner) is
   `planned_unbound -> prepared_bound -> ready -> launching -> running ->
   closing -> terminal`, plus `planned_unbound -> terminal` only for a durable
   no-resource proof, `planned_unbound -> reconcile-required`,
   `prepared_bound|ready|launching|running|closing -> reconcile-required`,
   `reconcile-required -> reconcile-required` for timed/failed attempts one or
   two, `reconcile-required -> terminal` only after a later complete
   observe-only proof, `reconcile-required -> manual-review` after timed/failed
   attempt three, and `manual-review -> reconcile-required` only by explicit
    producer-authorized recovery. Every transition CAS-guards expected state,
    `journalRevision`, attempt, and recovery epoch; the writer increments
    `journalRevision`/attempt atomically; immutable group/root generations never
    change. `manual-review` has no automatic recovery,
   cannot launch a replacement, and cannot transition directly to terminal.
   Recovery requires a fresh opaque nonce and durable authorization receipt
   (specified; not yet wired in production — see status banner),
    increments recovery epoch/journal revision, resets the attempt window, and makes
   no resource mutation; the next full observe-only attempt remains required.
   A stale guard/receipt leaves the record untouched. A direct
   `planned_unbound -> terminal` is allowed only when durable proof shows no
   resource could have existed before sink binding, Job setup, root
   resume/listener/staging/resource acquisition was attempted; otherwise it is
   `reconcile-required`. A bound state always carries the complete group/root
   ref tuple, generation tuple, plan digest, and receipt digest.
   The focused guard cases are
    `reconcile_attempt_and_revision_increment_atomically`,
   `reconcile_rejects_stale_state_generation_attempt_or_epoch`,
   `reconcile_failure_attempt_three_enters_manual_review`,
   `reconcile_complete_observe_only_proof_to_terminal`,
   `manual_review_requires_explicit_recovery_receipt`, and
   `manual_review_recovery_resets_attempt_window_without_resource_mutation`.

   The initial private journal foundation makes the terminal proof partition
   explicit: `unacquiredRootBindings` is required, ordered, disjoint from
   observed terminal roots, and must complete the bound ordinal set. This is an
   unreleased `RuntimeSessionJournalV1` foundation extension, so there is no
   compatibility reader for a missing field. A missing or malformed partition
   fails closed; an absent entry records a planned root that was never acquired
   and does not invent native identity. `JournalRoot.loopbackPort` is a
   required nonzero private observation and is compared across CAS updates, but
   a port is never accepted as ownership or cleanup proof. No authoritative
   `RootRole` enum or closed role vocabulary was found in the
   current `packages/capture-sidecar-launcher/src` owner (the journal's role
   fields are `String`); the value layer therefore retains the producer's role
   string and enforces nonempty exact role identity, while the later
   producer plan owner must supply and validate the closed vocabulary from its
   actual root plan rather than an invented allowlist here.

8. **Contract identity remains fixed.** API 2.0, raw/structured schema 2,
   and CaptureOcrProjectionV3 schema 3 remain the floor; the runtime contract-set hash is `contractSetSha256` in `packages/capture-runtime-client/package.json` (it changes only with a contract release). The
   first implementation slice upgrades Nx 23.1.0 to 23.1.2 in
   package.json and pnpm-lock.yaml and extends
   tools/release/version-sources.ts plus its existing
   capture-tools:release-version-test regression test. It enumerates runtime,
   document/projection schema, TS/Python/Java clients, Rust launcher/crate,
   Workbench packages/assets, manifests/locks/catalogs, and npm, PyPI, Maven,
   crates.io, and GitHub channels. A missing target such as
   capture-runtime:version-check is discovery-and-stop, not a new target.

   The compute real-proof owner is
   `packages/capture-runtime/src/capture_runtime/ocr/infrastructure/ocr_preflight.py:OcrComputePlan.select`
   with `OcrGpuCapabilitySnapshot`. Its focused regression is
   `packages/capture-runtime/tests/unit/test_ocr_compute_plan.py:test_positive_unavailable_dgpu_selects_usable_igpu`:
   a positively unavailable dGPU plus a usable mapped iGPU selects the iGPU
   DirectML mapping, not CPU; an indeterminate dGPU remains fail-closed. The
   existing full verification is
   `corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`.

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
- Rebuilding or republishing between candidate acceptance and publication,
  accepting a local candidate as published acceptance, or moving the stable
  pointer before published acceptance.
