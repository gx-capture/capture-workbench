# Capture Runtime 0.4.2 Phase 2 hardening (canonical design)

Status: canonical Phase 2 policy and acceptance source. `D0 DocsCommitted` is
complete for the commit that contains this documentation correction. The exact
commit id is intentionally not written here: external review binds the result
with `git rev-parse HEAD` after the commit. `D1 DesignReviewed` is pending a
fresh Standards and Specification review at that exact head. This document is
design and delivery policy; it does not authorize implementation, packaging,
publication, or stable-pointer mutation.

## Current checkpoint: 2026-09-10

- This closure starts from expected HEAD
  `78c8fe2718daa25ccf4b509a18598b4a710db47b`; stop if `HEAD` drifts. The only pre-existing working
  tree changes are untracked `.github/copilot-instructions.md` and
  `.github/instructions/`; they are preserved and are not part of this slice.
- PR #39 is at `c6d2140e233de70734005713427f77f92414f415`; its deterministic CI
  is green, but the PR is not merged. Phase 1 is complete only at the
  local-probe tier: Capture, Cert Prep, and GX Law Prep passed real
  local-package OCR in that order. That is not published or release evidence.
- No current-HEAD Phase 2 real JPEG, PDF page-1, GPU, cleanup, immutable
  candidate, download-back, or publication result is claimed. Source files
  currently contain release value `0.4.2`; that does not establish that an
  official `0.4.2` package is published.
- CI repair is paused and has no authority in this checkpoint. The named D5-D8
  implementation slice below explicitly owns publication-workflow contract
  edits; this documentation checkpoint makes no workflow changes, reruns no
  CI, and treats no deterministic run as OCR, GPU, cleanup, install, or release
  proof.
- The only completed state-machine gate in this docs commit is D0. D1 remains
  pending until a fresh external review names the post-commit `HEAD`, exact
  paths, and external check/PR metadata. Any later content commit returns the
  state to D1.

## Purpose and non-goals

Phase 2 hardens the existing producer-owned OCR and runtime lifecycle behind
deep modules, then proves the same bytes through candidate, publication,
download-back, and repeated consumer acceptance. It preserves the public
contract floor while making ownership, identity, cleanup, and evidence
mechanically checkable.

Non-goals:

- PDFium rasterizes every requested PDF page; PaddleOCR is the only extraction
  source. Embedded PDF text is never read, and no hybrid or LLM-routed path is
  introduced.
- Hosts do not create Paddle engines, choose devices, persist model paths,
  hold process handles, or name-kill processes. Cert Prep and GX Law Prep own
  durable domain data; runtime jobs and run-scoped staging are ephemeral.
- No feature code, consumer source, CI repair, release publication, stable
  pointer update, or destructive cleanup is authorized by this document-only
  checkpoint. Publication workflow edits are reserved for the explicit future
  D5-D8 slice; they are not forbidden by Phase 2 policy.
- Package QA, fake OCR, snapshots, screenshots, local source-tree imports, and
  successful exit codes are not substitutes for real installed or published
  acceptance.
- A selected DirectML construction or inference failure never retries another
  device or silently falls back to CPU. Indeterminate hardware remains
  indeterminate/unavailable.

## Change mode and supersession

Change mode is mixed with edit-first ownership. This correction edits the four
existing Phase 2 owner files and the two active README banners named below. It
does not create a second coordinator or a replacement repository owner. A
later authorized D5-D8 slice may edit the named publication workflows because
their contracts are part of the release owner, not CI repair.

| Action | Rule |
| --- | --- |
| Edit | Preserve the SPEC, DECISION, TODO, GUIDE, UI README, and desktop README paths. |
| Supersede | Replace duplicate cleanup, stale version, embedded-text, adapter-ordinal, and split acceptance policy only through a later authorized implementation slice with replacement tests. |
| Create | A new module, schema, fixture, or command requires discovery proving that no existing owner fits and a separate authorized slice. |
| Delete | Delete only after residual scans, replacement tests, an additive commit, and exact-owner review prove that the old policy is unused. |

Historical GPU/P1 documents already carry their superseded banners at this
checkpoint. Their bodies remain historical evidence and are not rewritten here:

- [GPU OCR decision](gpu-ocr-directml.md)
- [GPU OCR decision record](../DECISIONS/gpu-ocr-directml.md)
- [P1 compute preflight TODO](../TODOS/capture-runtime-042-p1-ocr-compute-preflight.md)

## Responsibility map

The producer owns runtime policy and execution truth. A host receives semantic
results and owns domain persistence only.

| Responsibility | Producer (`capture-runtime`, launcher, desktop harness) | Cert Prep / GX Law Prep |
| --- | --- | --- |
| OCR | `OcrPipeline`, PDFium rasterization, Paddle profile, normalization, page order, confidence, provenance, and typed failures | Invoke the public capture/ocr seam through an adapter; never create or route an OCR engine |
| Compute | `OcrComputePlan`, hardware truth, model/profile/catalog identity | Render readiness/notice; never probe, rank, select, or persist a GPU ordinal |
| Process lifecycle | `OwnedRuntimeSession`, native Job ownership, descendant cleanup, journal/reconciliation, and semantic proof | Request close/cancellation; never hold OS handles or name-kill |
| Acceptance | Producer-owned `AcceptanceRunner`, installed boundary, fixture scope, evidence, cleanup, and serial semaphore | Supply consumer assertions in the consumer repository |
| Version/release | One inventory, candidate bytes, manifests, publication ledgers, download-back, and stable-pointer policy | Pin exact bytes and verify before model start |

Runtime/model caches are durable only where explicitly declared. Run-scoped
staging, listeners, and owned processes are ephemeral and are reconciled by the
producer. Tauri may request a semantic operation but never owns or mutates a
runtime journal or native Job.

## Repository-grounded discovery

The following facts are the implementation boundary. The names are checked-in
symbols and paths, not proposed placeholders.

| Owner | Current symbol/surface | Callers or targets to migrate |
| --- | --- | --- |
| `packages/capture-runtime/src/capture_runtime/ocr_projection.py` | `OcrPipeline` at the class definition; current `extract`, `normalize_observation`, `serialize_page`, `serialize_manifest`, `failed_page`, and `failure` methods | `packages/capture-runtime/src/capture_runtime/extractors.py` (`StandaloneRuntimeCaptureExtractor` and `_WorkerOcrEngineAdapter`), `packages/capture-runtime/src/capture_runtime/services/streaming_capture_service.py`, `packages/capture-runtime/src/capture_runtime/workers/ocr_main.py`, `packages/capture-runtime/tests/unit/test_ocr_projection.py`, `packages/capture-runtime/tests/integration/test_streaming_api.py`, and `packages/capture-runtime/tests/integration/test_streaming_ocr_failure_evidence.py` |
| `packages/capture-runtime/src/capture_runtime/ocr_preflight.py` | `OcrComputePlan.select` and `OcrGpuCapabilitySnapshot` | `packages/capture-runtime/tests/unit/test_ocr_compute_plan.py:test_positive_unavailable_dgpu_selects_usable_igpu` (focused regression to add); the existing full `capture-runtime:test-unit` target remains the verification owner |
| `packages/capture-sidecar-launcher/src/process.rs` | `OwnedRuntimeSession`, `OwnedRuntimeSessionState`, `RuntimeTerminationProof`, and `RuntimeCleanupError` | `src/launcher.rs` (`LaunchedSidecar`, `launch_sidecar`, `launch_sidecar_with_observer`), `src/lib.rs` public exports, desktop Tauri `src/state.rs` (`OwnedRuntime` and cleanup/monitor paths), desktop Tauri `src/launcher.rs` (`LaunchedRuntime`), and desktop `src/commands.rs` shutdown path |
| `packages/capture-sidecar-launcher/src/launcher.rs` | `SidecarLaunchSpec`, `LaunchOptions`, `LaunchedSidecar`, readiness/retry/observer launchers | `capture-sidecar-launcher:cargo-fmt-check`, `cargo-check`, `cargo-test`, plus desktop launcher integration |
| `tools/release/version-sources.ts` | `collectReleaseVersionEntries()` and its existing version-source inventory | `tools/release/version-sources.test.ts`, target `capture-tools:release-version-test`; first implementation slice owns the inventory extension and Nx upgrade |
| `tools/three-project-acceptance.ts` | `runAcceptanceSequence`, `runCaptureWorkbenchAcceptance`, `validateChildManifest`, `validateTerminalManifest`, `validateCleanupEvidence`, and `verifyRecordedCleanupScope` | Sole producer runner for Capture private JPEG, Capture scanned PDF page 1, Cert, and LAW; it consumes the proposed `@capture-runtime/acceptance-contract` package; `tools/acceptance-contract.ts:writeAcceptanceManifest`/`readAcceptanceManifestTolerant` are consumer-adapter migration seams only |
| `packages/capture-acceptance-contract/` (proposed) | `schemas/*.schema.json`, `src/codecs.ts`, `tools/generate.ts`, `src/manifest.ts`, `src/hash.ts`, and `project.json` | Canonical generated acceptance package/bundle, manifest, and hash authority; creation is D2 discovery-and-stop and its exact bytes/hash are D3/D6 artifacts |
| `apps/capture-workbench-desktop/scripts/real-jpeg-acceptance-coordinator.ts` | `runRealJpegAcceptance` and `runRealJpegAcceptanceCli` | Standalone coordinator to migrate into `tools/three-project-acceptance.ts:runAcceptanceSequence`, then delete only after residual callers, async-boundary exceptions, and replacement tests are proven |

Before an implementation slice, run these read-only discovery commands and
record the resolved targets. A missing target is discovery-and-stop; it is not
permission to invent a target or alter CI:

```powershell
corepack pnpm nx show project capture-runtime --json
corepack pnpm nx show project capture-sidecar-launcher --json
corepack pnpm nx show project capture-tools --json
corepack pnpm nx show project capture-workbench-desktop --json
rg -n "class OcrPipeline|OwnedRuntimeSession|RuntimeTerminationProof|launch_sidecar_with_observer|collectReleaseVersionEntries|runAcceptanceSequence" packages apps tools
```

The resolved runtime version target is `capture-runtime:python-version-check`;
a target named `capture-runtime:version-check` is absent and remains
discovery-and-stop. The relevant native targets are the existing launcher and
desktop Cargo targets: `capture-sidecar-launcher:cargo-fmt-check`,
`:cargo-check`, and `:cargo-test`, and
`capture-workbench-desktop:cargo-fmt-check`, `:cargo-check`, and `:cargo-test`.
The release-version regression target is the existing
`capture-tools:release-version-test`, whose command is
`node --test tools/release/version-sources.test.ts`.

The current `packages/capture-sidecar-launcher/src/lib.rs` export boundary
re-exports `OwnedRuntimeSession`, `OwnedSidecarProcess`,
`RuntimeCleanupError`, `RuntimeCleanupErrorKind`, and `RuntimeTerminationProof`
from `process`, plus `generate_bearer_token`, `launch_sidecar`,
`launch_sidecar_with_observer`, `reserve_distinct_loopback_port`,
`reserve_loopback_port`, `LaunchOptions`, `LaunchedSidecar`, and
`SidecarLaunchSpec` from `launcher`. The convergence slice must migrate these
exports and their callers together; it must not leave a shadow process owner in
desktop state.

## Public contract floor and identity

Phase 2 preserves API `2.0`, raw and structured document schema `2`,
`CaptureOcrProjectionV3` schema `3`, and contract-set SHA-256
`d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40`. The
authenticated `GET /v2/captures/{capture_id}/ocr` route remains the typed
projection seam. No private process, device, path, bearer token, model, or
performance field is added to an HTTP route, SDK, public document, or UI
property.

Every requested page is represented in source order. Empty and failed pages
remain present, recognized regions have bounded polygons and scores, and raw
schema-2 segments are composed only from the normalized projection. A public
contract change requires a separate design, regeneration, and review.

