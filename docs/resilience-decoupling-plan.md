# Capture Workbench Release Resilience and Decoupling Plan

> Status: Final recommended implementation plan
> Scope: `capture-workbench`, `cert-prep`, and `law-prep`

## Executive Summary

The release architecture will be changed from:

```text
Version bump
→ Git tag
→ Build
→ Publish
→ Failure may consume another version
```

to:

```text
Release intent
→ Generated versions
→ Immutable candidate build
→ Layered candidate verification
→ Event-driven consumer gates
→ Publish exact candidate
→ Verify registries
→ Create Git tag
→ Create GitHub Release
→ Publish canonical stable pointer
```

The governing rules are:

1. Infrastructure, authentication, runner, and registry failures must not consume a new version.
2. Once any registry accepts an artifact, that version may only continue with the original immutable candidate.
3. A new version is required only when already published artifact contents or metadata must change.
4. Consumers never modify the producer candidate manifest.
5. Until independent versioning is introduced, Cert Prep upgrades the Workbench UI and runtime atomically.
6. Law Prep is selectively coupled only to contract-impacting releases.

---

# Phase 0 — Release Policy and Immediate Guardrails

## Goal

Stop infrastructure failures from causing unnecessary version bumps while the larger workflow is being refactored.

## Failure Policy

| Failure category                                               | Required response                                   |
| -------------------------------------------------------------- | --------------------------------------------------- |
| Runner interruption, dependency timeout, cache failure         | Retry or rebuild under the same unpublished version |
| OIDC, trusted-publisher, token, permission, or registry outage | Retry publication with the same candidate           |
| Workflow scripting defect before any registry publication      | Fix the workflow and rebuild under the same version |
| Partial registry publication                                   | Reuse the original candidate only                   |
| Published package content or metadata defect                   | Publish a new version                               |
| Registry bytes differ from the approved candidate              | Fail closed and investigate                         |

Pre-publish package validation catches artifact-content defects. It does not validate external trusted-publisher or OIDC configuration; those remain retryable publication-infrastructure failures.

## Candidate Retention

* Increase candidate retention from one day to at least fourteen days.
* Retain the candidate manifest, release ledger, checksums, verification reports, and consumer-gate results.
* Do not delete successful candidate workflow runs while a release or recovery is active.

## Hard Restrictions

* Do not rebuild a version after any registry has accepted artifacts.
* Do not recover from a mutable source branch.
* Do not modify an existing candidate.
* Do not add further one-off registry correction branches to the current monolithic workflow.
* Do not overwrite immutable package versions.

## Build Determinism Clarification

Deterministic builds remain desirable for auditing, but they are not a prerequisite for publication correctness.

Before publication, a failed build may produce a replacement candidate under the same intended version because no registry has consumed that version. After promotion begins, correctness comes from publishing the stored candidate bytes without rebuilding.

## Acceptance Criteria

* Infrastructure failures consume zero new versions.
* Recovery can identify the exact candidate and source commit.
* A partially published version cannot switch to newly built bytes.

---

# Phase 1 — Centralized Version Generation

## Goal

Remove manual synchronization across npm, Python, Rust, runtime, Tauri, fixtures, and catalogs before introducing the new candidate workflow.

## New Files

```text
release/version.json
tools/release/sync-versions.ts
tools/release/verify-generated-versions.ts
```

Example:

```json
{
  "releaseVersion": "0.4.0",
  "runtimeApiVersion": "2.0",
  "documentSchemaVersion": "2"
}
```

## Generated Targets

The synchronization tool updates:

* npm `package.json` files
* Python `pyproject.toml` files
* Cargo manifests
* Tauri application metadata
* Python runtime constants
* Rust constants
* deterministic runtime fixtures
* runtime manifests
* model source locks
* engine catalogs

## Verification Model

`verify-release-version.ts` remains a fail-closed gate, but it verifies generated values against `release/version.json`.

Direct manual edits to generated version fields fail CI.

## Release Intent

A normal release PR contains:

1. The intended version change.
2. Generated metadata updates.
3. Changelog changes.
4. Any actual product or packaging changes.

