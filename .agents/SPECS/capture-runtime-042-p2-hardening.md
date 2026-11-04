# Capture Runtime Phase 2 hardening (canonical design)

Status: canonical design for the producer-owned OCR pipeline, compute
selection, runtime lifecycle and acceptance evidence, first shipped in 0.4.2
(2026-09-27). The [release runbook](../GUIDES/release-runbook.md) owns the
release procedure. Open work: [#246](https://github.com/gx-capture/capture-workbench/issues/246) (restart reconciliation, "Option W")
and [#247](https://github.com/gx-capture/capture-workbench/issues/247) (iGPU selection test and installed proof).

## Implementation status (2026-11-01)

Live R3 journal CAS (Running/Closing/Terminal and activation-failure
reconciliation) is implemented. Restart reconciliation (automatic attempts
within 60 s, third-failure manual review, authorized recovery, and proof-backed
stale-record terminalization or staging release) is specified but not wired
into production. No host uses the R3 lifecycle yet: desktop, cert-prep and LAW
launch via the legacy path with native Windows Job containment
(`KILL_ON_JOB_CLOSE`). See [#246](https://github.com/gx-capture/capture-workbench/issues/246).

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
- Package QA, fake OCR, snapshots, screenshots, local source-tree imports, and
  successful exit codes are not substitutes for real installed or published
  acceptance.
- A selected DirectML construction or inference failure never retries another
  device or silently falls back to CPU. Indeterminate hardware remains
  indeterminate/unavailable.

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
producer (restart reconciliation specified; not yet wired in production — see
status banner). Tauri may request a semantic operation but never owns or mutates a
runtime journal or native Job.

## Public contract floor and identity

Phase 2 preserves API `2.0`, raw and structured document schema `2`,
`CaptureOcrProjectionV3` schema `3`, and one contract-set SHA-256
(`packages/capture-runtime/src/capture_runtime/assets/contract-set.sha256`). The
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

### `OcrPipeline`

The chosen design (O1) keeps PDFium/Paddle ownership in the producer and
preserves schema 2/3 output.

#### O1: one terminal operation

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

### `OwnedRuntimeSession`

The current native owner is concrete and must be converged, not wrapped by a
second coordinator. In `packages/capture-sidecar-launcher/src/process.rs`,
`OwnedRuntimeSession::spawn`, `id`, `try_wait`, `monitor_root_exit`,
`terminate_and_prove`, and `terminate` currently expose a one-root process
surface. `RuntimeTerminationProof` currently includes `root_pid`, and cleanup
errors can format a PID. Those are facts to replace; this document does not
pretend the current API is already opaque.

#### R3: producer-owned group/session (chosen shape)

Interface shape (the only public R3 lifecycle seam):

```text
OwnedRuntimeSession::prepare_group(
    plan: &ImmutableGroupPlan,
    sink: &dyn ReconcileRefSink,
) -> Result<PreparedGroup, PrepareError>

PreparedGroup // opaque, move-only, nonserializable; contains a private ActivationPermit

OwnedRuntimeSession::activate_group(
    prepared: PreparedGroup,
) -> Result<GroupLease, LaunchError>

GroupLease // opaque, move-only, one-use live lease
session.observe(lease: &GroupLease) -> Result<GroupObservation, LifecycleError>
session.close(lease: GroupLease, reason: CloseReason) -> Result<GroupProof, CleanupError>
```

`PreparedGroup` has no public fields, serializer, clone, debug projection, or
permit constructor. Its producer-private contents include the complete plan,
verified binding receipt, binding-attempt identity, and exactly one
`ActivationPermitV1`. `activate_group` consumes the value, so the permit and
the prepared state cannot be replayed or passed to a second activation call.
`GroupLease` is likewise opaque and move-only; it is issued only after the
whole group is live and ready. There is no public per-root activation, permit,
or serialized lease interface.

R3 is a whole-group protocol. `prepare_group` receives one immutable plan whose
ordered roots are complete before any journal or resource mutation. It first
durably writes one group journal record in `planned_unbound`; that state has the
group plan identity but an `unbound` binding and no bound root references or
receipt. The producer then creates a fresh `bindingAttemptId` for this binding
attempt and asks the injected `ReconcileRefSink` to persist the complete group
binding. The sink must flush the binding, read it back by that exact
`bindingAttemptId`, and verify the read-back against the complete expected
group/root tuple before returning. The tuple includes the plan digest, group
ref, immutable group generation, every ordered root ref/role/ordinal, immutable
root generation, root spec digest, reserved listener identity, and receipt
digest. A sink failure or incomplete read-back leaves `planned_unbound` and
acquires no process, listener, staging, or model resource.

Only after sink persistence, read-back, and verification does the producer
atomically write `prepared_bound`, replacing the `unbound` binding with one
complete `bound` binding and storing the verified `bindingAttemptId`. The
producer privately constructs exactly one `ActivationPermitV1` inside the
opaque `PreparedGroup`; the permit binds the permit version, plan digest,
binding-attempt identity, group-ref digest, immutable group generation, the
complete ordered root-binding set, and receipt digest. The producer re-verifies
that private permit against the current journal and sink binding. A missing,
stale, forged, partial, or mismatched binding fails closed. Permit construction
is not exposed to a host, and a host cannot call activation first or activate an
individual root. There is no per-root activation operation against a group
record.

`activate_group(prepared)` is the only activation operation and consumes the
opaque `PreparedGroup`. It validates the whole plan and binding, creates and
assigns every planned root while suspended, and verifies every Job membership,
creation identity, root nonce, reserved-listener identity, and staging binding.
The journal CAS advances `ready -> launching` with the expected
`journalRevision` and complete immutable binding before any root is resumed.
The producer then resumes roots and waits for live readiness. Reserved listener
identity before resume is deliberately distinct from the live listener
readiness binding after resume; a port or reservation alone is not readiness or
ownership proof. If assignment is partial, a root resumes unexpectedly, or any
listener/readiness check fails, the producer closes the entire Job, issues no
`GroupLease`, marks the whole group for reconciliation, and never continues one
root independently. Only a complete group may produce one live lease and enter
`running`. One root is represented by this same protocol with group size one. A
private `start_one` helper, if retained during migration, only calls
`prepare_group([spec], sink)` and then `activate_group`; it is not a second
public activation seam.

The sink interface is part of the R3 seam, not an optional test hook:

```text
trait ReconcileRefSink {
  persist(
    &self,
    binding_attempt_id: &BindingAttemptId,
    binding: &CompleteGroupBinding,
  ) -> Result<(), PersistError>;
  read_back(
    &self,
    binding_attempt_id: &BindingAttemptId,
  ) -> Result<CompleteGroupBindingReceiptV1, PersistError>;
  verify(
    &self,
    binding_attempt_id: &BindingAttemptId,
    expected: &CompleteGroupBinding,
    read_back: &CompleteGroupBindingReceiptV1,
  ) -> Result<VerifiedGroupBinding, PersistError>;
}

struct CompleteGroupBinding {
  bindingAttemptId: BindingAttemptId,
  planDigest: Sha256,
  groupRef: ReconcileRef,
  groupRefDigest: Sha256,
  groupGeneration: u64, // immutable binding identity
  rootBindings: Vec<RootRefBinding>, // complete ordered set
}

struct RootRefBinding {
  ordinal: u32,
  role: RootRole,
  rootRef: ReconcileRef,
  rootRefDigest: Sha256,
  rootGeneration: u64, // immutable binding identity
  specDigest: Sha256,
  reservedListenerIdentity: ReservedListenerIdentity,
}

struct CompleteGroupBindingReceiptV1 {
  bindingAttemptId: BindingAttemptId,
  binding: CompleteGroupBinding,
  receiptDigest: Sha256,
}

struct ActivationPermitV1 {
  // This type and its constructor exist only inside PreparedGroup.
  bindingAttemptId: BindingAttemptId,
  planDigest: Sha256,
  groupRefDigest: Sha256,
  groupGeneration: u64,
  rootBindings: Vec<RootRefBindingDigest>,
  receiptDigest: Sha256,
}
```

The permit constructor is private to the producer and the permit is not a
public parameter. `groupRefDigest` is the canonical digest of the opaque group
ref, `groupGeneration` is immutable binding identity, each `rootRefDigest` and
`rootGeneration` is the exact immutable per-root binding, and
`bindingAttemptId` identifies this one sink persist/read-back/verify attempt.
`journalRevision` (defined below) is the only mutable journal revision and is
incremented by a successful journal CAS; it never changes the group or root
generation. Every activation CAS includes expected state `ready`, expected
`journalRevision`, the binding-attempt identity, and the complete immutable
binding set; the sink must still verify the receipt for that tuple. The
prepared value cannot be activated with a subset of roots or twice. Tests must
cover unbound absence of receipt/bindings, sink persist/read-back/verify
failure, wrong binding-attempt id, wrong group/root ref digest, wrong immutable
group/root generation, wrong plan digest, wrong receipt digest, stale permit
after a journal revision change, partial suspended assignment with zero
resumes, listener readiness failure after partial resume, concurrent group
activation with one CAS winner, and valid group-size-one/multi-root paths.

Capture, Cert, and candidate journeys use the same group protocol with one
root (target host path; migration pending — see Implementation status). The LAW journey
may put Capture, Python, and Java roots in one
producer-owned group. A `GroupLease` is an opaque, move-only, one-use semantic
lease returned only after whole-group activation; no raw `Job`, process handle,
PID, native error, child object, or activation permit crosses the seam.

The hidden module owns one current unnamed no-breakaway Job configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, root identity, readiness, listener
bindings, descendants, journal/reconciler, bounded retry, and terminal proof
(restart reconciliation and retry specified; not yet wired in production — see
status banner).
It never uses a named Job takeover and never weakens close/crash cleanup.
Dependencies are the existing native launcher/process adapter, the existing
`SidecarLaunchSpec`/readiness adapter, and a deterministic native failure
adapter. The trade-off is slightly more state than R1, but it avoids a second
coordinator and provides one owner for the LAW multi-root case. The deletion
surface is `OwnedRuntimeSession`'s current direct process methods, desktop
`OwnedRuntime`/`LaunchedRuntime` raw-child assumptions, and host cleanup helpers.
Tests cover one-root group-size-one compatibility, all-roots-suspended-before-
resume activation, CAS-to-`launching` before resume, reserved-versus-live
listener identity, multi-root atomic group close, partial assignment with zero
resumes, listener readiness failure after partial resume, root crash, descendant
escape, listener/staging proof, baseline survival, journal replay, and one-use
lease close/replay rejection.

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
the crate export boundary; `src/launcher/` adapts `SidecarLaunchSpec` and
`LaunchedSidecar`; desktop `src/state.rs` and `src/launcher.rs` become
semantic adapters. The current `spawn`/`id`/`try_wait` methods and PID-bearing
proof are convergence surface, not a second target contract; the legacy public
interfaces remain available and used pending host migration. A future
implementation may retain an internal PID for native verification, but public
proof and errors are opaque and privacy-safe.

The R3 journal seam is specified as addressable and observe-only after restart
(not yet exported or wired in production — see Implementation status):
`RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`. The
producer allocates a distinct opaque `ReconcileRef` for every candidate or
prior session; it is a journal index/address only, not a job, process, PID,
path, or takeover lease. `ReconcileResult` contains semantic state, a
sanitized cleanup result, and `proofSha256` when proof exists, never native
identifiers. A restart observer may terminalize only the exact ref whose full
absence/listener/staging proof is complete (specified; not yet wired in
production — see Implementation status); present, reused, unqueryable, or
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
  "journalRevision": 7,
  "planDigest": "<sha256-lower-hex>",
  "state": "ready",
  "createdAt": "2026-09-10T00:00:00Z",
  "updatedAt": "2026-09-10T00:00:02Z",
  "jobBinding": { "setupState": "committed", "jobNonce": "opaque-native-binding" },
  "binding": {
    "kind": "bound",
    "bindingAttemptId": "binding-attempt-opaque-id",
    "groupRefDigest": "<sha256-lower-hex>",
    "groupGeneration": 4,
    "rootBindings": [
      {
        "ordinal": 0,
        "role": "capture",
        "rootRefDigest": "<sha256-lower-hex>",
        "rootGeneration": 1,
        "specDigest": "<sha256-lower-hex>",
        "reservedListenerIdentity": "opaque-reservation-identity"
      }
    ],
    "activationReceiptDigest": "<sha256-lower-hex>"
  },
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
      "reservedListenerIdentity": "opaque-reservation-identity",
      "loopbackPort": 43123,
      "liveListenerReadiness": null,
      "startedAt": "2026-09-10T00:00:01Z"
    }
  ],
  "proof": null,
  "recoveryEpoch": 0,
  "attempt": 0
}
```

Required base fields are the schema version, producer, session nonce, immutable
plan digest, state, timestamps, `journalRevision`, recovery epoch, and bounded
attempt counter. `binding` is an explicit state-independent union:

```text
Binding =
  { kind: "unbound" }
  | {
      kind: "bound",
      bindingAttemptId: BindingAttemptId,
      groupRefDigest: Sha256,
      groupGeneration: u64,
      rootBindings: CompleteOrderedRootBindings,
      activationReceiptDigest: Sha256,
    }
