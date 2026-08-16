# Modular Runtime and Host Reuse

## Purpose

Keep the Capture Runtime, runtime-local structuring parity, desktop launcher,
and named consumers independently releasable while preserving one canonical v2
wire contract. The runtime remains
the producer of models, validation, schemas, operation metadata, and problem
definitions.

## Ownership boundaries

1. `capture-runtime` owns extraction engines, ephemeral jobs, provenance,
   strict result validation, runtime-owned Ollama, the deterministic
   contract-set bundle, and `capture_runtime.structuring`, which is the current
   runtime-local parity owner for batching, prompt/schema adaptation, minimal
   semantic validation, and provenance reconstruction.
2. Python, TypeScript, and Java runtime-client SDKs are generated from that
   bundle. Their generated codecs are private; public transports, DTOs, error
   types, SSE helpers, retry/idempotency, and discovery methods are curated SDK
   interfaces.
3. The Python, TypeScript, and Java `capture-runtime-client` packages remain the
   client SDK surfaces. No `capture-structuring-client` or other structuring
   client packages are created during this migration.
5. The sidecar launcher crate owns process startup, health, launch policy, and
   manifest mechanics. Each host retains its installer, persistence, and UI.
6. Cert Prep and Law Prep keep their domain persistence and AI providers. They
   consume the runtime through authenticated client SDKs and never import native
   runtime internals.

## Contract flow

- Runtime extraction emits immutable raw capture with source and engine
  provenance.
- A runtime-owned or trusted host provider supplies semantic fields; provenance
  and locators are reconstructed from raw capture by the runtime-local
  `capture_runtime.structuring` parity owner.
- Runtime validation accepts only a complete, ordered, schemaVersion `2`
  document. Invalid or incomplete output is a terminal problem with diagnostic
  raw data retained according to runtime retention policy.
- The legacy v2 full-document host commit route remains behavior-compatible and
  active until the explicit v3 retirement gate. The additive pull-session
  contract does not retire or bypass that route early.
- `/meta/v2/contracts` publishes the exact operation, transport, schema, and
  problem catalog. SDKs negotiate the bundle digest before sending work.

## Pull-session contract freeze

The runtime now exposes the additive pull-session HTTP contract and all three
typed client SDKs expose its open/get/pull/submit methods. Its freeze semantics
remain binding for subsequent review-overlay and consumer cutover work:

- provider capabilities advertise both the available provider capability and
  the accepted schema dialect;
- providers return only minimal semantic batches, never trusted raw fields or
  provenance-bearing blocks;
- a review overlay may annotate or revise presentation, but never changes raw
  capture or reconstructed provenance;
- every batch and session carries a digest identity and explicit
  idempotency/conflict handling; and
- persisted checkpoints provide crash-safe recovery and deterministic replay.

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
- Standalone `capture-structuring` package deletion is complete in the 0.4.1
  release train after consumer cutover and same-digest verification.
