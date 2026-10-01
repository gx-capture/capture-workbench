# Scoped version management

User-authorized implementation, 2026-09-30. The research and independent review are in ../RESEARCH/cross-project-version-management-2026-09-30.md.

## Contract

1. Within each repository/package/test domain, share and reference version values through the existing owner where possible.
2. Version changes use code and normally update only those shared variables. Native metadata and generated contract bytes are explicit derived exceptions.

Keep the checked-in release at 0.4.4 while implementing. Keep product versions, Capture adoption pins, protocol/schema versions, model provenance and historical evidence distinct. Preserve current strict runtime/contract validation and standalone installed-package behavior.

Capture owns release/version.json; Python runtime constants and native package metadata are synchronized mirrors. Runtime SDK consumers use their own packaged constants. Cert extends its existing version facade; LAW gets one local pin source and extends existing check/staging tools. No cross-checkout runtime imports or floating versions.

## Version tool

Provide read-only plan/check and explicit apply operations with structured file/field mappings, input validation, missing/duplicate owner rejection, no broad repository string replacement, and idempotency. Derived metadata must be reported truthfully; a source-only preparation must not claim generated contracts/locks/release evidence are current. Model-source approval and content hashes are never invented or automatically approved.

## Acceptance

- Current 0.4.4 behavior and contract bytes remain unchanged after reference refactoring.
- Ordinary source/tests use local shared version owners; negative/history fixtures remain independent.
- Isolated alternate-version rehearsal changes only declared owners/metadata, preserves third-party same-version values, and repeats with no changes.
- Missing/duplicate fields fail before mutation; checks never write; artifact/version and hash mismatch checks remain.
- Nx targets include central version files as inputs; relevant tests, typechecks, lint/build checks pass.
- Three repositories are reviewed at their current HEAD and explicit dirty/untracked scope; no commit or publication is included.

## Verification

Use resolved pnpm nx targets. Unit tests exercise transformations and CLI behavior on private temporary roots; compare current-version generator output/contract digests. Consumer validation runs in isolated copies first, then rechecks applied files. Report packaging/network limitations separately from passing local checks.