```

`planned_unbound` carries the `unbound` variant only: it has no
`bindingAttemptId`, receipt, group-ref digest/generation, or bound per-root
ref/generation records, and carries only the complete plan identity.
`prepared_bound` and every resource-bearing descendant carry one complete
`bound` value; the group and root generations in that value are immutable
binding identity, not journal counters. A retry uses a fresh
`bindingAttemptId`; it never edits an existing group/root generation. A bound
`reconcile-required` or `manual-review` record reached from a bound state
retains the complete ordered binding set and verified receipt; a
`reconcile-required` record reached directly from `planned_unbound` remains
unbound when durable proof shows that no binding/resource was attempted.
`journalRevision` is the monotonic revision of the
durable journal and is incremented on every successful CAS, including a
reconciliation attempt or manual-review recovery. It is the mutable CAS guard;
it never substitutes for or increments a group/root generation. Job and
staging bindings are added only as their producer resources are acquired; the
Job binding records whether setup was durably committed before a root was
resumed. A `ready` record means every root has been assigned and verified
suspended; no root may be resumed from a partial record. Once a root is bound
to a native resource, it records ordinal, role, root-ref digest, root
generation, root nonce, PID, process creation identity, state, reserved
listener identity, live listener-readiness identity when available, and start
time. A terminal record adds semantic proof:
root reaped, descendants terminated, listeners released, staging released, and
the proof generation. A terminal proof also carries the required
`unacquiredRootBindings` array. It is empty when every planned root has an
observed terminal record; otherwise it contains the exact ordered bound-root
identities for planned roots that were never acquired. The observed terminal
roots and this absent-root array must be disjoint and together cover every
planned ordinal exactly once. An absent entry is an identity-bound observation
of non-acquisition, not a fabricated PID or cleanup claim. `loopbackPort` is a
private nonzero `u16` recorded with each acquired root and compared across CAS
observations; it is a listener detail and never ownership or terminal-proof
evidence by itself. `exitCode` is optional and sanitized; raw command lines,
environment, source paths, bearer tokens, OCR, model bytes, user names, machine
names, and arbitrary diagnostics are forbidden.

The field constraints are normative: `schemaVersion` is the literal
`RuntimeSessionJournalV1`; `producer`, `state`, binding `kind`, root `role`,
root `state`, and Job `setupState` are closed enums; `setupState` is `pending`
until the unnamed Job is configured and durably bound, then `committed` before
any root is resumed; `bindingAttemptId`, `groupRefDigest`, `rootRefDigest`,
`planDigest`, `activationReceiptDigest`, and every other digest/identity field
are lowercase SHA-256 or producer-issued opaque values as their type declares;
`sessionNonce`, `jobNonce`, `rootNonce`, and listener identities are 128-bit
random values or opaque native bindings; `groupGeneration` and
`rootGeneration` are immutable unsigned binding generations;
`journalRevision`, `recoveryEpoch`, and `attempt` are mutable unsigned
counters, with `attempt` in `0..=3`; timestamps are UTC RFC 3339 strings;
`pid` is a positive Windows process id; `creationIdentity` is the native
creation-time value captured at launch and is compared exactly; and
`loopbackPort` is an integer from 1 through 65535. `rootDigest` is lowercase
SHA-256 over the producer-resolved run-staging identity, not a source path.
`state` is one of `planned_unbound`, `prepared_bound`, `ready`, `launching`,
`running`, `closing`, `terminal`, `reconcile-required`, or `manual-review`;
`manual-review` is a blocked, nonterminal state. The `unbound` binding has no
receipt or root bindings; the `bound` binding has a complete ordered binding
set and receipt. Proof booleans may be true only after the corresponding
binding has been checked. The JSON example uses opaque placeholders to avoid
recording real identifiers; an implementation must validate these types and
closed values before accepting a journal.
The concrete `RootRole` vocabulary is owned by the producer's immutable root
plan. The current private value foundation has no authoritative role enum, so
it preserves and compares the producer-supplied role exactly and rejects empty
roles; production lifecycle wiring must validate the resolved closed
vocabulary at that plan owner rather than inventing an allowlist here.

For example, the terminal proof shape is closed and explicit even when no
planned root was left unacquired:

```json
{
  "rootReaped": true,
  "descendantsTerminated": true,
  "listenersReleased": true,
  "stagingReleased": true,
  "proofGeneration": 8,
  "unacquiredRootBindings": []
}
```

The producer rejects a missing array, unordered or duplicate absent entries,
overlap with observed roots, and any partition that does not cover the complete
ordered binding. The value foundation records this relation; later durable
observe-only code supplies the native evidence that justifies each proof.

The cleanup policy is also fixed: one recovery epoch receives at most three
identity-scoped automatic reconciliation attempts within a 60-second monotonic
budget (specified; not yet wired in production — see Implementation status). A
reconciliation attempt is one producer-observed timeout, failed
proof, or complete proof. With expected
`{state: "reconcile-required", journalRevision: J, attempt: A, recoveryEpoch: E}`,
the writer increments `attempt` and `journalRevision` together in the same CAS
record (transition foundation implemented; no production restart driver — see
status banner). The immutable group/root generations and binding-attempt identity do
not change. A complete observe-only proof may transition to `terminal` with
`{attempt: A + 1, journalRevision: J + 1, recoveryEpoch: E}`. A timeout or failed
proof may remain `reconcile-required` with the same binding while `A + 1 < 3`;
the third timeout or failed proof must transition to `manual-review` with
`attempt: 3` and `journalRevision: J + 1`. Thus `reconcile-required -> terminal`
is possible only on a later complete observe-only proof, never on timeout,
failure, stale data, or a boolean-only claim. A timeout or third failed
automatic attempt transitions to `manual-review`, remains promotion-blocked,
and never pretends to be terminal or starts a replacement root (specified; not
yet wired in production — see Implementation status). A terminal `proof` must
contain `rootReaped`, `descendantsTerminated`, `listenersReleased`,
`stagingReleased`, and the committed `proofGeneration`, all true and tied to
the same session/root nonces. A boolean without matching identity evidence is
invalid proof.

`manual-review` is a blocked nonterminal state. It has no automatic recovery
and cannot transition directly to `terminal`, `launching`, `running`, or
`closing`. Only an explicitly producer-authorized operator recovery may move
it to `reconcile-required` (specified; not yet wired in production — see status
banner): the recovery record must carry a fresh opaque
`recoveryNonce`, a durable `recoveryAuthorizationDigest`, and expected
`{state: "manual-review", journalRevision: J, attempt: 3, recoveryEpoch: E}`. That
CAS increments `journalRevision` and `recoveryEpoch`, resets `attempt` to
`0`, and records no resource mutation. Immutable group/root generations and
the binding-attempt identity remain unchanged. The recovery operation cannot launch a
replacement, terminate a process, delete staging, or claim terminal proof;
the next automatic attempt must still pass the full observe-only checks. A
stale, reused, or missing recovery receipt leaves `manual-review` unchanged.
After another three timed/failed attempts, the record returns to
`manual-review` under the same rules. There is no direct `manual-review ->
terminal` path.

The focused journal regression set includes
`reconcile_attempt_and_revision_increment_atomically`,
`reconcile_rejects_stale_state_generation_attempt_or_epoch`,
`reconcile_failure_attempt_three_enters_manual_review`,
`reconcile_complete_observe_only_proof_to_terminal`,
`manual_review_requires_explicit_recovery_receipt`, and
`manual_review_recovery_resets_attempt_window_without_resource_mutation`.
The tests assert the exact expected state, immutable binding generations,
`journalRevision`, attempt, and recovery epoch on every compare-and-swap; they
also assert that an attempt cannot increment one mutable counter without the
other and can never mutate a group/root generation.

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
proof, and the root/session nonces. Its live R3 `close` path may close
only that live session: it requests termination through the private Job handle,
reaps the roots and descendants, checks each reserved listener identity and
post-resume live-readiness identity, checks staging bindings, and commits
terminal proof. Legacy `terminate_and_prove` supplies native cleanup proof only;
it does not commit R3 Terminal or release verified staging.
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` remains enabled for normal
close, crash, and handle-loss cleanup; no named takeover or weakened cleanup
path is permitted. A successful activation consumes the prepared value and
returns one `GroupLease` carrying a private one-use live lease token. The token
is invalidated on close, cancellation, readiness failure, or lease drop; a
replayed token or a second close cannot operate on the group.

