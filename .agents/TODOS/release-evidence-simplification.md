# Release Evidence Simplification TODO

- [ ] Record the one-environment and one-bundle-secret contract.
  Verify: `.agents/SPECS/release-evidence-simplification.md`

- [ ] Edit `release.yml` to use one protected `capture-release` environment and
      materialize one evidence bundle.
  Verify: `node --test tools/release-workflow-contract.test.ts`

- [ ] Add the bundle encoder and unit tests.
  Verify: `node --test tools/release-evidence-bundle.test.ts`

- [ ] Keep exact candidate, preflight, fixture binding, and attestation gates.
  Verify: `corepack pnpm nx run capture-runtime:test --skip-nx-cache`

- [ ] Re-run package/runtime consumer regression.
  Verify: `corepack pnpm nx run capture-angular:test --skip-nx-cache` and
      `corepack pnpm nx run capture-runtime:local-release-consumer-smoke --skip-nx-cache`

- [ ] Commit and push the simplification without creating `v0.3.0`.
  Verify: clean worktree, remote commit, and no release tag mutation.