The exact identity rule is tiered, not relaxed:

| Tier | Required identity |
| --- | --- |
| Local E2E | The selected local package, runtime, worker, model/profile, catalog, and contract identities are bound at their declared local tier. A local path or package build is not a release identity. |
| Candidate/release | The manifest binds exact source HEAD, version, artifact bytes, runtime/worker/model/profile/catalog hashes, schema versions, the runtime contract-set hash, and the distinct generated acceptance-package hash when acceptance is in scope. Every consumer uses those bytes, not a source tree or mutable URL. |
| Published acceptance | D6 downloads the public artifacts and manifest, then D7 accepts the downloaded bytes. The release hard identity is exact SHA-256 equality, not a semantic version or average of checks. |

## Deep-module design discipline

An external interface is the smallest stable seam that carries inputs, results,
ordering, invariants, typed errors, cancellation, configuration, and resource
proof. Platform, transport, and failure-injection seams are internal adapters;
they are not promoted merely to make tests convenient. Deepening means
convergence/replacement of the existing owner, followed by deletion tests. It
does not mean adding a coordinator around the current shallow paths.

### `OcrPipeline`: three Design-It-Twice alternatives

All three alternatives below are materially different and are complete enough
for an independent review. Each keeps PDFium/Paddle ownership in the producer
and preserves schema 2/3 output.

#### Alternative O1: one terminal operation

Interface shape:

```text
OcrPipeline.extract(request: OcrRequest, engine: OcrEnginePort)
  -> OcrTerminalOutcome
OcrTerminalOutcome = Projection(CaptureOcrProjectionV3)
                   | Failure(SanitizedOcrFailure)
```

`OcrRequest` carries capture id, source kind, page scope, validated manifest,
creation time, warnings, and cancellation. `OcrEnginePort` accepts the
producer-owned normalized/raster page request and returns a bounded observation
or typed engine error. The host-facing usage is one call:

```text
outcome = pipeline.extract(request, producer_engine)
return outcome.to_public_projection_or_failure()
```

Hidden internals own source/page planning, PDFium rasterization, normalization,
ordered projection, provenance, serialization, cancellation, and sanitized
terminalization. At the current head, the producer extractor's `_extract_pdf`
and `_render_pdf_page` are the PDFium adapter to migrate behind this seam; the
current split is not a reason to add another coordinator. Dependencies are the
private PDFium adapter, worker transport adapter, `OcrEnginePort`, and schema
validators; deterministic in-memory engine and raster fixtures are test
adapters. The advantage is a deep common-caller
seam and one terminal proof. The trade-off is less convenient streaming and a
bounded in-memory/page-result policy must be explicit. Its deletion surface is
the current public normalization/serialization/failure helpers in
`ocr_projection.py`; tests migrate to terminal outcomes and deletion tests
prove callers no longer duplicate page policy. Tests cover every-page order,
empty/failed pages, cancellation, malformed manifests, worker failure, and
schema/contract identity.

#### Alternative O2: progressive page session

Interface shape:

```text
OcrPipeline.open(request: OcrRequest, engine: OcrEnginePort) -> OcrPageSession
OcrPageSession.next_page() -> PageResult | End
OcrPageSession.finish() -> OcrTerminalOutcome
```

Usage is an explicit producer loop:

```text
session = pipeline.open(request, producer_engine)
while (page = session.next_page()) is PageResult: consume(page)
outcome = session.finish()
```

The hidden session owns the page cursor, bounded page buffers, rasterization,
normalization, cancellation, and terminal projection. Dependencies are the
same native/worker adapters as O1, plus a session scheduler and back-pressure
adapter. The trade-off is excellent progressive delivery and memory locality,
but callers must handle a stateful protocol, early close, and partial output;
multiple consumers could accidentally recreate terminalization. The deletion
surface is current direct calls to `normalize_observation`, `serialize_page`,
and `failed_page`, plus ad hoc worker loops. Tests cover next/finish ordering,
double finish, cancellation between pages, back-pressure, and terminal
failure after partial observations.

#### Alternative O3: pure projection reducer

Interface shape:

```text
OcrProjectionReducer.project(manifest: OcrPageManifest,
                             observations: Sequence[OcrObservation])
  -> CaptureOcrProjectionV3 | SanitizedOcrFailure
```

The caller first owns source planning, PDFium rasterization, engine dispatch,
and observation collection, then calls the reducer:

```text
observations = producer_ocr_orchestrator.collect(request)
projection = reducer.project(request.manifest, observations)
```

The hidden reducer owns only validation, ordering, normalization, provenance,
schema projection, and typed failures. It depends on no native process or
worker adapter; observations and manifests are test fixtures and the producer
orchestrator is the production adapter. The trade-off is highly deterministic
unit testing and a small pure seam, but it moves page planning, rasterization,
cancellation, and engine failure policy into every caller. The deletion surface
would remove `OcrPipeline` and force consolidation of the current extractor,
streaming service, and OCR worker loops; deletion tests must prove those
callers share one orchestrator rather than copy the policy. Tests cover reducer
properties and malformed observations, but separate orchestration tests are
required for resource and process behavior.

| Comparison | O1 terminal operation | O2 progressive session | O3 pure reducer |
| --- | --- | --- | --- |
| Depth/locality | Deepest common seam; page and resource policy stays local | Deep seam with explicit page back-pressure | Deep only for projection; lifecycle policy remains in callers |
| Failure/cancellation | One sanitized terminal outcome; cancellation is owned once | Partial-page and early-close states require a protocol | Every orchestrator must define its own cancellation/failure mapping |
| Test seam | Engine/raster adapters and terminal fixtures | Session scheduler, back-pressure, and engine adapters | Pure property tests plus separate orchestration tests |
| Migration | Aligns with current extract callers and deletes helper surface | Requires all callers to adopt a stateful loop | Repartitions current extractor/worker policy and has the largest deletion risk |

#### Chosen O1, constrained by repository facts

Choose O1. The repository already has `OcrPipeline.extract`, an
`OcrEnginePort`, producer-owned worker and extractor adapters, and three caller
families. A terminal operation hides page policy and lets those callers cross
one deep seam. The implementation is convergence/replacement: retain a
compatibility adapter only while callers migrate, then make page normalization,
serialization, and failure helpers private or delete them. The chosen method
does not expose Paddle kwargs, source paths, model paths, process handles, or
private diagnostics. It is a design decision, not evidence that the code has
already been changed.

### `OwnedRuntimeSession`: three Design-It-Twice alternatives

The current native owner is concrete and must be converged, not wrapped by a
second coordinator. In `packages/capture-sidecar-launcher/src/process.rs`,
`OwnedRuntimeSession::spawn`, `id`, `try_wait`, `monitor_root_exit`,
`terminate_and_prove`, and `terminate` currently expose a one-root process
surface. `RuntimeTerminationProof` currently includes `root_pid`, and cleanup
errors can format a PID. Those are facts to replace; this document does not
pretend the current API is already opaque.

#### Alternative R1: opaque single-root semantic facade

Interface shape:

```text
OwnedRuntimeSession::start_one(spec: LaunchSpec) -> Result<RootLease, LaunchError>
session.observe(root: &RootLease) -> RuntimeObservation
session.close(root: RootLease, reason: CloseReason) -> Result<RootProof, CleanupError>
```

Usage is simple for Capture, Cert, and a candidate:

```text
root = session.start_one(spec)?
wait_until_ready(root)?
proof = session.close(root, Shutdown)?
```

The hidden module creates a suspended process, assigns it to the current
unnamed no-breakaway Job configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, verifies identity, resumes, observes
descendants, retries bounded cleanup, and keeps native handles private. It never
opens a named Job for takeover and never weakens close/crash cleanup.
Dependencies are the Windows process/Job adapter, sidecar readiness adapter,
journal adapter, and deterministic failure-injection adapter. The trade-off is
a very deep and easy common path, but it cannot place
Capture/Python/Java roots in one Job without a second coordination layer. The
deletion surface is desktop `OwnedRuntime` cleanup/monitor logic and direct
`id()`/`try_wait()` use; tests cover normal close, crash, descendants, baseline
survival, and retry.

#### Alternative R2: journal-first opaque lease

Interface shape:

```text
RuntimeSessionJournal.open(plan) -> SessionKey
producer.launch(key, root_spec) -> RootKey
producer.observe(key, root) -> RuntimeObservation
RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult
producer.close(key, root) -> RootProof
```

Usage gives the host only opaque keys and semantic observations:

```text
journal = RuntimeSessionJournal.open(plan)
ref = journal.reconcile_ref(journal_index)
result = RuntimeSessionJournal::reconcile(ref)
```

`ReconcileRef` is an opaque producer-issued journal index/address, never a PID,
Job handle, process takeover token, path, or lease. `ReconcileResult` is a
semantic result only: it can report a narrowly proven terminalization or
`reconcile-required` with a closed reason code; it cannot expose native
identifiers. Candidate and prior sessions receive distinct refs and a ref can
address only its exact journal record. The hidden implementation makes the
journal the primary state machine and reconstructs native identity from PID,
creation identity, nonce, Job, listener, and staging bindings. Dependencies are
the durable journal writer, native adapter, and a startup reconciler; a fake
journal/native adapter tests crashes.
The trade-off is strongest crash recovery and explicit durable evidence, but
the journal becomes a high-churn protocol and still needs a group relationship
for multi-root consumers. The deletion surface is current desktop state
ownership and ad hoc cleanup ledgers. Tests must include torn writes, replay,
identity mismatch, and stale journal retention as well as process behavior.

#### Alternative R3: producer-owned group/session (chosen shape)

Interface shape:

```text
OwnedRuntimeSession::prepare_group(
    immutable_plan: &ImmutableGroupPlan,
    reconcile_ref_sink: &dyn ReconcileRefSink,
) -> Result<PreparedGroupRuntimeSession, LaunchError>
PreparedGroupRuntimeSession {
  state: "prepared_bound",
  groupRef: ReconcileRef,
  groupRefDigest: Sha256,
  groupGeneration: u64,
  planDigest: Sha256,
  roots: [PreparedRootBinding],
}
PreparedRootBinding {
  ordinal: u32,
  role: RootRole,
  rootRef: ReconcileRef,
  rootRefDigest: Sha256,
  rootGeneration: u64,
  specDigest: Sha256,
}
ReconcileRefSink::persist_group_refs(
    group_ref,
    group_generation,
    plan_digest,
    roots,
) -> Result<ReconcileRefReceiptV1, PersistError>
ReconcileRefSink::verify_group_receipt(
    receipt,
    expected_group_and_roots,
) -> Result<VerifiedReconcileRefReceipt, PersistError>
ReconcileRefReceiptV1 {
  receiptDigest: Sha256,
  groupRefDigest: Sha256,
  groupGeneration: u64,
  planDigest: Sha256,
  roots: [{ ordinal, role, rootRefDigest, rootGeneration }],
}
ActivationPermit {
  permitVersion: "ActivationPermitV1",
  state: "prepared_bound",
  planDigest: Sha256,
  groupRefDigest: Sha256,
  groupGeneration: u64,
  rootBindings: [{ ordinal, role, rootRefDigest, rootGeneration }],
  receiptDigest: Sha256,
}
session.activate_group(prepared, permit) -> Result<GroupLease, LaunchError>
session.observe(root: &RootLease) -> Result<RuntimeObservation, LifecycleError>
session.close_root(root, reason) -> Result<RootProof, CleanupError>
session.close_group(reason) -> Result<GroupProof, CleanupError>
```

R3 is a whole-group protocol. `prepare_group` receives one immutable plan whose
ordered roots are complete before any journal or resource mutation. It first
durably writes one group journal record in `planned_unbound`; that state has the
group plan identity but no bound root references and no
`activationReceiptDigest`. The injected `ReconcileRefSink` then persists the
group ref and every per-root ref/generation as one exact binding set. Its
`persist_group_refs` operation flushes the durable receipt before returning;
`verify_group_receipt` reopens that receipt, recomputes its canonical digest,
and proves that group ref, group generation, plan digest, root ordinals/roles,
root ref digests, and root generations all match the prepared group. A sink
failure leaves `planned_unbound` and acquires no process, listener, staging, or
model resource.

