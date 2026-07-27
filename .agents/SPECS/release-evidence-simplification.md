# Release Evidence Simplification Spec

## Purpose

Reduce release configuration from multiple environments and evidence secrets
to one protected `capture-release` environment and one evidence bundle secret,
while preserving exact-artifact validation, approved fixture binding, and GitHub
artifact attestation.

## Non-Goals

- Removing clean-install evidence.
- Removing GitHub artifact attestation.
- Creating fake PDF, image, or audio evidence.
- Moving protected credentials or bearer tokens into repository files.

## Interfaces

The protected environment supplies:

- `CAPTURE_RELEASE_EVIDENCE_BUNDLE_B64`: Base64-encoded UTF-8 JSON bundle.
- `CAPTURE_RELEASE_EVIDENCE_SIGNER_WORKFLOW`: exact signer workflow identity
  passed to `gh attestation verify --signer-workflow`.

The repository-level WindowsML variables remain:

- `CAPTURE_WINDOWSML_BUNDLE_URL`;
- `CAPTURE_WINDOWSML_BUNDLE_BYTES`;
- `CAPTURE_WINDOWSML_BUNDLE_SHA256`.

The bundle schema is:

```json
{
  "schemaVersion": 1,
  "evidence": {},
  "fixtureRegistry": {}
}
```

`evidence` must validate as `ReleaseEvidenceV1`; `fixtureRegistry` must validate
as `FixtureRegistryV1`. The workflow materializes each nested object into its
existing temporary JSON path before running the unchanged Python preflight.

## Key Decisions

- `capture-release` is used by both verification and publication jobs.
- The build job has no environment because its WindowsML inputs are public
  repository variables and it has no release mutation permissions.
- The publish job retains narrow `contents: write` and `packages: write`
  permissions.
- Evidence and the registry are transported together, but remain two validated
  objects inside the bundle.
- The bundle helper emits only Base64 on stdout so it can be piped to
  `gh secret set` without exposing the decoded evidence in command output.

## Failure Modes

- Missing or invalid Base64 fails before candidate preflight.
- Missing bundle members fail before candidate preflight.
- Unknown bundle fields or invalid evidence/registry fields fail in the Python
  model validators.
- A valid bundle for a different candidate fails exact artifact binding.
- An unsigned or unattested evidence file remains non-releaseable.

## Acceptance Criteria

- `release.yml` contains only `capture-release` for release verification and
  publication.
- `release.yml` no longer references `capture-release-build`,
  `capture-release-publish`, `CAPTURE_RELEASE_EVIDENCE_B64`, or
  `CAPTURE_RELEASE_FIXTURE_REGISTRY_B64`.
- `CAPTURE_RELEASE_EVIDENCE_BUNDLE_B64` is decoded into the existing evidence
  and fixture-registry paths.
- The bundle helper and workflow contract tests pass.
- Existing runtime and package release smoke tests remain green.

## Test Plan

- `node --test tools/release-evidence-bundle.test.ts tools/release-workflow-contract.test.ts`
- `corepack pnpm nx run capture-runtime:test --skip-nx-cache`
- `corepack pnpm nx run capture-angular:test --skip-nx-cache`
- `corepack pnpm nx run capture-runtime:local-release-consumer-smoke --skip-nx-cache`
