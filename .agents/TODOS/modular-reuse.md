# Modular Host Reuse TODO

## Phase 0 - stop the bleeding

- [x] Verify `@gx-capture/capture-workbench@0.3.10` through the canonical GitHub
      Packages registry and record the install source.
      Evidence: `gh api /orgs/gx-capture/packages/npm/capture-workbench/versions`
      returned `0.3.10`; authenticated registry metadata returned the version,
      tarball, and integrity `sha512-a7YBguKhNER76WHoEPPht4L5+OxYelcLumDpbuqWzGw4VDWIVX0LnVFHQ6GeguMC/PRKIBN+8dBxxl/wdIcsPQ==`.
- [x] Inventory cert-prep version declarations and hand-cast seams; keep this
      consumer work blocked until producer availability is evidenced.
      Evidence: cert-prep root package, lockfile, workspace exclusion, runtime
      constants, and `tools/capture-runtime-version-check.mts` are already
      aligned to `0.3.10`; unrelated sibling dirty governance files remain out
      of scope.

## Phase 1 - generated shared contracts

- [x] Pin the generator/toolchain and create the TS/Python package owner from
      runtime contracts; preserve aliases, strict validation, and schema hash.
      Evidence: `packages/capture-contracts`, Pydantic `2.13.4`,
      pydantic-core `2.46.4`, generated 21 model schemas, and the pinned
      `CaptureDocumentV1` SHA `2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2`.
- [x] Add regeneration-diff and synchronized-version checks.
      Evidence: `capture-runtime:generate-contracts`,
      `capture-runtime:check-contracts`, `capture-runtime:test` (218 passed,
      1 skipped), and `verify:release-version -- v0.3.10` all pass.
- [x] Build/pack the producer artifacts and wire the TypeScript package into
      the release publication path.
      Evidence: `capture-contracts:build`, `capture-contracts:pack`,
      `capture-contracts:python-build`, source and wheel smoke tests, and the
      multi-package `tools/publish-release.ts` preflight/idempotency tests all
      pass. The tagged `0.3.10` release workflow and registry publication
      gates are now complete.
- [x] Export generated semantic metadata for future host SDK consumers.
      Evidence: `CAPTURE_CONTRACT_INVARIANTS` and
      `CAPTURE_CONTRACT_EXTRA_POLICIES` are generated from the same runtime
      schemas and documented as metadata rather than a second validator.
- [x] Prove the Python wheel artifact in a fresh virtual environment and remove
      the smoke test's hard-coded runtime version.
      Evidence: `capture-contracts:python-wheel-smoke` installs the built wheel
      into a temporary venv and derives the version assertion from the package
      manifest.
- [x] Delete cert-prep's hand-mirrored DTO owner and migrate backend imports to
      the generated `capture_contracts` API; keep the source cutover gated on
      publication evidence.
      Evidence: backend focused tests and import scan pass; `contracts.py` is
      absent and the generated models serialize with strict extra-field policy.
- [x] Publish npm, PyPI, and crates.io `0.3.10` artifacts, run clean registry
      install/import probes, then switch cert-prep and law-prep lockfiles and
      source declarations away from local paths.
      Evidence: producer CI run `31007970169` passed at commit `a3a7fee`;
      crates-only recovery run `31009720361` produced the
      `registry-recovery-complete` ledger with candidate run `30988734322`,
      schema SHA `2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2`,
      and crates.io archive SHA
      `533f497aa550589cec8e608c6b5fee29e69afb638ffe9d8c4cc41c0c4654bd0f`.
      Cert-prep PR #1 and law-prep PR #67 pass their clean registry install,
      consumer consistency, backend/Java, and desktop CI gates with no capture
      package path sources.

## Phase 1.5 - in-repo consumers first

- [x] Migrate `capture-angular` to `@gx-capture/capture-contracts` via
      `workspace:*`; delete its hand-maintained wire DTOs, version constants,
      generated schema copy, and `sync-angular-schema` target. Keep Angular
      request/DI/config/event API types local.
- [x] Repair the generated TypeScript fidelity gap needed by the producer
      consumer: tagged locator `kind` discriminators, tuple `boundingBox`,
      aliases, and a browser-safe generated document-schema constant now come
      from the same generator. Remaining `allOf`/cross-field/runtime constraint
      validation stays canonical in the runtime.
- [x] Add desktop contract consistency verification for the contracts manifest,
      Cargo version constants, staged runtime manifest, and schema SHA-256;
      wire it into the desktop Nx/CI lane.