Only after sink persistence and verification does the producer atomically write
`prepared_bound`, require `activationReceiptDigest`, and construct one private
`ActivationPermit`. The permit binds the permit version, plan digest, group ref
digest, group generation, the complete ordered group/per-root ref and generation
set, and the receipt digest. The producer re-verifies that permit against the
current journal and the sink receipt; a missing, stale, forged, partial, or
mismatched permit fails closed. Permit construction is not exposed to a host,
and a host cannot call activation first or activate an individual root. There
is no per-root `activate` operation against a group-level `planned_unbound` or
`prepared_bound` record.

`activate_group(prepared, permit)` is the only activation operation. It
validates the whole group, creates/assigns every planned root while suspended,
and verifies every Job membership, creation identity, root nonce, listener
binding, and staging binding before resuming any root. If any assignment or
verification fails, no root is resumed; the producer closes/reconciles the
partial suspended set and records the group failure. Only a complete suspended
set may advance the journal to `ready`, after which the group is resumed and
the normal `launching -> running` transitions continue. One root is represented
by this same protocol with a group size of one. A private `start_one` helper,
if retained during migration, is only a call to `prepare_group([spec])` and
`activate_group`; it is not a second public activation seam.

The sink interface is part of the R3 seam, not an optional test hook:

```text
trait ReconcileRefSink {
  persist_group_refs(
    &self,
    group_ref: &ReconcileRef,
    group_generation: u64,
    plan_digest: Sha256,
    roots: &[RootRefBinding],
  ) -> Result<ReconcileRefReceiptV1, PersistError>;
  verify_group_receipt(
    &self,
    receipt: &ReconcileRefReceiptV1,
    expected: &GroupRefBinding,
  ) -> Result<VerifiedReconcileRefReceipt, PersistError>;
}

struct RootRefBinding {
  ordinal: u32,
  role: RootRole,
  rootRef: ReconcileRef,
  rootRefDigest: Sha256,
  rootGeneration: u64,
}

struct ActivationPermitV1 {
  planDigest: Sha256,
  groupRefDigest: Sha256,
  groupGeneration: u64,
  rootBindings: Vec<RootRefBindingDigest>,
  receiptDigest: Sha256,
}
```

The permit constructor is private to the producer. `groupRefDigest` is the
canonical digest of the opaque group ref, `groupGeneration` is the exact
group generation persisted by the sink, each `rootRefDigest` and
`rootGeneration` is the exact per-root binding, and `receiptDigest` is the
canonical digest of the flushed receipt. Every activation CAS includes
expected state `prepared_bound`, expected plan/group generation, expected group
ref digest, and the complete root binding set; the sink must still verify the
receipt for that tuple. The prepared record cannot be activated with a subset
of roots. Tests must cover planned-unbound absence of the receipt digest, sink
persistence failure, wrong group/root ref digest, wrong group/root generation,
wrong plan digest, wrong receipt digest, stale permit after any generation
change, partial suspended assignment with zero resumes, concurrent group
activation with one CAS winner, and the valid group-size-one and multi-root
paths.

Capture, Cert, and candidate journeys use the same group protocol with one
root. The LAW journey may put Capture, Python, and Java roots in one
producer-owned group. A `RootLease` is an opaque semantic lease returned only
after group activation; no raw `Job`, process handle, PID, native error, or
child object crosses the seam.

The hidden module owns one current unnamed no-breakaway Job configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, root identity, readiness, listener
bindings, descendants, journal/reconciler, bounded retry, and terminal proof.
It never uses a named Job takeover and never weakens close/crash cleanup.
Dependencies are the existing native launcher/process adapter, the existing
`SidecarLaunchSpec`/readiness adapter, and a deterministic native failure
adapter. The trade-off is slightly more state than R1, but it avoids a second
coordinator and provides one owner for the LAW multi-root case. The deletion
surface is `OwnedRuntimeSession`'s current direct process methods, desktop
`OwnedRuntime`/`LaunchedRuntime` raw-child assumptions, and host cleanup helpers.
Tests cover one-root group-size-one compatibility, all-roots-suspended-before-
resume activation, multi-root atomic group close, partial assignment with zero
resumes, root crash, descendant escape, listener/staging proof, baseline
survival, journal replay, and idempotent close.

| Comparison | R1 single root | R2 journal-first lease | R3 producer-owned group |
| --- | --- | --- | --- |
| Depth/locality | Deep one-root lifecycle, but group policy has nowhere to live | Deep recovery state, but protocol churn becomes the public seam | Deep group, root, journal, and proof policy in the existing native owner |
| Failure/cancellation | Simple semantic close and bounded retry | Strong replay/recovery, with more journal transition failures | Group close can prove partial launch and cancellation without a second coordinator |
| Test seam | Native process adapter plus failure injection | Journal/native replay adapters plus failure injection | Native launcher, listener, journal, and failure adapters in one owner |
| Migration | Easiest Capture/Cert migration; cannot satisfy LAW multi-root | Replaces desktop state but still needs group semantics | Keeps one-root convenience and adds LAW capability while deleting raw-child assumptions |

#### Chosen R3, with explicit convergence limits

Choose R3 because the actual native crate already owns launch and Job lifecycle,
and the LAW journey needs Capture/Python/Java roots under one producer Job.
Extend that owner rather than adding a desktop coordinator. `src/lib.rs` keeps
the crate export boundary; `src/launcher.rs` adapts `SidecarLaunchSpec` and
`LaunchedSidecar`; desktop `src/state.rs` and `src/launcher.rs` become
semantic adapters. The current `spawn`/`id`/`try_wait` methods and PID-bearing
proof are convergence surface, not a second public contract. A future
implementation may retain an internal PID for native verification, but public
proof and errors are opaque and privacy-safe.

The R3 journal seam is addressable and observe-only after restart:
`RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`. The
producer allocates a distinct opaque `ReconcileRef` for every candidate or
prior session; it is a journal index/address only, not a job, process, PID,
path, or takeover lease. `ReconcileResult` contains semantic state, a
sanitized cleanup result, and `proofSha256` when proof exists, never native
identifiers. A restart observer may terminalize only the exact ref whose full
absence/listener/staging proof is complete; present, reused, unqueryable, or
ambiguous observations return `reconcile-required` and do not touch resources.
Candidate and prior refs are always distinct. If `prior=null` (the first
sequence item), `priorSessionRef` and `predecessorCleanupProofSha256` are both
null: null means no predecessor, never that cleanup was already proven. If a
prior ref is present, its cleanup-proof digest and generation are mandatory and
must bind that exact prior record; a candidate may not borrow a different
candidate's or prior session's proof.

## RuntimeSessionJournalV1 and reconciliation

The journal is a producer-owned durable cleanup record, not host/domain state.
It exists to make crash recovery fail closed. Tauri never creates, writes,
mutates, deletes, or reconciles it, and Tauri never owns or mutates a Job.

### Schema

The file is one JSON object written under a producer-owned run directory. Its
schema is exactly versioned as `RuntimeSessionJournalV1`. State-discriminated
variants prevent an unbound plan from being mistaken for an activated group:

```json
{
  "schemaVersion": "RuntimeSessionJournalV1",
  "producer": "capture-runtime",
  "sessionNonce": "128-bit-random-opaque-nonce",
  "groupRefDigest": "<sha256-lower-hex>",
  "groupGeneration": 4,
  "planDigest": "<sha256-lower-hex>",
  "state": "ready",
  "createdAt": "2026-09-10T00:00:00Z",
  "updatedAt": "2026-09-10T00:00:02Z",
  "jobBinding": { "setupState": "committed", "jobNonce": "opaque-native-binding" },
  "stagingBinding": {
    "runNonce": "same-session-nonce",
    "rootDigest": "sha256:...",
    "scope": "run"
  },
  "roots": [
    {
      "ordinal": 0,
      "role": "capture",
      "rootRefDigest": "<sha256-lower-hex>",
      "rootGeneration": 1,
      "rootNonce": "128-bit-random-opaque-nonce",
      "pid": 1234,
      "creationIdentity": { "kind": "windows-process-creation", "value": "opaque-native-value" },
      "state": "suspended",
      "listenerBindings": [
        { "kind": "sidecar-http", "loopbackPort": 43123, "bindingNonce": "opaque-listener-binding" }
      ],
      "startedAt": "2026-09-10T00:00:01Z"
    }
  ],
  "proof": null,
  "activationReceiptDigest": "<sha256-lower-hex>",
  "recoveryEpoch": 0,
  "attempt": 0
}
```

Required base fields are the schema version, producer, session nonce, immutable
plan digest, state, timestamps, recovery epoch, and bounded attempt counter.
`planned_unbound` intentionally has no `activationReceiptDigest`, group-ref
digest, group generation, or bound per-root ref/generation records: it is the
only pre-binding variant and carries only the complete plan identity. The
`prepared_bound` variant adds the group-ref digest/generation and complete
ordered per-root ref/generation bindings, and requires a non-null,
receipt-verified `activationReceiptDigest`; every state derived from it
(`ready`, `launching`, `running`, `closing`, `terminal`, `reconcile-required`,
and `manual-review`) retains that complete binding set and receipt. Job and
staging bindings are added only as their producer resources are acquired; the
Job binding records whether setup was durably committed before a root was
resumed. A `ready` record means every root has been assigned and verified
suspended; no root may be resumed from a partial record. Once a root is bound
to a native resource, it records ordinal, role, root-ref digest, root
generation, root nonce, PID, process creation identity, state, listener
bindings, and start time. A terminal record adds semantic proof:
root reaped, descendants terminated, listeners released, staging released, and
the proof generation. `exitCode` is optional and sanitized; raw command lines,
environment, source paths, bearer tokens, OCR, model bytes, user names, machine
names, and arbitrary diagnostics are forbidden.

The field constraints are normative: `schemaVersion` is the literal
`RuntimeSessionJournalV1`; `producer`, `state`, root `role`, root `state`, and
Job `setupState` are closed enums; `setupState` is `pending` until the unnamed
Job is configured and durably bound, then `committed` before any root is resumed;
`groupRefDigest`, `rootRefDigest`, `planDigest`,
`activationReceiptDigest`, and every other digest field are lowercase SHA-256;
`sessionNonce`, `jobNonce`, `rootNonce`, and every `bindingNonce` are 128-bit
random values encoded as lowercase hexadecimal; `groupGeneration`,
`rootGeneration`, and `recoveryEpoch` are monotonic unsigned integers;
`attempt` is an unsigned integer in `0..=3`;
timestamps are UTC RFC 3339 strings; `pid` is a
positive Windows process id; `creationIdentity` is the native creation-time
value captured at launch and is compared exactly; and `loopbackPort` is an
integer from 1 through 65535. `rootDigest` is lowercase SHA-256 over the
producer-resolved run-staging identity, not a source path. `state` is one of
`planned_unbound`, `prepared_bound`, `ready`, `launching`, `running`, `closing`,
`terminal`, `reconcile-required`, or `manual-review`; `manual-review` is a
blocked, nonterminal state. `activationReceiptDigest` is absent, not null, in
`planned_unbound`; it is required and receipt-verified in `prepared_bound` and
all later bound variants. Proof booleans may be true only after the corresponding
binding has been checked. The JSON example uses opaque placeholders to avoid
recording real identifiers; an implementation must validate these types and
closed values before accepting a journal.

