# Modular Host Reuse TODO

## Phase 0 - stop the bleeding

- [x] Verify `@gx-capture/capture-workbench@0.3.9` through the canonical GitHub
      Packages registry and record the install source.
      Evidence: `gh api /orgs/gx-capture/packages/npm/capture-workbench/versions`
      returned `0.3.9`; authenticated `npm view` returned the version, tarball,
      and integrity `sha512-GBt6y4lq3yjv0hSo1q5A5Y/H+bVdEwH+XcbicjCnkYohy1QKpwnoySBsYg7KYXP7pebhQ2Y2mri1tWEBZQSZZg==`.
- [x] Inventory cert-prep version declarations and hand-cast seams; keep this
      consumer work blocked until producer availability is evidenced.
      Evidence: cert-prep root package, lockfile, workspace exclusion, runtime
      constants, and `tools/capture-runtime-version-check.mts` are already
      aligned to `0.3.9`; unrelated sibling dirty governance files remain out
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
      1 skipped), and `verify:release-version -- v0.3.9` all pass.
- [x] Build/pack the producer artifacts without publishing.
      Evidence: `capture-contracts:build`, `capture-contracts:python-build`,
      the `0.3.9` npm tarball inventory, and the `capture_contracts-0.3.9`
      wheel inventory/import smoke all pass. Publication remains gated on the
      registry/auth decision.
- [ ] Migrate cert-prep only after publication/auth evidence; delete its
      hand-mirrored DTO owner rather than adding a compatibility shim.
      Verify: cert-prep backend focused tests and import scan.

## Phase 2 - host structuring SDK

- [ ] Extract batching, prompt assembly, minimal semantic block validation, and
      canonical document assembly into the shared SDK.
      Verify: SDK unit tests and pinned schema/hash validation.
- [ ] Rewire runtime Ollama/fake providers to the shared implementation.
      Verify: `corepack pnpm nx run capture-runtime:test` and standalone smoke.
- [ ] Migrate cert-prep to a thin host LLM adapter; delete full-block echoing.
      Verify: cert-prep structuring tests and host commit smoke.

## Phase 3 - shared launcher crate

- [ ] Extract launcher/process/health/launch-policy/manifest mechanics and
      constants into a publishable Rust crate.
      Verify: `cargo fmt --check`, `cargo check`, and crate tests.
- [ ] Rewire Workbench desktop and then cert-prep desktop; retain each host's
      installer/download and persistence responsibilities.
      Verify: shared probe/handshake contract tests and desktop smoke.

## Phase 4 - governance and final proof

- [ ] Add changelog, synchronized artifact versions, and 0.x minor alignment
      with deprecation/break-glass evidence.
      Verify: producer and consumer compatibility tests.
- [ ] Keep Angular/Vanilla/React/Vue clean-consumer smoke green after each
      producer phase and record standalone desktop evidence.
      Verify: `corepack pnpm run verify:package` plus proportional full verify.
- [ ] Defer law-prep proof until its non-Ollama brain/platform is concrete.
