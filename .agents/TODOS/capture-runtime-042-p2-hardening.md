# Capture Runtime 0.4.2 Phase 2 hardening (executable TODO)

The [canonical SPEC](../SPECS/capture-runtime-042-p2-hardening.md) owns policy
and the [DECISION](../DECISIONS/capture-runtime-042-p2-hardening.md) owns
rationale. The [GUIDE](../GUIDES/staged-ocr-delivery-workflow.md) owns fresh
worker procedure. This file is the only executable Phase 2 checklist.

## Gate status and non-negotiable rules

The state machine is strictly linear:

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

The documentation commit completes D0 without embedding its own SHA. The
external handoff records `git rev-parse HEAD`. D1 is pending until fresh
Standards and Specification reports review that exact head. Each gate is a
separate evidence/commit checkpoint and consumes only the preceding gate.

CI repair is paused and has no authority here. The future D5-D8 workflow slice
below explicitly owns publication-workflow contract edits; this documentation
slice does not edit workflows, rerun CI, or claim that deterministic CI proves
OCR, GPU, cleanup, installation, publication, or pointer state.

The expected starting HEAD for this closure is
`a51cd6876b2a4dc5eae378358a3aaa710d2cfce2`. Preserve unrelated untracked
`.github/copilot-instructions.md` and `.github/instructions/`; never stage them.

## D0 - DocsCommitted

- [x] **Commit the canonical policy and active banners.** Owner paths are
  `.agents/SPECS/capture-runtime-042-p2-hardening.md`,
  `.agents/DECISIONS/capture-runtime-042-p2-hardening.md`,
  `.agents/TODOS/capture-runtime-042-p2-hardening.md`,
  `.agents/GUIDES/staged-ocr-delivery-workflow.md`,
  `packages/capture-workbench-ui/README.md`, and
  `apps/capture-workbench-desktop/README.md`. The historical GPU and P1
  banners remain unchanged. Red proof: the canonical documents state D0
  complete, D1 pending, the exact D0-D8 order, no self-dependency, CI pause,
  owner paths, thresholds, restart rules, and release identity rules; active
  READMEs make no published 0.4.2 claim and contain no concrete machine-
  specific fixture path. The SHA is reported externally after commit.
  Prerequisite/stop: confirm the expected base and preserve unrelated changes.
  Verify relative links, anchors, fenced blocks, stale/absolute wording, and
  `git diff --check` before staging. Rollback: additive docs revert only.
  Commit checkpoint: `docs(phase2): resolve architecture review findings`.

## D1 - DesignReviewed

- [ ] **Fresh exact-head dual review.** Consume D0 only. Standards review must
  check repository conventions, actual paths/symbols/workflows, target
  validity, links, privacy, generated-file discipline, portable README
  examples, and staged scope. Specification review must check the OcrPipeline
  and OwnedRuntimeSession alternatives/choices, OCR-only semantics, compute
  truth, live/restart journal reconciliation, public schema identity, serial
  acceptance, D5-D8 dispatch ordering, CAS guards, and supersession rollback.
  Each report must name the post-D0 `git rev-parse HEAD`, exact path set, and
  external check/PR metadata. Stop on any finding; a content correction
  returns to D1 after a new D0 commit. This gate has no implementation commit;
  review artifacts are external.

## D2 - ImplementationAuthorized

D2 and D2.5 in this checklist are design, contract, and red-infrastructure
authorization only. They do not install, stage, build, launch, or accept a
candidate and do not require an installed candidate before D3. D3 first builds
the immutable byte ledger; D4 later consumes only externally supplied D3
candidate root/id/digests through its separately named target. Existing local
`capture-workbench-desktop:acceptance-real` remains a diagnostic and is not D4.

- [ ] **Authorize one bounded implementation queue after D1.** Consume only the
  approved D1 head. The root authorization records owner paths/symbols, the
  external interface, red proof, prerequisites, exact existing Nx GREEN
  commands, stop condition, rollback, and commit boundary before code or
  workflow changes. A missing owner, symbol, target, or workflow dispatch
  contract is discovery-and-stop; do not invent a second coordinator or claim
  a future target exists.

  Required read-only discovery:

  ~~~powershell
  corepack pnpm nx show projects --json
  corepack pnpm nx show project capture-runtime --json
  corepack pnpm nx show project capture-sidecar-launcher --json
  corepack pnpm nx show project capture-tools --json
  corepack pnpm nx show project capture-workbench-desktop --json
  rg -n "class OcrPipeline|OwnedRuntimeSession|OwnedRuntimeSessionState|RuntimeTerminationProof|RuntimeCleanupError|launch_sidecar_with_observer|collectReleaseVersionEntries|runAcceptanceSequence|writeAcceptanceManifest|updateReleaseIndex" packages apps tools
  rg -n "promotion-ledger|publish-stable-pointer|publish-github-release|verify-registries|workflow_dispatch|workflow_call" .github/workflows
  ~~~

  Every queue item below is a separate additive implementation commit. Each
  item must show its red proof first, then every applicable existing command
  below must finish with `--skip-nx-cache` before the item is GREEN. If a
  required future test target is absent, record the target-creation task and
  stop instead of invoking a made-up name.

  Prerequisite: the exact D0 documentation commit and fresh D1 review reports
  for that head. RED proof: an owner, symbol, interface, target, workflow
  contract, or required test is unresolved, or the proposed queue introduces a
  second coordinator. Rollback: reject the queue and leave implementation
  files unchanged. Commit boundary: D2 authorization is an external record;
  the first implementation item commits separately.

### D2.1 Version and inventory slice

