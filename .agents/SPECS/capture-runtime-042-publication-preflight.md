# 0.4.2 publication preflight repairs

## Purpose and authorization

On 2026-09-21 the user requested separate repository commits, preparation and
publication of 0.4.2 packages, then real OCR using fresh published downloads in
Capture Workbench, Cert Prep and LAW. The reviewed R3 work and consumer
checkpoints are committed at Capture `2f232b9`, Cert `5959572`, LAW `ea6199d`.
This slice repairs publication/diagnostic defects needed under either release
scope; it does not decide which unfinished Phase2 features ship in 0.4.2.

The user supplied the canonical JPEG (SHA-256
`9b1a9a87bae10ecd07b4b7874d5f8e46fbd8b798cc0becb20825636637da99b1`)
and explicitly selected actual usability as the minimum OCR requirement, with
Root judging autonomously. Full-text truth is unavailable; do not block only
on that absence or claim CER acceptance. Artifact identity, fresh extraction,
privacy, ownership and cleanup remain required.

## Bounded defects

1. `_publish-pypi.yml` uploads before unconditionally reading
   `runtime-candidate-manifest.json`. Standalone package and runtime candidates
   supply `candidate-manifest.json`; the full-release promotion layout may
   carry the runtime manifest under an alias. A later fallback cannot repair
   the earlier post-publication failure. Resolve the actual layout and exact
   source identity before publication, then use that same validated identity
   for the immutable ledger. Reject mismatched/ambiguous identities.
2. `runtime-candidate.yml` rebuilds the Python client after verifying a package
   candidate that already contains it. `assemble-runtime-candidate.ts` copies
   local Python dist bytes. Runtime candidates must reuse the verified package
   candidate's exact wheel and source archive, with explicit origin and hash
   checks, rather than produce another distribution for the same version.
3. LAW `AiEngineClient.extractOcr` logs upstream response bodies and exception
   messages and retains raw upstream exceptions as causes. Before private
   fixture execution, ensure OCR failure logging and propagated errors cannot
   expose synthetic secret/source/body sentinels. Preserve the public error
   category/status and ordinary OCR success behavior.
4. Release inventory scans intentional negative R3 test versions as release
   owners and assumes pre-R3 fixture counts. Validate the named production R3
   identity constants instead; preserve negative fixtures. Move PyPI endpoint
   and project inventory checks to the actual shared helper after consolidation.
5. LAW's Foundry structuring test retains a fixed 0.4.1 contract expectation.
   Its origin is commit `2e20f15`; current producer runtime/TypeScript/Python
   bundles independently hash to
   `d293a3de26114f1b4fd65ea6d6d3f157fa2f93109b31e1e30d5d15ef0dfdeb40`,
   matching the Java resource at producer commit `232d6ea`. Correct that fixed
   expectation explicitly; do not derive it from the tested SDK constant.

## Ownership and interfaces

Producer implementation owns `.github/workflows/_publish-pypi.yml`, the PyPI
job only in `.github/workflows/release-promote.yml`, identity-input propagation
only in `.github/workflows/package-promote.yml` and `runtime-promote.yml`,
`.github/workflows/runtime-candidate.yml`, existing
`tools/record-pypi-candidate.ts`, `tools/assemble-runtime-candidate.ts`, and
their focused tests. It may adjust the existing promotion-registry target in
`tools/project.json` solely to register meaningful new coverage. Read the
package/runtime/full promotion callers and validators before selecting a
manifest; do not infer identity from filename or file presence alone.

Prefer extending the existing ledger owner over creating a second authority.
Any new CLI option must have a clear required/default contract, preserve valid
existing callers, and reject unsupported kinds, incomplete identity, wrong
version/source/contract, wrong archive pairs and hash mismatch before upload.
No publication occurs in tests. Preserve candidate bytes and schemas.

Preserve the full-release inline Trusted Publishing action location, existing
environments, and surrounding promotion graph. Both the reusable and inline
PyPI jobs must establish Node 24 before invoking the typed shared helper.
Preflight must run before artifact upload and recording must consume its
validated binding. Do not change stable-pointer scheduling in this slice.

The CLI must require explicit mode (`preflight` or `record`) and complete
expected candidate kind, source commit, release version, contract hash, IDs and
manifest digest bindings. Migrate every repository caller together; reject
missing/unsupported inputs before upload rather than silently guessing a kind.
An explicit full-release kind is distinct from package and standalone runtime:

