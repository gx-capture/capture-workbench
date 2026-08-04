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
- Do not modify law-prep until its brain/platform decision is concrete.
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

1. Phase 0: verify/pin the published `0.3.9` component and inventory consumer
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
