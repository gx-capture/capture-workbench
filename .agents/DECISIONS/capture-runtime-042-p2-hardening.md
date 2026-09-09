# Capture Runtime 0.4.2 Phase 2 hardening decisions

Status: canonical rationale record for the documentation checkpoint dated
2026-09-10. The [Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md)
owns policy, actual owner paths, interface alternatives, journal schema,
compute truth, acceptance, identity, and D0-D8 gates. The
[TODO](../TODOS/capture-runtime-042-p2-hardening.md) owns executable work; the
[GUIDE](../GUIDES/staged-ocr-delivery-workflow.md) owns fresh-worker procedure.

## Checkpoint and authority

This closure starts from expected HEAD
78c8fe2718daa25ccf4b509a18598b4a710db47b; stop if `HEAD` drifts. The four canonical docs and the two
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
Its native implementation may retain a private size-one `start_one` helper
that delegates to the group path. Capture, Cert, and candidate journeys use one root; LAW may
place Capture/Python/Java roots in one producer-owned group. That group uses
the current unnamed no-breakaway Job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; it never uses a named Job takeover and
never weakens normal close or crash cleanup. Root leases, proofs, errors, Jobs,
process handles, PIDs, and native diagnostics do not cross the external seam.
The current spawn/id/try_wait API and PID-bearing RuntimeTerminationProof are
explicit convergence/deletion surface, not a reason to add another
coordinator.

R3 is a whole-group protocol with a required `ReconcileRefSink`:
`prepare_group(immutable_plan, sink)` first journals `planned_unbound` with the
complete immutable plan identity but no bound refs and no
`activationReceiptDigest`. The sink's `persist_group_refs` durably persists one
group ref plus every ordered per-root ref/generation and flushes a
`ReconcileRefReceiptV1`; its `verify_group_receipt` reopens, re-hashes, and
verifies the group/root refs, generations, roles, ordinals, and plan digest.
Only after that verification does the producer write `prepared_bound` and
construct one private `ActivationPermitV1` containing the permit version,
plan digest, group-ref digest/generation, complete root-ref digest/generation
bindings, and receipt digest. A missing, stale, forged, partial, or mismatched
permit fails closed.

`activate_group(prepared, permit)` is the only activation operation. It
assigns and verifies every root suspended before resuming any root. A failed or
partial assignment resumes none and closes/reconciles the suspended set. The
host cannot construct the permit, activate first, or activate an individual
root against a group `planned_unbound`/`prepared_bound` record. Single-root
convenience is group size one and may only wrap this same prepare/activate path;
there is no per-root activation seam. Reconciliation returns semantic cleanup
and `proofSha256`, never native identifiers. Focused red/green cases cover
planned-unbound receipt absence, sink failure, every group/root ref and
generation mismatch, stale permits, partial assignment with zero resumes, and
concurrent activation with one CAS winner.

   The addressable restart seam is the exact producer API
   `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`.
   `ReconcileRef` is an opaque journal index/address, never a PID, Job handle,
   path, process id, or takeover lease. Candidate and prior sessions each get a
   distinct ref. `ReconcileResult` is semantic and observe-only after restart:
   only exact full absence/listener/staging proof may terminalize that ref;
   present, reused, unqueryable, or ambiguous observations return
   `reconcile-required` and touch nothing. Candidate and prior refs are
   distinct. For `prior=null`, both the prior ref and predecessor proof digest
   are null and no cleanup proof is implied; a non-null prior requires its
   exact proof digest and generation.

5. **Existing native exports and callers are the migration boundary.**
   src/lib.rs exports OwnedRuntimeSession and its current error/proof types;
   src/launcher.rs owns SidecarLaunchSpec, LaunchOptions, LaunchedSidecar,
   launch_sidecar, and launch_sidecar_with_observer; desktop Tauri
   src/state.rs, src/launcher.rs, and src/commands.rs are callers. The
   implementation uses those paths and the existing launcher/desktop Cargo
   targets. It does not invent a desktop process owner.

6. **RuntimeSessionJournalV1 is producer-owned cleanup state.** The journal is
   not host/domain persistence and is never created, mutated, deleted, or
   reconciled by Tauri. Its state-discriminated schema includes
   `planned_unbound` (plan identity only, with no activation receipt, group-ref
   digest/generation, or bound root refs/generations) and `prepared_bound` plus
   its descendants (complete group/root ref and generation bindings and a
   required verified activation receipt). The required base fields include
   schemaVersion, producer, sessionNonce, plan digest, state, timestamps,
   recovery epoch, and bounded attempt counter; bound states add group-ref
   digest/generation, Job/staging bindings, root records, listener bindings,
   and semantic terminal proof. Each bound root records role, root
   nonce, PID, process creation identity, state, listener bindings, and start
   time; `ready` means every root is assigned and verified suspended.
   Raw command lines, paths, bearer tokens, OCR, model bytes, user names,
   machine names, and arbitrary diagnostics are forbidden. PID and creation
   identity stay in the private producer journal; evidence emits only digests
   or booleans.