The cleanup policy is also fixed: one recovery epoch receives at most three
identity-scoped automatic reconciliation attempts within a 60-second monotonic
budget. A reconciliation attempt is one producer-observed timeout, failed
proof, or complete proof. With expected
`{state: "reconcile-required", groupGeneration: G, attempt: A, recoveryEpoch: E}`,
the writer increments `attempt` and `groupGeneration` together in the same CAS
record. A complete observe-only proof may transition to `terminal` with
`{attempt: A + 1, groupGeneration: G + 1, recoveryEpoch: E}`. A timeout or failed
proof may remain `reconcile-required` with the same increment while `A + 1 <
3`; the third timeout or failed proof must transition to `manual-review` with
`attempt: 3` and `groupGeneration: G + 1`. Thus `reconcile-required -> terminal` is
possible only on a later complete observe-only proof, never on timeout, failure,
stale data, or a boolean-only claim. A timeout or third failed automatic
attempt transitions to `manual-review`, remains promotion-blocked, and never
pretends to be terminal or starts a replacement root. A terminal `proof` must
contain `rootReaped`, `descendantsTerminated`, `listenersReleased`,
`stagingReleased`, and the committed `proofGeneration`, all true and tied to
the same session/root nonces. A boolean without matching identity evidence is
invalid proof.

`manual-review` is a blocked nonterminal state. It has no automatic recovery
and cannot transition directly to `terminal`, `launching`, `running`, or
`closing`. Only an explicitly producer-authorized operator recovery may move
it to `reconcile-required`: the recovery record must carry a fresh opaque
`recoveryNonce`, a durable `recoveryAuthorizationDigest`, and expected
`{state: "manual-review", groupGeneration: G, attempt: 3, recoveryEpoch: E}`. That
CAS increments `groupGeneration`, increments `recoveryEpoch`, resets `attempt` to
`0`, and records no resource mutation. The recovery operation cannot launch a
replacement, terminate a process, delete staging, or claim terminal proof;
the next automatic attempt must still pass the full observe-only checks. A
stale, reused, or missing recovery receipt leaves `manual-review` unchanged.
After another three timed/failed attempts, the record returns to
`manual-review` under the same rules. There is no direct `manual-review ->
terminal` path.

The focused journal regression set includes
`reconcile_attempt_and_generation_increment_atomically`,
`reconcile_rejects_stale_state_generation_attempt_or_epoch`,
`reconcile_failure_attempt_three_enters_manual_review`,
`reconcile_complete_observe_only_proof_to_terminal`,
`manual_review_requires_explicit_recovery_receipt`, and
`manual_review_recovery_resets_attempt_window_without_resource_mutation`.
The tests assert the exact expected state, generation, attempt, and recovery
epoch on every compare-and-swap; they also assert that an attempt cannot
increment one counter without the other.

`pid` and native creation identity are private producer data. Evidence and host
responses emit only a stable digest or boolean proof. A listener port is not an
ownership proof: the producer must also validate the binding nonce and a
producer-owned readiness/close handshake. If the current launcher cannot prove
that binding, the implementation must reduce the claim to listener ownership
unknown; no kill/delete is allowed and ownership must not be inferred from a
port alone.

### Live in-memory close versus restart observation

While the producer process is alive, `OwnedRuntimeSession` keeps the private
handle for the current unnamed no-breakaway Job, its in-memory membership
proof, and the root/session nonces. Its `terminate_and_prove` path may close
only that live session: it requests termination through the private Job handle,
reaps the roots and descendants, checks listener/staging bindings, and commits
terminal proof. `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` remains enabled for normal
close, crash, and handle-loss cleanup; no named takeover or weakened cleanup
path is permitted.

After a producer restart, the observer has only the committed journal. It has
no Job handle, no live membership query, and no right to claim or adopt the old
Job or any recorded nonce. Restart reconciliation is therefore observe-only.
It may terminalize a stale record and remove only that record's exact
run-scoped staging when, and only when, the journal has a trustworthy committed
Job setup, every root's exact PID plus process-creation identity is absent (not
reused and not unqueryable), every recorded listener is proven absent, and the
staging binding resolves inside the same producer-owned run scope. It never
terminates a process during this observe-only path.

If a PID is reused, present, or unqueryable; a listener is ambiguous; a root or
staging identity mismatches; the Job setup was not durably committed; or any
other binding is unknown, the whole session becomes `reconcile-required`, the
observer touches nothing, and promotion is blocked. No process-name, PID-only,
or port-only kill is ever valid. For a multi-root group, all roots must satisfy
the observe-only rule before the group may terminalize or its exact staging may
be removed; one ambiguous root blocks the entire group.

### Atomic transitions and reconciler

Only the producer writer may transition a journal. The exhaustive transition
graph is:

```text
planned_unbound -> prepared_bound -> ready -> launching -> running -> closing -> terminal
planned_unbound -> terminal                         (no-resource proof only)
planned_unbound -> reconcile-required
prepared_bound|ready|launching|running|closing -> reconcile-required
reconcile-required -> reconcile-required    (timed/failed attempt 1 or 2)
reconcile-required -> terminal              (later complete observe-only proof)
reconcile-required -> manual-review         (timed/failed attempt 3)
manual-review -> reconcile-required         (explicit producer recovery only)
```

Every transition carries expected `state`, `groupGeneration`, `attempt`, and
`recoveryEpoch`; bound transitions also carry the complete plan/group/root
reference and `activationReceiptDigest` tuple. The writer rejects any mismatch
and never merges concurrent updates. A later `reconcile-required -> terminal`
requires a complete, identity-bound observe-only proof, increments `attempt`
and `groupGeneration` in the same record, and succeeds only when the expected
CAS matches. A timed or failed attempt increments `attempt` and
`groupGeneration` atomically; attempts one and two
remain `reconcile-required`, while attempt three takes the guarded
`reconcile-required -> manual-review` transition. No automatic transition from
`manual-review` is allowed. A direct `planned_unbound -> terminal` is valid only with
durable proof that no resource could ever have existed: Job setup was not
committed, no root was resumed or launched, no listener was bound, no staging
was acquired, and no resource acquisition was attempted. If any one of those
facts is unknown, the journal must take `planned_unbound -> reconcile-required`
instead. A transition uses compare-and-swap on the expected state,
groupGeneration, attempt, recovery epoch, and bound ref tuple, writes a temporary file in the same producer
directory, flushes it,
atomically replaces the journal, and flushes the directory/file according to
the platform adapter. A torn or unknown-generation write is a hard failure;
the previous valid journal is retained. There is no best-effort terminal
state.

On a live producer close, the reconciler reads only producer-owned journals and
validates schema, producer, session nonce, state, group/root generations, the
complete group/root ref tuple, private Job handle/membership, root identity, listener binding nonce, and run-scoped
staging nonce before terminating the current group. On producer startup after a
restart it reads only committed journals and performs the observe-only checks
above; it does not reconstruct, claim, or query Job membership. Exact PID plus
creation identity being absent, listener absence, and an exact staging binding
may permit stale-record terminalization and cleanup of that staging only. PID
reuse, a present or unqueryable PID, missing creation identity, root/staging
mismatch, Job-setup ambiguity, listener ambiguity, access denial, or malformed
journal sets `reconcile-required` and leaves process/listener/staging in place.
It never kills by executable name, PID alone, port alone, parent PID alone, or
directory name.

Cleanup retry is bounded and identity-scoped. The producer does not launch a
replacement root while an old root is unresolved. A terminal proof requires
the root reaped, all owned descendants absent, exact listeners released, and
run-scoped staging removed; durable runtime/model caches are retained. The
journal remains until terminal proof is committed, then follows a producer
retention policy. Failed proofs and retry history are retained as sanitized
metadata. This is implementable with the current native process owner only
after the implementation slice adds a private creation-identity/nonce and
listener-binding seam; until then, the documented reduced claim is fail-closed
unknown ownership, not cleanup success.

## Canonical compute decision truth table

`OcrComputePlan.select(input)` consumes one immutable producer hardware snapshot
and returns one immutable selection. The readiness result and engine session
use that same selection; hosts never select or persist an ordinal.

The exact implementation owner is
`packages/capture-runtime/src/capture_runtime/ocr_preflight.py:OcrComputePlan.select`
with `OcrGpuCapabilitySnapshot`; the focused regression owner is
`packages/capture-runtime/tests/unit/test_ocr_compute_plan.py:test_positive_unavailable_dgpu_selects_usable_igpu`.
The regression must model a dGPU that is positively unavailable (not
indeterminate) alongside a usable, fully mapped iGPU and assert DirectML on
that iGPU, including its LUID/ORT mapping, never CPU. The existing
indeterminate-dGPU test remains a separate fail-closed case.

| Snapshot | Selection | Failure/fallback rule |
| --- | --- | --- |
| A usable discrete GPU with complete LUID/ORT mapping | DirectML on the selected dGPU, with exact LUID join and ordinary ORT ordinal | No CPU fallback after selected construction or inference failure |
| No usable dGPU and a usable integrated GPU with complete mapping | DirectML on the selected iGPU | Same terminal failure rule |
| No usable GPU and policy permits CPU notice | CPU with an explicit noticed readiness result | CPU is not a recovery path after a selected GPU failure |
| Probe timeout, exception, unknown adapter, incomplete mapping, or indeterminate state | Indeterminate/unavailable | Do not guess, rank, or persist an ordinal |

The historical adapter-`0` and `CAPTURE_WINDOWSML_DEVICE_ID` notes are
superseded by this table. See the [historical GPU decision](gpu-ocr-directml.md)
for provenance only.

## Acceptance and evidence contract

Acceptance is semantic, per fixture, and fail-closed. For each real scanned
PDF fixture, every required page-1 result has character error rate (CER) `<=
1%`. For each real private JPEG fixture, CER is `<= 3%`. CER is computed per
fixture/page as code-point edit distance divided by
`max(expectedCodePointCount, 1)`; results are not averaged across pages,
fixtures, or products. Every
critical anchor must be present; one omitted critical anchor fails even when
the overall CER is below threshold. Raw OCR, source bytes, bearer tokens,
private paths, and machine names never enter the evidence artifact.

D4 candidate acceptance and D7 published acceptance use this exact serial
sequence, with cleanup and model-memory release after every child:

```text
Capture Workbench private JPEG
  -> cleanup proof
Capture Workbench original scanned PDF, page 1
  -> cleanup proof
Cert Prep
  -> cleanup proof
GX Law Prep
  -> cleanup proof
```

The runner stops on the first semantic, identity, process, listener, or
cleanup failure. The current `tools/three-project-acceptance.ts` child
manifest is a legacy migration surface; the future producer contract below
replaces it without adding a second runner. Its current validators and
`tools/acceptance-contract.ts:writeAcceptanceManifest` remain useful only as
red/green consumer-adapter seams until the replacement is implemented; they
never become contract authority.

### Canonical producer/consumer acceptance protocol (V1)

This is one producer-owned `ProducerAcceptanceContractV1` for the future
D2/D3/D4 and D7 implementation. Its canonical producer package/bundle name is
`@capture-runtime/acceptance-contract`; the package is proposed at
`packages/capture-acceptance-contract` and does not exist at this checkpoint.
The proposed package layout is:

```text
packages/capture-acceptance-contract/
  schemas/producer-child-scope-v1.schema.json
  schemas/producer-child-invocation-v1.schema.json
  schemas/consumer-semantic-result-v1.schema.json
  schemas/acceptance-child-wire-v1.schema.json
  src/canonical-json.ts
  src/codecs.ts
  src/hash.ts
  src/manifest.ts
  src/index.ts
  tools/generate.ts
  contract-manifest.json
  contract-sha256.txt
  package.json
  project.json
```

`src/codecs.ts` and `tools/generate.ts` are the proposed TypeScript codec and
schema-generator owners; `src/manifest.ts`, `src/hash.ts`,
`contract-manifest.json`, and `contract-sha256.txt` are the proposed manifest
and hash owners; `project.json` is the proposed Nx package owner. Target
creation and package generation require D2 discovery and a creation stop; no
target or package is claimed to exist now. The generated package/bundle bytes
and manifest are first-class D3 candidate artifacts and are included in the
D3 ledger; D6 downloads and hashes those exact public package/bundle bytes and
includes them in the D6 ledger before D7.

