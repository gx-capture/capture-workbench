# Capture Runtime 0.4.2 Phase 2 hardening (canonical design)

Status: design-only. This file is the canonical Phase 2 policy and acceptance
source for a fresh worker. It does not grant implementation, candidate,
release, or publication authority. The DECISION, TODO, and GUIDE link here;
they do not restate this policy.

## Current checkpoint: 2026-09-09

- PR #39 is at `c6d2140e233de70734005713427f77f92414f415`; its deterministic CI
  is green, but the PR is not merged.
- Phase 1 is **complete at the local-probe tier**: all three projects passed
  real local-package OCR in the ordered Capture -> Cert -> LAW sequence. This
  is not published/release evidence and does not mean an official `0.4.2`
  package exists.
- No current-HEAD Phase 2 real JPEG OCR, PDF page-1 OCR, GPU proof, or cleanup
  evidence is recorded here. There is no immutable candidate and no published
  `0.4.2`. PR #39 and current heads are engineering/release freshness facts;
  they do not negate Phase 1 completion.
- This task edits the four canonical Phase 2 documents and may add only the
  narrowly scoped historical banners named in the TODO. Phase 2 entry is
  allowed at documentation/design/review; implementation slices follow the
  recorded TODO gates.

The exact implementation-slice gate is: current-HEAD design review by Standards and
Specification axes, the serious grill questions resolved one at a time, an
authorized small vertical slice, and a fresh worker/checkpoint. Until then, do
not write feature code, run a model-enabled journey, build a candidate, publish
an artifact, or alter Cert/Law. A green deterministic CI run is not real OCR,
GPU, cleanup, install, or release evidence.

## Purpose and non-goals

Phase 2 hardens the existing OCR-only producer after the completed Phase 1
local-probe checkpoint. Phase 1 accepted real local-package OCR in the ordered
Capture -> Cert -> LAW sequence; that local tier does not imply published or
release evidence. Phase 2 concentrates policy, provenance, process ownership,
measurements, and acceptance evidence behind deep modules while preserving the
current public contracts.

Non-goals:

- Never read or arbitrate embedded PDF text. PDFium rasterizes PDF pages and
  PaddleOCR is the only extraction source; embedded text is ignored.
- Do not add hybrid, embedded, LLM-routed, host-specific, or language-selected
  OCR paths. Do not expose Paddle kwargs, model paths, process handles, device
  indexes, or private diagnostics to hosts.
- Do not change Cert Prep or GX Law Prep source from this repository, and do
  not add consumer-specific producer policy.
- Do not treat package QA, fake OCR, snapshots, screenshots, or a successful
  exit code as formal installed or published acceptance. Local-package OCR may
  establish the completed Phase 1 local-probe tier, but it is not release proof.
- Do not optimize before a reproducible baseline. Do not retry CPU after a
  selected DirectML construction or inference failure.
- Do not delete user/unknown files, rewrite shared history, push, merge,
  release, or move a stable pointer in a documentation checkpoint.

## Change mode and supersession

Change mode: **mixed**.

| Decision | Rule for this Phase 2 design |
| --- | --- |
| Edit | Edit the four existing owner files: this SPEC, its DECISION, its TODO, and the staged OCR delivery GUIDE. Preserve their stable paths. |
| Delete/supersede | Name obsolete policy and documents as candidates below. A later implementation worker may remove them only after ownership, replacement tests, and an additive commit are proven. The only historical edits in this checkpoint are the banners listed in the TODO. |
| Create | Create a file only when no existing owner can hold the lifecycle or seam. A new module, schema, fixture, or command requires a separate authorized vertical slice. |

### Supersession map

