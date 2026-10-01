# Scoped version management implementation

Implemented the user's two rules: share/reference versions within explicit ownership boundaries, then update those owners with code. No release bump was performed: Capture adoption remains 0.4.4; Cert and LAW product versions retain their independent values. The implementation checkpoints below were initially left uncommitted; the subsequent local-commit authorization is recorded at the end.

## Result and daily workflow

| Repository | Main version owner | Source update scope |
| --- | --- | --- |
| Capture Workbench | `release/version.json` | 13 explicit files: intent, packaged Python constant and native metadata |
| Cert Prep | `tools/capture-runtime-version.json` | 6 explicit fields in 5 files for Capture adoption; independent product scope |
| LAW Prep | `release/capture-version.json` | 11 explicit field mappings in 10 files, including native mirrors and current strict contract inputs |

Capture ordinary runtime, SDK, UI, desktop, launcher and tool/test consumers now reference scoped constants. TypeScript/Python/Java SDK constants remain packaged with the SDK; Rust uses package metadata where it owns the release. Node release tools read the release intent. Installed consumers do not reach into another checkout.

Cert extends its existing facade, embeds the adoption owner in the Rust build, and reads SDK metadata in installed Python code. Product QA and packaging use the existing Tauri/pyproject owners. The historical Phase 1 lane continues to use its immutable identity.

LAW reads its local adoption owner in tools/CI and uses packaged Python/Rust mirrors at runtime. Candidate overrides select all corresponding model asset filenames consistently. Its existing contract generator still owns generated validators and source hashes.

Preview and apply from each repository:

```powershell
# Capture
pnpm nx run capture-tools:release-version-plan --args="--version 0.4.5"
pnpm nx run capture-tools:release-version-sync --args="--version 0.4.5"
pnpm nx run capture-tools:release-version-check

# Cert: Capture adoption
pnpm nx run cert-prep-desktop:version-plan --args="--version 0.4.5"
pnpm nx run cert-prep-desktop:version-apply --args="--version 0.4.5"
pnpm nx run cert-prep-desktop:version-check

# Cert: independent product version
pnpm nx run cert-prep-desktop:version-plan --args="--scope product --version 0.1.0-alpha.2"
pnpm nx run cert-prep-desktop:version-apply --args="--scope product --version 0.1.0-alpha.2"
pnpm nx run cert-prep-desktop:version-check --scope product

# LAW: Capture adoption
pnpm nx run @org/scripts:capture-version -- plan 0.4.5
pnpm nx run @org/scripts:capture-version -- apply 0.4.5
pnpm nx run @org/scripts:capture-version -- check
```

These examples are future commands, not versions applied in this implementation.

## Update guarantees and limits

- Plan/check are read-only. Apply validates explicit owners before writing; repeated application is a no-op. Stale or injected plans are rejected. Failed writes trigger restoration and report restoration failures.
- Capture's raw CLI and `pnpm sync:release-version` default to preview, even with `--version`. Writing requires `--apply`; the Nx `release-version-sync` target already supplies it. The `synchronizeReleaseVersion` helper also previews unless passed `apply: true`, and rejects `check: true` combined with `apply: true`.
- Native TOML/JSON/XML/YAML fields are bounded to their owning section or node. Missing and duplicate owners fail; unrelated dependencies with the same version are preserved.
- Capture no longer recursively replaces version strings. Its no-op report retains follow-up when derived versions, hashes or local Cargo/uv lock identities are stale.
- Native metadata requiring literal versions remains an explicit mirror. Shared owner changes are Nx cache inputs.
- Locks are resolved by their package managers. Generated contracts/engine catalogs/profiles are produced by the existing generators. Model-source approval, schema hashes and receipt evidence require their existing independent verification.
- Source preparation is not release readiness. Historical evidence, negative fixtures, model provenance and fixed byte/digest vectors are not blanket rewritten.

The 13-file Capture plan is the source update count, not the total eventual release diff. Generator outputs and lock refreshes can still change additional files. The reduction is in hand-maintained version consumers and manual update decisions.

## Verification

Checks ran through resolved Nx targets in the original repositories after integration unless identified as worker validation. Normal sandboxed Node child spawning returned EPERM; those results were not counted as passes. Real checks were rerun with the necessary execution permission.

