# Staged OCR delivery workflow (Phase 2 worker guide)

This is the fresh-worker procedure for Capture Runtime 0.4.2 Phase 2. The
[Phase 2 SPEC](../SPECS/capture-runtime-042-p2-hardening.md) is the sole policy
source. The [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md)
records rationale, and the [TODO](../TODOS/capture-runtime-042-p2-hardening.md)
is the executable checklist. P1/PDF/acceptance/contract documents are context,
not alternate Phase 2 policy.

## Checkpoint first: 2026-09-10

This closure starts from expected HEAD
31b1232ea9ef5b9bc32679323c8c28b9500b0bf0. D0 is complete for the documentation
commit, but its SHA is intentionally external: record git rev-parse HEAD after
commit. D1 is pending fresh Standards and Specification review at that exact
head. Preserve untracked .github/copilot-instructions.md and
.github/instructions/; stage no unrelated path.

PR #39 at c6d2140e233de70734005713427f77f92414f415 is a green deterministic-CI
engineering checkpoint and remains unmerged. Phase 1 is complete only at the
local-probe tier: Capture -> Cert -> LAW passed real local-package OCR in that
order. This is not candidate, published, or release evidence. No current-HEAD
Phase 2 JPEG/PDF, GPU, cleanup, candidate, download-back, or publication result
is claimed.

CI repair is paused and has no authority in this workflow. Do not repair,
rerun/retry, or reconfigure CI, and do not treat deterministic CI as real OCR,
GPU, cleanup, installation, publication, or pointer proof. The future D5-D8
implementation slice is explicitly allowed to edit the named publication
workflow contracts; this docs-only checkpoint does not.

## Fresh-worker procedure

1. Confirm git rev-parse HEAD and the clean/dirty boundary. Read
   [AGENTS.md](../../AGENTS.md), this GUIDE, the SPEC, the DECISION, and the
   TODO. Read linked policy only when the named slice requires it.
2. Confirm the current owner before editing. Use the actual symbols:
   packages/capture-runtime/src/capture_runtime/ocr_projection.py::OcrPipeline;
   packages/capture-sidecar-launcher/src/process.rs::OwnedRuntimeSession,
   OwnedRuntimeSessionState, RuntimeTerminationProof, and
   RuntimeCleanupError; src/lib.rs exports; src/launcher.rs launchers; desktop
   Tauri src/state.rs, src/launcher.rs, and src/commands.rs callers.
3. Run the read-only project discovery before choosing a target:
   corepack pnpm nx show project capture-runtime --json;
   corepack pnpm nx show project capture-sidecar-launcher --json;
   corepack pnpm nx show project capture-tools --json; and
   corepack pnpm nx show project capture-workbench-desktop --json. A missing
   target or owner is discovery-and-stop; do not invent one.
4. For OcrPipeline and OwnedRuntimeSession, read all three Design-It-Twice
   alternatives in the SPEC. A new implementation requires the chosen seam,
   usage, hidden implementation, dependency/adapters, trade-offs, deletion
   surface, and focused tests to be recorded before code. No second
   coordinator is allowed.
5. Write a slice record containing owner paths/symbols, external interface, red
   proof, prerequisites, stop condition, exact Nx commands, rollback, and
   commit message. Use edit-first ownership and delete/supersede only after
   residual scans, replacement tests, and an additive commit.
6. A content commit invalidates all prior D1 review artifacts. Rerun
   git rev-parse HEAD and obtain fresh external review metadata after the new
   commit. Do not reuse a remembered SHA.

## Delivery order

The only permitted state progression is:

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