Its immutable contract version is `"1"` and its `contractSha256` is the
lowercase SHA-256 of the canonical package/bundle bytes. D3 records the literal
digest and D4/D6/D7 bind it; until that digest is recorded, no consumer may
choose a value or claim compatibility. This acceptance-contract identity is
distinct from the runtime contract-set identity (`contractSetVersion: "2"`,
`contractSetSha256: d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40`);
the two hashes must never be compared as if they were one contract. Cert and
LAW consume only the exact generated package bytes and literal hash from D3/D6;
they do not copy schemas, restate names/fields, or define local validators.
At this checkpoint `tools/acceptance-contract.ts` is only the existing
consumer adapter: its `writeAcceptanceManifest` and
`readAcceptanceManifestTolerant` paths may import the canonical package later,
but they are not schema, codec, generator, manifest, or hash authority.

There is exactly one writer for each record and exactly one serial producer
flow. The paths below are distinct, producer-scoped transport records:

| Record | Owner, mutability, path | Visibility and order |
| --- | --- | --- |
| `ProducerChildScopeV1` | Producer only; mutable until the child is closed; `CAPTURE_ACCEPTANCE_SCOPE_PATH` | State-discriminated: `planned` has only child/plan identity; `prepared` adds the bound root/ref and generations; `ready` adds the verified invocation digest. The child receives only the read-only invocation input. |
| `ProducerChildInvocationV1` | Producer only; immutable after freeze; `CAPTURE_ACCEPTANCE_INVOCATION_PATH` or an equivalent read-only handle/pipe transport | The producer publishes the canonical input before launch. The child receives only this frozen read-only transport and its digest; it never receives scope or wire. |
| `ConsumerSemanticResultV1` | The current child only; write-once; separate `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH` | The child writes one complete semantic result after its assertion. The producer reads and validates it; a second write, overwrite, or partial record fails closed. |
| `AcceptanceChildWireV1` | Producer only; immutable after cleanup; `CAPTURE_ACCEPTANCE_WIRE_PATH` | The producer validates the result, completes cleanup, and only then emits the wire. The child never receives or writes this path. |

The producer flow is: (1) create the scope and durably record its `planned`
variant, which has only child/plan identity; (2) call `prepare_group` with the
complete immutable plan, journal `planned_unbound`, persist and verify the
complete group/per-root receipt through the injected sink, write
`prepared_bound`, and construct one private group activation permit; (3) derive
a `ProducerChildInvocationV1` from that immutable plan and its capability
assignments; (4) compute its self-excluded canonical digest before writing the
final bytes, write those exact bytes to a secure same-directory temporary,
flush and close the temporary, publish the final invocation with atomic
create-new semantics, reopen it read-only to verify canonical bytes and digest,
then freeze/apply its ACL; (5) update the scope to `ready` with the verified
invocation digest and call `activate_group(prepared, permit)`, which assigns
and verifies every root suspended before resuming any root; (6) pass only the
frozen read-only invocation transport and canonical digest to the child; (7)
let the child create exactly one `ConsumerSemanticResultV1`; (8) validate the
semantic result against the ordered fixture assignments, resolver-verified
capability/media/oracle digests, exact fixture/artifact identity, and applicable
D3 or D6 ledger;
(9) close/reconcile and prove producer-owned process, listener, staging,
capture, and model-memory cleanup; and (10) emit one immutable
`AcceptanceChildWireV1`.
A failed validation or cleanup emits no wire and blocks the next sequence item.
The mutable scope is never exposed to the child. The invocation contains no
future result, wire, or output digest.

The invocation transport is a distinct immutable input channel. The producer
first omits `invocationSha256` from the canonical object and computes that
self-excluded digest before the final bytes exist. It then writes canonical
compact UTF-8 bytes, including that digest, to a secure same-directory
temporary file, flushes and closes the temporary handle, and publishes the
final invocation with atomic create-new semantics (never replace/overwrite).
It reopens the final path read-only, verifies exact canonical bytes and the
self-excluded digest, applies an ACL denying child write/delete/rename/reparse
operations, and freezes the file before `activate_group` is called. The child
receives only a read-only handle/pipe or read-only path and must recompute the
digest before doing work. A missing ACL, writable handle, symlink/reparse
target, digest mismatch, post-freeze replacement, or activation before this
verification fails closed. The invocation path and result path are different
from scope and wire paths and are unique to the child/output nonce.

The child result uses a separate write-once output channel. The producer first
proves the final result path is absent and grants only the child create/write
permission. The child writes canonical bytes to a unique same-directory
temporary file using `CREATE_NEW`, flushes and closes it, then publishes the
final result using `CREATE_NEW` (never replace/overwrite). The producer opens
the final result read-only only after the child exits and validates the
self-excluded `semanticResultSha256`; a pre-existing final path, second
create, partial record, replacement, or digest mismatch fails closed. Only
after this validation and producer cleanup can the producer create the wire.

`ProducerChildScopeV1` is mutable producer state, not consumer evidence, and is
a state-discriminated union. The `planned` variant contains only child/plan
identity; it has no root, reconcile ref, generation, invocation digest, output
path nonce, result digest, or wire digest. The `prepared` variant adds the
producer-bound group/root refs and generations. The `ready` variant adds the
verified invocation digest and output path nonce:

```text
ProducerChildScopeV1 =
  PlannedScope {
    schemaVersion: "ProducerChildScopeV1",
    contractVersion: "1",
    contractSha256: AcceptanceContractSha256,
    producer: "capture-runtime",
    parentGate: "D4" | "D7",
    tier: "candidate" | "published",
    runIdDigest: Sha256,
    sequenceIndex: u32,
    childKey: string,
    legId: string,
    childId: Sha256,
    childPlanDigest: Sha256,
    readyState: "planned",
  }
  | PreparedScope {
    ...PlannedScope,
    readyState: "prepared",
    groupRefDigest: Sha256,
    groupGeneration: u64,
    rootRefDigest: Sha256,
    rootGeneration: u64,
  }
  | ReadyScope {
    ...PreparedScope,
    readyState: "ready",
    invocationSha256: Sha256,
    outputPathNonce: OpaqueNonce,
  }
```

The producer writes the variants in order with a CAS over child/plan identity
and the applicable group/root generations. A `planned` scope cannot carry a
root/ref or invocation field, and a `prepared` scope cannot be sent to a child;
only `ready` may be used after invocation publication/reopen verification. The
scope may retain private resolved paths and capability handles in memory, but
neither is serialized into a child wire or exposed as a raw path/text value to
the child. The producer must not put any child-result or wire digest in any
scope variant before the child runs.

`ConsumerSemanticResultV1` is the child's one write-once semantic handoff. It
contains no scope or wire path and no native/process identity:

```json
{
  "schemaVersion": "ConsumerSemanticResultV1",
  "contractVersion": "1",
  "contractSha256": "<D3-bound-producer-contract-sha256>",
  "consumer": "cert-or-law-adapter",
  "parentGate": "D4",
  "tier": "candidate",
  "sequenceIndex": 3,
  "childKey": "cert",
  "legId": "cert-v1",
  "childId": "<sha256-lower-hex>",
  "artifactIds": ["<sha256-lower-hex>"],
  "fixtureResults": [{
    "fixtureIndex": 0,
    "fixtureKey": "private-fixture-1",
    "fixtureIdentitySha256": "<sha256-lower-hex>",
    "mediaKind": "jpeg",
    "page": null,
    "mediaCapabilityHandleSha256": "<sha256-lower-hex>",
    "oracleCapabilityHandleSha256": "<sha256-lower-hex>",
    "mediaSha256": "<sha256-lower-hex>",
    "oracleSha256": "<sha256-lower-hex>",
    "actualNormalizedOutputSha256": "<sha256-lower-hex>",
    "expectedNormalizedTruthSha256": "<sha256-lower-hex>",
    "expectedAnchorSetSha256": "<sha256-lower-hex>",
    "cer": 0.0,
    "anchorOmissions": 0,
    "cerThreshold": 0.03,
    "outcome": "passed",
    "projectionSha256": "<sha256-lower-hex>",
    "artifactId": "<sha256-lower-hex>"
  }],
  "semanticResultSha256": "<sha256-lower-hex>"
}
```

The producer validates the child result's producer contract version/hash,
scope identity, ledger binding, fixture cardinality/order, exact per-fixture
identity/digest binding, actual normalized output digest, CER, anchor omissions,
outcome, projection digest, artifact IDs, and self-excluded semantic digest.
`ConsumerSemanticResultV1` deliberately has no `producerCleanup`, journal,
reconcile-ref, generation, attempt, process/listener/staging, capture-delete,
model-memory, or wire fields. Cert and LAW import/reference the exact
producer-generated contract version/hash and emit only this semantic result;
they never redefine `AcceptanceChildWireV1`, `ProducerChildScopeV1`, or a
competing truth contract.

`AcceptanceChildWireV1` is the only canonical acceptance evidence envelope.
Its exact producer schema is:

```json
{
  "schemaVersion": "AcceptanceChildWireV1",
  "contractVersion": "1",
  "contractSha256": "<D3-bound-producer-contract-sha256>",
  "producer": "capture-runtime",
  "parentGate": "D4",
  "tier": "candidate",
  "runIdDigest": "<sha256-lower-hex>",
  "sequenceIndex": 1,
  "childKey": "capture-private-jpeg",
  "legId": "capture-private-jpeg-v1",
  "childId": "<sha256-lower-hex>",
  "root": "<sha256-lower-hex>",
  "artifactIds": ["<sha256-lower-hex>"],
  "ledgerBinding": {
    "sourceGate": "D3",
    "ledgerSha256": "<sha256-lower-hex>",
    "candidateId": "<sha256-lower-hex>",
    "candidateManifestSha256": "<sha256-lower-hex>",
    "artifactDigests": [{ "artifactKey": "runtime", "sha256": "<sha256-lower-hex>" }]
  },
  "invocationSha256": "<sha256-lower-hex>",
  "fixtureAssignments": [{
    "fixtureIndex": 0,
    "fixtureKey": "private-jpeg-1",
    "fixtureIdentitySha256": "<sha256-lower-hex>",
    "mediaKind": "jpeg",
    "page": null,
    "mediaCapabilityHandleSha256": "<sha256-lower-hex>",
    "oracleCapabilityHandleSha256": "<sha256-lower-hex>",
    "mediaSha256": "<sha256-lower-hex>",
    "oracleSha256": "<sha256-lower-hex>",
    "expectedNormalizedTruthSha256": "<sha256-lower-hex>",
    "expectedAnchorSetSha256": "<sha256-lower-hex>",
    "cerThreshold": 0.03,
    "artifactId": "<sha256-lower-hex>"
  }],
  "fixtureResults": [{
    "fixtureIndex": 0,
    "fixtureKey": "private-jpeg-1",
    "fixtureIdentitySha256": "<sha256-lower-hex>",
    "mediaKind": "jpeg",
    "page": null,
    "mediaSha256": "<sha256-lower-hex>",
    "oracleSha256": "<sha256-lower-hex>",
    "actualNormalizedOutputSha256": "<sha256-lower-hex>",
    "expectedNormalizedTruthSha256": "<sha256-lower-hex>",
    "expectedAnchorSetSha256": "<sha256-lower-hex>",
    "cer": 0.0,
    "anchorOmissions": 0,
    "cerThreshold": 0.03,
    "normalization": "nfkc-whitespace-v1",
    "distance": "code-point-levenshtein-v1",
    "outcome": "passed",
    "projectionSha256": "<sha256-lower-hex>",
    "artifactId": "<sha256-lower-hex>"
  }],
  "childSemanticResultSha256": "<sha256-lower-hex>",
  "producerCleanup": {
    "journalState": "terminal",
    "reconcileRefSha256": "<sha256-lower-hex>",
    "generation": 4,
    "automaticAttempts": 1,
    "rootReaped": true,
    "descendantsTerminated": true,
    "listenersReleased": true,
    "stagingReleased": true,
    "captureDeleted": true,
    "modelMemoryReleased": true,
    "processesAbsent": true,
    "listenersAbsent": true,
    "stagingAbsent": true,
    "proofSha256": "<sha256-lower-hex>"
  },
  "privacy": {
    "rawOcr": false,
    "rawTruth": false,
    "rawMedia": false,
    "tokens": false,
    "paths": false,
    "nativeIds": false
  },
  "wireSha256": "<sha256-lower-hex>"
}
```