| Scope | Evidence |
| --- | --- |
| Capture updater/inventory | 40 tests passed; lint, TypeScript and current 0.4.4 source/derived/lock check passed; alternate 7.8.9 preview lists exactly 13 files |
| Capture release tooling | Promotion/registry 48 tests; general tools 74; contract/candidate/consumer/promotion/manifest/index checks passed; isolated pip/Poetry HTTP candidate installation passed |
| Capture desktop scripts | 328 passed, 1 platform skip |
| Capture runtime | Post-fix unit target passed: 666 Python passed, 1 skipped, plus 22 Node tests; lint/typecheck passed; standalone no-project Python validator regression covered |
| Capture package references (worker) | Integration 216; TS SDK 25, Python SDK 28, Java 24; UI 77, app 109; desktop Rust 53; launcher 325 unit + 7 public API + 12 lifecycle + 34 fixture; browser 4; associated lint/typecheck/format checks passed |
| Cert original checkout | Final consumer/updater 42 (including updater 13); candidate gate 29; install binding 8; package QA 284 passed, 1 skipped; Rust 39; Python unit 120; script typecheck and version-check passed |
| LAW original checkout | Final version/contract/staging 45 passed, 1 skipped; new persistent strict TypeScript target passed and is required by focused/main tool tests; Python unit 573 passed, 5 skipped; contract generator, consistency, Python typecheck/lint and tools lint passed; Rust staging 18 passed/1 skipped, fmt/check/test 29 passed |

Current contract schemas, contract-set bytes, dependency lockfiles, fixed goldens and model approval data were not changed by this refactor. Generator execution in LAW preserved tracked generated files. Existing LAW lint/dead-code warnings are separate from this change.

Cert's existing root SDK link resolves 0.4.3 despite the 0.4.4 lockfile and UI-bound SDK. Normal and forced frozen installs retained the stale root alias. Investigation traced it to an extraneous candidate-install alias: Cert declares the UI package, and that UI correctly resolves SDK 0.4.4. The checker was corrected to validate the actual UI-bound SDK using Node resolution, retaining strict version and contract-hash checks. A regression covers a stale root alias with a correct UI-bound SDK, and rejects a wrong UI-bound SDK even if the root alias is correct.

## Review and integration evidence

Capture base: `14556693ae1fbda4ce528e96c5217246ebb8b2d4`. Independent app/package review found a standalone Python import regression; fixed with a stdlib release-intent reader and isolated `-I -S` test. Tooling reviews found native owner scoping, installer path, Nx input, stale follow-up and lock-check gaps; all were repaired and regression tested. Final independent tooling review reported no blockers. Its specified dirty-scope digest was `19a53b594a3b10e5a29789455920aca7a67835c57a1b9c05db71005ab028f207` (tracked diff plus specified untracked files); documentation closeout is additional.

Cert base: `1f493ca4873bdee48e07bb59c60359a3ceaf697a`. Independently approved 41-file patch SHA256 `78da16eff1eb5918cf9b35aae6a994f5cf08ce3a28a8b0936362a2656bc1fa5d`. Repairs covered owner boundaries, decoded duplicates, plan binding, partial-write rollback, dynamic current fixtures, immutable Phase 1 identity and PowerShell CI failure masking. Root applied the exact patch and verified reverse application. Independently approved incremental UI-to-SDK resolution repair SHA256 `6fe6454c9f1d7c79af1c35d83020373365977114f647b347629447e69984ff68` was applied and verified with 13 tests plus the original installed-package check.

LAW base: `2339f44e5a7bd482f289e2ea9949ea9398e8dfa9`. Applied 25-file patch SHA256 `a503dd9590529cb4f63973013cb3d96ab5b13ed8afd663ac55cfb408b414aca6`. Initial independent review blocked grouped YAML pin validation and non-transactional writes. Repairs added per-package section checks, staged writes/backups/rollback, TOML table scope and rejection of escaped duplicate JSON owners. Root inspected repairs, applied the exact patch and verified reverse application. Final review also required decoded duplicate rejection in native JSON mirrors and validation of their semantic field locations; these repairs and the persistent TypeScript target passed their regression checks. Final five-file repair snapshot SHA256: `a9f340fac9ac5a0c0efb43e14559cf46972e3092a31e42125e570e30152a209e`; whole dirty-scope SHA256: `ef404f13fa9cfc528074ffc01180c9489cae714d1b43e8694b1a9f206b7c9425`.

## Closeout

All three implementations are in the original worktrees. Capture remains 0.4.4; source/native checks, final LAW JSON/type checks and the Cert installed-package binding check pass. Final independent reviews of Capture, Cert and LAW have no remaining blockers in the reviewed scopes. These local results do not constitute published-download or installed OCR acceptance. The user explicitly requested no commit after completion; original repository indexes remain empty and all changes are left uncommitted.

## Follow-up: pnpm 12.8.2

The user's subsequent request upgrades all three project pins and exact pnpm engines to 12.8.2. Capture and Cert CI now obtain pnpm from the checked-out `packageManager`; LAW already did so. All action commit pins and verification jobs are preserved. Capture's generated consumer manifests and package-manager checks share a small reader of the root policy, replacing repeated version literals. Nx cache inputs include that reader and its manifest owner.

