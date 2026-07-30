# Capture Workbench v0.3.4 Release Checklist

This checklist is the active release gate. Check an item only after the exact
`v0.3.4` candidate or tagged commit has produced the stated evidence.

## Immutable failed-release evidence

- The lightweight `v0.3.2` tag remains at
  `8d5b3364320f60a1f16cf9ee222663150cb57c11`. Release run `30517094297`
  failed before publication because Windows checkout converted the canonical
  source-lock JSON to CRLF. No `v0.3.2` GitHub Release, assets, or package were
  created.
- The lightweight `v0.3.3` tag remains at
  `cfe570474a6925b4ad41a7c49685cae90f8aeebb`. Release run `30523583549`
  passed ancestry, exact-main-CI, frozen install, synchronized-version, and
  canonical core-only classification gates. It then failed in the redundant
  pre-staging `pnpm verify` because the clean release environment intentionally
  had no staged Tauri sidecar and no optional `pypdfium2` or Pillow worker
  dependencies. `publish` was skipped; no `v0.3.3` GitHub Release, assets, or
  package were created.
- Never delete, move, recreate, or publish around either failed tag. The next
  candidate is `v0.3.4`.

## Proof ownership

- Pull-request and `main` CI own the complete workspace
  lint/typecheck/test/build/package/desktop/smoke proof.
- Release must consume one successful exact-commit `.github/workflows/ci.yml`
  `push` run on `main` for the tagged SHA.
- Release must not rerun the redundant full-workspace `pnpm verify`.
- Release still owns ancestry, frozen install, synchronized-version,
  canonical source-lock classification, model receipt/catalog rules,
  production `build-release-artifacts`, runtime staging, NSIS build,
  installed-size/budget checks, candidate assembly/upload, downloaded-byte and
  package-integrity verification, and fail-closed publication.

## Candidate identity

- [x] All live first-party version owners are synchronized at `0.3.4`.
- [x] Canonical source-lock bytes classify as exactly `core-only`, with empty
      requirements and no model candidate receipt.
- [ ] Tag commit is reachable from `main`.
- [ ] One trusted exact-commit `main` push CI run is terminal success.

## Automated candidate evidence

- [x] Focused workflow contract and version checks pass.
- [x] Full `corepack pnpm verify` passes for the exact candidate tree.
- [ ] Production runtime release artifacts are rebuilt without ambient model
      stores.
- [ ] The staged runtime manifest/schema/executable are internally consistent.
- [ ] The exact `0.3.4` NSIS installer passes installed-size and budget checks.
- [x] The exact `0.3.4` package tarball passes isolated Angular, Vanilla,
      React, and Vue consumer proof.
- [ ] Core-only candidates contain no model, optional-worker, fixture, receipt,
      or model ZIP asset.

## Git and publication boundary

- [ ] Independent review approves the exact candidate tree.
- [ ] The reviewed tree is committed and merged to `main`.
- [ ] Lightweight `v0.3.4` is created exactly once at the reviewed `main`
      commit.
- [ ] Release workflow `build-candidate` and `publish` jobs are terminal
      success for the immutable tag SHA.
- [ ] Public GitHub Release targets the immutable tag, is neither draft nor
      prerelease, and contains only the canonical assets for the classified
      mode.
- [ ] Published package version/integrity equals the candidate tarball.

## Follow-up CI latency plan

Measured baseline:

- PR CI: `22m20s`
- `main` CI: `20m40s`
- Installer and size verification: about 8-10 minutes
- Desktop verification: about 4m45s
- Optional worker build/verification: about 2m40s

Later work should split and parallelize independent lanes, improve cache and
artifact reuse, and tier PR/main/release responsibilities. It must not drop
ancestry, exact-main trust, canonical metadata, model receipt/catalog,
production rebuild, packaging, integrity, or publication correctness gates.
