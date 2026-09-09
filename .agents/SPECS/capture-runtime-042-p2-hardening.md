# Capture Runtime 0.4.2 Phase 2 hardening (canonical design)

Status: design-only. This file is the canonical Phase 2 policy and acceptance
source for a fresh Luna xhigh worker. It does not grant implementation,
candidate, release, or publication authority.

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
- Only these four documents may be edited in this task. Phase 2 entry is allowed
  at documentation/design/review; implementation slices follow the approved
  TODO gates.

The exact implementation-slice gate is: current-HEAD design review by Standards and
Specification axes, the serious grill questions resolved one at a time, an
approved small vertical slice, and a fresh worker/checkpoint. Until then, do
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
| Delete/supersede | Name obsolete policy and documents as candidates below. A later implementation worker may remove them only after ownership, replacement tests, and an additive commit are proven. No other file is edited here. |
| Create | Create a file only when no existing owner can hold the lifecycle or seam. A new module, schema, fixture, or command requires a separate approved vertical slice. |

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
until a focused supersession commit updates them. Their relevant constraints
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

Each module has a small external interface. Its interface includes the type
shape plus invariants, ordering, error modes, required configuration, and
performance behavior. Internal seams are private test seams; they are not
promoted to callers merely to make tests convenient.

| Module and interface | Hidden policy and invariants | Dependencies and adapters | Deletion test |
| --- | --- | --- | --- |
| `OcrPipeline.run(request) -> CaptureOcrProjectionV3` | One source request in, one ordered page-complete projection out. PDFium/Pillow rasterize before worker dispatch; predictor initializes once; inference is serialized; malformed or incomplete pages fail atomically; all-pages is the default. Errors are typed and sanitized. Baseline is measured per fixture before optimization. | In-process normalization; local-substitutable page planner; producer-owned worker is a remote-but-owned transport adapter; in-memory behavior adapter is the test adapter. | If deleted, raster/page policy, Paddle normalization, projection and failure logic must not reappear in every route/host. |
| `OcrComputePlan.select(input) -> immutable OcrComputeSelection` | One automatic decision reaches readiness and every session. Priority is usable dGPU, then usable iGPU, then noticed CPU only under the truth table. Unknown is not unavailable; selected DML failure is terminal and has no retry. | Native DXGI/D3D12/DirectML is a true external/platform seam with production adapter; in-memory snapshot is test adapter. | If deleted, hosts or worker paths would have to rank devices and diverge; if they do, the module was not replaced deeply enough. |
| `ModelSourceSnapshot.capture(source) -> immutable snapshot` | Binds runtime/worker/model/profile/catalog/contract bytes and provenance at the point of use; no raw OCR, tokens, local paths, or machine names. Identity mismatch blocks. | Local filesystem/package boundary is local-substitutable; catalog/download is remote-but-owned adapter; immutable in-memory manifest is test adapter. | If deletion scatters hash and provenance rules through runner, worker, and hosts, this module earns depth. |
| `OwnedRuntimeSession.launch/observe/finish -> RuntimeTerminationProof` | One launch attempt owns suspended root, Job assignment before resume, no-breakaway, root events, descendants, idempotent finish, retry, and terminal cleanup proof. Baseline external processes survive. | Windows native process/Job APIs are true external; a narrow native test adapter/injected clock is required. Hosts receive semantic events only. | If deleting it leaves raw handles, name-kill, and cleanup policy in hosts, the replacement is invalid. |
| `AcceptanceRunner.run(plan) -> AcceptanceManifest` | Owns build/install boundary, runtime event scope, source fixture, evidence, exact deletion, cleanup, and terminalization. Runs Capture then Cert then LAW serially and stops on failure. | Installed executable is remote-but-owned; private app probe is production adapter; deterministic installed test double is test adapter. | If every app still duplicates event/cleanup/terminalization, the runner is pass-through. |
| `VersionInventory.check/upgrade(input) -> VersionReport` | One source drives runtime/API/schema, all SDKs, desktop metadata, catalogs/manifests, locks, and consumer expectations. Stale literals and mixed 0.4.1/0.4.2 fail. | In-process canonical serialization; repository files are local-substitutable; a checked-in generated report is production artifact and fixture input is test adapter. | If a version is still hand-edited in a consumer or manifest, inventory has not replaced the old source. |

