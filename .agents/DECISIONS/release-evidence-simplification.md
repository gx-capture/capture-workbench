# Release Evidence Simplification Decision

## Change checkpoint

- Change mode: mixed.
- Existing owner: `.github/workflows/release.yml` owns candidate verification and
  publication; `capture_runtime.release_evidence` owns evidence validation.
- Delete candidates: the build-only `capture-release-build` environment, the
  publish-only `capture-release-publish` environment, and the two separately
  transported evidence secrets.
- New owner needed: no. A small bundle helper only standardizes the input to the
  existing release workflow.
- Verification floor: workflow contract tests, bundle helper tests, runtime
  preflight tests, and the existing Angular/runtime release smoke tests.

## Decision

Use one protected `capture-release` environment for both the exact-candidate
verification job and the publish job. Move the evidence JSON and approved
fixture registry into one protected secret:

```text
CAPTURE_RELEASE_EVIDENCE_BUNDLE_B64
```

The decoded bundle has this shape:

```json
{
  "schemaVersion": 1,
  "evidence": { "...": "ReleaseEvidenceV1" },
  "fixtureRegistry": { "...": "FixtureRegistryV1" }
}
```

The workflow still verifies the exact evidence subject with GitHub artifact
attestation and runs the existing fail-closed production preflight. The
`CAPTURE_RELEASE_EVIDENCE_SIGNER_WORKFLOW` environment variable remains
required because it identifies the trusted attestation workflow.

## Why this is safe

The simplification removes configuration duplication, not release assurance.
Evidence remains bound to the candidate artifact, the fixture registry remains
independent from the evidence observations, and unsigned local evidence remains
non-releaseable.

## Non-goals

- Do not generate synthetic evidence in GitHub Actions.
- Do not remove the exact-candidate preflight or GitHub attestation.
- Do not silently treat local fake-provider smoke as production evidence.
- Do not create unprotected environments merely to make a tag workflow run.
