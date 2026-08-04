# Changelog

## Unreleased

### Compatibility policy

Capture Workbench follows an explicit 0.x compatibility policy:

- While the runtime is `0.x`, a minor-version change may be breaking.
- Capture Workbench clients therefore require the same runtime major and minor
  version during the readiness handshake; patch updates remain compatible.
- The in-scope consumers for the current `0.3.x` line are the published
  Angular package and Cert Prep's Angular, Python, and desktop hosts. They must
  be deployed on the same minor before a runtime release is enabled.
- `compatibleRuntimeMinor` is a temporary, explicit break-glass setting for a
  coordinated rollback or split-minor migration. Remove the override after the
  consumer and runtime are aligned; reverting the consumer package is the
  rollback path if an undiscovered incompatibility is found.

The consumer consistency check is a permanent CI gate for the declared
runtime, package lock, Python host, desktop host, and browser host versions.

## 0.3.9

- Published the shared contracts, structuring SDK, and sidecar launcher
  artifacts used by the desktop and host integrations.
