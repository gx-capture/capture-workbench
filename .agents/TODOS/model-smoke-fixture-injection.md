# Model smoke fixture injection TODO

- [x] Add feature-only opaque fixture registry and validation.
      Verify: `pnpm nx run capture-workbench-desktop:cargo-test -- --features model-smoke-app-data`
- [x] Register the command only in model-smoke builds and reuse native import.
      Verify: feature-disabled and feature-enabled `cargo check` commands.
- [x] Replace model-smoke picker calls with fixture-key injection plus existing
      UI retry processing.
      Verify: focused `real-media-model-smoke.test.ts` tests.
- [x] Label deterministic picker-bypass evidence and preserve private-output
      redaction.
      Verify: `pnpm nx run capture-workbench-desktop:package-qa-test`.
- [x] Run formatting, lint, and diff checks without running full media smoke.
      Verify: desktop Cargo format check, desktop lint, and `git diff --check`.
