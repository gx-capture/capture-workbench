# Modular Host Reuse Specification

## Purpose

Make Capture Workbench a brain-agnostic producer for cert-prep, law-prep, and
future hosts. Shared wire contracts, host-owned structuring scaffolding, and
sidecar launcher mechanics become importable producer artifacts while native
OCR/Whisper extraction remains in the runtime sidecar.

## Non-goals

- Do not merge capture-workbench and consumer repositories.
- Do not change `CaptureDocumentV1`, its schema id, or its pinned SHA-256.
- Do not move OCR/Whisper out of the sidecar.
- Do not remove runtime `ollama`, `external-ollama`, or `fake` providers.
- Do not send LLM calls from capture-workbench for host-owned structuring.
- Do not expand law-prep into Angular web integration in this closeout; its
  Java runtime schema gate and Foundry Local host proof are in scope.
- Do not expose sidecar bearer tokens to Angular, WebView, persistence, or logs.

## Current owners and target owners

| Capability                                             | Current owner                                    | Target owner                                                           |
| ------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------- |
| Canonical wire validation                              | `capture-runtime` Pydantic contracts             | Runtime remains canonical; generated contracts are published consumers |
| Host structuring batches and provenance reconstruction | runtime structuring module plus consumer forks   | Shared host SDK imported by runtime providers and consumers            |
| Sidecar process lifecycle                              | Workbench Tauri modules plus cert-prep duplicate | Shared Rust launcher crate; host-specific install remains local        |
| Native extraction                                      | runtime sidecar workers                          | unchanged                                                              |
| Host persistence and domain mapping                    | each consumer                                    | unchanged                                                              |

## Interfaces

### Shared contracts

- Authoritative source remains `packages/capture-runtime/src/capture_runtime/contracts/__init__.py`.
- Generated outputs must preserve camelCase wire aliases, strict extra-field
  rejection, enums, discriminators, validation constraints, and the pinned
  `CaptureDocumentV1` schema.
- TypeScript and Python artifacts are published separately from one producer
  source and carry synchronized versions.

### Host structuring SDK

- Input: validated `RawCaptureV1`, target language, provider budget, and a host
  callback `llm_generate(prompt, schema) -> bytes`.
- Output: validated `CaptureDocumentV1` candidate assembled from trusted raw
  provenance and host-supplied semantic fields.
- The model may return only `sourceSegmentId`, `type`, and optional `targetText`.
  It must not return `blockId`, `order`, `locator`, or `sourceText`.
- The runtime remains the canonical validator through `POST /structure`.

### Shared launcher

- Own loopback port reservation, token generation, readiness probe/parser,
  exact handshake comparison, bounded retry, and Windows Job Object cleanup.
- Keep installation/download-on-demand and host persistence outside the crate.
- Every public diagnostic must redact bearer tokens.

## Sequencing and gates

1. Phase 0: verify/pin the published `0.3.10` component and inventory consumer
   version drift before consumer alignment.
2. Phase 1: publish generated contracts and regeneration-diff verification.
3. Phase 1.5: make capture-workbench's Angular and desktop consumers prove the
   generated package before external consumer migration. Angular imports the
   npm package and uses its browser-safe schema constant; desktop retains its
   staged Rust resource but verifies it against the package manifest and SHA.
4. Phase 2: publish the host structuring SDK and replace consumer forks.
5. Phase 3: publish the launcher crate and replace consumer duplication.
6. Phase 4: enforce 0.x minor alignment only after all in-scope consumers are
   on one minor, with deprecation and break-glass rollback evidence.
7. Phase 5: law-prep validation only after its platform/brain is concrete.

No consumer migration is complete until the producer artifact version and
install source are recorded, the standalone product remains green, and the
consumer's focused tests pass.

## Acceptance criteria

- Regeneration produces no contract drift.
- No consumer keeps hand-mirrored wire DTOs or unsafe full-block LLM echoing.
- Runtime providers import shared structuring scaffolding without behavior drift.
- Cert-prep has no duplicated launcher mechanics after Phase 3.
- Published artifacts are version-consistent and independently testable.
- Angular/Vanilla/React/Vue clean-consumer smoke and standalone desktop gates
  remain green after every producer phase.

## Test plan

- Focused runtime Python contract, structuring, and provider tests.
- Generated-contract regeneration diff and schema/hash checks.
- TypeScript package typecheck/build/pack plus clean consumer smoke.
- Rust formatter/check/test plus shared probe/handshake contract tests.
- Cross-repo consumer tests only after the corresponding producer artifact is
  published and the install/auth path is explicitly evidenced.

## 0.3.10 implementation status

- `generate_schema.py` remains the runtime release-schema owner. The retired
  surface is only the Angular-specific schema output/target.
- Generated Python Pydantic wire models now ship beside the generated
  TypeScript models, JSON schemas, manifest, invariants, and extra policies.
- The release candidate verifies three npm packages, two Python packages in
  wheel/sdist form, and the launcher crate against version `0.3.10` and the
  canonical schema SHA before any registry write.
- PyPI publication uses separate OIDC Trusted Publishing matrix identities for
  the two environment names (`pypi` and `pypi-structuring`); crates.io is a separate
  retryable job. Each project/registry writes a ledger and runs an install or
  import probe; publication is not treated as atomic across registries.
- Consumer cutover is complete for `0.3.10`: public PyPI and crates.io
  publication plus clean install/import probes passed in recovery run
  `31009720361`. Cert-prep and law-prep lockfiles resolve the published
  artifacts and their CI consistency checks reject capture package path
  sources. The recovery ledger records the crates.io registry SHA
  `533f497aa550589cec8e608c6b5fee29e69afb638ffe9d8c4cc41c0c4654bd0f` and
  the local candidate SHA separately because Cargo's registry archive bytes
  are not identical to the local package archive.
- `pnpm verify:modular-reuse:local` is the runner-independent pre-commit/local
  command for regeneration drift, Python wheel smoke, SDK wheel smoke, and
  launcher publish dry-run. The release workflow remains the actual registry
  publication owner.
