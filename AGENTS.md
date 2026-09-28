# Nx workspace guidance

- Use `pnpm nx` for project discovery and all build, lint, test, and packaging targets.
- Use `pnpm nx show project <name> --json` for resolved target configuration.
- Use Nx generators with `--dry-run` and `--no-interactive` before creating Angular projects.
- The Capture Workbench package is framework-facing only; native process, filesystem, and model lifecycle belong to `capture-runtime` or the Tauri harness.
- The published Web Component is a host-framework-independent custom element. Consumer verification must use the packaged loader, public DOM/property/event API, and runtime contract; do not block a consumer solely because its host uses a different Angular major version. Treat Angular-version compatibility as a defect only when an actual build or runtime verification demonstrates a failure.
- Never log or persist sidecar bearer tokens.
- Runtime jobs are ephemeral; host applications own durable source and domain persistence.
- Tests must not leave temporary files. A TypeScript test file that creates temp files imports `tools/test-temp-root.ts` first (a private temp root removed on exit); pytest uses `tmp_path_retention_policy = "failed"` (passed tests' dirs are removed; only failed ones from the last 3 sessions stay). Never use `"none"`: it disables pytest's session lock, so concurrent pytest runs delete each other's temp dirs.

# Release and CI guidance

- Follow `.agents/GUIDES/release-runbook.md` for the current release state, the publish procedure, and known pitfalls.
- Push CI on `main` is release evidence: release candidates verify it for their source commit, so never skip or weaken it. Every pull request runs the full verification: contract tests read `.agents` TODOs and READMEs.
- Launcher `cargo test` is the only place failed tests are retried; fix timing-sensitive tests at the source rather than adding retries elsewhere.