| Candidate to retire or supersede | Canonical replacement | When deletion is allowed |
| --- | --- | --- |
| Default adapter `0` and `CAPTURE_WINDOWSML_DEVICE_ID` policy in old GPU notes | The GPU truth table in this SPEC and runtime-owned `OcrComputePlan` | After residual scan, red tests, and a replacement commit prove no caller derives or persists an ordinal. |
| `pdf-embedded-text`, embedded-only, and hybrid extraction paths | `OcrPipeline` PDFium-raster-to-Paddle path | After page-complete projection tests and deletion test pass. See [P1 OCR](../SPECS/capture-runtime-042-p1-ocr-and-lifecycle.md) and [PDF OCR-only](../SPECS/pdf-ocr-only-extraction.md). |
| v0.3/v0.4.1 runtime, worker, SDK, lock, catalog, or manifest literals | One generated version inventory and `version-check` command | After the inventory generates every owned value and strict stale-literal checks are green. Never mix 0.4.1 and 0.4.2. |
| Duplicate session-status, host process-cleanup, `taskkill`/name-kill, and parallel lifecycle helpers | `OwnedRuntimeSession` plus its semantic host adapters | After normal-close, failure, crash, termination, descendant, baseline, and next-start tests pass. |
| Acceptance runners that independently build/install/scope events/cleanup | Producer-owned `AcceptanceRunner` | After the canonical runner proves the same installed boundary and sequential semaphore. |

These are candidates, not permission to edit those files now. Existing P1,
PDF, acceptance, and contract documents remain historical/contextual owners
until a named supersession commit updates them. Their constraints
are [P1 OCR and lifecycle](../SPECS/capture-runtime-042-p1-ocr-and-lifecycle.md),
[P1 compute preflight](../SPECS/capture-runtime-042-p1-ocr-compute-preflight.md),
[PDF OCR-only](../SPECS/pdf-ocr-only-extraction.md),
[real OCR acceptance](../SPECS/real-ocr-result-acceptance.md),
[contract set](../SPECS/runtime-contract-set-client-sdks-hard-cut.md), and
[packaged import boundary](../SPECS/packaged-ocr-import-boundary.md).

## Responsibility map

The producer is the only owner of runtime policy and execution truth.

| Responsibility | Producer (`capture-runtime` / desktop harness) | Cert Prep and GX Law Prep hosts |
| --- | --- | --- |
| OCR | Owns `OcrPipeline`, PDFium rasterization, Paddle profile, normalization, page order, confidence, provenance, and typed failures. | Call the public capture/ocr seam through an adapter. Never create Paddle or choose a route. |
| Compute | Owns `OcrComputePlan` and GPU truth; `OcrComputePreflightV2` is a projection, not a host policy. | Render the existing readiness/notice; never probe, rank, select, or persist GPU indexes. |
| Model identity | Owns `ModelSourceSnapshot` and model/profile/catalog hashes. | Persist only domain records needed by the host; no model path or private token. |
| Process lifecycle | Owns `OwnedRuntimeSession`, Job/descendant cleanup, failure proof, and reconciliation. | Request graceful close and persist domain state; never hold OS handles or name-kill. |
| Acceptance | Owns `AcceptanceRunner`, installed boundary, fixture scope, evidence, cleanup, and sequence. | Supply consumer-specific domain assertions in their own repositories. |
| Version/release | Owns one version inventory, candidate bytes, manifests, and immutable release identity. | Pin the exact candidate/published bytes and verify before model start. |

Runtime jobs are ephemeral; hosts own durable source and domain persistence.
Durable runtime/model caches are retained, while run-scoped staging and stale
identity-proven state are reconciled by the owner.

## Public contract floor

Phase 2 preserves API `2.0`, `CaptureOcrProjectionV3` schema `3`, existing raw
and structured schema `2`, and the current contract-set identity
`d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40`. The existing
authenticated `GET /v2/captures/{capture_id}/ocr` remains the typed projection
seam. No private device, process, path, token, or performance field is added
to an HTTP route, SDK, public document, or UI property. A public contract
change is a separate design and regeneration decision, never an incidental
hardening change.

