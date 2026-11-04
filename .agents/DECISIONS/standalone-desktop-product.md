# Standalone Desktop Product Decisions

- Change mode: mixed.
- Existing owners: the Angular app owns desktop presentation; the Tauri host
  owns local filesystem state and runtime lifecycle; capture-runtime owns
  extraction and isolated Ollama.
- Delete candidates: validation-host copy, browser fixture/provider switching,
  and the misleading default deterministic dev entry point.
- New owner: a Tauri private library with opaque document IDs, because runtime
  jobs are intentionally ephemeral and host data must survive restart.
- The library uses versioned JSON plus atomic file replacement rather than a
  new database dependency.
- Bearer tokens remain exclusively in the native host. The renderer invokes a
  constrained native runtime proxy and receives only redacted runtime values;
  tokens are absent from IPC contracts, library files, and diagnostics.
- The WindowsML bundle descriptor is a release-versioned capture-runtime
  constant, not a CI/Tauri/runtime environment-variable protocol. It is the
  single owner for the consented OCR download and checksum verification.
- A missing remote WindowsML archive is an installer repair condition, not a
  Capture Workbench desktop release gate. The app does not bundle or launch the
  archive, while runtime requirement discovery and the consented installation
  path remain intact for OCR-capable installations.
- The desktop renderer uses Tailwind tokens and Spartan helm components
  (`tailwind-spartan-ui.md`). Angular Material remains only in the document
  workspace on `/history` until UI phase 7
  ([#161](https://github.com/gx-capture/capture-workbench/issues/161)) deletes
  it.

## Sidecar launch

Carried over from the retired Tauri reference-harness record, which described
the app as a verification harness rather than a product:

- The app bundles one `capture-runtime` Windows x64 sidecar and verifies its
  release manifest, byte count, SHA-256 digest, runtime version and schema
  version before it spawns it; any mismatch fails closed.
- Every launch creates an OS-random 256-bit bearer token and independent
  loopback ports. The token stays in native memory.
- The launcher owns only the process tree it starts. Shutdown targets the
  recorded child PID tree and never kills by executable name, port or shared
  model store.
- The production CSP permits Tauri IPC and loopback HTTP only, and production
  runtime launches disable the API documentation.
- Residual risk: the launcher picks an ephemeral port by binding and releasing
  it before the runtime binds, so a local process could race that interval. The
  token, an authenticated readiness response checked against the verified
  manifest, and exact `127.0.0.1:<port>` host authorization mitigate it.
- Deterministic package QA is diagnostic evidence, not a publication gate.
