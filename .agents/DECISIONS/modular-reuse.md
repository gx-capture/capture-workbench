# Modular Host Reuse Decisions

## Change mode

- Change mode: mixed.
- Existing owners: runtime contracts/validation, runtime structuring providers,
  Workbench Tauri launcher/process modules, and consumer persistence remain
  responsible for their current behavior.
- Delete candidates: generated consumer DTO copies, consumer structuring batch
  reimplementations, and consumer launcher/process duplication after the shared
  artifacts are proven.
- New owners needed: a generated contracts artifact, a host SDK, and a shared
  launcher crate, each only because there are already multiple consumers and a
  real package/process boundary.
- Token posture: compact quality; prefer extraction and deletion over parallel
  compatibility layers.
- Verification floor: focused producer tests plus clean-consumer smoke and
  standalone desktop verification at each phase.

## Accepted architecture

1. Keep `capture-runtime` as the canonical validator and schema source.
2. Generate consumer-facing contracts from the runtime models; do not hand-copy
   DTOs into cert-prep or law-prep.
3. Extract structuring pure logic into a host SDK. Runtime providers and hosts
   import the same implementation; no move-and-duplicate fork is allowed.
4. Extract only sidecar lifecycle mechanics into the Rust crate. Installer,
   persistence, and Tauri UI ownership stay with each host.
5. Treat the host LLM as untrusted semantic input. Reconstruct provenance from
   validated raw capture and let the runtime accept/reject the final candidate.

## Provisional release decisions

- TypeScript artifacts follow the existing GitHub Packages convention used by
  `@gx-capture/capture-workbench`.
- The Python wheel should use GitHub Packages' PyPI registry with the existing
  workflow `packages: write` permission and a short-lived `GITHUB_TOKEN`.
- This Python registry/auth choice is a publication gate, not proof of current
  package availability; CI configuration and a consumer install probe must
  confirm it before Phase 1 consumer migration.
- Package names, versions, and install URLs must be recorded in phase evidence
  before a consumer changes its dependency.

## Rejected alternatives

- A monorepo merge is rejected because independent product boundaries are
  deliberate.
- A second runtime/provider in each host is rejected because the host owns its
  existing brain and the sidecar owns extraction/validation.
- Full `CaptureBlockV1` model output from an LLM is rejected because it allows
  untrusted provenance and is the current cert-prep anti-pattern.
- Compatibility re-export/shim modules are rejected after the shared package is
  real; imports must move to the published owner and old copies be deleted.

## Rollback

- Producer rollback: retain the prior artifact and runtime minor; do not reuse
  immutable failed release tags or alter `CaptureDocumentV1`.
- Consumer rollback: revert the consumer dependency/import slice to the last
  verified producer artifact, without deleting the canonical runtime contract.
- Minor-alignment rollout: keep an explicit break-glass path until every
  in-scope consumer is confirmed same-minor.

## Open gates

- Confirm Python registry package naming, CI publish command, consumer auth, and
  whether the wheel is public/private for cert-prep and future law-prep.
- Confirm `sourceSegmentId` is stable and unique in `RawCaptureV1`.
- Enumerate cross-repo rollback owners before consumer migration.

## Resolved producer gates

- `@gx-capture/capture-workbench@0.3.9` is installable from the authenticated
  canonical GitHub Packages npm registry; npmjs.org is not the source.
- Contract generation is pinned to Pydantic `2.13.4`, pydantic-core `2.46.4`,
  and `pydantic.model_json_schema`; the generated manifest records these
  versions and the generator hash.