After a producer restart, the observer has only the committed journal. It has
no Job handle, no live membership query, and no right to claim or adopt the old
Job or any recorded nonce. Restart reconciliation is therefore observe-only
(specified; not yet wired in production — see Implementation status).
It may terminalize a stale record and remove only that record's exact
run-scoped staging (specified; not yet wired in production — see Implementation status)
when, and only when, the journal has a trustworthy committed
Job setup, every root's exact PID plus process-creation identity is absent (not
reused and not unqueryable), every recorded listener is proven absent, and the
staging binding resolves inside the same producer-owned run scope. It never
terminates a process during this observe-only path.

If a PID is reused, present, or unqueryable; a listener is ambiguous; a root or
staging identity mismatches; the Job setup was not durably committed; or any
other binding is unknown, the whole session becomes `reconcile-required`
(specified; not yet wired in production — see Implementation status), the
observer touches nothing, and promotion is blocked. No process-name, PID-only,
or port-only kill is ever valid. For a multi-root group, all roots must satisfy
the observe-only rule before the group may terminalize or its exact staging may
be removed; one ambiguous root blocks the entire group.

### Atomic transitions and reconciler

Only the producer writer may transition a journal. The exhaustive specified
transition graph is (restart and no-resource recovery transitions are not yet
wired in production — see Implementation status):

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