The current projection rules remain: every requested page (all pages by
default) is ordered and represented, empty pages are retained, recognized
regions have bounded polygons and scores, failed pages have sanitized typed
failures, and schema-2 raw segments are composed only from the normalized
recognized projection. See the P1 and PDF documents linked above; this SPEC
does not create a second wire policy.

## Phase 2 deep modules

Each module has one external interface. Interface means inputs and results plus
invariants, ordering, typed errors, required configuration, performance and
resource behavior. Internal seams are private test seams; they are not
promoted to callers merely to make tests convenient. The established modules
below have a concrete contract. `OcrPipeline` and `OwnedRuntimeSession` are
deliberately interface-neutral until the Design-It-Twice gate completes.

| Module | Interface state | Dependency category and adapters | Deletion test |
| --- | --- | --- | --- |
| `OcrPipeline` | Candidate interface is not chosen. It must accept the existing source request and return either an ordered page-complete OCR projection or a sanitized typed terminal failure. | In-process normalization and local-substitutable raster/page planning; producer-owned worker is a remote-but-owned adapter; deterministic in-memory behavior is the test adapter. | Removing the module must not scatter PDFium/page policy, Paddle normalization, projection, and failure logic across routes or hosts. |
| `OcrComputePlan` | Concrete selection contract is `select(input) -> immutable OcrComputeSelection`: a compute snapshot in, one immutable selection/readiness result out. | DXGI/D3D12/DirectML is a true external/platform seam with a native production adapter; an immutable in-memory snapshot is the test adapter. | Removing it must not make hosts or worker paths rank devices or derive divergent selections. |
| `ModelSourceSnapshot` | Concrete provenance contract is `capture(source) -> immutable snapshot`: source manifests in, bound runtime/worker/model/profile/catalog/contract hashes out. | Package/filesystem is local-substitutable; catalog/download is a remote-but-owned adapter; an immutable manifest is the test adapter. | Removing it must not scatter hash/provenance checks across runners, workers, and hosts. |
| `OwnedRuntimeSession` | Candidate interface is not chosen. It must accept one launch description and expose semantic lifecycle observation plus one terminal `RuntimeTerminationProof`, without OS handles or process identifiers. | Windows process/Job APIs are a true external seam with a native production adapter and deterministic failure-injection adapter for tests. | Removing it must not leave raw handles, name-kill, or cleanup policy in hosts. |
| `AcceptanceRunner` | Concrete contract is `run(plan) -> AcceptanceManifest`: an acceptance plan in, terminal manifest out only after evidence and cleanup. | Installed executable is remote-but-owned; private app probing is the production adapter; deterministic installed probing is the test adapter. | Removing it must not leave each app duplicating event scope, cleanup, and terminalization. |
| `VersionInventory` | Concrete check/upgrade contract is `check/upgrade(input) -> VersionReport`: one canonical version input in, a complete report or typed stale/mixed-version error out. | Canonical serialization is in-process; repository files are local-substitutable; a generated report is the production artifact and fixture input is the test adapter. | Removing it must not leave hand-edited versions in consumers or manifests. |

#### Interface-neutral records

These two records describe the behaviour that any chosen interface must carry;
they intentionally do not name a method, callback, port, or type signature.

##### `OcrPipeline`

- Inputs/results: the existing capture source request, including source kind
  and page scope, in; an ordered page-complete OCR projection or a sanitized
  typed terminal failure out.
- Invariants/order: image bytes and every selected PDF page are normalized or
  rasterized before worker dispatch; pages remain in source order; empty and
  failed pages remain represented; predictor/model initialization is bounded;
  inference is serialized; no embedded PDF text is read.
- Errors/configuration: unsupported media, malformed page, worker/provider
  failure, cancellation, and incomplete projection are typed and sanitized;
  profile/model/contract identity is required and host-specific Paddle options
  are not accepted.
- Performance/resources: one-page raster and inference buffers are released
  before the next page/app where possible; model initialization is reused only
  within the owned session; memory, latency, and first-page measurements are
  recorded as bounded numeric evidence before optimization.