- [ ] **Own the canonical version inventory.** Owner paths/symbols:
  `package.json` and `pnpm-lock.yaml` for the Nx `23.1.0` -> `23.1.2`
  upgrade while retaining Node 24 and pnpm 12.0.0;
  `tools/release/version-sources.ts:collectReleaseVersionEntries`,
  `verifyGeneratedVersions`, and `replaceReleaseVersion`; and
  `tools/release/version-sources.test.ts`. The inventory must bind the full
  runtime 0.4.2, API 2.0, document schema 2, projection schema 3, contract
  hash, TS/Python/Java clients, Rust launcher/crate, Workbench and desktop
  assets, manifests/catalogs/model-source locks, and npm, PyPI, Maven,
  crates.io, and GitHub channels.

  Prerequisite: D1 approval and the resolved `capture-tools` and
  `capture-runtime` project metadata. RED proof: a stale or mixed version,
  API/schema value, contract hash, or channel entry fails the collector while a
  complete 0.4.2 inventory reports every value. GREEN verification:

  ~~~powershell
  corepack pnpm nx run capture-tools:release-version-test --skip-nx-cache
  corepack pnpm nx run capture-runtime:python-version-check --skip-nx-cache
  corepack pnpm nx run capture-runtime:validate-model-source-lock --skip-nx-cache
  corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache
  ~~~

  Stop if the canonical source, a generated owner, or a required target is
  unresolved. `capture-runtime:version-check` is absent at this head: target
  discovery/creation is a stop, not permission to invent it. Rollback:
  additive revert of this inventory slice; do not rewrite unrelated locks.
  Commit boundary: `feat(release): add canonical version inventory`.

### D2.2 OcrPipeline convergence slice

- [ ] **Converge the existing OCR module behind the chosen O1 seam.** Owner
  paths/symbols:
  `packages/capture-runtime/src/capture_runtime/ocr_projection.py:OcrPipeline`,
  `extract`, `normalize_observation`, `serialize_page`, `serialize_manifest`,
  `failed_page`, and `failure`; callers
  `packages/capture-runtime/src/capture_runtime/extractors.py:StandaloneRuntimeCaptureExtractor,_WorkerOcrEngineAdapter`,
  `packages/capture-runtime/src/capture_runtime/services/streaming_capture_service.py`,
  and `packages/capture-runtime/src/capture_runtime/workers/ocr_main.py`; tests
  `packages/capture-runtime/tests/unit/test_ocr_projection.py`,
  `packages/capture-runtime/tests/integration/test_streaming_api.py`, and
  `packages/capture-runtime/tests/integration/test_streaming_ocr_failure_evidence.py`.
  The public seam hides PDFium rasterization, Paddle dispatch, page order,
  normalization, provenance, cancellation, bounded resources, and typed
  failure; schema 2/3 identity remains unchanged.

  Prerequisite: D1-approved O1 Design-It-Twice choice, D2 authorization, and a
  red public-seam test. RED proof: an old caller that bypasses the terminal
  seam, changes page order, reads embedded PDF text, or emits an unsanitized
  worker failure fails. GREEN verification:

  ~~~powershell
  corepack pnpm nx run capture-runtime:lint --skip-nx-cache
  corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache
  corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache
  corepack pnpm nx run capture-runtime:test-integration --skip-nx-cache
  corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache
  ~~~

  Stop if any caller still owns duplicate page/provenance/failure policy, if
  the O1 seam cannot be found at the checked-in path, or if the public contract
  would change. Add deletion tests proving page order, provenance,
  cancellation, and failure policy are not duplicated. Rollback: additive
  revert of the OCR slice only; preserve failed evidence. Commit boundary:
  `feat(runtime): replace OCR pipeline behind chosen interface`.

### D2.3 OwnedRuntimeSession convergence slice