Merging the PR does not publish anything.

## Acceptance Criteria

* A release version is declared once.
* All language-specific declarations are generated deterministically.
* Missing one manually edited version field can no longer break the release after tagging.

---

# Phase 2 — Immutable Candidate Build and Fast Verification

## Goal

Build every release artifact exactly once and reject malformed packages before any expensive or cross-repository verification begins.

## New Workflow

```text
.github/workflows/release-candidate.yml
```

## Trigger

Use `workflow_dispatch` with:

| Input          | Purpose                        |
| -------------- | ------------------------------ |
| `version`      | Intended SemVer                |
| `commit_sha`   | Exact source commit            |
| `release_mode` | `core-only` or `model-enabled` |

The workflow verifies:

* The commit is reachable from `main`.
* CI passed for the exact commit.
* Generated versions match the requested version.
* No registry has already accepted different bytes for the version.

## Candidate Build

Build:

* Workbench npm package
* TypeScript contracts package
* TypeScript structuring package
* Python wheels and source distributions
* Rust launcher crate
* Capture Runtime assets
* engine catalogs and manifests
* Windows desktop installer
* checksums
* SBOM and license inventories

## Fast Mandatory Verification

Run in or immediately after candidate assembly:

### npm

* Consume the immutable candidate from the configured package registry in a
  clean temporary project; the retired local Verdaccio trial is not evidence.
* Reject leaked `workspace:*` dependencies.
* Verify exports and type declarations.
* Import the runtime client's typed structuring/session DTOs and the Workbench packages.

### Python

* Install each wheel and source distribution in a clean virtual environment.
* Import `capture_runtime_client`.
* Import typed structuring/session DTOs from `capture_runtime_client`.
* Validate packaged schema availability.
* Verify inter-package dependencies.

### Rust

Run:

```text
cargo publish --dry-run --locked
```

Also compile a minimal clean consumer crate against the packaged launcher.

### Cross-Ecosystem Checks

* Compare TypeScript and Python schema digests.
* Validate runtime API and document schema versions.
* Validate package dependency ranges.
* Verify every candidate artifact digest.
* Verify the candidate contains the expected artifact inventory.

## Candidate Identity

Generate:

```text
candidateId =
SHA256(normalized candidate manifest + ordered artifact digests)
```

The immutable `candidate-manifest.json` includes:

```json
{
  "schemaVersion": "1",
  "candidateId": "...",
  "sourceCommit": "...",
  "releaseVersion": "...",
  "releaseMode": "...",
  "runtimeApiVersion": "...",
  "documentSchemaVersion": "...",
  "artifacts": [],
  "toolchains": {},
  "contractImpact": null
}
```

Consumer results are not written into this manifest.

## Candidate Attestation

Generate provenance attestations for the candidate manifest and primary release artifacts where GitHub artifact attestations are available. GitHub attestations bind an artifact to its repository, workflow, commit, event, and build identity and can be verified with the GitHub CLI.

## Acceptance Criteria

* Candidate assembly produces one immutable artifact set.
* Basic package and metadata defects are rejected quickly.
* No registry or Git tag is created.
* The candidate remains reusable by all subsequent verification jobs.

---

# Phase 3 — Heavy Candidate Verification

## Goal

Prevent slow or flaky installer and runtime tests from forcing candidate reconstruction.

## Architecture

Heavy verification runs as separate jobs that download and verify the stored candidate.

```text
build-candidate
├── verify-windows-install
├── verify-runtime-product
├── verify-cross-framework-consumers
└── verify-model-enabled-runtime
```

The jobs never rebuild candidate artifacts.

## Windows Install Verification

* Download and verify the candidate.
* Install the exact NSIS installer.
* Verify installed runtime assets.
* Launch the product.
* Run deterministic product smoke.
* Verify process cleanup.
* Uninstall the product.
* Confirm no unexpected persistent state remains.

## Runtime Verification

* Start the exact candidate runtime.
* Validate readiness and handshake.
* Validate schema and runtime version reporting.
* Exercise cancellation, timeout, and failure behavior.
* Validate manifest and checksum enforcement.

