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
  `@gx-capture/capture-workbench-ui`.
- The Python wheels use public PyPI with GitHub Actions OIDC Trusted
  Publishing (`id-token: write`); GitHub Packages is not the wheel registry.
- This registry/auth choice is a publication gate, not proof of current package
  availability; CI configuration and a clean import probe must confirm it
  before consumer source cutover.
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

## Resolved design gates

- Python package names are `capture-contracts` and `capture-structuring`; CI
  publishes them to public PyPI through OIDC Trusted Publishing.
- Consumer cutover is still gated on immutable registry artifacts and clean
  install/import probes; local path sources remain until that evidence exists.
- `sourceSegmentId` provenance and cross-repo rollback ownership remain part of
  the existing contract and release review evidence.

## 2026-08-05 release-boundary decision

- Use public PyPI for `capture-contracts` and `capture-structuring`, with
  GitHub Actions OIDC Trusted Publishing (`id-token: write`), rather than
  GitHub Packages as a wheel registry.
- PyPI pending publishers are project-specific, so the release matrix uses the
  existing `pypi` environment for `capture-contracts` and a separate
  `pypi-structuring` environment for `capture-structuring`; each writes its own
  publication ledger and registry digest probe.
- Use crates.io for `capture-sidecar-launcher`; its publish job is independent
  from npm and PyPI and is validated with `cargo publish --dry-run` first.
- Keep a release ledger per registry and retry only artifacts not recorded as
  successfully published. Consumer path dependencies remain until all probes
  pass; there is no assumed cross-registry rollback.
- Java law-prep uses the staged `capture-document-v1.schema.json` and pinned
  runtime manifest as the authority for Foundry responses. The hand-written
  Java DTOs remain mapping targets, not schema sources.
- `generate_schema.py` is retained because runtime release staging consumes it;
  only its retired Angular-specific output path is deleted.
- Runner availability does not weaken validation: local pre-commit commands
  cover deterministic artifact checks, while actual registry publication and
  staged-file integration remain fail-closed gates.

## 2026-08-05 publication and consumer evidence

- The immutable `0.3.10` release is published. Producer CI run `31007970169`
  passed at `a3a7fee`; recovery run `31009720361` passed all registry gates.
- The recovery ledger records canonical schema SHA
  `2721093496a9f09044d5737cce70d2356d5f71757b1cd23a960e1d003ea014f2` and
  crates.io archive SHA
  `533f497aa550589cec8e608c6b5fee29e69afb638ffe9d8c4cc41c0c4654bd0f`.
  Cargo candidate SHA is retained separately as provenance, not treated as a
  registry byte identity.
- Cert-prep PR #1 and law-prep PR #67 passed their published-package,
  lockfile/source consistency, Java schema, and desktop checks. Their capture
  dependencies no longer use local path sources. Angular web integration in
  law-prep remains explicitly deferred.

## Resolved producer gates

- `@gx-capture/capture-workbench-ui@0.3.10` is installable from the authenticated
  canonical GitHub Packages npm registry; npmjs.org is not the source.
- Contract generation is pinned to Pydantic `2.13.4`, pydantic-core `2.46.4`,
  and `pydantic.model_json_schema`; the generated manifest records these
  versions and the generator hash.
- Phase 1.5 keeps the contracts package as the Angular wire/schema owner. The
  producer release and clean registry probes are evidenced; the desktop keeps
  its Rust-local staged schema because it cannot consume TypeScript, but CI
  compares its manifest, versions, and schema SHA to the generated contracts
  manifest.