Every transition carries expected `state`, `journalRevision`, `attempt`, and
`recoveryEpoch`; bound transitions also carry the complete plan/group/root
reference, immutable generation, binding-attempt, and `activationReceiptDigest`
tuple. The writer rejects any mismatch
and never merges concurrent updates. A later `reconcile-required -> terminal`
requires a complete, identity-bound observe-only proof, increments `attempt`
and `journalRevision` in the same record, and succeeds only when the expected
CAS matches (transition foundation implemented; no production restart driver —
see Implementation status). A timed or failed attempt increments `attempt` and
`journalRevision` atomically; attempts one and two
remain `reconcile-required`, while attempt three takes the guarded
`reconcile-required -> manual-review` transition (specified; not yet wired in
production — see Implementation status). No automatic transition from
`manual-review` is allowed. A direct `planned_unbound -> terminal` is valid only with
durable proof that no resource could ever have existed: Job setup was not
committed, no root was resumed or launched, no listener was bound, no staging
was acquired, and no resource acquisition was attempted. If any one of those
facts is unknown, the journal must take `planned_unbound -> reconcile-required`
instead. A transition uses compare-and-swap on the expected state,
journalRevision, attempt, recovery epoch, and bound ref tuple, writes a temporary file in the same producer
directory, flushes it,
atomically replaces the journal, and flushes the directory/file according to
the platform adapter. A torn or unknown-revision write is a hard failure;
the previous valid journal is retained. There is no best-effort terminal
state.

