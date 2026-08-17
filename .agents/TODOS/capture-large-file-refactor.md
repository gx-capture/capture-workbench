# Capture Workbench Large-File Refactor TODO

- [x] Capture the public export, DI token, Tauri command, contract hash, async
      boundary, and documentation baselines.
      Verify: `git status --short --branch`, `pnpm nx show projects --json`,
      `pnpm nx run capture-angular:async-boundary-check --skip-nx-cache`,
      `pnpm nx run capture-runtime:check-contracts --skip-nx-cache`

- [x] Add direct public-seam regression coverage for
      `CaptureWorkflowService` before moving its implementation.
      Verify: `pnpm nx run capture-angular:test --skip-nx-cache`

- [x] Dispatch disjoint Luna lanes for the Angular host, UI package, runtime
      installation/contracts/storage, Tauri/Rust, and SDK internals.
      Verify: each worker reports changed paths, ownership, commands, output,
      and deferred risks; root agent independently reruns the focused targets.

- [ ] Integrate and verify all production refactor lanes without changing
      public facades or generated artifacts.
      Verify: affected Nx lint/typecheck/test/build targets, contract checks,
      cargo checks/tests, SDK checks, and `git diff --check`

  Completed production slices: Angular host store, runtime installation,
  contract-set helpers, streaming repository, and Tauri library persistence.
  Remaining production slices: TypeScript SDK, Python SDK, Tauri runtime
  client, and any explicitly approved UI workflow extraction.

- [ ] Refactor desktop smoke and evidence harnesses after production lanes.
      Verify: deterministic, installed, real smoke targets and async-boundary
      checker remain green; evidence remains redacted and schema-compatible.

  Current decision: deferred. The existing smoke entrypoints have source-marker
  tests that require a narrower extraction design. The completed local registry
  research trial and its stale local-registry test have been retired separately.

- [ ] Complete public API documentation and advisory coverage report.
      Verify: public exports/classes/methods/tokens/commands have human-readable
      TSDoc, docstrings, JavaDoc, or rustdoc; generated files remain untouched.

- [ ] Run final cross-project verification and review the complete worktree.
      Verify: `pnpm verify`, `git diff --check`, unchanged contract hashes,
      unchanged public exports, and an explicit list of all remaining changes.