- Internal seam/adapters: the rasterizer, normalizer, and worker transport stay
  behind private seams; the producer worker is the production adapter and a
  deterministic in-memory engine is the test adapter.
- Deletion test: removing the module must not force routes or hosts to repeat
  page planning, rasterization, normalization, projection, or failure policy.

##### `OwnedRuntimeSession`

- Inputs/results: one producer-owned launch description and semantic close or
  cancellation request in; lifecycle observations and one terminal
  `RuntimeTerminationProof` out, with no OS handle, PID, or raw native error in
  the external interface.
- Invariants/order: create the root suspended, assign it to a fresh
  no-breakaway Job before resume, observe root/descendant events, make finish
  idempotent, and terminalize only after owned descendants/listeners are absent;
  baseline processes survive.
- Errors/configuration: launch, readiness, root-crash, host-termination,
  descendant, timeout, and cleanup failures are typed; retry is bounded and
  identity-scoped; durable runtime/model cache configuration is never treated
  as run-scoped residue.
- Performance/resources: one owned root/session at a time for model journeys;
  bounded event/journal state; native handles and descendant enumeration are
  released at terminalization; reconciliation never broad-kills names.
- Internal seam/adapters: native Windows process/Job operations stay behind a
  private seam; the native launcher is the production adapter and a
  deterministic failure-injection lifecycle adapter is the test adapter.
- Deletion test: removing the module must not leave hosts holding OS handles,
  guessing ownership from names, or duplicating cleanup/reconciliation policy.

### Established-module interface records

The following records are the minimum design record for the established
modules. They name the full interface, not merely a type signature.

#### `OcrComputePlan`

- Inputs/results: an immutable hardware/provider snapshot; an immutable
  `OcrComputeSelection` containing mode, reason, exact LUID join, ordinary ORT
  ordinal, and sanitized readiness notice where applicable.
- Invariants/order: usable dGPU, then usable iGPU, then noticed CPU only under
  the truth table; the same selection is used by readiness and the session;
  no selection is emitted from an incomplete snapshot.
- Errors/configuration: timeout, exception, unknown adapter class, incomplete
  LUID map, or provider discovery failure is typed indeterminate/unavailable;
  selected DML construction/assignment/graph/inference failure is terminal and
  carries no fallback detail or retry.
- Performance/resources: one bounded snapshot and one selection per readiness
  generation; no repeated probe or unbounded device diagnostics.
- Internal seam/adapters: `ocr_preflight.py` keeps the native probe seam
  private; `engine_adapters.py` is the production execution adapter and an
  immutable snapshot is the test adapter.
- Deletion test: remove the module and verify no host or worker can choose a
  device, persist an ordinal, or retry a failed selected provider.

#### `ModelSourceSnapshot`

- Inputs/results: package/catalog/source-lock bytes and contract identity in;
  an immutable snapshot of runtime, worker, model, profile, catalog, contract,
  and artifact hashes out.
- Invariants/order: capture occurs at point of use before model start; every
  consumed byte is hashed once; any mismatch blocks before execution; raw OCR,
  tokens, local paths, and machine names are excluded.
- Errors/configuration: malformed lock, stale version, checksum mismatch, or
  catalog drift is a typed identity error; the error exposes only sanitized
  labels and digests.
- Performance/resources: bounded streaming hashes and retained durable model
  caches; no raw source or model bytes are copied into evidence.
- Internal seam/adapters: `model_source_lock.py` validation and
  `engine_catalog.py` parsing stay private; release/package readers are the
  production adapter and an immutable manifest fixture is the test adapter.
- Deletion test: delete the snapshot and prove identity checks do not reappear
  independently in the runner, worker, and host adapters.

#### `AcceptanceRunner`

- Inputs/results: a candidate, fixture, app sequence, and cleanup scope in;
  one terminal `AcceptanceManifest` with artifact hashes, semantic counts,
  provenance, and cleanup booleans out.
