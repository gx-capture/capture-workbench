# Modular Host Reuse Decisions

## Ownership

- `capture-runtime` owns extraction, canonical validation, runtime lifecycle,
  the contract models, and the embedded contract-set asset.
- The Python, TypeScript, and Java runtime-client SDKs expose typed public
  interfaces generated from that asset. Consumer applications do not copy
  wire DTOs or schemas.
- `capture-structuring` owns shared prompt/batching and semantic assembly
  behavior. Runtime providers and host adapters use the same implementation;
  no consumer forks the validation rules.
- The sidecar launcher crate owns process/health/launch-policy mechanics.
  Installers, persistence, and Tauri UI remain owned by each host.
- Host LLM output is untrusted semantic input. Provenance is reconstructed from
  validated raw capture and the runtime accepts or rejects the complete result.

## Release identity

- Runtime, SDKs, and named consumers ship as one release train bound to the
  contract-set version and SHA-256, not to independently inferred schema copies.
- Generated SDK codecs remain private implementation details; public DTOs and
  client methods are deliberate stable interfaces.
- Registry publication uses the package's configured trusted publisher and
  records immutable artifact digests in a release ledger. A clean install/import
  probe is required before consumer source or lockfile cutover.
- The Rust launcher publication is independently retriable, but its manifest,
  version, and digest must match the same candidate before promotion.

## Rejected alternatives

- Merging the independent product repositories would blur ownership boundaries.
- A second runtime or semantic provider in each host would duplicate native
  lifecycle and validation responsibilities.
- Letting an LLM return complete provenance-bearing blocks would permit
  untrusted locator and source data.
- Compatibility re-exports, hand-maintained schema copies, and parallel
  validators are not permitted after the shared v2 source is available.

## Rollback and verification

- A failed immutable artifact is never overwritten or reused. Roll back the
  runtime, SDKs, and consumers together to the last verified digest.
- Keep a break-glass dependency path only until every in-scope consumer has
  passed the same-digest installation and integration checks.
- Local verification covers deterministic generation, route/manifest parity,
  package integrity, and clean-consumer fixtures. Registry publication and
  staged-file integration remain fail-closed gates.