## Cross-Framework Verification

Run required clean-consumer smoke for:

* Angular
* Vanilla JavaScript
* React
* Vue

## Model-Enabled Verification

Only when the release mode requires models:

* Validate engine catalog and source lock.
* Validate model receipt evidence.
* Run approved OCR and audio smoke.
* Confirm no ambient local model store influenced the candidate.

## Retry Behavior

* Failed heavy jobs may be rerun independently.
* Reruns download the same candidate.
* A flaky installer test does not trigger a package or runtime rebuild.
* Separate timeouts are assigned to each heavy job instead of sharing one 90-minute monolithic timeout.

## Acceptance Criteria

* Heavy verification failures are cheap to retry.
* Every verification report identifies the candidate ID.
* Promotion requires all applicable heavy jobs to pass.

---

# Phase 4 — Contract Impact Classification

## Goal

Give the Law Prep gate and release policy a concrete, machine-enforceable definition of contract compatibility.

## Baseline

The classifier compares the candidate contracts against the contracts referenced by the current stable release manifest.

Inputs include:

* normalized JSON Schema
* generated TypeScript contracts
* generated Python contracts
* runtime API metadata
* event and error-code definitions

## Classification Output

```json
{
  "classification": "no-impact | additive | breaking | manual-review",
  "baselineRelease": "...",
  "candidateId": "...",
  "changes": []
}
```

## Classification Rules

### No Impact

Examples:

* Description or title changes
* Documentation-only changes
* Formatting changes
* Reordered schema declarations with identical semantics

### Additive

Examples:

* New optional property that remains omitted by default
* New unused schema definition
* New optional event metadata
* New optional provenance field

An optional property is classified as additive only when existing consumers will not reject the property under the applicable `additionalProperties` policy.

### Breaking

Examples:

* Adding a required property
* Removing or renaming a property
* Replacing a property type
* Removing an enum value
* Changing `$id` or schema version without the required compatibility transition
* Changing `additionalProperties` from permissive to restrictive
* Removing an event or error code
* Changing existing field semantics

### Manual Review

Examples:

* Adding a value to a closed enum
* Widening a union type
* Changing numeric, string, or array constraints
* Any change the classifier cannot safely categorize
* Changes whose compatibility depends on producer emission behavior

## Promotion Policy

| Classification  | Law Prep gate | Additional requirement                                |
| --------------- | ------------- | ----------------------------------------------------- |
| `no-impact`     | Not required  | Normal producer verification                          |
| `additive`      | Required      | Consumer tests must pass                              |
| `breaking`      | Required      | Contract/API version transition and explicit approval |
| `manual-review` | Required      | Human classification before promotion                 |

Unknown changes fail closed.

## Acceptance Criteria

* Contract compatibility is not based on informal review.
* Every contract-affecting candidate has a machine-readable classification.
* Breaking and unknown changes cannot silently enter a stable release.

---

# Phase 5 — Event-Driven Cross-Repository Consumer Gates

## Goal

Run each consumer’s tests in its own repository while keeping the producer candidate manifest single-writer and immutable.

## Selected Model

Use an event-driven consumer-gate protocol.

The producer does not check out and execute entire consumer repositories inside the producer workflow.

## Dispatch Mechanism

After the candidate and applicable producer verification jobs pass, the producer dispatches explicit consumer workflows:

```text
cert-prep/.github/workflows/capture-candidate-gate.yml
law-prep/.github/workflows/capture-contract-gate.yml
```

Use the GitHub workflow-dispatch API with a GitHub App installation token scoped to the required repositories. The API accepts workflow inputs and returns the created workflow-run ID, allowing the producer to track the exact consumer run. It requires Actions write permission on the target repository.

The consumer workflow files must exist on their default branches.

## Dispatch Inputs

```json
{
  "producer_repository": "gx-capture/capture-workbench",
  "producer_run_id": "...",
  "candidate_id": "...",
  "candidate_manifest_sha256": "...",
  "source_commit": "...",
  "release_version": "...",
  "contract_classification": "..."
}
```