- Invariants/order: Capture JPEG, Capture PDF page 1, Cert, and LAW are
  strictly serial; each child persists its evidence, releases model memory,
  closes its journal, and proves cleanup before the next starts; first failure
  stops the chain.
- Errors/configuration: missing identity, semantic failure, child failure,
  cleanup unknown, or journal-not-closed is typed terminal failure; raw OCR,
  secrets, paths, and machine names are omitted. Candidate and fixture roots
  are explicit and never inferred from a source tree.
- Performance/resources: one model process at a time; bounded fixture and
  journal scope; no parallel child or unbounded diagnostic retention.
- Internal seam/adapters: `tools/three-project-acceptance.ts` owns sequence
  orchestration and `tools/acceptance-contract.ts` owns manifest validation;
  the installed app probe is the production adapter and a deterministic
  installed probe is the test adapter.
- Deletion test: remove the runner and show that no consumer script can still
  produce a terminal manifest without independently duplicating all sequence,
  evidence, and cleanup policy.

#### `VersionInventory`

- Inputs/results: canonical runtime/API/schema/client/tooling versions and
  generated artifact inventory in; a complete `VersionReport` or a typed
  stale/mixed-version report out.
- Invariants/order: check is read-only; upgrade is explicit; generated values
  and locks are updated together; no 0.3/0.4.1 and 0.4.2 mixture passes.
- Errors/configuration: missing owner, stale literal, mixed lock, or unknown
  consumer is a typed stop with the path and value class, never a secret or
  private path.
- Performance/resources: bounded repository scan from declared roots and one
  deterministic report; no network, model, or installer side effect in check.
- Internal seam/adapters: `constants/versions.py`, `release.py`, and
  `scripts/model_source_lock.py` remain source-specific seams; repository
  readers are the production adapter and fixture trees are test adapters.
- Deletion test: remove the inventory and prove a stale version cannot be
  detected only by a subset of package, lock, catalog, or consumer checks.

### Design-It-Twice gate for the two unresolved interfaces

No implementation of `OcrPipeline` or `OwnedRuntimeSession` starts until at
least three independent fresh reviewers, working under materially different
constraints, each publish a complete alternative for each module. The
constraints must differ in interface shape, not cosmetic naming: for example,
minimum surface area, maximum extension flexibility, common-caller
simplicity, and (when selected) explicit ports and adapters.

Every reviewer record must contain the interface (inputs, results, invariants,
ordering, errors, cancellation/termination, configuration, performance, and
bounded resources), a usage example, the hidden implementation, dependency
categories with production and test adapters, trade-offs, and the deletion
test. No method name or signature is selected in this SPEC before that record.

Root then grills the alternatives one question at a time. The comparison must
cover depth/leverage, locality, seam placement, failure readability,
cancellation/termination, adapter count, and migration cost. Only after that
comparison may Root choose a contract, commit the chosen contract, and request
fresh Standards and Specification reviews bound to the exact new HEAD. Any
content commit invalidates earlier review artifacts. The chosen contract must
not add a second coordinator around existing policy.

## OCR-only execution and acceptance

The producer always executes **PDF raster -> PaddleOCR**; embedded text is
ignored even if present or misleading. Real private acceptance uses a JPEG and
PDF page 1. The required model-enabled order is:

```text
Capture Workbench JPEG
  -> cleanup + model-memory release
Capture Workbench original PDF page 1
  -> cleanup + model-memory release
Cert Prep (same candidate bytes)
  -> cleanup + model-memory release
GX Law Prep (same candidate bytes)
```

Only one OCR/model process may run at a time. A failed child stops the chain and
must still complete its cleanup proof before the runner returns. Full-document
OCR is a targeted test only when the risk is page accumulation, order, or
memory; it is not a default iteration cost.

### GPU truth (single policy)

