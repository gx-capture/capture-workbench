# Changelog

## Unreleased

### Compatibility policy

Capture Workbench follows an explicit 0.x compatibility policy:

- While the runtime is `0.x`, a minor-version change may be breaking.
- Capture Workbench clients therefore require the same runtime major and minor
  version during the readiness handshake; patch updates remain compatible.
- The in-scope consumers for the current `0.4.x` line are the published
  Web Component package, Cert Prep's Angular, Python, and desktop hosts, and
  LAW's Java engine and Python AI service. They must be deployed on the same
  minor before a runtime release is enabled.
- `compatibleRuntimeMinor` is a temporary, explicit break-glass setting for a
  coordinated rollback or split-minor migration. Remove the override after the
  consumer and runtime are aligned; reverting the consumer package is the
  rollback path if an undiscovered incompatibility is found.

The consumer consistency check is a permanent CI gate for the declared
runtime, package lock, Python host, desktop host, and browser host versions.

### Release tooling

- The post-publish PyPI readback waits up to about five minutes for PyPI's
  metadata instead of failing on the first 404.

## 0.4.3 (2026-09-29)

- Published to npm, Maven, PyPI, and crates.io, with the runtime, engine zips,
  and desktop installer on the GitHub release; the stable pointer moved to
  `v0.4.3`. Cert Prep and LAW consume it.
- A first OCR install on fresh app data takes about 40 s (was 9–17 minutes
  with 0.4.2), and about 8 s once any Capture host on the machine has
  downloaded the engine.

### Runtime

- Engine artifacts of 16 MiB or more download as four concurrent byte ranges
  when the host supports them, falling back to one stream otherwise; size and
  SHA-256 are still verified. The 152 MB OCR engine took 4.7 minutes instead of
  roughly 15 when GitHub Releases served ~170 KB/s per connection.
- Engine workers and model files are kept in a machine-wide cache
  (`%LOCALAPPDATA%\gx-capture\engine-cache`), keyed by SHA-256 and re-verified
  on every read. A second host, a fresh app-data directory, or a reinstall
  copies the verified bytes instead of downloading them again; entries unused
  for 60 days are evicted. Set `CAPTURE_ENGINE_CACHE_DIR` to move the cache or
  to `off` to disable it.

### CI and release tooling

- Release candidates read size budgets from the tooling ref.
- `sync-versions` also updates workspace crates in `Cargo.lock`.
- The launcher's activation probe fixture keeps serving after a test client
  drops a connection, which removes the intermittent launcher test failure.

## 0.4.2 (2026-09-27)

- Runtime OCR is delivered as an installable `windowsml-ocr` engine from the
  release catalog and gated by an OCR compute preflight; PDFs are OCR-only.
- The public launcher lifecycle (prepare, activation, Running, Closing,
  Terminal) persists durable ownership and releases verified staging.
- Published to npm, Maven, PyPI (`capture-runtime-client`, first PyPI
  release), and crates.io, with the runtime, engine zips, and desktop
  installer on the GitHub release; the stable pointer moved to `v0.4.2`.
- Known limitations: handwritten text is recognised poorly (printed text is
  the supported floor); the first engine download from GitHub releases can take
  over ten minutes.

## 0.4.1

- Canonical v2 contract set shared by the runtime and its TypeScript, Python,
  and Java clients; releases require matching contract-set digests.

## 0.3.9

- Published the shared contracts, structuring SDK, and sidecar launcher
  artifacts used by the desktop and host integrations.