### Required interface detail

Before implementation, each module's review record must explicitly state:

- invariants and ordering (including terminal events and idempotency);
- typed errors and which details are deliberately omitted;
- performance behavior and bounded resources (especially one-page memory and
  serialized inference);
- internal seam location and at least one production and one test adapter;
- dependency category using the codebase-design vocabulary; and
- the deletion test plus the old paths/tests that will be replaced.

Tests cross the external interface. Tests of private Paddle calls, private
methods, call counts, raw Job handles, or adapter indexes are not acceptance
surfaces.

### Design-It-Twice gates

No actual implementation of `OcrPipeline` or `OwnedRuntimeSession` starts
until a fresh worker records three materially different interface alternatives
for each module and compares depth, locality, seam placement, failure
readability, cancellation/termination, and migration cost. The accepted
option must include usage, hidden implementation, dependency category,
production/test adapters, invariants, and deletion test.

The required alternatives are intentionally distinct, not cosmetic renames:

| Module | Alternative A: minimal | Alternative B: staged | Alternative C: port/event |
| --- | --- | --- | --- |
| `OcrPipeline` | One `run(request)` command returning the terminal projection. | `plan(request)` then `execute(plan)` with the plan private to the producer. | One semantic `capture(request, progressPort)` command with a cancellation/progress port. |
| `OwnedRuntimeSession` | `launch()` plus idempotent `finish(reason) -> proof`. | A session state machine exposing `observe()` and `finish()` while hiding OS handles. | A lifecycle port that consumes root events and returns one terminal proof, with adapters for native and deterministic failure injection. |

The comparison may combine ideas only after the three alternatives are public
to the reviewer. It must not add a second coordinator around the old policy.

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
  -> approved exact-HEAD slice
  -> sprint backlog
  -> TDD red public-seam test
  -> implementation + replacement cleanup
  -> two review axes
  -> local staging / local-real evidence
  -> immutable candidate
  -> published release (only after consumer gates)
```

Each arrow is a gate, not a claim that this checkpoint has run. A fresh worker
starts from its checkpoint commit, reads only the relevant design and owner
files, and commits one closed vertical slice. Any commit invalidates previous
exact-HEAD review approval. Root coordinates review and does not edit this
slice. Sol Ultra is read-only and may be activated only when the same blocker
has failed more than three consecutive times; it may provide diagnosis,
options, and tests, but never edit, commit, push, publish, or own the slice.

Phase 2 promotion requires architecture, version, performance, and lifecycle
hardening; an immutable candidate is then built; only after that are Capture ->
Cert -> LAW tested sequentially with a formal/published `0.4.2` package. The
package and promotion are future gates, not claims made by this design.

## Acceptance and rollback definition

Phase 2 is not complete until each slice has its red public-interface tests,
focused and `--skip-nx-cache` verification, both review axes on the exact
commit, privacy/path/secret audit, and a recorded rollback. Promotion is not
complete until architecture/version/performance/lifecycle hardening is done,
an immutable candidate is built, and Capture JPEG -> Capture PDF page 1 -> Cert
-> Law all use the same immutable candidate bytes, clean up serially, and pass
with a formal/published `0.4.2` package whose published download-back identity
is exact.

Rollback is additive: revert the focused slice to its prior reviewed
checkpoint, preserve durable caches and historical manifests, and never mix
0.4.1/0.4.2 assets or rewrite shared history. This design claims no new Phase 2
verification, candidate, release, or publication; the completed Phase 1
local-probe result is recorded above.