7. **Reconciliation is atomic and fail-closed.** Only the producer writer may
   compare-and-swap expected state, generation, attempt, and recovery epoch,
   flush a same-directory temporary
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

   The exhaustive journal graph is
   `planned_unbound -> prepared_bound -> ready -> launching -> running ->
   closing -> terminal`, plus `planned_unbound -> terminal` only for a durable
   no-resource proof, `planned_unbound -> reconcile-required`,
   `prepared_bound|ready|launching|running|closing -> reconcile-required`,
   `reconcile-required -> reconcile-required` for timed/failed attempts one or
   two, `reconcile-required -> terminal` only after a later complete
   observe-only proof, `reconcile-required -> manual-review` after timed/failed
   attempt three, and `manual-review -> reconcile-required` only by explicit
   producer-authorized recovery. Every transition CAS-guards expected state,
   generation, attempt, and recovery epoch; the writer increments
   generation/attempt atomically. `manual-review` has no automatic recovery,
   cannot launch a replacement, and cannot transition directly to terminal.
   Recovery requires a fresh opaque nonce and durable authorization receipt,
   increments recovery epoch/generation, resets the attempt window, and makes
   no resource mutation; the next full observe-only attempt remains required.
   A stale guard/receipt leaves the record untouched. A direct
   `planned_unbound -> terminal` is allowed only when durable proof shows no
   resource could have existed before sink binding, Job setup, root
   resume/listener/staging/resource acquisition was attempted; otherwise it is
   `reconcile-required`. A bound state always carries the complete group/root
   ref tuple, generation tuple, plan digest, and receipt digest.
   The focused guard cases are
   `reconcile_attempt_and_generation_increment_atomically`,
   `reconcile_rejects_stale_state_generation_attempt_or_epoch`,
   `reconcile_failure_attempt_three_enters_manual_review`,
   `reconcile_complete_observe_only_proof_to_terminal`,
   `manual_review_requires_explicit_recovery_receipt`, and
   `manual_review_recovery_resets_attempt_window_without_resource_mutation`.

8. **Contract identity remains fixed.** API 2.0, raw/structured schema 2,
   CaptureOcrProjectionV3 schema 3, and runtime contract-set hash
   d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40 remain
   the floor. The acceptance contract has a separate generated package/hash:
   `@capture-runtime/acceptance-contract` under the proposed
   `packages/capture-acceptance-contract/` owner, with JSON schemas,
   `src/codecs.ts`, `tools/generate.ts`, `src/manifest.ts`, `src/hash.ts`,
   `contract-manifest.json`, `contract-sha256.txt`, `package.json`, and
   `project.json`. This package/bundle hash is distinct from the runtime
   contract-set hash and is the only acceptance schema/codec authority; the
   existing `tools/acceptance-contract.ts` is a consumer adapter only. The
   first implementation slice upgrades Nx 23.1.0 to 23.1.2 in
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

