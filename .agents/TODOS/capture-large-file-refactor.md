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

- [x] Document the public client SDK APIs.
      Done (2026-09-28): one-line docs on every public method of the TypeScript
      (`capture-runtime-client`), Python (`capture-runtime-client-python`), and
      Java (`CaptureRuntimeClient`) clients; no behaviour or contract change.

- [ ] Add rustdoc to the remaining public `capture-sidecar-launcher` functions
      (26 of 81 `pub fn` were documented on 2026-09-28).
      Verify: `pnpm nx run capture-sidecar-launcher:cargo-check` and
      `cargo doc --no-deps` without missing-docs regressions.