Availability and bootstrap behavior were checked against the official [12.8.2 release](https://github.com/pnpm/pnpm/releases/tag/v12.8.2) and [action-setup documentation](https://github.com/pnpm/action-setup#version). LAW preserves its existing integrity-pinned packageManager format using the registry/Corepack-verified SHA512 `a5941679663d952c5f0ecc38ba98af98b4dc01b95780354f6894f2f873973cef2f7e2989d7db3ee5393938ae21f62fe06bcdf685d475ddad829a62095d2b8b11`.

All three original checkouts passed `pnpm install --frozen-lockfile` using 12.8.2 and retained their lifecycle and supply-chain policies. Capture's project lockfile is unchanged. Cert and LAW's package-manager lock document was regenerated by pnpm; their application dependency documents are unchanged after line-ending normalization. Application dependency versions and native Python/Cargo locks were not upgraded.

The machine's user-level pnpm command was previously an npm-installed pnpm 10.33.2 shim; its automatic switch to the native pnpm 12.8.2 package generated a broken Windows launcher. Running the official `corepack enable --install-directory C:\Users\User\AppData\Roaming\npm pnpm` repaired the launcher. Both Corepack and bare `pnpm --version` now select 12.8.2 in each repository.

Upgrade checks: Capture passed 75 tools tests, 40 version tests, 48 release/workflow tests, related TypeScript/lint and current-version checks. Cert passed 47 release-tool TS tests, 16 Python tests, Ruff, scripts typechecks and version check. LAW passed 45 focused tests with one platform skip, TypeScript and current source/lock/contract checks. These checks exercise the tooling upgrade; the earlier product test evidence remains distinct.

Capture's reviewed pnpm slice consists of 13 files, snapshot SHA256 `5a75b0db0c7b06886a559a20ce768dafbe89f23373a7e6f63dbf2d87c0c7a507`; Cert's seven-file slice is `dbbc72f98f09cb107165bf640916c191c85adea63312d6255e6ebcf03da9746b`; LAW's three-file diff is `4312d7a7cee0430303db147091d17f497ab66691ad6e6912419b10333a662047`. Independent review approved all three bounded upgrade slices without blockers. No remote CI run, commit or staging is included in this follow-up.

## Follow-up: Grok findings resolved, 2026-10-01

Both reported bugs were confirmed against the current working trees and repaired within the version-management scope.

1. Capture's CLI and `synchronizeReleaseVersion` previously applied changes without explicit authorization in the invocation. The CLI now defaults to plan; the helper requires `apply: true` and rejects check/apply conflicts. The package script inherits the preview default, while the existing Nx sync target retains its explicit `--apply`. Regression tests first reproduced both default-write paths, then passed after the correction. They also cover drift without a requested version, `apply: false`, explicit apply, conflicting modes and repeated application.
2. Cert's bare Cargo requirement admitted compatible updates, contrary to its Capture adoption pin. The manifest now declares `capture-sidecar-launcher = "=0.4.4"`; the updater keeps `=` outside the version capture. Inventory and published/candidate checkers also require the exact prefix. Tests verify that apply retains `=`, and reject bare, caret, tilde, range and wildcard requirements before any writes. See the official [Cargo requirement syntax](https://doc.rust-lang.org/cargo/reference/specifying-dependencies.html#version-requirement-syntax).

Validation: Capture's `release-version-test` passed all 43 tests and its lint, typecheck and current-version check dependencies. Running `pnpm sync:release-version` both without arguments and with `--version 9.9.9` produced `mode: plan`; all 13 owner hashes remained unchanged. Cert's `consumer-test` passed all 45 tests; `version-check` and both script TypeScript configurations passed.

Cargo's targeted offline update of launcher 0.4.4 produced unrelated Windows dependency-edge changes. Those tool-generated changes were withdrawn; no manual lock/checksum edit was retained. The existing lock already resolves launcher 0.4.4. Full `cargo metadata --locked` subsequently succeeded after downloading one missing cached crate; the original Cargo.lock bytes remained unchanged. The first full offline attempt was blocked by missing `zerocopy-derive` 0.8.54, so that attempt is not counted as a pass. No Rust compilation or product acceptance is claimed by this follow-up.

Capture's repaired source/test hashes are `404b1e4a5c018559bb2ebe5838cdb9311a53fffa5ab3a3782a2e310687c199a8` and `207761778ecb388691c0d3ab29e8d259b1a75d5eb44b6a8c0642381045d4ff00`. Cert's five-file source/test snapshot is `f0046bff791f5fc8ca365eb3d0aead268847c41f3cfcb6202d75c8b5dc3d0341`. Independent review verified these final files and accepted both fixes without blockers or missing decisions. Review is limited to these two repairs and their adjacent call sites; unrelated OCR/runtime changes retain their separate evidence. Release/adoption versions remain 0.4.4. No files were staged or committed.

## Local commit authorization, 2026-10-01

After the verified implementation, pnpm upgrade and Grok repairs above, the user requested commits for this work. The commit scope is the reviewed version-sharing/updater changes, pnpm 12.8.2 configuration and related documentation in each repository. The earlier no-commit statements describe their respective checkpoints. Stage explicit reviewed paths and retain normal Git hooks; do not include unrelated work, push, tag or publish.
