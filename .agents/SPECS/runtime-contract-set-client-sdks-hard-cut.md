# Runtime Contract Set and Client SDK

## Purpose

Capture Runtime and its Python, TypeScript, and Java clients share one immutable,
deterministic contract set. The runtime is the canonical model and policy source;
client SDKs expose deliberate typed interfaces generated from the checked-in
bundle. A release is promoted only when the runtime, SDKs, and named consumers
agree on the same contract-set digest.

## Runtime discovery and bundle

- `GET /meta/v2/contracts` is bearer-authenticated and returns `catalogVersion: 2`,
  runtime and surface versions, `contractSetVersion`, the bundle SHA-256, an
  `ETag`, and an immutable download location.
- `GET /meta/v2/contracts/sha256/{digest}` is bearer-authenticated and returns
  the embedded bundle only when the requested digest matches its exact bytes.
- `capture_runtime.contract_set` owns canonical serialization, hashing, bundle
  validation, and route/model/problem drift checks. HTTP discovery is an adapter.
- The bundle includes canonical JSON schemas, the complete operation and
  transport manifest, invariants, extra policies, and the centralized problem
  catalog.
- `ProblemRegistry` defines each remote code, HTTP status, category, retry
  policy, and details schema exactly once.
- The active HTTP surface covers readiness, streaming readiness, runtime
  requirements/installations/model options, ingestion, capture, structuring,
  results, cancellation/deletion, and SSE events.
- Runtime startup fails closed when registered routes, models, operations, or
  problems drift from the embedded bundle.

## Client SDKs

- Python package: `capture-runtime-client`.
- npm package: `@gx-capture/capture-runtime-client`.
- Maven package: `com.gx.capture:capture-runtime-client`.
- Each SDK exposes typed discovery, capture and streaming operations, runtime
  setup, authentication, SSE resume, idempotency/retry, negotiation, and typed
  errors through a shared `RuntimeTransport` port.
- Generated models and codecs are private implementation details. Public DTOs,
  methods, and error mappings are intentional stable SDK interfaces.
- `capture_runtime.structuring` is the current runtime-local parity owner for
  provider-neutral batching, prompt/schema adaptation, minimal semantic
  validation, and provenance reconstruction.
- The standalone `@gx-capture/capture-structuring` TypeScript package and
  `capture-structuring` Python package were deleted in 0.4.1 after consumer
  cutover and same-digest gates passed. The runtime-owned pull-session module
  is now the sole structuring implementation and no structuring-client package
  is published.
- The Python, TypeScript, and Java `capture-runtime-client` packages remain the
  client SDK surfaces. No `capture-structuring-client` or other structuring
  client packages are created.

## Structuring migration and pull-session freeze

The legacy v2 full-document host commit route remains active and
behavior-compatible until the explicit v3 retirement gate. The additive
pull-session contract is implemented by the runtime and typed Python,
TypeScript, and Java client SDKs; these semantics remain frozen for subsequent
review-overlay and consumer cutover work:

- provider capabilities advertise the provider capability and schema dialect;
- provider responses contain minimal semantic batches only;
- a review overlay may annotate or revise presentation, but cannot change raw
  capture or reconstructed provenance;
- every batch and session carries a digest identity with explicit
  idempotency/conflict handling; and
- persisted checkpoints support crash-safe recovery and deterministic replay.

## Compatibility identity and security

- `catalogVersion: 2` identifies the discovery interface major.
- `contractSetVersion` plus the bundle SHA-256 is the compatibility identity;
  runtime semver is diagnostic metadata.
- Before an operation, clients validate the catalog, required operations and
  surfaces, exact bundle bytes, and an SDK-compiled hash allowlist.
- Decoders are strict. Unknown hashes, fields, or problem codes fail closed or
  map to the typed remote-error envelope without discarding status and details.
- Bearer credentials and the loopback sidecar URL stay in trusted native/backend
  boundaries and never enter browser properties, logs, reports, or persistence.
- SSE reconnect preserves `Last-Event-ID`; malformed frames, replay gaps, and
  transport violations become protocol errors.
- Retry never repeats a non-idempotent operation without an idempotency key.

## Release and verification

- The runtime embeds exactly one byte-stable, secret-free contract bundle and
  adjacent SHA-256 asset in every executable and wheel.
- Python, TypeScript, and Java SDK artifacts are generated from that bundle and
  publish with the same digest allowlist.
- Consumer integrations validate discovery, strict decoding, unknown errors,
  SSE resume, retry/idempotency, and in-memory transports with shared fixtures.
- Release assembly verifies route/manifest parity, generated-artifact drift,
  packaging inclusion, clean consumer installation, and the final digest before
  publication.
- A failed registry, consumer, or integrity check blocks promotion; artifacts
  are rolled back as one release train.

## Durable acceptance criteria

- The runtime registers only the active v2 product routes plus
  `/meta/v2/contracts`.
- Both discovery endpoints enforce authentication, ETag and immutable caching,
  exact digest behavior, and wrong-digest rejection.
- The bundle is deterministic, secret-free, complete, and has one entry per
  canonical model, operation, route, transport, and problem.
- All three SDKs pass typed v2 negotiation, transport, error, SSE, retry, and
  shared-fixture tests.
- Active producers, SDKs, consumers, release tools, and current documentation
  use the runtime-owned v2 contract source and its single digest.
- The standalone structuring packages are absent from current producer source,
  candidate manifests, registry publication workflows, and consumer locks.
