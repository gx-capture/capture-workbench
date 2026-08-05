# Modular Host-Reuse Plan for capture-workbench

> Audience: Codex (implementation agent). Status: plan. Read-only review
> produced this on 2026-08-04; no code has been changed yet.
>
> Owner repos: `capture-workbench` (producer, this repo) and `cert-prep`
> (consumer, sibling at `C:\software-dev\cert-prep`).

> Version-train note: the original `0.3.9` target is already an immutable
> runtime release. The successor train implemented by this closeout is
> `0.3.10`; `0.3.9` must not be overwritten or retagged.

## Goal

Make `capture-workbench` a genuinely **modular, brain-agnostic** product that
`cert-prep`, `law-prep`, and future hosts pull in so the **host's own LLM
brain** can drive capture + structuring. Today the host re-implements the whole
integration layer (launcher, wire contracts, structuring scaffolding) in three
languages and the copies are already drifting. This plan moves those layers
into shared, importable artifacts published from capture-workbench, while
keeping heavy native extraction (OCR / Whisper) as a sidecar process.

## Architectural principle (do not violate)

- **The HOST owns the brain.** capture-workbench never makes the LLM call. The
  host does. capture-workbench is therefore brain-agnostic — Ollama today only
  by coincidence; `law-prep` may use Foundry AI or any other LLM.
- `external-ollama` is an **optional convenience** for Ollama-family brains and
  for capture-workbench's own standalone desktop product. It is **not** the
  integration model. Do not migrate consumers onto it as the integration model.