The producer creates this wire by binding the validated semantic result and
then adding `producerCleanup` only after terminal process/listener/staging,
capture, and model-memory proof. Cleanup fields are never required from or
accepted in `ConsumerSemanticResultV1`; a consumer cannot manufacture a final
wire by adding them locally.

For D4, `ledgerBinding.sourceGate` is `D3` and binds the immutable candidate
id, `ledgerSha256`, manifest digest, and every raw artifact digest. For D7, the
same exact schema uses `parentGate: "D7"`, `tier: "published"`, and
`ledgerBinding.sourceGate: "D6"`; its closed D6 variant carries
`ledgerSha256`, `publicationLedgerSha256`, `downloadBundleSha256`, and every
downloaded-byte digest. Cert and LAW must reference this exact producer schema
and its `fixtureResults[]`; they may not create a local child wire or redefine
the ledger fields. `parentGate` is closed to `D4`/`D7`, `tier` is closed to
`candidate`/`published`, and the binding is fail-closed unless D4 pairs with
D3/candidate or D7 pairs with D6/published.

`fixtureAssignments[]` and `fixtureResults[]` are mandatory, ordered, and
equal-cardinality; neither is a summary average. Every result entry records
its assignment identity plus the actual normalized output digest, CER, anchor
omissions, outcome, projection digest, and per-fixture artifact id. Every wire
also includes the child semantic-result digest, top-level artifact IDs,
detailed producer cleanup, privacy booleans, parent gate/tier, invocation
digest, and the self-excluded canonical JSON digest. Raw OCR/truth/media,
bearer tokens, private paths, and native identifiers stay producer-private.

`ProducerChildInvocationV1` is an input, not an evidence record. It has a
ready state, child/sequence identity, and exactly one of the two immutable
binding forms: D4 input bound to the D3 candidate ledger, or D7 input bound to
the D6 download/publication ledger. It also has predecessor cleanup-proof
digests, the bound group/root ref digests and generations, one ordered
`fixtureAssignments[]` array, a separate output path nonce, and its
self-excluded invocation digest. Its fixture capability values are opaque
handles, never source paths or raw truth:

```json
{
  "schemaVersion": "ProducerChildInvocationV1",
  "contractVersion": "1",
  "contractSha256": "<D3-bound-producer-contract-sha256>",
  "producer": "capture-runtime",
  "parentGate": "D4",
  "tier": "candidate",
  "readyState": "ready",
  "sequenceIndex": 1,
  "childKey": "capture-private-jpeg",
  "legId": "capture-private-jpeg-v1",
  "childId": "<sha256-lower-hex>",
  "root": "<sha256-lower-hex>",
  "groupRefDigest": "<sha256-lower-hex>",
  "groupGeneration": 4,
  "rootRefDigest": "<sha256-lower-hex>",
  "rootGeneration": 1,
  "artifactIds": ["<sha256-lower-hex>"],
  "ledgerBinding": { "sourceGate": "D3", "ledgerSha256": "<sha256-lower-hex>" },
  "predecessorCleanupProofSha256": null,
  "fixtureAssignments": [{
    "fixtureIndex": 0,
    "fixtureKey": "private-jpeg-1",
    "fixtureIdentitySha256": "<sha256-lower-hex>",
    "mediaKind": "jpeg",
    "page": null,
    "mediaCapabilityHandle": "opaque-media-capability-handle",
    "mediaCapabilityHandleSha256": "<sha256-lower-hex>",
    "oracleCapabilityHandle": "opaque-oracle-capability-handle",
    "oracleCapabilityHandleSha256": "<sha256-lower-hex>",
    "mediaSha256": "<sha256-lower-hex>",
    "oracleSha256": "<sha256-lower-hex>",
    "expectedNormalizedTruthSha256": "<sha256-lower-hex>",
    "expectedAnchorSetSha256": "<sha256-lower-hex>",
    "cerThreshold": 0.03,
    "artifactId": "<sha256-lower-hex>"
  }],
  "outputPathNonce": "<random-opaque-nonce>",
  "invocationSha256": "<sha256-lower-hex>"
}
```

The D7 invocation uses the same identity fields and ready-state rules but its
closed ledger binding is `{ "sourceGate": "D6", "ledgerSha256": "<sha256>",
"publicationLedgerSha256": "<sha256>", "downloadBundleSha256": "<sha256>" }`;
there is no D3/D7 ledger mixing and no mutable URL input.

`fixtureAssignments[]` is ordered producer input, never a consumer-selected
summary. Each assignment has exactly `fixtureIndex`, `fixtureKey`,
`fixtureIdentitySha256`, `mediaKind`, `page`, opaque
`mediaCapabilityHandle` plus `mediaCapabilityHandleSha256`, opaque
`oracleCapabilityHandle` plus `oracleCapabilityHandleSha256`, `mediaSha256`,
`oracleSha256`, `expectedNormalizedTruthSha256`, `expectedAnchorSetSha256`,
`cerThreshold`, and its per-fixture `artifactId`. The producer rejects duplicate
keys, gaps, reordering, unknown media/page combinations, non-opaque handles,
or any assignment whose `fixtureIdentitySha256` is not the canonical digest of
all these fields. The
corresponding `fixtureResults[]` must have exactly the same cardinality and
array order. For every index `i`, result `fixtureIndex`, `fixtureKey`,
`fixtureIdentitySha256`, `mediaKind`, `page`, `mediaSha256`, `oracleSha256`,
expected truth/anchor digests, threshold, and `artifactId` must equal
assignment `i`; actual output, CER, omission count, outcome, and projection
digest are the only child-produced measurements. The top-level `artifactIds`
must contain every per-fixture artifact exactly once.

The producer defines the generic capability contract, but the consumer owns
the resolver and private store. Its proposed package-level shape is:

```text
type FixtureCapabilityHandle = OpaqueCapabilityHandle;

interface FixtureCapabilityResolver {
  resolveMedia(
    handle: FixtureCapabilityHandle,
    expectedHandleSha256: Sha256,
    expectedMediaSha256: Sha256,
  ): ReadonlyByteStream;
  resolveOracle(
    handle: FixtureCapabilityHandle,
    expectedHandleSha256: Sha256,
    expectedOracleSha256: Sha256,
  ): ReadonlyPrivateOcrTruth;
}
```

Cert and LAW implement their resolver/store in their own repositories. The
resolver opens the real media and complete normalized truth read-only, verifies
the handle digest and exact `mediaSha256`/`oracleSha256`, and supplies those
bytes/truth only inside the child. The invocation contains the opaque handles
and their digests, but never a raw path, raw media bytes, raw truth text, or
consumer store location. The consumer then runs the exact
`nfkc-whitespace-v1` normalization and `code-point-levenshtein-v1` CER against
the resolved full truth and critical anchors, so a normalized CER can execute
without leaking the oracle. A resolver mismatch, unavailable real fixture,
changed bytes, incomplete truth, or non-read-only stream fails closed; the
producer accepts only the resulting digest-bound semantic measurements.

The Capture JPEG child and Capture PDF page-1 child each have exactly one
assignment: `capture-private-jpeg-1` with `mediaKind: "jpeg"` and `page: null`,
or `capture-scanned-pdf-page1-1` with `mediaKind: "pdf"` and `page: 1`,
respectively. Cert and LAW may have multiple assignments, but they use the
same ordered cardinality/key/digest rules. A child cannot add, remove, reorder,
or substitute a fixture, and a wire carries the same per-fixture identity,
capability-handle digests, media/oracle digests, and measurements rather than a
singular media or oracle field. Opaque handle values are invocation-only and
never enter the wire.