Each is a separate item and evidence/commit checkpoint. A failed state stops
later work. D2 and D2.5 are design, contract, and red-infrastructure gates
only: they do not install or require an installed candidate. D3 is the first
gate that builds an immutable byte ledger. D4 consumes only externally
supplied D3 candidate root/id/digests through the future
`capture-workbench-desktop:acceptance-d3-candidate` target, never by staging,
building, importing source, or following a mutable URL. The current
`capture-workbench-desktop:acceptance-real` target remains a local diagnostic,
not D4. D5 publishes identical D3
bytes after D4 and has no stable-pointer call. D6 downloads back D5 public
bytes through a fresh-download dispatch. D7 repeats acceptance using D6
downloads only. D8 is a separate protected producer dispatch that consumes the
D7 chain and a current-pointer CAS guard before calling the stable-pointer
workflow/tool. Never combine D4 and D7 identity ledgers or make a
self-dependent gate.

## Future D5-D8 workflow contract

The checked-in workflow owners are real, but their current graph is not yet the
required state machine: `.github/workflows/release-promote.yml` currently puts
`promotion-ledger` after `publish-stable-pointer`. After D1/D2, one explicit
workflow slice owns and may edit:

* `.github/workflows/release-promote.yml` for D5 orchestration and the D6
  download-back/D7 published-acceptance dispatch contracts;
* `.github/workflows/_publish-github-release.yml` for exact candidate assets and
  the immutable release manifest;
* `.github/workflows/_verify-registries.yml` for complete registry-ledger
  validation;
* `.github/workflows/_publish-runtime-github-release.yml` for the existing
  runtime-release asset lane when it is part of the D5 train;
* `.github/workflows/_publish-promotion-ledger.yml` for the D5 publication
  ledger, before D6 and before any stable-pointer operation; and
* `.github/workflows/_publish-stable-pointer.yml` as the D8 implementation
  adapter, called only by a separate protected dispatch;
* `tools/create-promotion-ledger.ts` and `tools/update-release-index.ts` for
  the D5 ledger and producer-only D8 CAS operation; and
* `tools/three-project-acceptance.ts` and `tools/acceptance-contract.ts` for
  the D7 downloaded-byte acceptance contract.

D5 consumes D4, publishes every D3 byte through all required registry and
GitHub Release lanes, verifies them, and emits a publication ledger. A
single-lane retry may repair publication, but D5 cannot terminalize or dispatch
D6 until the complete required set passes. It must remove the direct
stable-pointer edge and call. D6 consumes only that ledger
and immutable public references, performs fresh cache-bypassed downloads, and
emits a hash-equality ledger. D7 consumes only the D6 downloads and invokes the
serial installed acceptance owner. D8 is a separate protected dispatch, not an
automatic D5 dependency: it re-reads the D7 chain, checks the expected current
stable-pointer generation/tag/manifest digest with CAS, and only then calls
`tools/update-release-index.ts` in the protected environment.

No separate D8 dispatch workflow or D6/D7 workflow-contract Nx target exists at
this head. The implementation worker must discover an existing protected
dispatch owner or create/name one, and discover or create a focused target in
the existing `capture-tools` project before invoking it. Until that discovery
and creation is recorded, stop; do not write a fake current target or claim
that the dispatch contract is already implemented.

## D3 ledger and D4 candidate target boundary

D3 builds one immutable byte ledger: a bounded candidate root, candidate id,
manifest digest, every raw artifact SHA-256, and source/version/schema/
contract/model/profile/catalog identity. It does not require an installed
candidate. The future D4 target is proposed as
`capture-workbench-desktop:acceptance-d3-candidate` in
`apps/capture-workbench-desktop/project.json`, with
`apps/capture-workbench-desktop/scripts/acceptance-d3-candidate.ts:runD3CandidateAcceptance`
as its script owner. It accepts externally supplied `D3_CANDIDATE_ROOT`,
`D3_CANDIDATE_ID`, `D3_LEDGER_SHA256`, and `D3_ARTIFACT_DIGESTS`, validates
exact equality, and opens only the prebuilt D3 bytes. It must never call
`stage-product-runtime`, any build target/script, a source-tree import, or a
mutable URL. The target/script are absent at this head: first run
`corepack pnpm nx show project capture-workbench-desktop --json`, then stop for
explicit target/schema creation; do not invoke the proposed name early. The
existing `capture-workbench-desktop:acceptance-real` target remains a local
installed diagnostic and is non-D4.