| Layout | Ledger candidate ID | Release candidate ID | Source manifest digest |
| --- | --- | --- | --- |
| Package | Package ID | Package ID | `candidate-manifest.json` |
| Standalone runtime | Runtime ID | Runtime ID | `candidate-manifest.json` |
| Full release | Runtime ID | Full-release ID | `runtime-candidate-manifest.json` |

For full release, the main manifest legitimately lacks `candidateKind`.
Validate its runtime reference against the runtime alias, including source,
version, contract, package reference and Python inventory. Reject conflicting
aliases and duplicate entries. Preserve the raw validated manifest digests and
selected distribution hashes in the preflight binding; recording must detect
manifest or staged-byte substitution and must not rebind identities afterward.

Preflight must reconcile existing remote PyPI distributions before upload.
Only a definite HTTP 404 means absent. A complete or partial existing set is
allowed only when every existing filename/hash matches the exact selected
wheel/sdist pair; conflicting or extra distributions, malformed metadata,
authentication/server/network failures are blockers. Keep mandatory post-upload
readback for races and ambiguous outcomes; no passing ledger until both remote
files match. `skip-existing` alone is not reconciliation or acceptance.

Root owns `tools/release/version-sources.ts` and its tests. Keep production
identity checks fail-closed on value drift, removal and duplication. Existing
positive test fixtures and intentional negative fixtures are not independent
production version authorities. Track PyPI project and endpoint at their real
executable owner, and retain corresponding destination mutation coverage.

A separate LAW worker owns only
`apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/ai/AiEngineClient.java`
for the OCR method and a focused test under the corresponding test package;
creation of `AiEngineOcrPrivacyTest.java` is explicitly in scope if no existing
test owns this seam. The same worker also owns only the fixed expected digest
in `apps/law-prep-engine/src/test/java/com/gx/lawprep/engine/capture/FoundryCaptureStructuringProviderTest.java`,
based on the independently verified source provenance above. Keep this change
separate from privacy coverage. Do not change unrelated AI operations, OCR DTOs, routes,
receipt integration, lifecycle, dependency pins or the public API.

## Verification and stop conditions

Fresh Root Nx discovery succeeded after read-only workers encountered sandbox
access-denied errors. Resolve targets again when necessary; use uncached Nx.
Producer floor: `capture-tools:promotion-registry-test` and
`capture-tools:release-version-test`, with focused behavioral RED/GREEN cases
for each candidate layout and exact SDK-byte reuse. Extend the existing target
for new tests instead of inventing an unregistered command. LAW floor:
`law-prep-engine:test` with explicit evidence that the new privacy class ran.

Tests must prove pre-publication failure for missing/conflicting identities,
correct ledger binding for package/runtime/full callers, byte-for-byte Python
reuse despite differing local dist files, and privacy under HTTP and transport
failures. Do not reduce tests to string snapshots of the new implementation.

Required behavioral cases include all three realistic layouts; missing,
conflicting or substituted manifest bindings; exact wheel/sdist pairing; local
Python dist absent or different; remote 404, exact partial/complete retry,
conflicting/extra remote files and indeterminate responses; and post-preflight
byte/identity changes. Check workflow preflight ordering as supplementary
coverage. LAW coverage includes HTTP/transport/malformed/empty responses and
success, with sentinel checks on formatted logs, messages, causes and suppressed
exceptions. Inventory mutations must reject missing/duplicate/drifted production
constants and wrong PyPI destination/project while leaving negative Rust
fixtures intact. No real registry publication occurs during these tests.

Root's initial baseline: producer promotion-registry 28 passed; release-version
17 tests with 10 failures from the diagnosed inventory defects. LAW Java
358 tests with one old-hash failure and one skip. Retain these results as RED
evidence, not acceptance. Full specified Nx floors must pass after repairs.

Fresh specification and standards reviews precede implementation; fresh review
also follows repairs. All workers are new GPT-6 Astra medium sessions with at
least 30 minutes for analysis/review. Preserve prior commits and stage exact
owned paths. Any required expansion is reported to Root before editing.

The first fresh plan reviews (30m20s and 30m30s) were BLOCKED on the ownership,
remote reconciliation, inventory and LAW baseline omissions now specified
above. They are not approvals. Obtain fresh amendment reviews before opening
implementation gates; Root does not self-approve their closure.

No registry upload, tag, candidate sealing, stable-pointer mutation or installed
OCR claim occurs in this repair slice. A confirmed occupied immutable version
requires exact-byte reconciliation or an explicit successor decision. The
separate release-scope question remains pending; no silent contract relaxation
or claim of complete Phase2 is authorized by this document.