The invocation never contains a future result/wire digest, raw truth, raw
media, source/model path, bearer token, process handle, PID, or mutable URL.
The producer contract defines `PrivateOcrTruthOracleV1` as a digest-bound
shape, while the consumer-private resolver/store holds the raw normalized
reference text and critical anchors. Only its `oracleSha256` and the
per-fixture semantic measurements cross the wire. D4 and D7 require the full
private normalized reference plus critical anchors from that resolver. An
anchor-only fixture is invalid. The formal Cert migration deletes the
`anchorOnly` field/flag and the
`parseOcrAnchorExpectation` parser from
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts`
and `${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/acceptance-real-options.mts`;
the final D4/D7 schema, config, and producer contract contain no `anchorOnly`
name. A supplied legacy `anchorOnly` field is rejected as an unknown field,
never ignored or treated as a successful anchor-only mode. The red test fails
if the formal path still accepts the flag or parser; green requires full
private normalized reference text and anchors with no anchor-only success path.

The private oracle's closed fields remain `schemaVersion`, `producer`,
`mediaKind`, `page`, `mediaDigest`, raw `truthText`, private `anchorTexts`,
`expectedNormalizedTruthSha256`, `expectedAnchorSetSha256`, `normalization`,
`distance`, `cerThreshold`, `anchorOmissionsAllowed`, and its self-excluded
`oracleSha256`. The complete oracle is held only in the consumer-private
resolver/store and is opened read-only inside the child; it is never serialized
in the invocation, wire, uploaded artifact, or host response. Cert and LAW
receive only the opaque handle, handle digest, `oracleSha256`, and resulting
semantic measurements.

The four producer legs are fixed and independently addressable. Their
`sequenceIndex`, `childKey`, `legId`, `childId`, `root`, and `artifactIds` are
unique within a run and never reused across candidate/prior sessions:

| sequenceIndex | childKey | legId | media/adapter |
| ---: | --- | --- | --- |
| 1 | `capture-private-jpeg` | `capture-private-jpeg-v1` | Capture private JPEG, CER `0.03` |
| 2 | `capture-scanned-pdf-page1` | `capture-scanned-pdf-page1-v1` | Capture scanned PDF page 1, CER `0.01` |
| 3 | `cert` | `cert-v1` | Cert adapter |
| 4 | `law` | `law-v1` | LAW adapter |

Each child writes only its semantic result. The producer validates it, proves
cleanup, then writes the immutable wire before the next `sequenceIndex`.
The standalone
`apps/capture-workbench-desktop/scripts/real-jpeg-acceptance-coordinator.ts:runRealJpegAcceptance`
and `runRealJpegAcceptanceCli` are migration/deletion surfaces, not a second
runner. Delete them only after residual-caller, async-boundary, and replacement
tests are green.

Identity derivation is deterministic and scope-bound: `runIdDigest` is the
lowercase SHA-256 of the private run id; `childId` is the SHA-256 of canonical
JSON containing schema, producer, run digest, sequence/leg identity, ledger
candidate identity, and the ordered fixture-assignment identity digests;
`root` includes the opaque session-ref digest; and each per-fixture artifact id
includes its raw-byte digest. A candidate/prior
session or another leg cannot reuse an identity while raw run ids, paths, and
native refs remain private.

Serialization is deterministic: encode canonical compact UTF-8 JSON without a
BOM or trailing newline; recursively sort object keys lexicographically;
preserve arrays in semantic order (sort set-like digest lists by their stated
digest/artifact key); and emit SHA-256 as lowercase hex. Compute each self
digest over canonical JSON with its own self-digest field omitted.
Each `fixtureAssignments[i].mediaSha256` and its artifact digest cover exact
raw JPEG/PDF or artifact bytes, never decoded/re-encoded text or path bytes.
The expected truth digest is SHA-256 of the UTF-8 normalized raw truth; the expected anchor-set digest is
SHA-256 of canonical UTF-8 JSON of the ordered normalized anchor set.

`nfkc-whitespace-v1` is exactly: apply Unicode NFKC; convert CRLF, CR, LF,
newlines, and every Unicode whitespace code point to ASCII U+0020; collapse
consecutive ASCII spaces to one; then trim. Preserve case, punctuation, and
traditional/simplified characters: no lowercasing, transliteration, or
punctuation stripping. `code-point-levenshtein-v1` compares Unicode code-point
arrays with insertion, deletion, and substitution cost one. CER is zero only
when both normalized values are empty; otherwise it is distance divided by
`max(expectedCodePointCount, 1)`, per fixture/page. Thresholds are PDF page 1
`0.01`, JPEG `0.03`, and anchor omissions `0`; there is no average across
pages, fixtures, products, or anchors.

The exact Cert migration seams are
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:evaluateOcrTruth`,
`normalizeOcrText`, `parseOcrTruthManifest`, and `levenshtein`,
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/acceptance-real-options.mts:parseOcrAnchorExpectation`,
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts:buildPhase1AcceptanceEvidence`,
and `${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts:serializePrivacySafeOcrSemanticEvidence` /
`OCR_NORMALIZATION_VERSION`. The exact LAW Java seams are
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/capture/FoundryCaptureStructuringProvider.java:FoundryCaptureStructuringProvider`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/extraction/EvidenceTextExtractionService.java:EvidenceTextExtractionService`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/support/acceptance-expectations.ts:loadLawAcceptanceExpectation`,
and `${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/support/acceptance-artifacts.ts:writeAcceptanceManifest`.
These are migration seams, not claims that Cert or LAW already emit the
producer records.

### Python LAW adapter capture lifecycle

The current Python adapter is
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-ai-service/src/app/ocr/service.py:OcrExtractionService.extract`,
with its `CaptureRuntimeClient` construction in `_client`, readiness wait in
`_wait_for_ocr_ready`, and cleanup in `_cleanup`. The producer defines the
RequestRef format and semantics. `RequestRefV1` is exactly `rr1_` followed by
64 lowercase hexadecimal characters generated from 32 CSPRNG bytes; Python's
future owner uses `secrets.token_bytes(32)`. It is opaque and must not be a
deterministic hash, UUID5, source/path digest, or value derived from the
request.

The idempotent producer operation is exactly:

```text
start_or_get(
  request_ref: RequestRefV1,
  metadata: StartCaptureByRequestRefV1,
  source: ReadonlyByteStream,
) -> StartCaptureByRequestRefResult
```

`StartCaptureByRequestRefV1` is canonical metadata, not a free-form map. Its
closed shape is `protocolVersion: "2"`, `sourceKind`, `fileName`, `mediaType`,
`totalBytes`, expected `sourceSha256`, `structuringMode`, `targetLanguage`,
and `startPolicy: "eager"`; `requestRef` and `requestDigest` are separate
identity arguments/outputs. The producer canonicalizes compact UTF-8 JSON with
sorted keys and computes `requestDigest` over those exact metadata bytes. It
consumes the source stream once into producer-owned staging while recomputing
byte count and `sourceSha256`; it never trusts a caller-provided digest. The
idempotency tuple is `(requestRef, requestDigest, sourceSha256)`.

Before any network or capture side effect, the Python adapter durably writes a
`start_pending` record containing the generated ref, canonical request digest,
source digest/length, and producer-contract version/hash. The producer then
atomically journals that request-ref intent before `create_capture`, scheduling,
or any other operation side effect. A first tuple creates the existing v2
capture and returns `created`; the same ref with the same metadata and
identical source bytes returns `discovered`/the existing operation without a
duplicate. The same ref with changed metadata, length, or source bytes is a
conflict and performs no mutation. A timeout or dropped acknowledgement
retains the ref and retries the same tuple; it never generates a replacement
ref. A producer durable ACK/discovery receipt is required before Python marks
the operation `running`.

The future Capture Runtime route/service/storage ownership is explicit:

| Layer | Current migration seam | Future owner (proposed; no new route is implied) |
| --- | --- | --- |
| HTTP route | `packages/capture-runtime/src/capture_runtime/routes/streaming.py:register_streaming_routes` nested `start_capture` on `POST /v2/captures` | `start_capture_by_request_ref` adapter on the same API-2.0 route; it passes a verified source stream to `start_or_get` |
| Runtime service | `packages/capture-runtime/src/capture_runtime/services/streaming_capture_service.py:StreamingCaptureService.start_capture` | `StreamingCaptureService.start_or_get` with the pre-side-effect journal/receipt ordering |
| Durable storage | `packages/capture-runtime/src/capture_runtime/storage/streaming_repository.py:StreamingRepository.create_capture` and `storage/_streaming_persistence.py:_StreamingRepositoryPersistence.persist_capture` | `StreamingRepository.start_or_get_by_request_ref` plus its durable request-ref index/record; ref lookup is the sole later identity |
| Python SDK | `packages/capture-runtime-client-python/src/capture_runtime_client/client.py:CaptureRuntimeClient.start_capture` | `CaptureRuntimeClient.start_or_get` with `RequestRefV1` generation and durable `start_pending` adapter state |
| TypeScript SDK | `packages/capture-runtime-client/src/private/streaming.ts:startStreamingCapture` and `packages/capture-runtime-client/src/client.ts:CaptureRuntimeClient.startStreamingCapture` | `startCaptureByRequestRef` in the private streaming adapter and `CaptureRuntimeClient.startCaptureByRequestRef` in the public framework-neutral client |

`get(requestRef)`, `cancel(requestRef)`, and `delete(requestRef)` all resolve
the producer's private mapping by that same opaque ref. They never accept a
capture id, path, token, alternate ref, or request-derived substitute. The
producer returns only semantic state/receipts; capture ids, native ids, paths,
and tokens remain private. Cleanup retention is bounded and sanitized.

This is the same `/v2/captures` operation and lifecycle already represented by
`packages/capture-runtime/src/capture_runtime/routes/streaming.py` and
`packages/capture-runtime-client-python/src/capture_runtime_client/client.py`
(`start_capture`, `get_capture`, `cancel_capture`, `delete_capture`); it is
not a second OCR route or engine. The public floor remains API `2.0`, raw and
structured schema `2`, and `CaptureOcrProjectionV3` schema `3`. The exact
LAW config seam is
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-ai-service/src/app/common/config.py:AiServiceConfig`.
Migration red: Python does not use CSPRNG bytes, `start_pending` is not
durable before `start_or_get`, the producer starts before journaling, changed
metadata, length, or source bytes are accepted for an existing ref, running is
marked without a producer ACK/discovery receipt, a timeout loses the ref,
lookup/cancel/delete accept another identity, cleanup is unbounded, or a new
route/engine is introduced. Required green cases are
`same_ref_same_bytes_discovers_without_duplicate`,
`same_ref_changed_metadata_conflicts_without_mutation`,
`same_ref_changed_source_conflicts_without_mutation`,
`start_pending_survives_timeout_and_retries_same_tuple`,
`running_requires_producer_ack_or_discovery`, `lookup_cancel_delete_use_same_ref`,
and `request_refs_are_csprng_and_not_request_derived`. Discovery stop: confirm
the LAW adapter's resolved client/config and current route metadata before
assigning an Nx or workflow target; no such target is claimed by this docs
checkpoint.

Any schema, producer, sequence/leg/child/root/artifact, candidate/D3/D6
root/id/digest, media/truth digest, normalization, distance, threshold,
raw-byte, semantic-result, or cleanup-proof mismatch fails closed: emit no
evidence, do not promote, and retain only the sanitized failure record.

### D3/D4 immutable-byte boundary (proposed target)

D2 and D2.5 authorize only design, contract, and red infrastructure. They do
not install or require an installed candidate. D3 is the first construction
gate: the existing release/candidate owners build one immutable byte ledger
containing a bounded candidate root, candidate id, manifest digest, every raw
artifact digest, and all source/version/schema/contract/model/profile/catalog
identity. D4 must consume that ledger, not reconstruct it.

The proposed future D4 owner is a new
`capture-workbench-desktop:acceptance-d3-candidate` target in
`apps/capture-workbench-desktop/project.json`, backed by
`apps/capture-workbench-desktop/scripts/acceptance-d3-candidate.ts:runD3CandidateAcceptance`.
It accepts externally supplied `D3_CANDIDATE_ROOT`, `D3_CANDIDATE_ID`,
`D3_LEDGER_SHA256`, and `D3_ARTIFACT_DIGESTS`, validates exact equality, and
passes only those prebuilt bytes to the producer runner. It must never invoke
`capture-workbench-desktop:stage-product-runtime`, any build target or build
script, a source-tree import, or a mutable URL. The current
`capture-workbench-desktop:acceptance-real` target remains a local installed
diagnostic and is explicitly not D4.

The target and script do not exist at this checkpoint. Discovery begins with
`corepack pnpm nx show project capture-workbench-desktop --json`; target/script
creation is a separate authorized implementation task and a
discovery-and-stop until its metadata and schema tests exist. No made-up target
invocation or installed-candidate claim is valid before that stop clears.

## D2.5 cross-repository contract handoff

D2.5 is a cross-repository design/contract gate, not permission to edit sibling
worktrees from Capture. Its only checkout inputs are the environment variables
`${CERT_PREP_CHECKOUT}` and `${GX_LAW_PREP_CHECKOUT}` (PowerShell spelling:
`${env:CERT_PREP_CHECKOUT}` and `${env:GX_LAW_PREP_CHECKOUT}`). The D2
authorization record must name, for each checkout, the resolved Git root,
authorized branch, authorized `HEAD`, and exact path set. No sibling-relative
fallback, current-directory inference, or mutable package install is allowed.

Before assigning any D2.5 implementation work, the worker resolves each
variable and verifies:

```powershell
$certCheckout = (Resolve-Path -LiteralPath ${env:CERT_PREP_CHECKOUT} -ErrorAction Stop).Path
$lawCheckout = (Resolve-Path -LiteralPath ${env:GX_LAW_PREP_CHECKOUT} -ErrorAction Stop).Path
git -C $certCheckout rev-parse --show-toplevel
git -C $certCheckout rev-parse --abbrev-ref HEAD
git -C $certCheckout rev-parse HEAD
git -C $lawCheckout rev-parse --show-toplevel
git -C $lawCheckout rev-parse --abbrev-ref HEAD
git -C $lawCheckout rev-parse HEAD
```

The returned roots must equal the resolved variables, and branch/`HEAD` must
equal the values authorized by D2. For every exact path, `git -C <root>
ls-files --error-unmatch -- <path>` and a path-scoped
`git -C <root> status --short --untracked-files=all -- <path>` check ownership
and pre-existing dirt before editing. The Cert path set is the four OCR truth/
evidence scripts named above; the LAW path set is the Java provider/extraction,
web-E2E expectation/artifact, Python OCR service, and config paths named above.
Missing variables, root mismatch, branch/`HEAD` drift, a missing path, or an
extra path is discovery-and-stop.

Cert and LAW consumer docs and schemas import/reference the exact generated
`ProducerAcceptanceContractV1` version `"1"` and the literal producer
`contractSha256` recorded by D3/D6. They do not redefine producer record names,
fields, fixture assignment rules, cleanup fields, or validation. If a consumer
needs a field, the producer contract changes first and receives a new hash;
consumer-local edits cannot fork the protocol. Capture, Cert, and LAW have
separate commit boundaries: a Capture commit contains only Capture paths, a
Cert commit contains only paths below `${CERT_PREP_CHECKOUT}`, and a LAW commit
contains only paths below `${GX_LAW_PREP_CHECKOUT}`. Each repository reports its
own commit SHA and checks; no one Capture commit stages or commits sibling
files, and no cross-repository push is implied by D2.5.

## Version, schema, projection, and release-channel inventory

The first implementation slice owns the Nx upgrade and version-source
extension before a candidate is built. It updates `package.json` and
`pnpm-lock.yaml` from Nx `23.1.0` to `23.1.2`, then extends the existing
`tools/release/version-sources.ts` collector and
`tools/release/version-sources.test.ts` regression target
`capture-tools:release-version-test`. It does not invent
`capture-runtime:version-check`; that target is absent and remains
discovery-and-stop until an authorized owner is found.

| Inventory family | Current owner/path to enumerate |
| --- | --- |
| Workspace/tooling | Root `package.json`, `pnpm-lock.yaml`, all Nx packages, and resolved project metadata; the first slice must detect 23.1.2 consistency |
| Release identity | `release/version.json`: release `0.4.2`, runtime API `2.0`, document schema `2` |
| Runtime and projection | `packages/capture-runtime/pyproject.toml`, generated raw/structured schema 2, `CaptureOcrProjectionV3` schema 3, runtime constants, manifests, catalogs, model/source locks, `apps/capture-workbench-desktop/src-tauri/resources/capture-document-v2.schema.json`, and `packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256` |
| TypeScript clients and Workbench | `packages/capture-runtime-client/package.json`, `packages/capture-workbench-ui/package.json`, generated contracts, loader/assets, and desktop staged runtime/assets/configuration (including the TypeScript contract-hash resource) |
| Python client | `packages/capture-runtime-client-python/pyproject.toml`, generated schemas, and its contract-hash resource |
| Java client | `packages/capture-runtime-client-java/pom.xml`, generated schema/contract resource, and build/install/contract-hash targets |
| Rust launcher/crates | `packages/capture-sidecar-launcher/Cargo.toml`, `src/process.rs`, `src/launcher.rs`, `src/lib.rs`, generated/embedded manifest and contract identity |
| Acceptance/release tooling | `tools/release/version-sources.ts`, its test, `tools/three-project-acceptance.ts`, `tools/acceptance-contract.ts`, candidate/release manifests and locks |

The channels are distinct and all must be represented by a candidate/release
manifest: npm/GitHub Packages for the Workbench UI and TypeScript runtime
client; PyPI for the Python runtime client (and any explicitly assembled Python
distribution); Maven/GitHub Packages for the Java client; crates.io for
`capture-sidecar-launcher`; and GitHub Releases for runtime/desktop/installable
assets and immutable release manifests. The existing producer workflows are
the only publication owners: `_publish-npm.yml`, `_publish-pypi.yml`,
`_publish-maven.yml`, `_publish-crates.yml`, `_publish-github-release.yml`,
`_publish-runtime-github-release.yml`, `_verify-registries.yml`,
`_publish-promotion-ledger.yml`, and `_publish-stable-pointer.yml`, with
`release-promote.yml` owning their orchestration. `tools/update-release-index.ts`
may mutate the stable pointer only when invoked by the separately protected D8
stable-pointer dispatch. No local script or consumer may mutate it.

## D5-D8 workflow contract (future implementation slice)

These workflow files exist at this head, but their current job graph is not yet
the D5-D8 state machine. In particular, `release-promote.yml` currently has
`prepare-candidate`, registry publication jobs, `verify-registries`,
`tag-release`, `publish-github-release`, `publish-stable-pointer`, and
`promotion-ledger`; the current graph makes `promotion-ledger` depend on
`publish-stable-pointer`. That direct stable-pointer edge is the defect to
remove. The documentation checkpoint does not edit the workflows, but the
future implementation slice explicitly owns and may edit these contracts:

* `.github/workflows/release-promote.yml` owns the D5 publication orchestration
  and the D6 download-back/D7 published-acceptance dispatch inputs and outputs.
* `.github/workflows/_publish-github-release.yml` owns the immutable GitHub
  Release assets and manifest created from the exact D3 candidate after D4 and
  registry verification; it must not rebuild or rewrite candidate bytes.
* `.github/workflows/_verify-registries.yml` owns the complete registry-ledger
  check bound to the D3 candidate and D4 acceptance record.
* `.github/workflows/_publish-runtime-github-release.yml` remains the existing
  runtime-release asset lane when that lane is included in the D5 train.
* `.github/workflows/_publish-promotion-ledger.yml` owns the D5 publication
  ledger assembled by `tools/create-promotion-ledger.ts`; it runs before D6
  and is never a prerequisite edge from D5 to the stable pointer.
* `.github/workflows/_publish-stable-pointer.yml` remains the implementation
  adapter for the protected D8 operation. It is called only by the separate
  D8 dispatch after D7, never directly by the D5 promotion graph.
* `tools/create-promotion-ledger.ts:main` and its argument/ledger validation
  own the D5 ledger input contract. The future schema must bind D3 candidate
  and D4 acceptance digests, every publication URL/byte digest, the GitHub
  Release ledger, and the producer source/version/contract identity.
* `tools/update-release-index.ts:updateReleaseIndex` and `main` own the
  producer-only pointer operation. The future D8 invocation must carry the
  D7 chain digest and expected current pointer generation/digest, and reject a
  compare-and-swap (CAS) mismatch before changing either index file.
* `tools/three-project-acceptance.ts:runAcceptanceSequence`,
  `runCaptureWorkbenchAcceptance`, `validateChildManifest`,
  `validateTerminalManifest`, and `validateCleanupEvidence`, together with
  `tools/acceptance-contract.ts:writeAcceptanceManifest` and
  `readAcceptanceManifestTolerant`, own the D7 downloaded-byte acceptance
  contract.
  They must accept a D6 download bundle, not a source tree or local candidate,
  and retain the same serial child/cleanup proof as D4.

The required future dispatch contract is explicit:

1. **D5.** After D4, `release-promote.yml` verifies the D4 record and dispatches
   every applicable registry publisher from the one immutable D3 candidate.
   `_verify-registries.yml` then verifies all required publication ledgers;
   `tag-release` and `_publish-github-release.yml` publish the same candidate
   bytes and immutable manifest; `_publish-promotion-ledger.yml` records the
   complete D5 ledger. D5 has no `_publish-stable-pointer.yml` call, direct or
   transitive. The current `publication_scope` retry input may repair a failed
   lane, but it cannot terminalize D5 or dispatch D6 until every required lane
   is complete. Any missing channel, byte mismatch, rebuilt artifact, or
   conflicting immutable version stops the chain.
2. **D6.** A new or changed download-back dispatch contract, owned by
   `release-promote.yml` unless D2 discovery assigns a separate existing owner,
   takes only the D5 publication ledger, immutable public references, expected
   D3/D5 hashes, and source/version/contract identity. It performs fresh
   downloads with caches bypassed, writes a D6 download ledger, and fails on a
   redirect ambiguity, missing asset, inaccessible manifest, or hash mismatch.
   No stable pointer or mutable channel is an input.
3. **D7.** A new or changed published-acceptance dispatch contract, also owned
   by `release-promote.yml` unless D2 discovery assigns a separate existing
   owner, takes only the D6 download ledger and downloaded bundle. It invokes
   the existing acceptance owner sequentially in the order Capture JPEG,
   cleanup, Capture PDF page 1, cleanup, Cert, cleanup, LAW, cleanup, and
   writes an independent D7 ledger. It cannot rebuild, republish, substitute
   local bytes, or average CER/anchors.
4. **D8.** A separate protected `workflow_dispatch` is a required creation task;
   no separate D8 dispatch workflow exists at this head. D2 must discover an
   existing protected owner or create and name one before implementation
   proceeds, then wire it to `_publish-stable-pointer.yml`. The dispatch takes
   the D7 run/ledger identifiers and digest chain, D5 publication ledger,
   expected current `stable.json` generation/tag/manifest digest, and the
   candidate manifest digest. The protected job re-reads all records, checks
   the expected pointer with a CAS guard, and only then invokes
   `tools/update-release-index.ts` in the `capture-release-index` environment.
   A changed pointer, missing D7 record, or chain mismatch aborts without
   touching the protected branch.

There is no checked-in Nx target for D6/D7 workflow-contract validation or the
new D8 dispatch. D2 must run `corepack pnpm nx show project capture-tools --json`
and either discover an existing target or create/record a target in the
existing `capture-tools` owner before calling it; until then, target creation
is a discovery-and-stop condition, not an implied command. Existing
`capture-tools:promotion-evidence-test`, `promotion-registry-test`,
`release-manifest-test`, and `release-index-test` remain useful GREEN checks but
do not prove the future dispatch contracts by themselves.

## D0 -> D8 delivery state machine

The gates are strict, linear, and separate. A gate consumes only the preceding
gate's immutable record. No gate is allowed to build a new candidate while
accepting an earlier one, and no gate depends on itself or on a later gate.

| Gate | State and exact dependency | Required terminal record |
| --- | --- | --- |
| D0 | `DocsCommitted`: this documentation correction is committed. The exact SHA is external, not self-embedded. | Exact path set, diff/anchor/fence checks, and commit SHA reported by the worker |
| D1 | `DesignReviewed`: consumes D0 `HEAD` only. Pending now. | Fresh Standards and Specification reports naming `git rev-parse HEAD`, paths, and external check/PR metadata |
| D2 | `ImplementationAuthorized`: consumes D1 approval and no later record. | Root authorization, owner paths, first-slice plan, and bounded implementation queue; no handoff commit is implied |
| D3 | `CandidateBuilt`: consumes D2 authorization and the exact implementation source. | One immutable byte ledger containing candidate bytes, root/id, manifest, source/version/schema/contract/model hashes, and every raw artifact digest |
| D4 | `CandidateAccepted`: consumes only externally supplied D3 root/id/digests through the future `acceptance-d3-candidate` target. | Sequential four-leg acceptance manifest, per-fixture CER/anchor results, cleanup/journal proofs, and D3 identity equality |
| D5 | `PublishedImmutable`: consumes D4 success and publishes all D3 candidate bytes through the future workflow contract above; it does not call the stable-pointer workflow. | Public artifact URLs, immutable publication metadata, and equality ledger; stable pointer remains unmoved |
| D6 | `DownloadBackVerified`: consumes only D5 public artifacts through a fresh-download dispatch. | Fresh downloads and hashes equal the D3/D5 ledger for every channel; no local path, cache, or mutable pointer is accepted |
| D7 | `PublishedAccepted`: consumes only D6 downloads through the published-acceptance dispatch and repeats the D4 sequence. | Published/downloaded acceptance manifest with the same thresholds, anchors, cleanup, and no averaging |
| D8 | `StablePointerMoved`: consumes D7 success only through a separate protected dispatch and CAS guard. | D7 chain, expected/current pointer guard, and producer-owned `tools/update-release-index.ts` receipt are retained before the additive pointer mutation |

D4 never consumes a D4/D6 identity ledger: it consumes the one D3 candidate
ledger. D5 never rebuilds or changes bytes and never calls the stable-pointer
workflow. D6 is the fresh download-back proof. D7 never accepts a local
candidate. D8 is a separate producer-only protected dispatch with a CAS guard;
a worker, host, or local script has no authority to edit
`release-index/stable.json`.

## Rollback and review rules

A failed gate stops all later gates and preserves its sanitized evidence,
journal, byte ledger, and rollback reference. Before any registry accepts bytes,
stop and retain the failed candidate. After publication, rollback is producer
supersession only: publish a corrected successor through the same immutable
candidate/D5-D8 path, then mark the defective release superseded through the
protected producer index operation. Never rewrite or overwrite published
`0.4.2` bytes, directly revert the stable pointer, reset/rebase/amend, or mix
`0.4.1` and `0.4.2` assets. Any content commit invalidates prior D1 review.
Local package evidence remains local-tier evidence, and an old executable
cannot prove a fresh installer or publication.

The canonical documents are reviewed for current-code grounding, links,
anchors, fenced blocks, privacy, staged scope, and truthfulness. This docs
checkpoint claims no feature change, model journey, candidate, publication,
download-back, D7 acceptance, or D8 pointer movement.