## D2.5 cross-repository handoff

Use only `${CERT_PREP_CHECKOUT}` and `${GX_LAW_PREP_CHECKOUT}` for sibling
checkouts (PowerShell: `${env:CERT_PREP_CHECKOUT}` and
`${env:GX_LAW_PREP_CHECKOUT}`). The D2 authorization record must name each
resolved Git root, authorized branch, authorized `HEAD`, and exact path set.
Before a sibling worker edits anything, run and compare:

~~~powershell
$certCheckout = (Resolve-Path -LiteralPath ${env:CERT_PREP_CHECKOUT} -ErrorAction Stop).Path
$lawCheckout = (Resolve-Path -LiteralPath ${env:GX_LAW_PREP_CHECKOUT} -ErrorAction Stop).Path
git -C $certCheckout rev-parse --show-toplevel
git -C $certCheckout rev-parse --abbrev-ref HEAD
git -C $certCheckout rev-parse HEAD
git -C $lawCheckout rev-parse --show-toplevel
git -C $lawCheckout rev-parse --abbrev-ref HEAD
git -C $lawCheckout rev-parse HEAD
~~~

Each root must equal its resolved variable, and branch/`HEAD` must equal the
D2 authorization. For every exact path, run
`git -C <root> ls-files --error-unmatch -- <path>` and
`git -C <root> status --short --untracked-files=all -- <path>` before and
after edits. Missing variables, root/branch/`HEAD` drift, missing or extra
paths, or unresolved ownership is discovery-and-stop. Cert and LAW import the
producer-generated `ProducerAcceptanceContractV1` version `"1"` and literal
D3/D6 `contractSha256`; they do not redefine its names or fields. Commit each
sibling repository separately below its own resolved root and report its own
SHA/checks. A Capture commit never stages sibling paths, and no
cross-repository push is implied.