- cert-prep's current `structuringMode: 'host'` + `hostStructuringOwner:
  'client'` is **correct** for this principle. The bug is that capture-workbench
  gives the host no reusable scaffolding, so cert-prep reimplemented it
  unsafely.
- **Heavy native extraction stays a sidecar.** Pure logic (contracts,
  structuring scaffolding, launcher mechanics) becomes importable libraries.

## Target layering (form per layer)

| Layer | Target form | Status today |
|---|---|---|
| Angular component | npm lib `@gx-capture/capture-workbench` | ✅ done |
| Wire contracts / schema | generated shared types pkg (TS + Py) | ❌ hand-mirrored in cert-prep |
| Structuring scaffolding | host SDK (Py wheel + TS) | ❌ locked in sidecar; cert-prep forked it unsafely |
| Sidecar lifecycle | shared Rust crate | ❌ cert-prep forked it, already drifting |
| Native extraction (OCR / Whisper) | sidecar process | ✅ done, correct — leave as-is |

## Non-goals / hard constraints

- Do **not** collapse repos into a monorepo (deliberately rejected; preserves
  the independent product boundary).
- Do **not** change `CaptureDocumentV1` — not its schema, `$id`, or pinned
  SHA-256 `2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2`.
- Do **not** remove the runtime's `ollama` / `external-ollama` / `fake`
  structuring providers — still used by the standalone desktop product and by
  external-ollama consumers.
- Do **not** move OCR/Whisper out of the sidecar.
- Preserve the **credential boundary**: the sidecar bearer token never reaches
  Angular / WebView / storage / logs.
- Keep the **standalone capture-workbench desktop product fully working** at
  every phase (it uses the Ollama providers).
- `law-prep` is **read-only** until its platform/brain is concrete; use it only
  as the brain-agnosticism proof in Phase 5.
- Trust discipline unchanged: the runtime remains the **canonical validator**
  (host always `POST /structure`s and persists only after success).

## Sequencing

Phase 0 first (independent, stops a live bug). Phases 1–3 are the dedup core,
in leverage order: **2 (structuring SDK) > 1 (contracts) > 3 (launcher)**.
Phase 4 runs in parallel / ongoing. Phase 5 is gated on the law-prep platform
decision.

### Cross-phase dependencies and rollout order

The leverage ranking above is not the execution order. Phase 1 contracts are a
hard input to the Phase 2 SDK because the SDK API is typed on `RawCaptureV1`
and `CaptureSemanticBlockV1`; execute those phases as **1 -> 2 -> 3** unless
Phase 2 explicitly imports the contract types directly from the runtime and
documents that exception.

- **Phase 0.0 prerequisite:** confirm that
  `@gx-capture/capture-workbench@0.3.10` is published. If it is absent, cut
  that producer release before attempting the consumer alignment in 0.1.
- **Producer before consumer:** publish each contracts package, structuring
  SDK, and launcher crate before its corresponding cert-prep consumer phase
  starts. Record the package version and install source in the phase evidence.
- **In-repo consumers before external ones (Phase 1.5):** capture-workbench's
  own `capture-angular` and desktop must consume `@gx-capture/capture-contracts`
  before cert-prep/law-prep do. The producer is the first consumer of its own
  contract — eat your own dog food, retire the parallel in-repo schema path, and
  surface lossy-codegen friction internally rather than in a consumer PR.
- **Handshake rollout:** Phase 4.2 is breaking for any 0.3.x/0.3.y split pair.
  Enforce minor alignment only after all in-scope consumers are confirmed to
  be on the same minor; provide a deprecation note and an explicit break-glass
  or rollback path.
- **Open decisions before implementation:** choose the Python wheel registry
  and CI authentication mechanism; pin the Pydantic and schema-generator
  versions; confirm that `sourceSegmentId` is stable and unique in
  `RawCaptureV1`; and define rollback ownership for each cross-repo phase.

---

## Phase 0 — Stop the bleeding (cert-prep; immediate; independent)

cert-prep currently ships an **untested combination**: `@gx-capture/capture-workbench@0.3.8`
(npm component) + runtime `0.3.10` (Rust/Python/manifest/UI all say 0.3.10). The
compatibility handshake only checks major `0`, so it cannot catch this.

**0.0** Confirm that `@gx-capture/capture-workbench@0.3.10` is published and
installable by cert-prep. If it is not published, cut the producer component
release before changing consumer pins.

**0.1** Pick the canonical target version (`0.3.10`) and align every declaration:
- `apps/cert-prep/package.json` (`@gx-capture/capture-workbench` pin)
- `pnpm-lock.yaml`, `pnpm-workspace.yaml` (`minimumReleaseAgeExclude`)
- `apps/cert-prep-desktop/scripts/package-qa/constants.mts` (`CAPTURE_RUNTIME_VERSION`)
- `apps/cert-prep-backend/src/cert_prep_backend/domains/capture_workbench/contracts.py` (`SUPPORTED_RUNTIME_VERSION`)
- `tools/install-local-capture-workbench.mts` (`packageVersion`)
- `tools/install-capture-runtime.test.mts` (URL expectation)

**0.2** Source version strings from ONE place: import
`CAPTURE_RUNTIME_MAJOR` / `CAPTURE_API_VERSION` / `CAPTURE_DOCUMENT_SCHEMA_VERSION`
from the package; derive UI copy from the runtime handshake instead of the
nine hardcoded `0.3.10` literals (`cert-prep-capture-client.ts:432` passes a
literal `0` instead of `CAPTURE_RUNTIME_MAJOR`; `desktop-runtime.store.ts:282`,
`capture-workbench-trial.page.ts:160`, `capture-workbench-trial.page.html:7`,
`desktop-runtime-view.service.ts:42,62,100`).

**0.3** Add a **consumer-side version-consistency check** mirroring
`tools/verify-release-version.ts`; wire it as an nx target + CI step that fails
if any of the declarations in 0.1 diverge.

**0.4** Cleanups: replace the `as unknown as` double-casts at
`cert-prep-capture-client.ts:201,208` with real field mappers; delete the
orphaned `deterministic-capture-client.ts`; remove or wire up the dead
`SUPPORTED_API_VERSION` / `SUPPORTED_RUNTIME_VERSION` constants in `contracts.py`.

**Acceptance:** single source of truth for versions; consistency check green in
CI; the handshake and UI consume the imported version constants; no
`as unknown as` at the raw/result seam. Drift detection is provided by 0.3's
consumer consistency check and Phase 4.2's cross-minor handshake policy.

---

## Phase 1 — Publish shared wire-contract package (producer)

**1.1** Create `packages/capture-contracts` (TS) and a `capture_contracts`
Python package, **generated** from the runtime's Pydantic models /
`model_json_schema()`. Single source:
`packages/capture-runtime/src/capture_runtime/contracts/__init__.py` and the
generator at `packages/capture-runtime/scripts/generate_contracts.py` (pinned SHA
in `packages/capture-runtime/src/capture_runtime/release.py:22-24,111-131`).
Pin the Pydantic and schema-generator versions used by this process, and record
the generator toolchain version alongside the pinned release evidence so the
regeneration diff is deterministic.

**1.2** Publish the TS package to the existing GitHub Packages namespace
alongside `@gx-capture/capture-workbench`; publish the Python wheels to public
PyPI with GitHub Actions OIDC Trusted Publishing, without conflating them with
the standalone runtime executable asset inventory. The consumer cutover is
gated on clean PyPI installation and import probes.

**1.3** Add a **regeneration-diff contract test** to producer CI: regenerate
contracts from the runtime and diff against the committed package; fail on
drift. Extend `tools/verify-release-version.ts` to cover the new package so it
stays version-synchronized at the source.

**1.4** cert-prep consumes it: replace the hand-mirrored
`apps/cert-prep-backend/.../capture_workbench/contracts.py` and the TS type
imports in `apps/cert-prep/src/app/pages/capture-workbench-trial/` with the
published package.

**Acceptance:** zero hand-mirrored DTOs in cert-prep; the regeneration-diff
test gates the producer; existing cert-prep backend tests pass.

### Release asset boundary

The public release must distinguish runtime execution dependencies from
build-time and release-evidence artifacts. The standalone Windows runtime is
self-contained: the executable embeds the engine catalog used by its runtime
dependency graph, so it does not require an external JSON catalog to start or
serve requests.

- For the standalone runtime distribution, publish the x64 runtime executable
  and its `.sha256` checksum. The checksum is not required for execution, but
  is the recommended download-integrity control.
- For the desktop product, the NSIS installer is the end-user artifact. It
  already contains the runtime plus the manifest and schema resources needed by
  the installed Tauri host.
- Keep `capture-runtime-manifest.json`,
  `capture-document-v1.schema.json`, `capture-engine-catalog.json`, and
  `runtime-size-report.json` (and their checksums) in the CI/release-candidate
  workspace for staging, contract, provenance, and size validation, but do not
  publish them as GitHub Release assets unless an external consumer is
  explicitly designed to consume them.
- Removing these files from the public asset inventory must not remove their
  build-time validation. The publisher, exact-asset tests, README, and local
  release-consumer smoke must enforce the smaller public inventory while still
  validating the internal candidate files before publication.

The target public inventory is therefore either the standalone runtime
executable plus checksum, or the desktop installer alone; it is not the
current nine-file mixture of runtime, metadata, QA evidence, and installer.

---

## Phase 1.5 — Migrate in-repo consumers first (producer; before external consumers)

Phase 1 ships `@gx-capture/capture-contracts`, but today **nothing in-repo consumes
it** — `capture-angular` still carries hand-written wire types
(`src/lib/contracts/index.ts`, `src/lib/contracts/versions.ts`) plus its own
generated schema, and `capture-workbench-desktop` carries its own schema-resource
copy and Rust version constants (`constants/versions.rs`). There are four
`capture-document-v1.schema.json` copies in-repo before this phase; the two under
`capture-contracts/` are generator outputs and the desktop copy remains a staged
resource verified by CI. The producer therefore has the same duplication the
package is meant to eliminate. This phase makes capture-workbench
the **first consumer of its own contract** before cert-prep/law-prep depend on it.

**1.5.1** `capture-angular`: import the wire-model types, version constants, and
document schema from `@gx-capture/capture-contracts` via `workspace:*` (valid for
in-repo consumers even though external consumers use the published package). **Keep
package-API types local** — `CaptureClient` (the DI seam), `CaptureOutputMode`,
`CaptureDensity`, component-config types, and the custom-event map are
capture-angular's own surface, not wire types. Retire the Angular-specific
TypeScript-output path and the `sync-angular-schema` target; retain
`generate_schema.py` because it owns the runtime release schema artifact, while
Angular no longer owns a schema copy.

**1.5.2** Resolve the lossy-codegen regression before migrating. The generator
now emits required `kind` discriminators, tuple `boundingBox`, aliases, and a
browser-safe schema constant.
Tagged locator unions now carry a required `kind:` discriminator, and
`PageLocatorV1.boundingBox` is emitted as a four-number tuple.
The generator now owns the tagged-union output and no Angular overlay is needed.
It also emits aliases and a browser-safe schema constant; the remaining
`allOf` and cross-field constraints stay runtime-validator concerns.
The invariants and `extraPolicy` are exported to TS for capture-angular early
checks.

**1.5.3** `capture-workbench-desktop` (Rust) cannot import a TS/Python package.
Add a **build-time consistency check** to CI that verifies the desktop
schema-resource copy and `constants/versions.rs` (`EXPECTED_*_VERSION`) against the
`capture-contracts` manifest and schema SHA-256. A shared Rust contracts crate is
the longer-term end state and is explicitly out of scope here.

**1.5.4** Verify the standalone desktop product and the Angular/Vanilla/React/Vue
`clean-consumer-smoke` stay green throughout.

**Acceptance:** zero hand-maintained wire-model TS duplicates in `capture-angular`;
its only document-schema source is `@gx-capture/capture-contracts`; the Rust
constants/schema are verified against the manifest in CI; the standalone product
and consumer smokes are unaffected. The clean consumer smoke uses local packed
producer artifacts until the corresponding npm/PyPI publication and
registry-install gates are closed.
Once the producer itself is a consumer, cert-prep's
Phase 1.4 migration de-risks onto a proven artifact instead of an orphan package.

---

## Phase 2 — Publish brain-agnostic structuring host SDK (producer) — highest leverage

**2.1** Extract the brain-agnostic scaffolding out of
`packages/capture-runtime/src/capture_runtime/structuring.py` into a
host-importable SDK (Python wheel + TS module): `plan_structuring_batches`,
`build_structuring_batch_prompt`, `validate_structuring_batch`,
`assemble_structuring_document`, and the minimal block contract
(`CaptureSemanticBlockV1` = `sourceSegmentId` + `type` + optional
`targetText`). **Extract, do not move-and-duplicate** — the runtime's own
providers should import these same modules so the standalone product is
unchanged.

**2.2** SDK API shape: *"given `RawCaptureV1` + a host-supplied
`llm_generate(prompt, schema) -> bytes` callable, return a validated
structuring candidate."* The host owns the actual LLM call (Ollama / Foundry /
anything); the SDK owns batching, prompt assembly, and provenance-safe
validation.

**2.3** Enforce the **safe provenance model** in the SDK: the host LLM returns
ONLY the minimal fields; the SDK reconstructs trusted provenance and the host
`POST /structure`s the candidate for canonical validation. Document that
asking the LLM to echo the full block (`blockId/order/locator/sourceText/...`)
is forbidden — that is the exact anti-pattern cert-prep currently has.

**2.4** cert-prep consumes it: delete the reimplementation in
`apps/cert-prep-backend/.../capture_workbench/structuring.py`
(`_plan_batches`, `_estimated_json_tokens`, `_estimated_block_output_tokens`,
the full-block prompt at `:299-309`, `_validated_batch`) and reduce it to an
LLM-call wrapper around the SDK, driven by cert-prep's reasoning Ollama.

**Acceptance:** cert-prep's `structuring.py` reduced to a thin adapter over the
SDK; the unsafe full-block-echo path removed; existing structuring tests pass
against the SDK; SDK-emitted documents validate against the pinned
`CaptureDocumentV1` schema and SHA-256; standalone desktop product structuring
unchanged.

---

## Phase 3 — Publish shared sidecar-launcher crate (producer)

**3.1** Extract
`apps/capture-workbench-desktop/src-tauri/src/{launcher,process,health,launch_policy,manifest}.rs`
(+ `constants/launch.rs`, `constants/versions.rs`) into a shared Rust crate
(e.g. `capture-sidecar-launcher`) published from capture-workbench. It owns:
loopback port reservation, bearer-token generation, the `/v1/health/ready`
probe, HTTP parser, exact-match handshake compare, `wait_until_ready`, the
Windows Job-Object + `CREATE_SUSPENDED` process killer, and the 3-attempt
bounded retry.

**3.2** Both `capture-workbench-desktop` and `cert-prep-desktop` depend on the
crate. cert-prep deletes the duplicated mechanics in
`apps/cert-prep-desktop/src-tauri/src/capture_runtime.rs` (probe/parser/
handshake/wait-loop/port/token) and `windows_process.rs`, **keeping only its
legitimate install/download-on-demand flow** (`capture_runtime.rs`
`install_bundled_capture_runtime` + `capture_manifest.rs`) which has no
capture-workbench counterpart.

**3.3** Add a **shared probe+handshake contract test** both sides run, so the
`/v1/health/ready` contract cannot drift silently.

**3.4** cert-prep inherits the stronger process killer (Job-Object) and the
3-attempt launch retry as a side benefit.

**Acceptance:** zero duplicated launcher mechanics in cert-prep; cert-prep
gets retry + Job-Object kill; the shared contract test is green on both sides;
the shared crate never exposes bearer tokens across the host/webview boundary
and all launcher logging is token-redacted.

---

## Phase 4 — Version governance (both)

**4.1** Producer: add `CHANGELOG.md`; adopt an explicit **0.x semver policy**
(recommend: while 0.x, treat minor bumps as potentially-breaking and enforce
**minor** alignment in the handshake, not just `major == 0`). Keep
`tools/verify-release-version.ts` as the producer-internal sync gate.

**4.2** Bump `assertCaptureRuntimeCompatible`
(`packages/capture-angular/src/lib/capture-helpers.ts:90-130`) and the Python
`_assert_compatible` (`client.py:329-345`) to enforce minor alignment while 0.x.
Replace the magic literal `"0.3.8"` in `coordinator.py:236` with an explicit,

The minor-alignment flip must be treated as a breaking rollout: enumerate the
in-scope consumers, confirm same-minor deployment before enabling strictness,
publish a deprecation notice, and retain an explicit break-glass or rollback
path for an undiscovered split pair.

**4.3** Consumer: Phase 0's consistency check becomes permanent CI.

**Acceptance:** changelog published with each release; handshake rejects
cross-minor mismatch; consumer CI enforces declaration consistency.

---

## Phase 5 — Brain-agnostic proof (law-prep; validation only)

**5.1** Once law-prep's brain (e.g. Foundry AI) is concrete, wire it to the
Phase 2 host SDK as the `llm_generate` callable. **No capture-workbench change
should be required** — this is the proof of brain-agnosticism.

**5.2** Confirm capture-workbench is drivable end-to-end by a non-Ollama brain.

**Acceptance:** law-prep structures captures via its own brain through the host
SDK with zero capture-workbench brain-coupling.

---

## Verification strategy (all phases)

- Keep capture-workbench's `clean-consumer-smoke` green (Angular/Vanilla/
  React/Vue hosts) after every phase.

## 0.3.10 closeout status

The producer-side generated contracts, Python wheels, TypeScript packages,
structuring SDK artifacts, launcher crate metadata, release candidate ledger,
and registry publication jobs are implemented and locally verified. The
runtime schema generator remains an active release input at
`packages/capture-runtime/scripts/generate_schema.py`; it is not dead code.

Cert Prep now imports generated Python contracts, deletes its hand-mirrored
contract module, uses fail-closed raw/document mappers, and permanently runs
the consumer consistency target. Law Prep validates Foundry responses against
the staged schema and pinned runtime manifest before Jackson mapping; its
Angular web migration remains deferred.

The following gates remain active until external state changes: publishing the
three npm/PyPI/crates.io artifact groups, registry-install probes, switching
consumer lockfiles away from local paths, and the engine-bearing Windows
OCR/Whisper packaged smoke with cleanup evidence. No unpublished artifact or
path-based consumer is counted as complete.
- Add an **end-to-end "real runtime + real published package + real PDF"**
  smoke to consumer CI (Windows runner); wire `local-release-consumer-smoke`
  into the producer release-candidate job (it exists but is not CI-wired today).
  The smoke must verify the reduced public asset inventory while validating the
  manifest, schema, catalog, and size report from the internal candidate before
  publication.
- `tools/verify-release-version.ts` must cover every newly published artifact
  (contracts package, structuring SDK, launcher crate) so producer versions
  stay synchronized at the source.
- Trust discipline unchanged: runtime remains canonical validator; host
  persists only after `POST /structure` success.
- Every cross-repo phase must document producer publication, consumer install,
  rollback ownership, and the evidence that the standalone product remains
  green.

## Risk

The dominant risk is that **extracting from the runtime regresses the
standalone desktop product.** Mitigation: extract (shared modules), never
move-and-duplicate; keep the runtime's internal providers intact; run the
standalone product's full verify suite as a gate on Phases 1–3.
