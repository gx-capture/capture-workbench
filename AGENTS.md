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
