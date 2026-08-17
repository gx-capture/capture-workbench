# Capture Workbench UI Directory Rename Decisions

- Rename only the top-level publishable package directory and path-dependent
  configuration in this change.
- Keep `capture-angular` as the Nx project id because the request names the
  directory specifically; changing task names would be a separate developer-facing
  migration.
- Keep `src/lib/capture-angular` and its component filenames because they identify
  Angular implementation details rather than the package directory.
- Keep the published identity `@gx-capture/capture-workbench-ui` unchanged.