## Consumer Responsibilities

Each consumer:

1. Checks out its own default branch.
2. Downloads the producer candidate using the supplied producer run ID.
3. Verifies candidate ID and manifest digest.
4. Verifies producer attestation where available.
5. Runs its repository-owned test suite.
6. Produces an independent result artifact.
7. Never modifies the producer candidate or candidate manifest.

## Consumer Gate Result

Each workflow produces:

```text
consumer-gate-result-v1.json
```

Example:

```json
{
  "schemaVersion": "1",
  "consumerRepository": "WodenWang820118/cert-prep",
  "consumerCommit": "...",
  "workflowPath": ".github/workflows/capture-candidate-gate.yml",
  "workflowRunId": "...",
  "candidateId": "...",
  "candidateManifestSha256": "...",
  "verdict": "passed",
  "checks": [],
  "startedAt": "...",
  "completedAt": "..."
}
```

## Result Trust Model

The producer verifies:

* Target repository
* Workflow path
* Workflow run ID
* Consumer commit
* Workflow conclusion
* Candidate ID
* Candidate manifest digest
* Downloaded result digest

Use GitHub artifact attestations for consumer results where supported. Artifact attestations are available for public repositories on current GitHub plans; private-repository availability depends on Enterprise Cloud. The protocol therefore does not rely solely on attestation availability.

For a private consumer without attestation support, the minimum trust boundary is the authenticated GitHub workflow run plus the exact downloaded result artifact and digest.

## Producer Aggregation

The producer:

1. Stores the consumer workflow-run IDs.
2. Polls the exact runs to completion.
3. Downloads the independent result artifacts.
4. Verifies each result.
5. Produces a separate aggregate gate ledger.

```text
consumer-gate-ledger.json
```

The producer remains the sole writer of release state.

The final release manifest may contain copies of verified gate summaries, but consumers never write into it directly.

## Cert Prep Gate Scope

Required when any of the following change:

* Workbench package
* runtime
* launcher
* contracts
* runtime API
* schema
* installer-staged runtime resources

Tests include:

* candidate Workbench installation
* exact runtime staging
* backend coordination
* Web Component integration
* Tauri package QA
* runtime process lifecycle

## Law Prep Gate Scope

Required only for:

* `additive`
* `breaking`
* `manual-review`

contract classifications.

Tests include:

* candidate Python package installation
* Java contract consistency
* schema validation
* structuring integration
* generated contract drift
* backward-compatibility fixtures

## Failure and Retry

* A failed or timed-out consumer workflow blocks promotion.
* The same candidate may be redispatched.
* Consumer retries do not rebuild the producer candidate.
* Gate requirements are determined from the candidate’s change classification, not from manual operator choice.

## Acceptance Criteria

* Cross-repository gates have a concrete dispatch, tracking, result, and verification protocol.
* No shared manifest has multiple writers.
* Each repository remains responsible for its own environment and credentials.
* A consumer failure reliably blocks promotion.

---

# Phase 6 — Promotion and Tag-Last Publication

## Goal

Publish only an approved immutable candidate and make each registry independently retryable.

## New Workflow

```text
.github/workflows/release-promote.yml
```

## Inputs

| Input               | Purpose                                           |
| ------------------- | ------------------------------------------------- |
| `candidate_run_id`  | Producer run containing the candidate             |
| `candidate_id`      | Expected candidate identity                       |
| `publication_scope` | `all`, `npm`, `pypi`, `crates`, or recovery scope |

## Promotion Preconditions

* Candidate identity and digests verify.
* Required producer verification jobs passed.
* Required consumer gate results passed.
* Contract classification policy passed.
* The version is not associated with conflicting registry bytes.
* Promotion environment approval is complete.

## Reusable Registry Workflows

```text
.github/workflows/_publish-npm.yml
.github/workflows/_publish-pypi.yml
.github/workflows/_publish-crates.yml
.github/workflows/_verify-registries.yml
.github/workflows/_publish-github-release.yml
```