The full decision table is here and is the only GPU policy: [canonical compute
decision truth table](#canonical-compute-decision-truth-table). In short:

- automatic selection is usable dedicated GPU (dGPU) -> usable integrated GPU
  (iGPU) -> noticed CPU;
- CPU is allowed only when authoritative evidence proves every hardware
  candidate unavailable/no hardware, or a completed provider query positively
  proves `DmlExecutionProvider` absent;
- timeout, exception, unknown architecture, incomplete mapping, or structural
  inconsistency is **indeterminate/unavailable**, never CPU fallback;
- a selected DML construction, assignment, graph-proof, or inference failure is
  fail-closed for that operation, with no other GPU or CPU retry; and
- Capture Workbench must first prove the automatic usable NVIDIA GeForce RTX
  4060 on the acceptance machine, including the real JPEG then PDF page 1,
  before the Phase 2 Cert/Law run.

### Canonical compute decision truth table

| Situation | Required evidence | Result |
| --- | --- | --- |
| Usable dGPU exists | Complete positive-usable dGPU snapshot | Select highest-priority dGPU, `gpu-dml`, no CPU. |
| No usable dGPU and usable iGPU exists | Every dGPU that could outrank it is positively unavailable or authoritatively absent | Select iGPU, `gpu-dml`, no CPU. |
| All hardware positive-unavailable or authoritative empty hardware inventory | Complete affirmative snapshot | Explicit `cpu-fallback`, `no_compatible_gpu`, user notice. |
| Completed provider query proves DML absent | Authoritative provider list without `DmlExecutionProvider` | Explicit `cpu-fallback`, `dml_provider_unavailable`, user notice. |
| Any evidence that could change the choice is indeterminate/structurally invalid | Timeout, exception, unknown class, incomplete LUID map, failed provider discovery | Readiness unavailable; no plan and no CPU notice. |
| Selected GPU later fails | DML construction/identity/assignment/graph/inference failure | Capture fails; plan invalidated; fresh readiness required later; no retry. |

`highPerformanceRank` and ordinary `EnumAdapters1` `dmlDeviceId` are different
coordinates joined by exact run-scoped LUID. ORT receives the ordinary ordinal,
never the preference rank. The implementation pins
`ort-directml-1.24.4-enumadapters1-v1`; a changed ORT mapping requires a new
reviewed mapping contract. No implicit device `0`, old ordinal override,
display-name selection, or host-derived numeric setting survives.

The private proof may contain sanitized class, LUID, PCI identity, bounded
observational label, plan/execution digests, map digest, worker/model/profile/
contract hashes, provider order, fallback-disabled result, and positive DML
node evidence. It must never contain raw OCR/truth text, token, path, user or
machine name, environment dump, or arbitrary diagnostics. Private proof is
validated through the existing installed-evidence seam and is not an API/SDK
field.

## Lifecycle, background ownership, and reconciliation

`OwnedRuntimeSession` is the only process-tree owner. Every root is created
suspended, assigned to a fresh no-breakaway Job, verified, then resumed. Native
handles, PIDs, process creation identity, descendant enumeration, retry
details, and OS errors remain behind its interface. Hosts express graceful
close and persist domain status; they do not duplicate cleanup.

| Event | Required behavior | Forbidden shortcut |
| --- | --- | --- |
| Normal close/window close | Request graceful termination, observe root, finish and prove descendants/listener cleanup. | Treating renderer reload as lifecycle proof. |
| Startup failure/readiness failure | Finish the launch attempt and emit typed failed cleanup; no model success evidence. | Starting a consumer or silently retrying another process. |
| Root crash | Observe unexpected exit, run the same idempotent finish/proof path. | Assuming the OS callback means cleanup succeeded. |
| Host terminate/app exit | Join the owned session, close descendants, then terminalize. | Letting descendants outlive the owner or broad-killing names. |
| App child process/descendant | Track exact ownership identity and prove absence at terminalization. | `taskkill /IM`, name-kill, or matching an unrelated process. |
| Baseline external process | Preserve it, even if it has the same executable name. | Counting baseline as owned residue. |
| Next start after crash/power loss | Reconcile only identity-proven stale PIDs/listeners/run staging; retain durable runtime/model caches. | Deleting durable caches or guessing identity from a PID/name alone. |

Cleanup is fail-closed: no `clean=true` or completed acceptance manifest is
written until app, sidecar, CDP port, temporary app data, owned PIDs,
listeners, workers, errors, and page errors satisfy the manifest contract.

## Version-first phase and identity

The first implementation slice is `VersionInventory`, before OCR/session
refactors. The intended single check/upgrade entrypoint is:

```powershell
corepack pnpm nx run capture-runtime:version-check --skip-nx-cache
```

Its upgrade mode is explicit and reviewable; the check mode is read-only. It
must inventory and bind:

| Inventory group | Required identity |
| --- | --- |
| Runtime and contracts | Runtime `0.4.2`, API `2.0`, OCR schema `3`, raw/structured schema `2`, contract-set version/hash. |
| Languages and clients | TypeScript/npm, Python, Java, Rust client/runtime versions and generated artifacts. |
| Desktop and package | Capture desktop metadata, runtime/worker/model catalogs, installer manifests, profile/model digests. |
| Repository/tooling | pnpm 12, Capture Workbench Nx `23.1.2`, Cert Prep Nx `23.1.2`, and lockfile main dependency documents. |
| Consumers | Cert/Law expected runtime and contract identity, local direct URL metadata, and published URL restrictions. |

No stale 0.3/0.4.1 literal or mixed lock may pass. Local E2E uses tiered
identity: URL/port identify transport only; contract hash, package boundary,
provenance, and loaded executable identity remain required. Release/published
acceptance restores strict immutable-byte identity: exact candidate bytes,
version, every manifest/hash entry, frozen locks, and download-back hashes;
local paths/direct URLs are rejected there. There is currently no immutable
candidate or publish authorization.

## Measure first, then optimize

The first performance slice records a no-behavior-change baseline for each
real private fixture, independently:

- cold model/predictor initialization and model memory;
- PDF rasterization time/dimensions;
- serialized per-page inference and total elapsed time;
- time to first completed page;
- peak worker/Job memory and close/reconciliation time; and
- compute mode and exact runtime/worker/model/profile/contract identities.

Evidence is bounded numeric data plus hashes, never OCR text, truth text,
tokens, local paths, machine names, or arbitrary diagnostics. Every later
optimization names one metric, comparison cohort, noise rule, and rollback
before coding. Each JPEG and PDF page-1 fixture must independently pass
semantic anchors, page/provenance, and cleanup gates; a mean cannot hide one
failed fixture or missing critical anchor. Inference stays serialized and
model memory is released before the next app.

## Privacy-safe evidence and acceptance

Evidence may record artifact/HEAD/model/profile/worker/contract hashes, CER
numeric summaries, stable anchor IDs and matched counts (not anchor text), page
counts, provenance categories, provider/compute decision, and cleanup booleans.
It must not record raw OCR/truth text, bearer tokens, local paths, user names,
machine names, or unbounded environment/diagnostic values. Screenshots are
secondary and must be reviewed for leakage; their content is not a substitute
for semantic assertions.

The installed acceptance manifest is a terminal artifact only after the exact
fixture is deleted, the app and owned descendants/listeners are absent, the
baseline process survives, and the child journal is closed. OCR execution proof
and host structuring success remain separate terminals: proof follows raw and
OCR projection persistence plus `awaiting_structuring`, and does not wait for
LLM structuring or release. A host commit failure does not retroactively make
the OCR proof a structuring success.

## Delivery flow and gates

The canonical flow is:

```text
design docs
  -> serious grill + Standards/Specification review
  -> authorized exact-HEAD slice
  -> sprint backlog
  -> TDD red public-seam test
  -> implementation + replacement cleanup
  -> two review axes
  -> local staging / local-real evidence
  -> immutable candidate
  -> published release (only after consumer gates)
```

Each arrow is a gate, not a claim that this checkpoint has run. A fresh worker
starts from its checkpoint commit, reads the design and named owner files, and
commits one closed vertical slice. Any content commit invalidates previous
exact-HEAD review artifacts. Root coordinates review and does not edit this
slice. Sol Ultra is read-only and may be activated only when the same blocker
has failed more than three consecutive times; it may provide diagnosis,
options, and tests, but never edit, commit, push, publish, or own the slice.

Phase 2 promotion requires architecture, version, performance, and lifecycle
hardening; an immutable candidate is then built; only after that are Capture ->
Cert -> LAW tested sequentially with a formal/published `0.4.2` package. The
package and promotion are future gates, not claims made by this design.

## Release promotion gates D0-D8

Release promotion is one fail-closed state machine. The current documentation
checkpoint is before D0 and claims none of these gates. Each transition records
the exact source/manifest/evidence identity; a failure stops the sequence,
preserves the failed evidence and rollback pointer, and prevents later gates.

| Gate | Required transition and proof |
| --- | --- |
| D0 `DocsCommitted` | Commit the canonical SPEC/DECISION/TODO/GUIDE and any named historical banners. Record the commit SHA and explicit cached path set. |
| D1 `DesignReviewed` | Standards and Specification external review artifacts both record `git rev-parse HEAD` after D0 and the external check/PR metadata. A later content commit invalidates both artifacts. |
| D2 `ImplementationAuthorized` | Root records the bounded slice, owner paths/symbols, red proof, prerequisites, stop condition, verification, rollback, and commit message. There is no handoff commit and no feature-code authority in this gate. |
| D3 `CandidateBuilt` | Build from the exact source HEAD and record SHA-256 identities for runtime, worker, model, profile, contract set, manifests, locks, and every candidate artifact. Any missing or mismatched hash stops promotion. |
| D4 `CandidateAccepted` | Use those same candidate bytes in strict serial order: Capture JPEG -> cleanup/model-memory release -> Capture original PDF page 1 -> cleanup/model-memory release -> Cert -> cleanup/model-memory release -> LAW -> cleanup. Every child must produce semantic evidence and a terminal cleanup proof. |
| D5 `PublishedImmutable` | Publish the D3 bytes and manifests without moving the stable pointer. The published artifact identity is immutable and must equal the candidate ledger byte-for-byte. |
| D6 `DownloadBackVerified` | Download each published artifact and manifest through the public path, hash the bytes, and compare them to D3/D5; reject mutable URLs, version drift, missing locks, or manifest mismatch. |
| D7 `PublishedAccepted` | Repeat the sequential Capture JPEG -> Capture PDF page 1 -> Cert -> LAW journey using only D6 download-back bytes; retain per-child cleanup and semantic evidence. |
| D8 `StablePointerMoved` | Move the stable pointer only after D7 is terminal-success and all ledgers, hashes, cleanup proofs, and rollback references are preserved. |

No gate may infer proof from a green deterministic CI run, local package,
older manifest, screenshot, or historical Phase 1 result. Phase 1 remains
complete only at the local-probe tier and is not D3-D8 evidence.

## Acceptance and rollback definition

Phase 2 is not complete until each slice has its red public-interface tests,
slice-scoped and `--skip-nx-cache` verification, both review axes on the exact
commit, privacy/path/secret audit, and a recorded rollback. Promotion is not
complete until architecture/version/performance/lifecycle hardening is done,
an immutable candidate is built, and Capture JPEG -> Capture PDF page 1 -> Cert
-> Law all use the same immutable candidate bytes, clean up serially, and pass
with a formal/published `0.4.2` package whose published download-back identity
is exact.

Rollback is additive: revert the named slice to its prior reviewed
checkpoint, preserve durable caches and historical manifests, and never mix
0.4.1/0.4.2 assets or rewrite shared history. This design claims no new Phase 2
verification, candidate, release, or publication; the completed Phase 1
local-probe result is recorded above.
