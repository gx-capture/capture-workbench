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

## Ownership and interfaces

Producer implementation owns `.github/workflows/_publish-pypi.yml`,
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

A separate LAW worker owns only
`apps/law-prep-engine/src/main/java/com/gx/lawprep/engine/ai/AiEngineClient.java`
for the OCR method and a focused test under the corresponding test package;
creation of `AiEngineOcrPrivacyTest.java` is explicitly in scope if no existing
test owns this seam. Do not change unrelated AI operations, OCR DTOs, routes,
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

Fresh specification and standards reviews precede implementation; fresh review
also follows repairs. All workers are new GPT-6 Astra medium sessions with at
least 30 minutes for analysis/review. Preserve prior commits and stage exact
owned paths. Any required expansion is reported to Root before editing.

No registry upload, tag, candidate sealing, stable-pointer mutation or installed
OCR claim occurs in this repair slice. A confirmed occupied immutable version
requires exact-byte reconciliation or an explicit successor decision. The
separate release-scope question remains pending; no silent contract relaxation
or claim of complete Phase2 is authorized by this document.