## Registry Behavior

```text
Version absent
→ Publish the exact candidate artifact

Version present
→ Verify the published artifact against the approved candidate or accepted registry representation
```

Registry-specific normalization must be explicit. For example, if a registry legitimately repackages an archive, both the candidate digest and the registry archive digest must be recorded and the relationship verified according to a documented rule.

An unexplained digest difference fails closed.

## Correct Publication Order

```text
Publish npm, PyPI, and crates.io
→ Verify clean installation from each registry
→ Create annotated Git tag
→ Push Git tag
→ Create GitHub Release for the existing tag
→ Upload candidate runtime and desktop assets
→ Upload immutable compatibility manifest
→ Verify anonymous downloads and attestations
→ Update canonical stable pointer
```

GitHub’s release API requires a `tag_name` and can create a tag from `target_commitish` when the tag does not already exist. To preserve true tag-last behavior, this plan explicitly creates and pushes the tag before creating the GitHub Release.

## Recovery

* Registry jobs may be independently rerun.
* Recovery always downloads the original candidate.
* A fresh build is rejected after any registry publication.
* The final tag and GitHub Release are created only after the complete required registry set succeeds.

## Tag Audit Workflow

A tag-triggered workflow remains only as an audit:

```text
Tag pushed
→ Verify tag commit, registry versions, candidate ID, and release manifest
```

It does not build or publish.

## Acceptance Criteria

* Promotion performs no build.
* Registry outages do not consume new versions.
* The tag is evidence of successful publication rather than the release trigger.
* GitHub Release assets come from the approved candidate.

---

# Phase 7 — Canonical Compatibility Channel and Supersession

## Goal

Provide consumers with a stable discovery channel while keeping the actual release trust anchor immutable and verifiable.

## Immutable Trust Anchor

Each GitHub Release contains:

```text
capture-release-manifest-v1.json
capture-release-manifest-v1.json.sha256
```

The manifest records:

```json
{
  "schemaVersion": "1",
  "status": "released",
  "candidateId": "...",
  "sourceCommit": "...",
  "releaseTag": "...",
  "releaseVersion": "...",
  "components": {},
  "registryArtifacts": [],
  "runtimeAssets": [],
  "contractClassification": {},
  "consumerGates": {}
}
```

The manifest and primary release assets receive GitHub artifact attestations. Consumers verify both the digest and expected signer workflow. GitHub supports verification against a specific signing repository or workflow.

## Mutable Discovery Pointer

Maintain:

```text
release-index/stable.json
```

on a protected dedicated branch.

Example:

```json
{
  "schemaVersion": "1",
  "channel": "stable",
  "releaseTag": "v0.4.0",
  "manifestSha256": "...",
  "manifestAssetName": "capture-release-manifest-v1.json",
  "updatedAt": "..."
}
```

The pointer is used only for discovery.

It is not the trust anchor.

Consumers:

1. Read `stable.json`.
2. Fetch the immutable manifest from the referenced release.
3. Verify the manifest digest.
4. Verify the manifest attestation and signer policy.
5. Apply consumer-specific compatibility rules.

Only the promotion workflow may update the protected release-index branch.

## Release Completion

A release is considered stable only after:

* required registries pass verification
* Git tag exists
* GitHub Release exists
* immutable manifest is uploaded and attested
* anonymous asset verification passes
* `stable.json` points to the release

## Supersession and Rollback

Immutable release manifests are never rewritten.

When a released version is defective:

1. Publish a corrected version when artifact contents must change.
2. Move `stable.json` to the corrected or previous known-good release.
3. Update a mutable release status index:

```text
release-index/releases.json
```

Example:

```json
{
  "v0.3.10": {
    "status": "superseded",
    "supersededBy": "v0.4.0",
    "reason": "launcher metadata defect"
  }
}
```

4. Add a warning to the affected GitHub Release notes.
5. Where appropriate:

   * deprecate the npm package version
   * yank the PyPI release
   * yank the crates.io version

Registry artifacts remain immutable and are never overwritten.