- [ ] **Converge the producer lifecycle owner and preserve its exports.** Owner
  paths/symbols:
  `packages/capture-sidecar-launcher/src/process.rs:OwnedRuntimeSession`,
  `OwnedRuntimeSessionState`, `RuntimeTerminationProof`,
  `RuntimeCleanupError`, `terminate_and_prove`, and `terminate`;
  `packages/capture-sidecar-launcher/src/launcher.rs:SidecarLaunchSpec`,
  `LaunchOptions`, `LaunchedSidecar`, `launch_sidecar`, and
  `launch_sidecar_with_observer`; `packages/capture-sidecar-launcher/src/lib.rs`
  re-exports `OwnedRuntimeSession`, `OwnedSidecarProcess`,
  `RuntimeCleanupError`, `RuntimeCleanupErrorKind`, `RuntimeTerminationProof`,
  `generate_bearer_token`, `launch_sidecar`, `launch_sidecar_with_observer`,
  `reserve_distinct_loopback_port`, `reserve_loopback_port`, `LaunchOptions`,
  `LaunchedSidecar`, and `SidecarLaunchSpec`; and desktop callers
  `apps/capture-workbench-desktop/src-tauri/src/state.rs:OwnedRuntime`,
  `src/launcher.rs:LaunchedRuntime`, and `src/commands.rs` shutdown paths.
  Choose R3: one producer-owned group with one-root convenience, so LAW can
  place Capture/Python/Java roots together while Capture/Cert/candidate remain
  one-root. The current unnamed no-breakaway Job is configured with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`; named Job takeover and weakened
  close/crash cleanup are forbidden.

  R3 `open`/`prepare` must durably write the producer journal as `planned`
  and return `PreparedRuntimeSession { ReconcileRef, generation }` before
  activation. The producer host persists both values before `activate`; the
  one-root convenience methods use the same ordering. Reconciliation returns
  semantic cleanup and `proofSha256`; no native identity crosses the seam.

  Prerequisite: D1-approved R3 choice, D2 authorization, and a red lifecycle
  test. RED proof: a raw Job/handle/PID crosses the seam, a descendant escapes,
  baseline processes are killed, a multi-root close is partial, or live
  `terminate_and_prove` does not produce terminal proof. GREEN verification:

  ~~~powershell
  corepack pnpm nx run capture-sidecar-launcher:cargo-fmt-check --skip-nx-cache
  corepack pnpm nx run capture-sidecar-launcher:cargo-check --skip-nx-cache
  corepack pnpm nx run capture-sidecar-launcher:cargo-test --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:cargo-check --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
  ~~~

  Stop if the existing native owner/export/caller cannot be resolved or a
  desktop coordinator would be required. Rollback: additive revert to the
  prior launcher and retain failed cleanup proof. Commit boundary:
  `feat(desktop): own runtime session lifecycle`.

### D2.4 RuntimeSessionJournalV1 and reconciler slice

- [ ] **Add the durable cleanup record only inside the existing producer
  lifecycle owner.** Owner paths/symbols are
  `packages/capture-sidecar-launcher/src/process.rs:OwnedRuntimeSession` and
  its private state/proof/error types,
  `packages/capture-sidecar-launcher/src/launcher.rs` launch/readiness adapter,
  `packages/capture-sidecar-launcher/src/lib.rs` semantic exports, and desktop
  semantic callers in `apps/capture-workbench-desktop/src-tauri/src/state.rs`,
  `src/launcher.rs`, and `src/commands.rs`. The existing
  `tools/acceptance-checkpoint-journal.ts` (`openAcceptanceCheckpointWriter`,
  `readAcceptanceCheckpointJournal`, and `writeAcceptanceTerminal`) is an
  acceptance evidence journal, not a second native lifecycle owner.

  Implement the exact `RuntimeSessionJournalV1` schema, atomic
  compare-and-swap transitions, setup-committed marker, root/session/staging/
  listener bindings, privacy, and bounded three-attempt/60-second policy from
  the SPEC. Live in-memory close uses the private current unnamed Job handle,
  membership, and nonce and preserves `KILL_ON_JOB_CLOSE`. Restart is
  observe-only: it has no Job handle, membership, or nonce claim; only a
  trustworthy committed setup plus absent exact PID/creation identities,
  absent listeners, and exact staging may terminalize stale state. PID
  reuse/presence/unqueryability, listener ambiguity, root mismatch, or unknown
  identity means `reconcile-required`, touch nothing, and block promotion.

  The producer exposes the exact addressable observe-only API
  `RuntimeSessionJournal::reconcile(ReconcileRef) -> ReconcileResult`.
  `ReconcileRef` is an opaque journal index/address, never a PID, Job handle,
  process id, path, or takeover lease; candidate and prior sessions receive
  distinct refs. A semantic `ReconcileResult` returns cleanup and
  `proofSha256`, and may terminalize only the exact ref with complete
  absence/listener/staging proof. For `prior=null`, the prior ref and
  predecessor proof digest are null and no cleanup proof is implied; a
  non-null prior requires its exact proof digest and generation. Present,
  reused, unqueryable, or ambiguous observations return `reconcile-required`
  and touch nothing. The journal graph is
  `planned -> launching -> running -> closing -> terminal`, with
  `planned -> reconcile-required` and
  `launching|running|closing -> reconcile-required`. A later
  `reconcile-required -> terminal` requires a full observe-only proof, an
  expected state/generation CAS, and a committed self retry attempt update.
  After three automatic failures, the record stays `manual-review` blocked,
  never terminal, and cannot launch a replacement. Direct
  `planned -> terminal` is allowed only when durable proof shows no resource
  could have existed before setup/root/listener/staging acquisition and no
  resource acquisition was attempted.

  Prerequisite: D2.3 lifecycle owner and its native failure adapters. RED proof:
  torn/unknown-generation writes, uncommitted setup, PID reuse, present or
  unqueryable PID, listener ambiguity, staging mismatch, or a restart attempt
  to adopt a Job must fail closed without touching process/listener/staging.
  GREEN verification:

  ~~~powershell
  corepack pnpm nx run capture-sidecar-launcher:cargo-fmt-check --skip-nx-cache
  corepack pnpm nx run capture-sidecar-launcher:cargo-check --skip-nx-cache
  corepack pnpm nx run capture-sidecar-launcher:cargo-test --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:cargo-fmt-check --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:cargo-check --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:cargo-test --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
  ~~~

  There is no dedicated RuntimeSessionJournal Nx target at this head. Add
  focused tests to the existing Cargo/package-QA targets, or record a
  target-creation task after `nx show project`; do not invoke an invented
  `journal-test` target. Stop if native creation identity, Job setup commit,
  or listener binding cannot be proven. Rollback: additive revert of the
  journal/reconciler slice; leave unresolved residue untouched. Commit boundary:
  `feat(runtime): add fail-closed session journal`.

### D2.5 Acceptance evidence and measured baseline slice

- [ ] **Converge the producer/consumer acceptance protocol without adding a
  coordinator.** Current owner paths/symbols are
  `tools/three-project-acceptance.ts:runAcceptanceSequence`,
  `runCaptureWorkbenchAcceptance`, `validateChildManifest`,
  `validateTerminalManifest`, `validateCleanupEvidence`,
  `verifyRecordedCleanupScope`,
  `tools/acceptance-contract.ts:writeAcceptanceManifest`,
  `readAcceptanceManifestTolerant`,
  `apps/capture-workbench-desktop/scripts/acceptance-real.ts:waitForChildClose`,
  `apps/capture-workbench-desktop/scripts/acceptance-orchestration.ts:runCaptureWorkbenchAcceptanceOrchestration`,
  and `apps/capture-workbench-desktop/scripts/real-ocr-result-assertions.ts:assertRealOcrResult`.
  These current child/terminal manifests are migration surfaces. The future
  producer is the sole writer of mutable `ProducerChildScopeV1` at
  `CAPTURE_ACCEPTANCE_SCOPE_PATH`; the current child writes exactly one
  `ConsumerSemanticResultV1` at
  `CAPTURE_ACCEPTANCE_SEMANTIC_RESULT_PATH`; only after validation and
  producer cleanup does the producer write immutable `AcceptanceChildWireV1`
  at `CAPTURE_ACCEPTANCE_WIRE_PATH`. The child receives a read-only
  `ProducerChildInvocationV1` and never receives or writes scope or wire
  records. A read-only invocation snapshot may be nested in scope/input, but
  it must not contain a future result/wire/output digest.

  The exact wire includes `parentGate`, `tier`, a D3 (D4) or D6 (D7) ledger
  binding, invocation digest, `fixtureResults[]` containing actual normalized
  output digest/CER/anchor omissions/outcome/projection digest, expected
  normalized-truth and anchor-set digests, the child semantic-result digest,
  artifact IDs, detailed producer cleanup, privacy flags, and its self-excluded
  canonical JSON digest. The invocation has
  `readyState`, child/sequence identity, D4/D3 or D7/D6
  download/publication binding, predecessor cleanup proof digests,
  oracle/media assignment, a separate output path nonce, and its own
  self-excluded digest. D4 requires full private normalized reference text
  plus critical anchors, as does D7; explicitly delete/prohibit Cert's
  `anchorOnly` and `parseOcrAnchorExpectation` formal paths. Cert and LAW
  reference this exact producer schema and do not redefine it. Preserve the
  existing per-fixture thresholds (PDF page 1 `0.01`, JPEG `0.03`), zero
  critical-anchor omissions, and no averaging.

  The exact Cert adapter migration paths are
  `cert-prep/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:evaluateOcrTruth`,
  `cert-prep/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:normalizeOcrText`,
  `cert-prep/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:parseOcrTruthManifest`,
  `cert-prep/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:levenshtein`,
  `cert-prep/apps/cert-prep-desktop/scripts/acceptance-real-options.mts:parseOcrAnchorExpectation`,
  `cert-prep/apps/cert-prep-desktop/scripts/phase1-acceptance-evidence.mts:buildPhase1AcceptanceEvidence`,
  and `cert-prep/apps/cert-prep-desktop/scripts/ocr-semantic-evidence.mts:serializePrivacySafeOcrSemanticEvidence` /
  `OCR_NORMALIZATION_VERSION`. The exact LAW adapter migration paths are
  `gx.law-prep/apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/capture/FoundryCaptureStructuringProvider.java:FoundryCaptureStructuringProvider`,
  `gx.law-prep/apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/extraction/EvidenceTextExtractionService.java:EvidenceTextExtractionService`,
  `gx.law-prep/apps/law-prep-web-e2e/src/e2e/support/acceptance-expectations.ts:loadLawAcceptanceExpectation`,
  `gx.law-prep/apps/law-prep-web-e2e/src/e2e/support/acceptance-artifacts.ts:writeAcceptanceManifest`,
  and `gx.law-prep/apps/law-prep-ai-service/src/app/ocr/service.py:OcrExtractionService.extract`.
  D4 and D7 use the same producer-owned serial runner with four distinct legs:
  `(1, capture-private-jpeg, capture-private-jpeg-v1)`,
  `(2, capture-scanned-pdf-page1, capture-scanned-pdf-page1-v1)`,
  `(3, cert, cert-v1)`, and `(4, law, law-v1)`. Every leg receives a unique
  `sequenceIndex`, `childKey`, `legId`, `childId`, `root`, and `artifactIds`,
  plus its own artifact and cleanup proof; no identity is reused by another
  leg, candidate, or prior session. CER is <= 3% for every real private JPEG,
  <= 1% for every real scanned PDF page 1, and critical-anchor omissions are
  zero; no averaging. Model memory and journal/process/listener/staging
  cleanup must be proven before the next child.
  `apps/capture-workbench-desktop/scripts/real-jpeg-acceptance-coordinator.ts:runRealJpegAcceptance`
  and `runRealJpegAcceptanceCli`, its test, and its special
  `tools/check-async-boundary.ts` allowance are migration/deletion surfaces;
  migrate them into `tools/three-project-acceptance.ts:runAcceptanceSequence`
  as the sole producer runner, then delete only after residual scans and
  replacement tests pass.

  `AcceptanceChildWireV1` is the producer's only canonical evidence envelope.
  It carries `parentGate`, `tier`, D3/D6 ledger binding, invocation digest,
  `fixtureResults[]` with actual normalized-output digest/CER/anchor omissions/
  outcome/projection digest, child semantic-result digest, artifact IDs,
  detailed producer cleanup, privacy flags, and a self-excluded canonical JSON
  digest. `ProducerChildInvocationV1` carries ready state, the same
  child/sequence identity, exactly one D4/D3 or D7/D6 download/publication
  binding, predecessor cleanup-proof digests, private oracle/media assignment,
  a separate output path nonce, and its own self-excluded digest. It carries
  no future result or wire digest. `PrivateOcrTruthOracleV1` is local/private
  and carries raw normalized reference text and critical anchors beside their
  expected digests, media/page identity, normalization/distance, threshold,
  omission count, and self-excluded oracle digest. Raw truth remains local;
  evidence exports digests and semantic measurements only.

  Serialization is canonical compact UTF-8 JSON with no BOM/trailing newline,
  recursively lexicographically sorted object keys, deterministic semantic
  arrays/set ordering, and lowercase SHA-256. Exclude the self digest field
  before hashing. Hash exact raw media/artifact bytes. Normalize exactly
  `nfkc-whitespace-v1`: NFKC, then newlines and all Unicode whitespace to ASCII
  space, collapse ASCII spaces, trim; preserve case, punctuation, and
  traditional/simplified characters. `code-point-levenshtein-v1` uses Unicode
  code points, and CER is per fixture/page with PDF `0.01`, JPEG `0.03`,
  anchors `0`, and no average. Any schema or scope/identity mismatch fails
  closed without evidence or promotion.
  Record numeric memory/latency/resource evidence before any single-metric
  optimization; never change two metrics in one commit.

  Cert's formal D4/D7 migration is anchored at
  `cert-prep/apps/cert-prep-desktop/scripts/ocr-truth-contract.mts:evaluateOcrTruth`,
  `normalizeOcrText`, `parseOcrTruthManifest`, and `levenshtein`, plus
  `cert-prep/apps/cert-prep-desktop/scripts/acceptance-real-options.mts:parseOcrAnchorExpectation`.
  RED: an `anchorOnly` expectation or the anchor-expectation parser is accepted
  by the formal path. GREEN: both are deleted/prohibited there, full private
  normalized reference text is required, and critical anchors are checked in
  the producer-owned semantic result. Cert consumes the exact producer
  `ConsumerSemanticResultV1`/`AcceptanceChildWireV1` fields and does not define
  a substitute wire.

  The Python LAW adapter is anchored at
  `gx.law-prep/apps/law-prep-ai-service/src/app/ocr/service.py:OcrExtractionService.extract`,
  with its runtime client, readiness, and cleanup seams in that module and
  configuration at `gx.law-prep/apps/law-prep-ai-service/src/app/common/config.py:AiServiceConfig`.
  Add producer-authenticated opaque `requestRef` operations for start, get,
  cancel, and delete. Atomically journal the request ref and operation intent
  before any capture side effect; resolve later operations through that private
  mapping; retain sanitized cleanup state for a bounded period. RED: a missing
  pre-side-effect journal, unbounded retention, token/path exposure, or a
  second OCR route/engine. GREEN: the adapter uses the existing authenticated
  `/v2/captures` operation and lifecycle and keeps API `2.0` plus
  `CaptureOcrProjectionV3` schema `3`. Discovery stop: verify the resolved LAW
  client/config and route metadata before assigning a new target; this
  checkout does not claim such a target exists.

  Prerequisite: D2.3/D2.4 lifecycle design, D2 authorization, explicit
  fixture/anchor manifest, current owner discovery, and the exact producer
  schema review. This D2.5 slice is design/contract/red infrastructure only:
  no installed candidate is a prerequisite and it must not install, stage,
  build, launch, or accept a candidate before D3. RED proof: a missing/invalid
  scope/result/wire or manifest, private evidence leak, non-canonical
  serialization, raw-byte digest mismatch, non-unique leg identity, unknown
  cleanup, anchor omission, threshold violation, request-ref journal failure,
  or child started before prior cleanup must stop the sequence. GREEN
  verification:

  ~~~powershell
  corepack pnpm nx run capture-tools:lint --skip-nx-cache
  corepack pnpm nx run capture-tools:typecheck --skip-nx-cache
  corepack pnpm nx run capture-tools:test --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
  ~~~

  These existing checks cover contract/red infrastructure only; they do not
  prove D3, D4, OCR, GPU, or installed acceptance. If the schema owner, wire
  target, or existing acceptance owner cannot be resolved, stop and report the
  missing discovery rather than inventing a coordinator. Rollback: additive
  revert of acceptance changes and retain failed manifests. Commit boundary:
  `feat(acceptance): centralize producer acceptance runner`.

### D2.5.1 Compute real-proof slice

- [ ] **Compute real-proof slice: preserve usable iGPU selection when dGPU is
  positively unavailable.** The exact owner is
  `packages/capture-runtime/src/capture_runtime/ocr_preflight.py:OcrComputePlan.select`
  with `OcrGpuCapabilitySnapshot`; the focused regression owner is
  `packages/capture-runtime/tests/unit/test_ocr_compute_plan.py:test_positive_unavailable_dgpu_selects_usable_igpu`.
  Model a dGPU with the positive `unavailable` assessment and a usable,
  fully mapped iGPU. The plan must select DirectML on the iGPU with its exact
  LUID/ORT mapping, never CPU; retain the separate indeterminate-dGPU
  fail-closed regression.

  Prerequisite: D1/D2 design approval, current owner discovery, and the
  existing `capture-runtime:test-unit` target. RED proof: the focused test is
  absent or a positively unavailable dGPU incorrectly blocks the usable iGPU,
  selects CPU, or loses the mapping. GREEN verification:

  ~~~powershell
  corepack pnpm nx run capture-runtime:test-unit --skip-nx-cache
  ~~~

  If the owner, symbol, or existing target is absent, record discovery-and-stop
  after `corepack pnpm nx show project capture-runtime --json`; do not invent a
  focused Nx target. Rollback: additive revert of the compute design/test
  slice only. Commit boundary: `test(runtime): cover positive unavailable dGPU`.

### D2.5.2 D3-supplied candidate acceptance target design

- [ ] **Name the future D4 target without invoking it early.** The proposed
  owner is a new target in
  `apps/capture-workbench-desktop/project.json` named
  `capture-workbench-desktop:acceptance-d3-candidate`, backed by the future
  script `apps/capture-workbench-desktop/scripts/acceptance-d3-candidate.ts:runD3CandidateAcceptance`.
  It accepts externally supplied `D3_CANDIDATE_ROOT`, `D3_CANDIDATE_ID`,
  `D3_LEDGER_SHA256`, and `D3_ARTIFACT_DIGESTS` (or equivalent explicit CLI
  values), validates exact root/id/ledger/artifact digests, and consumes only
  the prebuilt D3 bytes. It must never call
  `capture-workbench-desktop:stage-product-runtime`, any build target/script,
  a source-tree import, or a mutable URL. The existing
  `capture-workbench-desktop:acceptance-real` target remains a local installed
  diagnostic and is explicitly non-D4.

  Prerequisite: D2.5 wire schemas and D3's immutable byte ledger. RED proof:
  the target derives bytes from source, stages/builds them, follows a mutable
  URL, accepts missing/mismatched D3 identity, or reuses a candidate/prior
  session ref. GREEN verification is an explicit target/schema-creation stop:
  first run `corepack pnpm nx show project capture-workbench-desktop --json`,
  then create the target and script in a separate authorized implementation
  slice; until they exist, do not invoke the proposed target name. After
  creation, use the existing full `corepack pnpm nx ... --skip-nx-cache`
  checks for the resolved project and the new target only after its metadata is
  recorded. Rollback: additive revert of the target/script/wire slice and
  retain the D3 ledger. Commit boundary:
  `feat(acceptance): consume externally supplied D3 candidate`.

### D2.6 Native verification and deletion slice

- [ ] **Verify the chosen owners together and delete only replaced policy.**
  Owner paths are the concrete runtime, launcher, desktop, and tools project
  metadata plus the OcrPipeline, OwnedRuntimeSession, RuntimeSessionJournalV1,
  and acceptance seams above. Prerequisite: D2.1-D2.5 owner slices are
  authorized, their replacement tests are present, and the resolved Nx target
  metadata is recorded. RED proof: a required target is missing, a
  deleted helper still has callers, a host owns private process/OCR policy, or
  a stale absolute fixture/0.4.1 literal remains. GREEN verification (all are
  existing targets at this head):

  ~~~powershell
  corepack pnpm nx run capture-runtime:lint --skip-nx-cache
  corepack pnpm nx run capture-runtime:typecheck --skip-nx-cache
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
  corepack pnpm nx run capture-tools:release-version-test --skip-nx-cache
  corepack pnpm nx run capture-tools:release-candidate-test --skip-nx-cache
  corepack pnpm nx run capture-tools:release-manifest-test --skip-nx-cache
  corepack pnpm nx run capture-tools:promotion-evidence-test --skip-nx-cache
  corepack pnpm nx run capture-tools:promotion-registry-test --skip-nx-cache
  corepack pnpm nx run capture-tools:release-index-test --skip-nx-cache
  ~~~

  Stop on any unresolved target, owner, or deletion-test failure. The existing
  `capture-runtime:version-check` and
  `capture-workbench-desktop:acceptance-real-ocr-gpu-selection` targets are
  absent; discovery/creation is required before either can be used. Rollback:
  additive revert of the named slice only. Commit boundary:
  `test(phase2): verify converged owner boundaries`.

## D3 - CandidateBuilt

- [ ] **Build one immutable byte ledger from the authorized implementation.**
  Owner paths/symbols:
  `packages/capture-runtime/src/capture_runtime/release.py:build_release_artifacts,sha256_file`,
  `packages/capture-runtime/project.json:build-release-artifacts`,
  `apps/capture-workbench-desktop/scripts/stage-runtime.ts:stageRuntime,validateRuntime,sha256File`,
  `apps/capture-workbench-desktop/scripts/assert-staged-runtime.ts:assertStagedRuntime`,
  `tools/verify-release-candidate.ts:computeCandidateId`,
  `tools/create-release-manifest.ts:main`, and the existing candidate manifest,
  source-lock, catalog, and generated-contract owners. Consume D2 authorization
  and the exact implementation source only. D3 builds one immutable byte ledger
  that records candidate root, candidate id, manifest digest, every raw artifact
  SHA-256, and source/version/schema/contract/model/profile/catalog identity;
  it does not require an installed candidate. D3 owns candidate construction;
  the separately authorized D5-D8 workflow slice owns publication-workflow
  contract changes.

  Prerequisite: all authorized D2 implementation commits, Nx 23.1.2/pnpm 12
  identity checks, and the exact 0.4.2/API 2.0/schema/contract inventory. RED proof:
  every candidate byte has a SHA-256 and the immutable ledger binds source
  commit, version, schema/projection, contract, runtime/worker/model/profile/
  catalog, channel, and build provenance; a source-tree, mutable URL, stale
  version, or mixed artifact fails. GREEN verification:

  ~~~powershell
  corepack pnpm nx run capture-runtime:build-release-artifacts --skip-nx-cache
  corepack pnpm nx run capture-runtime:check-contracts --skip-nx-cache
  corepack pnpm nx run capture-runtime:validate-model-source-lock --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:stage-product-runtime --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:contract-consistency --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:build-nsis --skip-nx-cache
  corepack pnpm nx run capture-tools:release-candidate-test --skip-nx-cache
  corepack pnpm nx run capture-tools:release-manifest-test --skip-nx-cache
  ~~~

  Stop if any required target, manifest identity, source lock, or staged asset
  is absent. Rollback: retain the failed byte ledger and additively revert
  only the implementation slice. Commit boundary: candidate bytes/ledger are
  separate from D4 acceptance and D5 publication commits.

## D4 - CandidateAccepted

 - [ ] **Accept only externally supplied D3 candidate bytes.** The proposed
  future owner is `apps/capture-workbench-desktop/project.json` target
  `capture-workbench-desktop:acceptance-d3-candidate`, backed by
  `apps/capture-workbench-desktop/scripts/acceptance-d3-candidate.ts:runD3CandidateAcceptance`.
  It accepts externally supplied `D3_CANDIDATE_ROOT`, `D3_CANDIDATE_ID`,
  `D3_LEDGER_SHA256`, and `D3_ARTIFACT_DIGESTS`, validates exact root/id/ledger/
  artifact identity, and passes the prebuilt bytes to the producer-owned
  `tools/three-project-acceptance.ts:runAcceptanceSequence` and
  `runCaptureWorkbenchAcceptance`, whose validators are
  `validateChildManifest`, `validateTerminalManifest`,
  `validateCleanupEvidence`, and `verifyRecordedCleanupScope`. Manifest
  serialization remains at `tools/acceptance-contract.ts:writeAcceptanceManifest`
  and `readAcceptanceManifestTolerant`. The target must never call
  `capture-workbench-desktop:stage-product-runtime`, any build target/script,
  source-tree import, or mutable URL, and must not consume a D6 ledger. The
  existing `capture-workbench-desktop:acceptance-real` target remains a local
  installed diagnostic and is explicitly non-D4.

  Prerequisite: D3 immutable byte ledger, the future target's created and
  resolved metadata, real private JPEG and scanned PDF page-1 fixtures with
  critical anchors, model memory release, and lifecycle/journal proof. RED
  proof: the exact externally supplied D3 byte hashes are not present in each
  child, a target derives bytes from source or stages/builds them, a mutable URL
  is used, leg identity/order or CER/anchors fail, or any
  process/listener/staging cleanup is unknown. GREEN verification:

  ~~~powershell
  corepack pnpm nx run capture-tools:lint --skip-nx-cache
  corepack pnpm nx run capture-tools:typecheck --skip-nx-cache
  corepack pnpm nx run capture-tools:test --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
  corepack pnpm nx show project capture-workbench-desktop --json
  ~~~

  The proposed target is absent at this head. Its target/script creation is a
  discovery-and-stop prerequisite after `nx show project`; do not invoke a
  made-up target. The existing `acceptance-real` and
  `acceptance-three-projects` targets remain non-D4 until their producer-wire
  migration is authorized. Stop on the first semantic, identity, process,
  listener, journal, or cleanup failure and retain the sanitized failed
  semantic-result/legacy manifest record.
  Rollback: stop the chain and retain D3/failed D4 evidence; no publication or
  pointer action is allowed. Commit boundary: D4 acceptance evidence is
  separate from D3 candidate bytes and D5 publication.

## D5 - PublishedImmutable

- [ ] **Publish all exact candidate bytes after D4.** This is a future workflow
  contract slice, not a prohibition on workflow edits. Its exact owners are
  `.github/workflows/release-promote.yml`,
  `.github/workflows/_publish-stable-pointer.yml`,
  `.github/workflows/_publish-promotion-ledger.yml`,
  `.github/workflows/_publish-github-release.yml`,
  `.github/workflows/_verify-registries.yml`,
  `tools/create-promotion-ledger.ts:main,parseArguments`,
  `tools/update-release-index.ts:updateReleaseIndex,main`, and the existing
  registry publisher workflows `_publish-npm.yml`, `_publish-pypi.yml`,
  `_publish-maven.yml`, `_publish-crates.yml`, and
  `_publish-runtime-github-release.yml` where the runtime-release lane applies.

  Prerequisite: D4 terminal success, the D3 candidate/byte ledger, and a D2
  workflow-contract authorization. RED proof must fail against the current
  graph because `release-promote.yml` currently makes `promotion-ledger`
  depend on `publish-stable-pointer`. The replacement proof requires
  `release-promote.yml` to consume D4, publish every required npm/GitHub
  Packages, PyPI, Maven, crates.io, and GitHub Release artifact from the same
  D3 bytes, run `_verify-registries.yml`, create the tag/release, and emit the
  D5 publication ledger through `_publish-promotion-ledger.yml` before D6. It
  must remove the direct stable-pointer call and dependency; a selective
  `publication_scope` retry cannot terminalize D5 or dispatch D6 until all
  required lanes pass. D5 never rebuilds, rewrites, or silently substitutes
  bytes.

  GREEN verification of the existing supporting owners:

  ~~~powershell
  corepack pnpm nx run capture-tools:typecheck --skip-nx-cache
  corepack pnpm nx run capture-tools:promotion-evidence-test --skip-nx-cache
  corepack pnpm nx run capture-tools:promotion-registry-test --skip-nx-cache
  corepack pnpm nx run capture-tools:release-manifest-test --skip-nx-cache
  corepack pnpm nx run capture-tools:release-index-test --skip-nx-cache
  ~~~

  No Nx target currently validates this workflow graph. D2 must discover an
  existing `capture-tools` contract-test target or create/record one before
  invoking it; target creation is an explicit discovery stop, not a claimed
  current GREEN result. Stop on any missing channel, byte mismatch, immutable
  version conflict, or workflow-contract target absence. Rollback: stop and
  retain all ledgers; once any 0.4.2 bytes are public, corrections use
  producer supersession only and never overwrite those bytes. Commit boundary:
  workflow/tooling contract changes are separate from D4 evidence and the
  publication ledger.

## D6 - DownloadBackVerified

- [ ] **Fresh-download every D5 public artifact.** The future D6 dispatch
  contract is owned by `.github/workflows/release-promote.yml`; any called
  child workflow must be discovered/named under that orchestration owner. Its
  inputs are the D5 publication-ledger artifact/run, immutable public URLs or
  release tag,
  expected D3/D5 byte and manifest hashes, candidate/source/version/schema/
  contract identity, and no stable or mutable pointer. Its output is an
  independently hashed D6 download bundle/ledger that records the source URL,
  final immutable reference, bytes, and SHA-256 for every channel.

  Prerequisite: D5 terminal publication ledger and public references. RED proof:
  a local path, source package, cache hit, mutable pointer, redirect ambiguity,
  inaccessible manifest, missing channel, semantic-version-only check, or hash
  mismatch fails. GREEN verification of existing supporting owners:

  ~~~powershell
  corepack pnpm nx run capture-tools:promotion-registry-test --skip-nx-cache
  corepack pnpm nx run capture-tools:release-manifest-test --skip-nx-cache
  corepack pnpm nx run capture-tools:promotion-evidence-test --skip-nx-cache
  corepack pnpm nx run capture-tools:typecheck --skip-nx-cache
  ~~~

  No D6 download-back workflow or Nx contract target exists at this head. D2
  must discover or create the workflow dispatch contract and a focused
  `capture-tools` target before calling it; until then stop at discovery/
  creation. Stop on any equality or public-reference failure. Rollback: do not
  accept or promote; retain D5 and failed D6 ledgers. If public 0.4.2 bytes are
  defective, producer supersession is the only rollback and the original bytes
  remain immutable. Commit boundary: D6 download evidence is separate from D5
  publication.

## D7 - PublishedAccepted

- [ ] **Repeat the D4 journey using only D6 downloads.** The future published-
  acceptance dispatch contract is owned by `.github/workflows/release-promote.yml`;
  any called child workflow must be discovered/named under that orchestration
  owner. Its input is only the D6
  download ledger/bundle and the bound D5/D3 identity chain; its output is an
  independent D7 published-acceptance ledger. It invokes
  `tools/three-project-acceptance.ts:runAcceptanceSequence` and
  `runCaptureWorkbenchAcceptance` plus
  `tools/acceptance-contract.ts:writeAcceptanceManifest,
  readAcceptanceManifestTolerant`; its validators are
  `validateChildManifest`, `validateTerminalManifest`, and
  `validateCleanupEvidence` in `tools/three-project-acceptance.ts`. Run in
  strict serial order: Capture JPEG -> cleanup -> Capture original PDF page 1
  -> cleanup -> Cert Prep -> cleanup -> GX Law Prep -> cleanup.

  Prerequisite: D6 fresh-download ledger, installed public bytes, lifecycle
  proof, private fixtures/anchors, and the D2 workflow/target creation record.
  RED proof: any local candidate/source-tree substitution, rebuild/republish,
  child overlap, cleanup ambiguity, CER > 3% JPEG, CER > 1% PDF page 1, or
  critical-anchor omission fails before the next child. GREEN verification of
  existing acceptance owners:

  ~~~powershell
  corepack pnpm nx run capture-tools:lint --skip-nx-cache
  corepack pnpm nx run capture-tools:typecheck --skip-nx-cache
  corepack pnpm nx run capture-tools:test --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:typecheck-scripts --skip-nx-cache
  corepack pnpm nx run capture-workbench-desktop:package-qa-test --skip-nx-cache
  ~~~

  No D7 published-acceptance workflow or Nx contract target exists at this
  head. Discover/create the owner and focused target before invoking it; do not
  mark existing local/package checks, including non-D4 `acceptance-real`, as
  D7. Stop on the first failure and block D8. Rollback: retain D6/D7 ledgers;
  after publication, producer supersession
  is the only correction path and published 0.4.2 bytes remain immutable.
  Commit boundary: D7 acceptance evidence is separate from D6 downloads.

## D8 - StablePointerMoved

- [ ] **Move the stable pointer only through a separate protected dispatch.**
  The implementation owners are the required future protected workflow-dispatch
  entrypoint (a new path must be discovered/created and named in D2),
  `.github/workflows/_publish-stable-pointer.yml`,
  `tools/update-release-index.ts:updateReleaseIndex,main`, and the protected
  `release-index` branch. The dispatch consumes the D7 run/ledger identifiers,
  D7 digest chain, D5 publication ledger, candidate manifest digest, and the
  expected current `stable.json` generation/tag/manifest digest. It runs in
  `capture-release-index` with contents write permission only after checking
  all D3-D7 records and the CAS guard. It must not be an automatic D5 edge.

  Prerequisite: D7 terminal success and the D2 record naming the protected
  dispatch owner. RED proof: a missing D7 chain, changed expected pointer,
  stale generation, manifest mismatch, or non-producer caller aborts without
  touching the protected branch. GREEN verification of the existing updater:

  ~~~powershell
  corepack pnpm nx run capture-tools:release-index-test --skip-nx-cache
  corepack pnpm nx run capture-tools:promotion-evidence-test --skip-nx-cache
  corepack pnpm nx run capture-tools:typecheck --skip-nx-cache
  ~~~

  The current `_publish-stable-pointer.yml` is a reusable workflow, not a
  separate protected D8 dispatch, and its updater has no D7/CAS input yet.
  Discover/create the missing workflow contract and focused target before
  calling them; otherwise stop. Rollback is producer supersession only: publish
  a corrected successor, then supersede the defective release through the
  protected producer operation. Never directly revert the pointer, rewrite
  history, or overwrite published 0.4.2 bytes. Commit boundary: the protected
  pointer receipt is separate from D7 evidence and the docs commit.

## Documentation handoff and verification

The docs worker stages only these six documentation paths and never stages the
untracked instruction files:

~~~text
.agents/SPECS/capture-runtime-042-p2-hardening.md
.agents/DECISIONS/capture-runtime-042-p2-hardening.md
.agents/TODOS/capture-runtime-042-p2-hardening.md
.agents/GUIDES/staged-ocr-delivery-workflow.md
packages/capture-workbench-ui/README.md
apps/capture-workbench-desktop/README.md
~~~

Before commit, verify:

~~~powershell
git diff --check -- .agents/SPECS/capture-runtime-042-p2-hardening.md .agents/DECISIONS/capture-runtime-042-p2-hardening.md .agents/TODOS/capture-runtime-042-p2-hardening.md .agents/GUIDES/staged-ocr-delivery-workflow.md packages/capture-workbench-ui/README.md apps/capture-workbench-desktop/README.md
corepack pnpm nx show project capture-runtime --json
corepack pnpm nx show project capture-sidecar-launcher --json
corepack pnpm nx show project capture-tools --json
corepack pnpm nx show project capture-workbench-desktop --json
rg -n "class OcrPipeline|OwnedRuntimeSession|collectReleaseVersionEntries|runAcceptanceSequence|writeAcceptanceManifest|updateReleaseIndex" packages apps tools
git diff --name-only
git status --short
~~~

Validate relative links and anchors, balanced Markdown fences, actual owner
paths/symbols/workflows, resolved existing Nx target names, absence of
repository-specific absolute fixture paths, and absence of a published-version
claim or concrete registry install in the UI README. Stage explicit paths only,
run `git diff --cached --check` and `git diff --cached --name-only`, then commit
`docs(phase2): resolve architecture review findings`. After commit, report the
new `git rev-parse HEAD`, exact staged/committed names, checks and results, and
unresolved D1/implementation/publication/download-back/D7/D8 gates. Never push.
