<!-- nx configuration start -->
# Nx workspace guidance

- Use `pnpm nx` for project discovery and all build, lint, test, and packaging targets.
- Use `pnpm nx show project <name> --json` for resolved target configuration.
- Use Nx generators with `--dry-run` and `--no-interactive` before creating Angular projects.
- The Capture Workbench package is framework-facing only; native process, filesystem, and model lifecycle belong to `capture-runtime` or the Tauri harness.
- The published Web Component is a host-framework-independent custom element. Consumer verification must use the packaged loader, public DOM/property/event API, and runtime contract; do not block a consumer solely because its host uses a different Angular major version. Treat Angular-version compatibility as a defect only when an actual build or runtime verification demonstrates a failure.
- Never log or persist sidecar bearer tokens.
- Runtime jobs are ephemeral; host applications own durable source and domain persistence.
<!-- nx configuration end -->

# Release and CI guidance

- Follow `.agents/GUIDES/release-runbook.md` for the current release state, the publish procedure, and known pitfalls.
- Push CI on `main` is release evidence: release candidates verify it for their source commit, so never skip or weaken it. Only pull requests that touch nothing but `.agents/**` or Markdown skip verification.
- Route A (`package-promote`, then `runtime-promote`) publishes the registries and the runtime seed release. The full route (`release-candidate`, `consumer-gates`, `release-promote`) reuses those candidate runs at the same source commit, re-verifies registries idempotently, adds the desktop assets and moves the stable pointer.
- Size budgets are release policy read from the tooling ref. When the runtime outgrows the headroom, re-baseline `packages/capture-runtime/size-budgets/*` with new measurement evidence; never alter a candidate.
- PyPI Trusted Publishing binds the top-level workflow, so uploads run inline only in `package-promote.yml` and `release-promote.yml`; `_publish-pypi.yml` only verifies.
- Before dispatching `consumer-gates`, run each consumer's gate script locally against the downloaded release candidate (`--skip-checks` first, then the full checks); the gates run rarely and drift with toolchain upgrades.
- Launcher `cargo test` runs through `tools/cargo-test-retry-failed.ts`, which reruns failed tests once. Fix timing-sensitive tests at the source rather than adding retries elsewhere.
- For local practical OCR runs, keep `CAPTURE_APP_DATA_DIR` short (installed OCR worker paths beyond Windows MAX_PATH crash the worker) and set `CAPTURE_PORT` together with `--port`.