Consumer update automation follows only the stable pointer and ignores releases marked superseded.

## Acceptance Criteria

* Consumers have a canonical discovery location.
* The discovery pointer is not confused with the cryptographic trust anchor.
* A defective complete release can be superseded without rewriting history.
* Consumer bots do not propose known-bad releases.

---

# Phase 8 — Independent Artifact Versioning

## Goal

Remove the lockstep version train only after candidate publication, compatibility manifests, and consumer gates have proven stable.

## Timing

Start only after:

* several successful tag-last releases
* stable cross-repository gate operation
* trusted manifest publication
* proven SemVer discipline
* operational supersession procedures

## Version Groups

| Group       | Contents                                   |
| ----------- | ------------------------------------------ |
| Contracts   | TypeScript and Python contract packages    |
| Structuring | TypeScript and Python structuring packages |
| Workbench   | Angular and Web Component package          |
| Runtime     | Runtime executable and runtime metadata    |
| Launcher    | Rust sidecar launcher                      |
| Desktop     | Capture Workbench desktop product          |

## Compatibility Model

Each group declares:

* independent SemVer
* supported contract range
* supported runtime API range
* schema version and digest
* relevant peer-framework ranges

The release manifest publishes a machine-checked compatibility set rather than relying on equal version numbers.

## Consumer Dependency Policy

### Cert Prep

* Continues to consume a tested Workbench/runtime set.
* Runtime binaries remain exact and SHA-pinned.
* Library ranges may be introduced only when the compatibility manifest and consumer gate prove the resulting combination.
* Upgrades remain atomic through `capture-release.lock.json`.

### Law Prep

* May adopt compatible package ranges once contract-package SemVer is proven.
* Lockfiles retain exact resolved versions.
* Contract classification and consumer tests remain mandatory for applicable changes.

## Accepted Asymmetry

Until this phase:

* A genuine Capture Workbench artifact change still bumps the lockstep train.
* Cert Prep still receives an atomic upgrade PR for each complete release.
* Law Prep is already partially decoupled because it gates only contract-impacting changes.

The early phases eliminate infrastructure-caused bumps. They do not claim to eliminate genuine lockstep product releases before independent versioning is implemented.

## Acceptance Criteria

* A launcher-only fix does not bump contracts, Workbench, runtime, and desktop.
* A UI-only fix does not republish Python and Rust packages.
* Compatibility is machine-checked rather than inferred from equal versions.
* Consumer ranges are introduced selectively, not globally or prematurely.

---

# Final Implementation Sequence

1. Establish Phase 0 release and recovery policy.
2. Introduce centralized version generation.
3. Add fast pre-publish package verification.
4. Create the immutable candidate workflow.
5. Split heavy verification into candidate-reuse jobs.
6. Implement the contract impact classifier.
7. Implement event-driven Cert Prep and Law Prep gate workflows.
8. Implement producer gate-result collection.
9. Create candidate-only promotion and registry workflows.
10. Move Git tag and GitHub Release creation to the end.
11. Publish the immutable attested release manifest.
12. Add the protected stable release index.
13. Add supersession and rollback handling.
14. Stabilize the architecture over several releases.
15. Introduce independent artifact versioning.
16. Adopt compatible ranges selectively after SemVer guarantees mature.

---

# Final Success Criteria

* CI infrastructure failures consume zero new versions.
* OIDC and registry outages consume zero new versions.
* Promotion never rebuilds release artifacts.
* Every retry uses the same candidate ID.
* Heavy verification jobs independently reuse the stored candidate.
* Consumer gates execute in their own repositories.
* Consumers publish independent result artifacts.
* The producer remains the sole writer of release state.
* Contract compatibility has a concrete classifier.
* Git tags are created only after registry publication succeeds.
* GitHub Releases are created only after their tags exist.
* The stable pointer references an immutable, attested release manifest.
* Defective releases can be superseded without mutating published history.
* Cert Prep upgrades UI and runtime atomically.
* Law Prep blocks only contract-affecting releases.
* Independent artifact versioning is deferred until the release and compatibility systems are stable.
