# Capture Boundary Doctor Decisions

## 2026-08-02

- Place the doctor in the Capture Workbench repository because this workspace
  owns the canonical Runtime HTTP contract and can compare a consumer proxy to
  the direct source of truth without importing Cert Prep internals.
- Build an attach-only, read-only CLI. Starting or installing either product
  would add process-lifecycle and mutation failures that obscure the boundary
  being diagnosed.
- Give `tools/` its own `capture-tools` Nx project. Do not add TypeScript targets
  to the Python `capture-runtime` project or overlap its existing dirty
  `local-media-probe` configuration.
- Require explicit correlation identifiers rather than infer a mapping from
  filenames, timestamps, source hashes, SQLite, or Runtime job directories.
  The first version changes no public API and reads no host-owned persistence.
- Accept bearer tokens only through environment variables. Reject credentials
  embedded in URLs, DNS names (including `localhost`), and non-loopback origins
  so the tool cannot accidentally forward a local product token to a remote
  host. Both observed services use the verified standard Bearer scheme.
- Compare only normalized, allowlisted readiness, capability, requirement, and
  job-state fields. Never persist headers, tokens, raw response bodies, source
  data, absolute app-data paths, or diagnostic raw extraction content.
- Use one versioned JSON report for both terminal output and optional explicit
  file output. Keep human progress on stderr so stdout remains machine-readable.
- Treat a Runtime-terminal/Cert-Prep-active pair as the primary regression
  signature. This is the boundary failure that previously made a completed
  sidecar failure look like a hanging Runtime.
- Keep UI/Web Component inspection in existing browser/packaged smokes. A
  future correlation header may be considered only if multiple consumers need
  automatic operation-to-capture discovery.
- Register the doctor as an explicit async CLI boundary in the existing static
  checker and prove the exact-path exception. Network I/O remains forbidden in
  ordinary product modules.
- A host operation that claims a terminal state while its Runtime capture is
  still active is a Cert Prep cancellation/reconciliation defect, not an
  unknown result.