- [x] Run packed Angular/Vanilla/React/Vue consumer smoke against both local
      producer artifacts; the publication gate remains explicit.
      Evidence: `capture-angular:clean-consumer-smoke` passed all four browser
      smokes; `capture-workbench-desktop:contract-consistency` passed.
- [x] Run an opt-in real loopback packaged Capture Runtime plus packed Web
      Component browser E2E with an explicit host-managed handshake and a real
      OCR PDF.
      Evidence:
      `capture-workbench-e2e:runtime-web-component-e2e` passed the runtime
      handshake, consented OCR installation, real PDF upload, capture polling,
      DirectML OCR provenance, embedded-text conformance for every extractable
      page, result retrieval, Shadow DOM lifecycle, and composed completion
      event. A rendered page-1 visual spot check covered the PDF and completed
      Web Component result view. The target is opt-in so ordinary verification
      does not download model assets.

## Phase 2 - host structuring SDK

- [x] Extract batching, prompt assembly, minimal semantic block validation, and
      canonical document assembly into the shared SDK.
      Evidence: `capture-structuring-python` and TypeScript SDK tests/builds,
      pinned generated schema/hash validation, and law-prep Foundry Local host
      integration pass.
- [x] Rewire runtime Ollama/fake providers to the shared implementation.
      Evidence: `capture-runtime:test` and standalone producer verification
      remain green with the shared brain-agnostic implementation.
- [x] Migrate cert-prep to a thin host LLM adapter; delete full-block echoing.
      Evidence: cert-prep structuring/backend regression tests and host
      consumer consistency checks pass.

## Phase 3 - shared launcher crate

- [x] Extract launcher/process/health/launch-policy/manifest mechanics and
      constants into a publishable Rust crate.
      Evidence: `cargo fmt --check`, `cargo check`, crate tests, and
      `cargo publish --dry-run` pass for `capture-sidecar-launcher@0.3.10`;
      the public crates.io archive is verified by recovery run `31009720361`.
- [x] Rewire Workbench desktop and then cert-prep desktop; retain each host's
      installer/download and persistence responsibilities.
      Evidence: both desktop manifests consume the launcher crate through the
      shared package boundary; desktop contract/consumer tests pass. Registry
      publication remains covered by the active release gate above.

## Phase 4 - governance and final proof

- [x] Add changelog, synchronized artifact versions, and 0.x minor alignment
      with deprecation/break-glass evidence.
      Evidence: `CHANGELOG.md`, producer/consumer minor-alignment handshakes,
      release-version checks, and compatibility tests pass.
- [x] Keep Angular/Vanilla/React/Vue clean-consumer smoke green after each
      producer phase and record standalone desktop evidence.
      Evidence: `capture-angular:clean-consumer-smoke` and proportional
      standalone desktop verification pass against local packed artifacts.
- [x] Complete law-prep proof with the non-Ollama brain/platform.
      Evidence: Foundry Local drives the host structuring path; Java validates
      the staged producer schema and manifest before Jackson mapping.
- [x] Add law-prep's runtime JSON Schema plus manifest version/SHA validation
      before Jackson DTO mapping; keep Angular web migration deferred.
      Evidence: Java validator positive/negative tests, staged-runtime tests,
      and law-prep Tauri contract tests pass.
- [ ] Run the engine-bearing Windows OCR/Whisper packaged smoke only after the
      published `0.3.10` runtime is available; clean runtime, models, app data,
      generated output, and owned processes afterward. The checked-in OCR PDF
      and image are available, but the lock-selected private audio fixture is
      not present on this machine; do not synthesize a replacement.

## 0.3.12 v2 producer and consumer release gates

- [x] Reconcile the authenticated v2 SSE contract with generated contracts,
      live durable replay, heartbeat comments, `Last-Event-ID`, and terminal or
      host-handoff close semantics.
- [x] Reconcile the v2 Web Component import boundary. The package-owned
      `loader.mjs` owns Angular compiler/elements dependencies; clean Angular,
      Vanilla, React, and Vue consumers use only the public package entry point.
- [x] Add v2 host candidate commit/failure parity with idempotency and strict
      provenance validation. Verify: focused runtime API/contract tests.
- [ ] Build one exact-source 0.3.12 candidate and update all three consumer
      lockfiles to its published tarball integrity; never fabricate registry
      URLs or reuse the mixed 0.3.11 artifact.
- [ ] Publish the matching GitHub Release runtime executable and manifest, then
      run engine-bearing Windows OCR/Whisper smoke with cleanup evidence.
- [ ] Complete gx.law-prep, cert-prep, and capture-workbench consumer gates
      against the same immutable candidate before promote. Keep the existing
      PyPI/crates.io workflows until a separate artifact-ownership review proves
      they can be retired safely.