The one producer-owned `ProducerAcceptanceContractV1` has contract version
`"1"` and a producer-assigned canonical `contractSha256`, recorded by D3 and
bound by D4/D6/D7. Cert and LAW import/reference that exact generated version
and hash; they do not redefine any producer record name, field, cleanup rule,
or validation. Its records have distinct paths:
`ProducerChildScopeV1` is producer-mutable at
`CAPTURE_ACCEPTANCE_SCOPE_PATH`; `ProducerChildInvocationV1` is frozen at the
separate `CAPTURE_ACCEPTANCE_INVOCATION_PATH` (or an equivalent read-only
handle/pipe); the child writes one `ConsumerSemanticResultV1` at the separate
`CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; and the producer validates that
result, proves cleanup, then writes immutable `AcceptanceChildWireV1` at
`CAPTURE_ACCEPTANCE_WIRE_PATH`. The child receives only the frozen invocation
transport and its canonical digest; it never receives or writes the mutable
scope or final wire.

The producer writes canonical invocation bytes to a same-directory temporary,
flushes and publishes them with atomic create-new, computes the
self-excluded digest, closes the write handle, and applies an ACL that denies
child write/delete/rename/reparse. The child opens only a read-only path,
handle, or pipe and recomputes the digest before work. The producer proves the
semantic-result path is absent; the child writes a temporary result with
`CREATE_NEW`, flushes/closes, and publishes the separate final result with
`CREATE_NEW`, never replace/overwrite. The producer reads it only after child
exit. A second create, writable invocation, pre-existing output, partial
record, or digest mismatch fails closed. Cleanup fields are absent from the
consumer semantic result and are added only by the producer to the final wire.

The wire includes parentGate/tier, the D3 or D6 ledger binding, invocation
digest, ordered `fixtureAssignments[]` and equal-cardinality/order-bound
`fixtureResults[]` with per-fixture identity/media/oracle/artifact digests,
actual normalized-output digest/CER/anchor omissions/outcome/projection digest,
expected normalized-truth and anchor-set digests, child semantic-result digest,
top-level artifact IDs, detailed producer cleanup, privacy flags, and its
self-excluded canonical JSON digest. For Capture JPEG the assignment list has
exactly `capture-private-jpeg-1`; for Capture PDF page 1 it has exactly
`capture-scanned-pdf-page1-1`; Cert and LAW use the same ordered binding rules.
The invocation has ready state, child/sequence identity, D4/D3 or D7/D6
download/publication binding, predecessor cleanup-proof digests, ordered
fixture assignments, a separate output path nonce, and no future result or
wire digest.

Serialize canonical compact UTF-8 JSON with sorted object keys, semantic array
ordering, self-digest omission, and lowercase SHA-256. Hash exact raw bytes;
keep raw truth local and export expected normalized-truth/anchor digests only.
Use exactly `nfkc-whitespace-v1` (NFKC, all newlines/Unicode whitespace to one
ASCII space, collapse, trim; preserve case/punctuation/traditional-simplified)
and `code-point-levenshtein-v1`; thresholds are PDF `0.01`, JPEG `0.03`,
anchor omissions `0`, with no average. Schema/scope mismatch fails closed.
Cert migrates from
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:evaluateOcrTruth`,
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:normalizeOcrText`,
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:parseOcrTruthManifest`,
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:levenshtein`,
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/acceptance-real-options.mts:parseOcrAnchorExpectation`,
`${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts:buildPhase1AcceptanceEvidence`,
and `${CERT_PREP_CHECKOUT}/apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts:serializePrivacySafeOcrSemanticEvidence`.
The formal D4/D7 Cert path deletes/prohibits `anchorOnly` and
`parseOcrAnchorExpectation`; a full private normalized reference plus critical
anchors is required. The final schema/config has no `anchorOnly` name; a
legacy field is rejected as unknown, never ignored or accepted as an
anchor-only success path.
LAW migrates from
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/capture/FoundryCaptureStructuringProvider.java:FoundryCaptureStructuringProvider`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/extraction/EvidenceTextExtractionService.java:EvidenceTextExtractionService`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/support/acceptance-expectations.ts:loadLawAcceptanceExpectation`,
`${GX_LAW_PREP_CHECKOUT}/apps/law-prep-web-e2e/src/e2e/support/acceptance-artifacts.ts:writeAcceptanceManifest`,
and `${GX_LAW_PREP_CHECKOUT}/apps/law-prep-ai-service/src/app/ocr/service.py:OcrExtractionService.extract`.
The Python adapter uses the producer-defined opaque `RequestRefV1`, exactly
`rr1_` plus 64 lowercase hex characters generated with CSPRNG
`secrets.token_bytes(32)`, never a deterministic request-derived value. It
durably writes `start_pending` with `requestRef`, `requestDigest`, and the
producer contract version/hash before idempotent
`start-or-get(requestRef, requestDigest)`. Same tuple creates/discovers
without a duplicate; changed digest conflicts without mutation. Only a
producer ACK/discovery receipt permits `running`; timeout or dropped ACK stays
`start_pending` and retries the same tuple. `get`, `cancel`, and `delete` use
that same ref and private mapping. The adapter uses the existing v2
capture operation/lifecycle, adds no OCR route or engine, exposes no
token/path/native id, and retains API `2.0` plus `CaptureOcrProjectionV3`
schema `3`. The standalone
`real-jpeg-acceptance-coordinator.ts:runRealJpegAcceptance`/CLI migrates into
the sole producer runner, then is deleted with its test and async-boundary
allowance after residual scans and replacement tests pass.

The required RequestRef red/green cases are
`same_ref_same_digest_discovers_without_duplicate`,
`same_ref_changed_digest_conflicts_without_mutation`,
`start_pending_survives_timeout_and_retries_same_tuple`,
`running_requires_producer_ack_or_discovery`, `lookup_cancel_delete_use_same_ref`,
and `request_refs_are_csprng_and_not_request_derived`. A missing resolved LAW
test owner or target is discovery-and-stop; do not invent an Nx target.

## First implementation slice

After D1 review and D2 authorization, the first code slice owns the existing
version sources and lock:

- Upgrade Nx 23.1.0 to 23.1.2 in root package.json and pnpm-lock.yaml.
- Retain the repository's Node 24 requirement and exact pnpm 12.0.0 package
  manager.
- Extend tools/release/version-sources.ts and its existing
  tools/release/version-sources.test.ts. Verify with
  corepack pnpm nx run capture-tools:release-version-test --skip-nx-cache.
- Enumerate runtime 0.4.2, API 2.0, document schema 2, projection schema 3,
  contract hash d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40,
  TS/Python/Java clients, Rust launcher/crate, Workbench packages/assets,
  desktop staging, generated schemas/manifests/catalogs/model locks, and npm,
  PyPI, Maven, crates.io, and GitHub channels.
- Do not advertise capture-runtime:version-check: it is absent. If a required
  target is missing, record discovery-and-stop.

The next authorized commits converge OcrPipeline and OwnedRuntimeSession in
their existing owners, add the producer-owned RuntimeSessionJournalV1 and
reconciler, then extend the existing acceptance runner. The native design may
add an opaque multi-root group so LAW can put Capture/Python/Java roots in one
producer-owned unnamed no-breakaway Job configured with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; Capture/Cert/candidate single-root calls
remain supported. Tauri never owns or mutates a journal or Job. A later
workflow-contract slice also edits the named D5-D8 publication workflows; CI
repair remains paused.

The compute proof remains in the existing producer owner
`packages/capture-runtime/src/capture_runtime/ocr_preflight.py:OcrComputePlan.select`
and snapshot type. Add the focused regression
`packages/capture-runtime/tests/unit/test_ocr_compute_plan.py:test_positive_unavailable_dgpu_selects_usable_igpu`
for a positively unavailable dGPU plus usable mapped iGPU selecting DirectML
on the iGPU, never CPU; the existing full command is
`corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache`. If the owner,
symbol, or target is absent, `corepack pnpm nx show project capture-runtime --json`
is discovery-and-stop.

## Real OCR acceptance

The producer rasterizes every requested PDF page with PDFium and sends the
raster to PaddleOCR. Embedded text is ignored. Acceptance is per fixture, not
an average:

- Each real scanned PDF page-1 result must have CER <= 1%.
- Each real private JPEG result must have CER <= 3%.
- Every critical anchor must be present; one omission fails.
- CER is normalized edit distance per fixture/page. Never average pages,
  fixtures, products, or thresholds.

For both D4 and D7, use the same serial journey, releasing model memory and
proving journal/process/listener/staging cleanup after each child:

~~~text
Capture Workbench private JPEG
  -> cleanup proof
Capture Workbench original scanned PDF page 1
  -> cleanup proof
Cert Prep
  -> cleanup proof
GX Law Prep
  -> cleanup proof
~~~

The four children are unique within one run: sequence/child-key/leg-id are
`(1, capture-private-jpeg, capture-private-jpeg-v1)`,
`(2, capture-scanned-pdf-page1, capture-scanned-pdf-page1-v1)`,
`(3, cert, cert-v1)`, and `(4, law, law-v1)`. Each also receives a distinct
`childId`, `root`, and `artifactIds`, plus exact artifact and cleanup proof;
none may be reused by another leg, candidate, or prior session. The child
writes only its write-once semantic result; the producer validates it, proves
cleanup and model-memory release, and emits the immutable wire before the next
child begins.
The standalone `apps/capture-workbench-desktop/scripts/real-jpeg-acceptance-coordinator.ts:runRealJpegAcceptance`
and CLI are migrated into `tools/three-project-acceptance.ts:runAcceptanceSequence`
as the sole producer runner, then deleted with their test and async-boundary
allowance only after residual scans and replacement tests pass.

Stop at the first semantic, identity, process, listener, or cleanup failure.
The completed local-probe Phase 1 result does not satisfy D3-D8. Cert and LAW
adapt the exact producer result/wire and never own a competing scope, truth, or
wire schema.

## Journal and lifecycle boundary

RuntimeSessionJournalV1 is producer-owned durable cleanup state, not host
domain persistence. Only the producer may write atomic
state/generation transitions, retain PID plus process creation identity/nonce,
and bind the producer Job, run staging, and listener nonce. The live owner uses
the current unnamed no-breakaway Job with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; it never names a Job for takeover and
never weakens close/crash cleanup. Never persist raw tokens, OCR, source/model
paths, command lines, or machine names. A PID, port, parent process,
executable name, or directory name alone is not ownership proof.

R3 `open`/`prepare` durably writes `planned` and returns
`PreparedRuntimeSession { ReconcileRef, refDigest, generation }` before
activation. An injected `ReconcileRefSink` durably persists that exact ref and
generation and returns the CAS-bound
`ActivationPermit{refDigest, generation, receiptDigest}` only after its receipt
is flushed. `activate(prepared, permit)` validates all three values against the
prepared journal and sink receipt before any resource acquisition; there is no
activation overload without a permit. One-root convenience methods require the
sink or remain private and use the same order. Reconciliation returns semantic
cleanup and `proofSha256`; candidate and prior refs are distinct. For
`prior=null`, the prior ref and predecessor proof digest are null and no proof
is implied. A non-null prior requires its exact proof digest and generation.

Live in-memory `terminate_and_prove` has the private Job handle, membership,
and root/session nonce, so it may terminate only that live producer-owned group
and then prove root, descendant, listener, and staging cleanup. After restart,
the observer has no Job handle, membership query, or nonce claim and is
observe-only. It may terminalize a stale journal and remove only its exact
run-scoped staging when Job setup was durably committed, every root's exact PID
plus creation identity is absent, every listener is proven absent, and the
staging binding is exact. PID reuse/presence/unqueryability, listener
ambiguity, root/staging mismatch, uncommitted setup, or any unknown binding
means `reconcile-required`: touch nothing and block promotion. No
process-name, PID-only, or port-only kill is valid. In a multi-root group all
roots must pass; one ambiguous root blocks group terminalization.

The producer reconciler may terminate/delete only on the live exact-identity
path, or remove exact stale staging under the restart observe-only conditions
above. Retry is bounded and identity-scoped; do not launch a replacement root
while cleanup is unresolved. Tauri can request close and receive semantic
proof, but cannot write/mutate the journal or Job. The addressable observe-only
API is `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`.
`ReconcileRef` is an opaque journal index/address, not a PID, Job handle,
process id, path, or takeover lease; candidate and prior sessions each receive
a distinct ref. The exhaustive graph is
`planned -> launching -> running -> closing -> terminal`, plus
`planned -> terminal` only for a durable no-resource proof,
`planned -> reconcile-required`,
`launching|running|closing -> reconcile-required`,
`reconcile-required -> reconcile-required` for timed/failed attempts one or
two, `reconcile-required -> terminal` only after a later complete
observe-only proof, `reconcile-required -> manual-review` after timed/failed
attempt three, and `manual-review -> reconcile-required` only by explicit
producer-authorized recovery. Every transition CAS-guards expected state,
generation, attempt, and recovery epoch and increments generation/attempt
atomically where an attempt is recorded. `manual-review` has no automatic
recovery, cannot launch a replacement, and cannot transition directly to
terminal. Recovery requires a fresh opaque nonce and durable authorization
receipt, increments recovery epoch/generation, resets the attempt window, and
performs no resource mutation; the next full observe-only attempt remains
mandatory. A stale guard or receipt leaves the record untouched.

Required journal tests in the existing launcher/desktop Cargo owners are
`reconcile_attempt_and_generation_increment_atomically`,
`reconcile_complete_observe_only_proof_to_terminal`,
`reconcile_timeout_attempt_one_stays_required`,
`reconcile_failure_attempt_two_stays_required`,
`reconcile_failure_attempt_three_enters_manual_review`,
`reconcile_rejects_stale_state_generation_attempt_or_epoch`,
`manual_review_requires_explicit_recovery_receipt`,
`manual_review_recovery_resets_attempt_window_without_resource_mutation`,
`manual_review_cannot_transition_directly_to_terminal_or_running`, and
`recovery_retry_enters_manual_review_again_after_three_failures`. Keep them in
existing targets after `nx show project`; a missing focused target is a
creation stop, not permission to call an invented command.

## Verification floor

Confirm every target with Nx project metadata, then append
--skip-nx-cache to each invocation. Existing targets to select as applicable
include:

~~~powershell
corepack pnpm nx run capture-runtime:lint --skip-nx-cache
corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache
corepack pnpm nx run capture-runtime:python-version-check --skip-nx-cache
corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache
corepack pnpm nx run capture-runtime:test-integration --skip-nx-cache
corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache
corepack pnpm nx run capture-sidecar-launcher:cargo-fmt-check --skip-nx-cache
corepack pnpm nx run capture-sidecar-launcher:cargo-check --skip-nx-cache
corepack pnpm nx run capture-sidecar-launcher:cargo-test --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:cargo-check --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:contract-consistency --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
~~~

Real installed-boundary targets are opt-in and still do not prove publication:

~~~powershell
corepack pnpm nx run capture-runtime:e2e-local-package-pdf-ocr --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:smoke-real-desktop-ocr-directml --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:acceptance-real --skip-nx-cache
corepack pnpm nx run capture-workbench-desktop:acceptance-three-projects --skip-nx-cache
~~~

The existing `capture-workbench-desktop:acceptance-real` and
`acceptance-three-projects` targets are local installed diagnostics under the
current graph, not D4 or D7 proof; D4/D7 must use their separately authorized
immutable-byte/downloaded-byte producer dispatches.

The target capture-workbench-desktop:acceptance-real-ocr-gpu-selection is
absent; do not invent it. Package QA and local package evidence remain
supplementary until the installed/public boundary and identity requirements are
met.

## Publication and handoff

D3 creates one immutable candidate ledger. D4 accepts only that ledger. D5 uses
the future contract in the named producer workflows for npm/GitHub Packages,
PyPI, Maven/GitHub Packages, crates.io, and GitHub Releases and publishes
identical bytes after D4; it never calls the stable-pointer workflow. D6
obtains fresh public downloads and compares every hash. D7 repeats the serial
journey using D6 downloads only. D8 is a separate protected dispatch that
consumes the D7 chain and CAS-guards the current pointer before invoking
`.github/workflows/_publish-stable-pointer.yml` and
`tools/update-release-index.ts`. No worker, host, Tauri process, local script,
or source-tree command may mutate `release-index/stable.json`.

If D5-D7 fails, stop and retain the candidate/publication/download ledgers. If
published `0.4.2` bytes are later defective, rollback is producer supersession
only: publish a corrected successor and mark `0.4.2` superseded through the
protected producer index operation. Never overwrite or rebuild the published
`0.4.2` bytes or directly revert the stable pointer.

Commit only explicitly named paths after git diff --cached --check and
git diff --cached --name-only. Record SHA, paths, commands/results, evidence
tier, unresolved gates, and rollback. Never push from this workflow.
