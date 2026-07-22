# Tauri Reference Harness TODO

- [x] Add Nx/Tauri 2 Windows x64 NSIS scaffold with strict CSP.
      Verify: `pnpm nx show project capture-workbench-desktop --json`
- [x] Verify the bundled runtime manifest before spawning.
      Verify: `cargo test --manifest-path apps/capture-workbench-desktop/src-tauri/Cargo.toml manifest`
- [x] Launch the sidecar with an ephemeral token and isolated Workbench Ollama environment.
      Verify: `cargo test --manifest-path apps/capture-workbench-desktop/src-tauri/Cargo.toml launch`
- [x] Expose memory-only `backend_config` and implement owned process-tree cleanup.
      Verify: `cargo test --manifest-path apps/capture-workbench-desktop/src-tauri/Cargo.toml`
- [x] Add deterministic package QA and smoke fixtures with secret redaction.
      Verify: `pnpm nx run capture-workbench-desktop:package-qa-test`
- [x] Mirror canonical v1 multipart/status/raw/result/error envelopes and exact Host authority in deterministic smoke.
      Verify: `pnpm nx run capture-workbench-desktop:smoke-deterministic --skip-nx-cache`
- [x] Format and check all native code.
      Verify: `pnpm nx run-many -t cargo-fmt-check,cargo-check,cargo-test -p capture-workbench-desktop`