9. **Acceptance is one producer contract, per fixture, and serial.** Every
    real scanned PDF page 1 must have CER <= 1%; every real private JPEG must
    have CER <= 3%; no critical-anchor omissions are allowed; CER is never
    averaged. The producer owns one generated `ProducerAcceptanceContractV1`
    from `@capture-runtime/acceptance-contract`, version `"1"`, with a
    D3/D6-bound canonical package/bundle `contractSha256`. Cert and LAW consume
    the exact package bytes/hash and may not copy schemas, redefine producer
    record names or fields, or create local validators. The producer is the sole
    writer of mutable `ProducerChildScopeV1` at
    `CAPTURE_ACCEPTANCE_SCOPE_PATH`; it publishes a
    frozen `ProducerChildInvocationV1` through the distinct
    `CAPTURE_ACCEPTANCE_INVOCATION_PATH` (or read-only handle/pipe); the child
    writes exactly one `ConsumerSemanticResultV1` at the separate
    `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; and only after validation and
    cleanup does the producer emit immutable `AcceptanceChildWireV1` at
    `CAPTURE_ACCEPTANCE_WIRE_PATH`. The child never receives scope or final
    wire. Invocation bytes are canonicalized, atomically create-new published,
    flushed, digest-bound, frozen, and ACL/read-only checked before launch.
    Semantic output is canonicalized and atomically create-new written once;
    any second create, overwrite, partial record, or digest mismatch fails
    closed. `ConsumerSemanticResultV1` contains no cleanup fields; the producer
    adds `producerCleanup` only to the final wire.

    Scope is a state-discriminated union: `planned` contains only child/plan
    identity; `prepared` adds the complete group/root ref and generation
    bindings; `ready` adds the invocation digest and output nonce. The producer
    computes the self-excluded invocation digest before the final bytes exist,
    writes canonical bytes to a secure same-directory temporary, flushes and
    closes it, atomically creates the final file, reopens it read-only to verify
    bytes/digest, and freezes/ACL-checks it before `activate_group`. No root is
    resumed before that verification.

    The wire carries parentGate/tier, D3 or D6 ledger binding, invocation
    digest, ordered `fixtureAssignments[]`, equal-cardinality/order-bound
    `fixtureResults[]` with per-fixture key/index/identity/media/oracle/artifact
    digests, actual normalized-output digest/CER/anchor omissions/outcome/
    projection digest, expected truth/anchor digests, child semantic-result
    digest, detailed producer cleanup, privacy flags, and its self-excluded
    canonical digest. Capture JPEG and Capture PDF page-1 children each have
    exactly one assignment with keys `capture-private-jpeg-1` and
    `capture-scanned-pdf-page1-1`; Cert/LAW may have multiple assignments but
    cannot add, remove, reorder, or substitute one. D4 consumes only D3
    candidate bytes and runs four unique legs; D7 consumes only D6 downloads
    and repeats that sequence. D4/D7 require full private normalized reference
    text plus critical anchors. The formal Cert migration deletes the
    `anchorOnly` field/flag and parser; a legacy field is rejected, never
    ignored or accepted as anchor-only success. The standalone real-JPEG
    coordinator is migrated/deleted in favor of the sole
    `tools/three-project-acceptance.ts:runAcceptanceSequence` runner.

    `fixtureAssignments[]` include opaque media and oracle capability handles
    plus their handle digests, media digest, and oracle digest. The producer
    defines the generic capability shape; Cert and LAW own private resolvers and
    read-only stores that verify the handle and `mediaSha256`/`oracleSha256`
    bindings. Raw paths, text, and store locations never enter the invocation,
    wire, or host response; exact normalized CER executes against the resolved
    real media/full truth.

    The Python LAW adapter migration is anchored at
    `${GX_LAW_PREP_CHECKOUT}/apps/law-prep-ai-service/src/app/ocr/service.py:OcrExtractionService.extract`
    and its `CaptureRuntimeClient` seam. The producer defines `RequestRefV1`
    as `rr1_` plus 64 lowercase hex characters; Python generates it with
    CSPRNG `secrets.token_bytes(32)`, never from request data. Python persists
    `start_pending` with ref/digest/contract identity before idempotent
    `start_or_get(RequestRefV1, StartCaptureByRequestRefV1 metadata, source byte
    stream)`. The producer recomputes the canonical request digest and source
    byte count/digest. Same ref plus same metadata and bytes creates/discovers
    without duplication; changed metadata, length, or source bytes conflicts
    without mutation; only a producer ACK/discovery receipt permits `running`;
    timeout/dropped ACK stays pending and retries the same tuple.
    `RequestRefV1` is exactly `rr1_` plus 64 lowercase hex characters from 32
    CSPRNG bytes. Lookup/cancel/delete use the same ref.
    The producer journals before capture side effect, retains sanitized cleanup
    state for a bounded period, and uses the same v2 operation/lifecycle. Tokens,
    paths, and native ids never cross the seam; API `2.0` and
    `CaptureOcrProjectionV3` schema `3` remain unchanged.

10. **D2.5 cross-repository handoff is root/HEAD/path bound.** The only sibling
    inputs are `${CERT_PREP_CHECKOUT}` and `${GX_LAW_PREP_CHECKOUT}` (PowerShell
    `${env:CERT_PREP_CHECKOUT}` and `${env:GX_LAW_PREP_CHECKOUT}`). D2 records the
    resolved Git root, authorized branch, authorized `HEAD`, and exact path set
    for each. Before edits, a worker runs `git -C <resolved-root>
    rev-parse --show-toplevel`, `rev-parse --abbrev-ref HEAD`, `rev-parse HEAD`,
    `ls-files --error-unmatch -- <exact-path>`, and a path-scoped
    `status --short --untracked-files=all -- <exact-path>`. Root mismatch,
    branch/`HEAD` drift, missing/extra path, missing variable, or unresolved
    owner is discovery-and-stop. Consumer docs/adapters import/reference only
    the exact generated `@capture-runtime/acceptance-contract` package bytes,
    version `"1"`, and literal D3/D6 `contractSha256`; they do not fork
    schemas, names, fields, codecs, or validators. `tools/acceptance-contract.ts`
    remains a consumer adapter and is not contract authority.
    Capture, Cert, and LAW each commit only inside their own resolved root and
    report separate SHAs/checks; no one Capture commit stages sibling files.

11. **Release gates do not collapse.** D0 DocsCommitted is the current docs
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
`tools/three-project-acceptance.ts`, the proposed
`packages/capture-acceptance-contract/` package/bundle, and
`tools/acceptance-contract.ts` as its consumer adapter. The existing symbols
are `parseArguments`/`main`, `updateReleaseIndex`/`main`,
`runAcceptanceSequence`/`runCaptureWorkbenchAcceptance` and the three
manifest validators, plus `writeAcceptanceManifest`/
`readAcceptanceManifestTolerant`; the adapter may consume the canonical package
but is not schema/codec/generator/manifest/hash authority. D5 must consume D4, publish every exact D3
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
