# Modular Runtime and Host Reuse

## Purpose

Keep the Capture Runtime, shared structuring behavior, desktop launcher, and
named consumers independently releasable while preserving one canonical v2
wire contract. The runtime remains the producer of models, validation, schemas,
operation metadata, and problem definitions.

## Ownership boundaries

1. `capture-runtime` owns extraction engines, ephemeral jobs, provenance,
   strict result validation, runtime-owned Ollama, and the deterministic
   contract-set bundle.
2. Python, TypeScript, and Java runtime-client SDKs are generated from that
   bundle. Their generated codecs are private; public transports, DTOs, error
   types, SSE helpers, retry/idempotency, and discovery methods are curated SDK
   interfaces.
3. `capture-structuring` owns provider-neutral batching, prompt assembly, and
   semantic block assembly. It never becomes a second runtime validator.
4. The sidecar launcher crate owns process startup, health, launch policy, and
   manifest mechanics. Each host retains its installer, persistence, and UI.
5. Cert Prep and Law Prep keep their domain persistence and AI providers. They
   consume the runtime through authenticated client SDKs and never import native
   runtime internals.

## Contract flow

- Runtime extraction emits immutable raw capture with source and engine
  provenance.
- A runtime-owned or trusted host provider supplies semantic fields; provenance
  and locators are reconstructed from raw capture.
- Runtime validation accepts only a complete, ordered, schemaVersion `2`
  document. Invalid or incomplete output is a terminal problem with diagnostic
  raw data retained according to runtime retention policy.
- `/meta/v2/contracts` publishes the exact operation, transport, schema, and
  problem catalog. SDKs negotiate the bundle digest before sending work.

## Packaging and release

- The executable and wheel embed `assets/contract-set.json` plus its adjacent
  SHA-256. Generation is deterministic and `check-contracts` fails on drift.
- Runtime, SDKs, launcher, and consumers are assembled from one candidate and
  verified with route/manifest parity, package integrity, clean installation,
  and shared cross-language fixtures.
- Publication uses immutable registry artifacts and a release ledger. A failed
  registry or consumer gate blocks promotion; no same-version overwrite is
  attempted.
- Consumer lockfiles move only after the exact candidate digest is available.
  Local smoke may use a loopback mirror, but it cannot substitute for published
  artifact evidence.

## Verification gates

- Runtime: generation drift, lint, typecheck, unit/API/streaming tests,
  PyInstaller asset inclusion, and packaged readiness.
- SDKs: typed discovery/negotiation, strict decode, error taxonomy, SSE resume,
  retry/idempotency, in-memory transport, build, and clean-consumer install.
- Hosts: authenticated integration, persistence/restart behavior, native
  launcher checks, and UI/browser consumer smoke.
- Cross-repository tests run only after the producer artifact and digest are
  explicitly recorded. Unavailable publication or engine evidence remains an
  explicit blocker rather than an inferred success.