On a live R3 close, the producer reads only producer-owned journals and
validates schema, producer, session nonce, state, group/root generations, the
complete group/root ref tuple, private Job handle/membership, root identity, listener binding nonce, and run-scoped
staging nonce before terminating the current group. On producer startup after a
restart it reads only committed journals and performs the observe-only checks
above (specified; not yet wired in production — see Implementation status); it does not
reconstruct, claim, or query Job membership. Exact PID plus
creation identity being absent, listener absence, and an exact staging binding
may permit stale-record terminalization and cleanup of that staging only
(specified; not yet wired in production — see Implementation status). PID
reuse, a present or unqueryable PID, missing creation identity, root/staging
mismatch, Job-setup ambiguity, listener ambiguity, access denial, or malformed
journal sets `reconcile-required` and leaves process/listener/staging in place
(specified; not yet wired in production — see Implementation status).
It never kills by executable name, PID alone, port alone, parent PID alone, or
directory name.

Restart cleanup retry is bounded and identity-scoped (specified; not yet wired
in production — see Implementation status). The producer does not launch a
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
with `OcrGpuCapabilitySnapshot`; its tests are in
`packages/capture-runtime/tests/unit/test_ocr_compute_plan.py`. A focused
regression for a positively unavailable dGPU beside a usable iGPU is still
missing ([#247](https://github.com/gx-capture/capture-workbench/issues/247)); the existing
indeterminate-dGPU test is a separate fail-closed case.

| Snapshot | Selection | Failure/fallback rule |
| --- | --- | --- |
| A usable discrete GPU with complete LUID/ORT mapping | DirectML on the selected dGPU, with exact LUID join and ordinary ORT ordinal | No CPU fallback after selected construction or inference failure |
| No usable dGPU and a usable integrated GPU with complete mapping | DirectML on the selected iGPU | Same terminal failure rule |
| No usable GPU and policy permits CPU notice | CPU with an explicit noticed readiness result | CPU is not a recovery path after a selected GPU failure |
| Probe timeout, exception, unknown adapter, incomplete mapping, or indeterminate state | Indeterminate/unavailable | Do not guess, rank, or persist an ordinal |

This table replaces the earlier adapter-`0` default and the
`CAPTURE_WINDOWSML_DEVICE_ID` host override. The DirectML provider policy,
provenance meaning, and production environment gate are in
[gpu-ocr-directml.md](gpu-ocr-directml.md).

## Acceptance and evidence contract

Gate names used below: D2 schemas, codecs and synthetic cases only; D3
candidate built (immutable byte ledger); D4 candidate accepted; D5 published
without rebuilding; D6 public bytes downloaded back and re-hashed; D7 published
bytes accepted; D8 stable pointer moved. The
[release runbook](../GUIDES/release-runbook.md) owns the procedure.

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

This is one producer-owned `ProducerAcceptanceContractV1`
(`@capture-runtime/acceptance-contract`). Today
`packages/capture-acceptance-contract` holds the four schemas
(`schemas/producer-child-scope-v1`, `producer-child-invocation-v1`,
`consumer-semantic-result-v1`, `acceptance-child-wire-v1`, each
`.schema.json`) and `src/codecs.ts`, exercised by
`tools/three-project-acceptance.test.ts`. The runner itself still writes
manifests through `tools/acceptance-contract.ts`. The generated bundle, hash
and manifest modules described below are not built; whether to finish or remove
them is [#257](https://github.com/gx-capture/capture-workbench/issues/257).

`schemas/*.schema.json` are the schema owners; `src/codecs.ts` owns strict
codecs; `src/export.ts` and `src/index.ts` own the public package exports;
`src/canonical-json.ts`, `src/manifest.ts`, and `src/hash.ts` own canonical
serialization, semantic manifest construction, and digest domains;
`tools/generate.ts` creates generated schema/codec material and
`tools/create-bundle.ts` creates the external archive; `package.json` and
`project.json` own package metadata and the Nx delivery target. The package
root, its Nx project, and these owner files do not exist at this checkpoint;
their exact creation is a D2 discovery/creation stop. D2 may add only the
schemas, codecs, and synthetic RED cases after that stop. D3 is the first gate
that runs the generator, emits the immutable package/bundle and semantic
manifest, computes their hashes, and records them in one candidate ledger. D6
downloads and hashes those exact public bytes before D7.

Its immutable contract version is `"1"`. The semantic manifest entry set is a
canonical, ordered set of `{ path, byteLength, sha256 }` entries for the
contract's schema/codec/export/canonical-json files; it excludes the manifest
file itself, any hash file, generated archive, and delivery metadata. Each
entry digest is SHA-256 of the exact file bytes. `contractSha256` is SHA-256 of
the canonical compact UTF-8 bytes of that semantic manifest, not of the package
archive and not of a manifest containing its own digest. No generated
standalone hash file or embedded self-hash is permitted. D3 records the
literal `contractSha256` plus a separate external
`acceptanceContractArchiveSha256` for the exact archive bytes; D4 binds both to
the candidate ledger. D6 recomputes `contractSha256` from the downloaded
manifest and separately hashes the downloaded archive, requiring equality to
the D3 values; D7 binds the D6 values. This acceptance-contract identity is
distinct from the runtime contract-set identity (`contractSetVersion: "2"`,
`contractSetSha256` in `packages/capture-runtime-client/package.json`);
the two hashes must never be compared as if they were one contract. Cert and
LAW consume only the exact generated package bytes and literal hash from D3/D6;
they do not copy schemas, restate names/fields, or define local validators.
At this checkpoint `tools/acceptance-contract.ts` is only the existing
consumer adapter: its `writeAcceptanceManifest` and
`readAcceptanceManifestTolerant` paths may import the canonical package later,
but they are not schema, codec, generator, manifest, or hash authority.

The digest DAG is exact and acyclic:

| Digest | Domain | May not include or substitute |
| --- | --- | --- |
| entry `sha256` | Exact bytes of one listed schema/codec/export/canonical-json file | Manifest bytes, archive bytes, paths encoded as content, or a self-entry |
| `contractSha256` | Canonical compact UTF-8 bytes of `contract-manifest.json` whose entry set excludes the manifest, hash file, archive, and delivery metadata | The archive, runtime `contractSetSha256`, or an embedded self-hash field |
| `acceptanceContractArchiveSha256` | Exact external archive/bundle bytes emitted by `tools/create-bundle.ts` | `contractSha256`, a source tree, mutable URL, or a hash file embedded in the archive |
| D3/D6 ledger digest | Canonical bytes of that gate's immutable ledger | A later acceptance result or mutable publication pointer |
| media/oracle digest | Exact private media bytes or canonical normalized oracle bytes | A path, decoded/re-encoded media, raw truth in evidence, or an anchor-only substitute |
| invocation/result/wire digest | Canonical record bytes with only that record's own self-digest field omitted | Scope nesting, producer cleanup invented by a consumer, or another record's digest |
| runtime `contractSetSha256` | Existing generated runtime contract-set bytes | Acceptance package/manifest/archive identity |

D3 is therefore the parent of the acceptance-package artifact and its ledger;
D4 consumes those exact D3 bytes and digests; D5 publishes them without
rebuilding; D6 downloads and independently hashes them; and D7 consumes only
the D6 ledger. D2 has no package/archive/hash-delivery edge, D3 has no
acceptance-consumer edge that reconstructs its inputs, and no later gate points
back to D2 or D3. No digest domain contains a later result that would make the
graph cyclic.

There is exactly one writer for each record and exactly one serial producer
flow. The paths below are distinct, producer-scoped transport records:

| Record | Owner, mutability, path | Visibility and order |
| --- | --- | --- |
| `ProducerChildScopeV1` | Producer only; mutable until the child is closed; `CAPTURE_ACCEPTANCE_SCOPE_PATH` | State-discriminated: `planned` has only child/plan identity; `prepared` adds the complete ordered `rootBindings` and immutable generations; `ready` adds the verified invocation digest. The ready scope is not nested in the invocation and is never sent to the child. |
| `ProducerChildInvocationV1` | Producer only; immutable after freeze; `CAPTURE_ACCEPTANCE_INVOCATION_PATH` or an equivalent read-only handle/pipe transport | The producer publishes the canonical input before launch. The child receives only this frozen read-only transport, its digest, and complete ordered `rootBindings`; it never receives scope or wire. |
| `ConsumerSemanticResultV1` | The current child only; write-once; separate `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH` | The child writes one complete semantic result after its assertion. The producer reads and validates it; a second write, overwrite, or partial record fails closed. |
| `AcceptanceChildWireV1` | Producer only; immutable after cleanup; `CAPTURE_ACCEPTANCE_WIRE_PATH` | The producer validates the result, completes cleanup, and only then emits the wire. The child never receives or writes this path. |

The producer flow is: (1) create the scope and durably record its `planned`
variant, which has only child/plan identity; (2) call `prepare_group(plan, sink)`
with the complete immutable plan, journal `planned_unbound`, persist/read back/
verify the complete group/per-root receipt through the sink by
`bindingAttemptId`, write `prepared_bound`, and construct the permit inside the
opaque `PreparedGroup`; (3) derive
a `ProducerChildInvocationV1` from that immutable plan and its capability
assignments; (4) compute its self-excluded canonical digest before writing the
final bytes, write those exact bytes to a secure same-directory temporary,
flush and close the temporary, publish the final invocation with atomic
create-new semantics, reopen it read-only to verify canonical bytes and digest,
then freeze/apply its ACL; (5) update the scope to `ready` with the verified
invocation digest and complete `rootBindings`, then call
`activate_group(prepared)`, which assigns and verifies every root suspended,
CASes `launching` before resume, and returns one use-once lease only after live
readiness; (6) pass only the
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
identity and an `unbound` binding; it has no root, reconcile ref, generation,
invocation digest, output path nonce, result digest, or wire digest. The
`prepared` variant adds one complete producer-bound group/root binding set and
its receipt. The `ready` variant adds the verified invocation digest and output
path nonce. The `ready` scope is a producer-side state record, not a nested
object in `ProducerChildInvocationV1`:

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
    binding: { kind: "unbound" },
  }
  | PreparedScope {
    ...PlannedScope,
    readyState: "prepared",
    bindingAttemptId: BindingAttemptId,
    groupRefDigest: Sha256,
    groupGeneration: u64,
    rootBindings: [
      { ordinal, role, rootRefDigest, rootGeneration, specDigest,
        reservedListenerIdentity }
    ],
    activationReceiptDigest: Sha256,
  }
  | ReadyScope {
    ...PreparedScope,
    readyState: "ready",
    invocationSha256: Sha256,
    outputPathNonce: OpaqueNonce,
  }
```

The producer writes the variants in order with a CAS over child/plan identity,
scope revision, and the complete applicable binding tuple. A `planned` scope
cannot carry a root/ref, generation, receipt, or invocation field, and a
`prepared` scope cannot be sent to a child; only `ready` may be used after
invocation publication/reopen verification. `rootBindings` is always the
complete ordered group set, never the current child root alone. The scope may
retain private resolved paths and capability handles in memory, but neither is
serialized into a child wire or exposed as a raw path/text value to the child.
The producer must not put any child-result or wire digest in any scope variant
before the child runs. The invocation contains the scalar scope identity and
its own complete `rootBindings`, never a nested `ProducerChildScopeV1` object
or its mutable `ready` record.

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
frozen input state, child/sequence identity, and exactly one of the two
immutable binding forms: D4 input bound to the D3 candidate ledger, or D7 input
bound to the D6 download/publication ledger. It also has predecessor
cleanup-proof digests, the complete ordered group/root `rootBindings` and
immutable generations, one ordered `fixtureAssignments[]` array, a separate
output path nonce, and its self-excluded invocation digest. It never nests or
serializes the mutable `ProducerChildScopeV1` (including the scope's `ready`
variant). Its fixture capability values are opaque handles, never source paths
or raw truth:

```json
{
  "schemaVersion": "ProducerChildInvocationV1",
  "contractVersion": "1",
  "contractSha256": "<D3-bound-producer-contract-sha256>",
  "producer": "capture-runtime",
  "parentGate": "D4",
  "tier": "candidate",
  "invocationState": "frozen",
  "sequenceIndex": 1,
  "childKey": "capture-private-jpeg",
  "legId": "capture-private-jpeg-v1",
  "childId": "<sha256-lower-hex>",
  "root": "<sha256-lower-hex>",
  "groupRefDigest": "<sha256-lower-hex>",
  "groupGeneration": 4,
  "bindingAttemptId": "binding-attempt-opaque-id",
  "rootBindings": [{
    "ordinal": 0,
    "role": "capture",
    "rootRefDigest": "<sha256-lower-hex>",
    "rootGeneration": 1,
    "specDigest": "<sha256-lower-hex>",
    "reservedListenerIdentity": "opaque-reservation-identity"
  }],
  "activationReceiptDigest": "<sha256-lower-hex>",
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

Capability lifetime and audience are normative. A media or oracle capability
is producer-issued for exactly one child/leg, one gate (`D4` or `D7`), and one
invocation. Its audience is the named consumer child, not the host, another
product, another leg, a retry, or a later gate. The resolver atomically marks a
capability consumed on its first successful open; a second open, replayed
invocation, or copied handle is rejected and requires a newly bound child
identity. The producer durably revokes a capability before launch on cancel,
identity mismatch, failed freeze/activation, or failed cleanup, and revokes it
at child close; expiry, revocation, or a terminal/reconcile transition makes
the handle unusable. Revocation cannot be bypassed by reopening a path or
reconstructing a handle from a digest. Raw handle values, media, truth, paths,
tokens, PIDs, and native diagnostics are never logged or persisted outside the
private invocation/resolver store; logs, errors, reports, and wires may contain
only capability digests and sanitized reason codes. A missing lifetime,
audience, single-use, revocation, or log prohibition is a fail-closed contract
failure.

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
`runAcceptanceSequence` is the only runner; there is no standalone JPEG
coordinator.

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
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts:serializePrivacySafeOcrSemanticEvidence` /
`OCR_NORMALIZATION_VERSION`, and the actual acceptance artifact owner
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/acceptance-artifacts.mts:writeAcceptanceManifest`,
`sanitizeAcceptanceFixtureMetadata`, `collectAcceptanceArtifactInputs`, and
`redact`, plus
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/acceptance-artifacts.test.mts`.
The exact LAW seams are
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/reading/application/EvidenceTextExtractionService.java:EvidenceTextExtractionService`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/support/acceptance-expectations.ts:loadLawAcceptanceExpectation`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/support/acceptance-artifacts.ts:createAcceptanceRun`,
`writeAcceptanceManifest`, and `redact`, the contract owner
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/local-package/acceptance-artifacts.contract.mts`,
and the real runner
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/scripts/acceptance-real.mts`.
LAW's current capability/fixture owners are
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/support/evidence-workbench.scenario-types.ts:createDefaultFixtureBundle`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/local-package/evidence-workbench.real.acceptance.spec.ts`,
and `${GX_LAW_PREP_CHECKOUT}/apps/law-prep-ai-service/src/app/ocr/service.py:OcrExtractionService.extract`.
These are migration seams, not claims that Cert or LAW already emit the
producer records.

Any schema, producer, sequence/leg/child/root/artifact, candidate/D3/D6
root/id/digest, media/truth digest, normalization, distance, threshold,
raw-byte, semantic-result, or cleanup-proof mismatch fails closed: emit no
evidence, do not promote, and retain only the sanitized failure record.

## Version, schema, projection, and release-channel inventory

`tools/release/version-sources.ts` (`collectReleaseVersionEntries()`, tested
by `capture-tools:release-version-test` and run by
`capture-tools:release-version-check`) inventories every version, schema,
projection and contract identity. `release/version.json` is the release
intent; the runbook describes the version workflow.

The release channels are distinct and each is represented in the candidate and
release manifests: npm on GitHub Packages (`npm-github-packages`: the Workbench
UI and the TypeScript runtime client), PyPI (`pypi`: the Python runtime
client), crates.io (`crates-io`: `capture-sidecar-launcher`), and GitHub
Releases (`github-releases`: runtime, engine and desktop assets and the
immutable release manifests). Their only publication owners are
`_publish-npm.yml`, `_publish-pypi.yml`, `_publish-crates.yml`,
`_publish-github-release.yml`, `_publish-runtime-github-release.yml` and
`_verify-registries.yml`, orchestrated by `release-promote.yml`; the stable
pointer is moved only by `_publish-stable-pointer.yml`. No local script or
consumer may mutate it.
