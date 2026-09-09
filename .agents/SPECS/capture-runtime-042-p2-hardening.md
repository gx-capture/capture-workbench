# Capture Runtime 0.4.2 Phase 2 hardening (canonical design)

Status: canonical Phase 2 policy and acceptance source. `D0 DocsCommitted` is
complete for the commit that contains this documentation correction. The exact
commit id is intentionally not written here: external review binds the result
with `git rev-parse HEAD` after the commit. `D1 DesignReviewed` is pending a
fresh Standards and Specification review at that exact head. This document is
design and delivery policy; it does not authorize implementation, packaging,
publication, or stable-pointer mutation.

## Current checkpoint: 2026-09-09

- This closure starts from expected HEAD
  `586423c1c7faa213b68a6f53ee346ac8035e5723`. The only pre-existing working
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
| `packages/capture-sidecar-launcher/src/process.rs` | `OwnedRuntimeSession`, `OwnedRuntimeSessionState`, `RuntimeTerminationProof`, and `RuntimeCleanupError` | `src/launcher.rs` (`LaunchedSidecar`, `launch_sidecar`, `launch_sidecar_with_observer`), `src/lib.rs` public exports, desktop Tauri `src/state.rs` (`OwnedRuntime` and cleanup/monitor paths), desktop Tauri `src/launcher.rs` (`LaunchedRuntime`), and desktop `src/commands.rs` shutdown path |
| `packages/capture-sidecar-launcher/src/launcher.rs` | `SidecarLaunchSpec`, `LaunchOptions`, `LaunchedSidecar`, readiness/retry/observer launchers | `capture-sidecar-launcher:cargo-fmt-check`, `cargo-check`, `cargo-test`, plus desktop launcher integration |
| `tools/release/version-sources.ts` | `collectReleaseVersionEntries()` and its existing version-source inventory | `tools/release/version-sources.test.ts`, target `capture-tools:release-version-test`; first implementation slice owns the inventory extension and Nx upgrade |
| `tools/three-project-acceptance.ts` | `runAcceptanceSequence`, `runCaptureWorkbenchAcceptance`, `validateChildManifest`, `validateTerminalManifest` | `tools/acceptance-contract.ts:writeAcceptanceManifest`, desktop `acceptance-three-projects`, and consumer assertion adapters |

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
| Candidate/release | The manifest binds exact source HEAD, version, artifact bytes, runtime/worker/model/profile/catalog hashes, schema versions, and contract hash. Every consumer uses those bytes, not a source tree or mutable URL. |
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
producer.reconcile(key) -> ReconcileResult
producer.close(key, root) -> RootProof
```

Usage gives the host only opaque keys and semantic observations:

```text
key = journal.open(plan)
root = producer.launch(key, spec)
producer.close(key, root)
```

The hidden implementation makes the journal the primary state machine and
reconstructs native identity from PID, creation identity, nonce, Job, listener,
and staging bindings. Dependencies are the durable journal writer, native
adapter, and a startup reconciler; a fake journal/native adapter tests crashes.
The trade-off is strongest crash recovery and explicit durable evidence, but
the journal becomes a high-churn protocol and still needs a group relationship
for multi-root consumers. The deletion surface is current desktop state
ownership and ad hoc cleanup ledgers. Tests must include torn writes, replay,
identity mismatch, and stale journal retention as well as process behavior.

#### Alternative R3: producer-owned group/session (chosen shape)

Interface shape:

```text
OwnedRuntimeSession::open(plan) -> Result<OwnedRuntimeSession, LaunchError>
session.start_one(spec) -> Result<RootLease, LaunchError>
session.start_root(role, spec) -> Result<RootLease, LaunchError>
session.observe(root) -> Result<RuntimeObservation, LifecycleError>
session.close_root(root, reason) -> Result<RootProof, CleanupError>
session.close_group(reason) -> Result<GroupProof, CleanupError>
```

`start_one` is the one-root convenience; `start_root` lets a producer put the
Capture, Python, and Java roots used by LAW in one producer-owned Job/group.
Capture, Cert, and candidate journeys continue to use one root. A `RootLease`
is an opaque semantic lease; no raw `Job`, process handle, PID, native error,
or child object crosses the seam.

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
Tests cover one-root compatibility, multi-root atomic group close, partial
launch, root crash, descendant escape, listener/staging proof, baseline
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

## RuntimeSessionJournalV1 and reconciliation

The journal is a producer-owned durable cleanup record, not host/domain state.
It exists to make crash recovery fail closed. Tauri never creates, writes,
mutates, deletes, or reconciles it, and Tauri never owns or mutates a Job.

### Schema

The file is one JSON object written under a producer-owned run directory. Its
schema is exactly versioned as `RuntimeSessionJournalV1`:

```json
{
  "schemaVersion": "RuntimeSessionJournalV1",
  "producer": "capture-runtime",
  "sessionNonce": "128-bit-random-opaque-nonce",
  "generation": 4,
  "state": "running",
  "createdAt": "2026-09-09T00:00:00Z",
  "updatedAt": "2026-09-09T00:00:02Z",
  "jobBinding": { "setupState": "committed", "jobNonce": "opaque-native-binding" },
  "stagingBinding": {
    "runNonce": "same-session-nonce",
    "rootDigest": "sha256:...",
    "scope": "run"
  },
  "roots": [
    {
      "role": "capture",
      "rootNonce": "128-bit-random-opaque-nonce",
      "pid": 1234,
      "creationIdentity": { "kind": "windows-process-creation", "value": "opaque-native-value" },
      "state": "running",
      "listenerBindings": [
        { "kind": "sidecar-http", "loopbackPort": 43123, "bindingNonce": "opaque-listener-binding" }
      ],
      "startedAt": "2026-09-09T00:00:01Z"
    }
  ],
  "proof": null,
  "attempt": 1
}
```

Required fields are the schema version, producer, session nonce, monotonic
generation, state, timestamps, Job binding, staging binding, and one record per
root. The Job binding records whether setup was durably committed before a root
was resumed. Every root records role, root nonce, PID, process creation
identity, state, listener bindings, and start time. A terminal record adds
semantic proof:
root reaped, descendants terminated, listeners released, staging released, and
the proof generation. `exitCode` is optional and sanitized; raw command lines,
environment, source paths, bearer tokens, OCR, model bytes, user names, machine
names, and arbitrary diagnostics are forbidden.

The field constraints are normative: `schemaVersion` is the literal
`RuntimeSessionJournalV1`; `producer`, `state`, root `role`, and Job
`setupState` are closed enums; `setupState` is `pending` until the unnamed Job
is configured and durably bound, then `committed` before any root is resumed;
`sessionNonce`, `jobNonce`, `rootNonce`, and every `bindingNonce` are 128-bit
random values encoded as lowercase hexadecimal; `generation` and `attempt` are
positive unsigned integers; timestamps are UTC RFC 3339 strings; `pid` is a
positive Windows process id; `creationIdentity` is the native creation-time
value captured at launch and is compared exactly; and `loopbackPort` is an
integer from 1 through 65535. `rootDigest` is lowercase SHA-256 over the
producer-resolved run-staging identity, not a source path. `state` is one of
`planned`, `launching`, `running`, `closing`, `terminal`, or
`reconcile-required`; proof booleans may be true only after the corresponding
binding has been checked. The JSON example uses opaque placeholders to avoid
recording real identifiers; an implementation must validate these types and
closed values before accepting a journal.

The cleanup policy is also fixed: one journal generation receives at most three
identity-scoped reconciliation attempts within a 60-second monotonic budget.
Each attempt increments `attempt` atomically; a timeout or third failed attempt
transitions to `reconcile-required` and does not start a replacement root. A
terminal `proof` must contain `rootReaped`, `descendantsTerminated`,
`listenersReleased`, `stagingReleased`, and the committed `proofGeneration`,
all true and tied to the same session/root nonces. A boolean without matching
identity evidence is invalid proof.

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

Only the producer writer may transition a journal. Valid transitions are
`planned -> launching -> running -> closing -> terminal` and
`launching|running|closing -> reconcile-required`. A transition uses
compare-and-swap on the expected generation and state, writes a temporary file
in the same producer directory, flushes it, atomically replaces the journal,
and flushes the directory/file according to the platform adapter. A torn or
unknown-generation write is a hard failure; the previous valid journal is
retained. There is no best-effort terminal state.

On a live producer close, the reconciler reads only producer-owned journals and
validates schema, producer, session nonce, state, generation, private Job
handle/membership, root identity, listener binding nonce, and run-scoped
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
fixture/page as normalized edit distance divided by the expected character
count; results are not averaged across pages, fixtures, or products. Every
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
cleanup failure. It records a child manifest and an overall terminal manifest
only after the child’s journal reaches terminal proof. `tools/three-project-
acceptance.ts` owns sequence orchestration and
`tools/acceptance-contract.ts:writeAcceptanceManifest` owns manifest shape;
the installed app and consumer assertion adapters are production seams.

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
| D3 | `CandidateBuilt`: consumes D2 authorization and the exact implementation source. | Immutable candidate bytes, manifest, source/version/schema/contract/model hashes, and byte ledger |
| D4 | `CandidateAccepted`: consumes only the D3 candidate bytes. | Sequential real acceptance manifest, per-fixture CER/anchor results, cleanup/journal proofs, and candidate identity ledger |
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
