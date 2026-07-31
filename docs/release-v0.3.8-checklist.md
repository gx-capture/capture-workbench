# Capture Workbench v0.3.8 Release Checklist

This is the active release gate. Check an item only after the exact `v0.3.8`
candidate or tagged commit has produced the stated evidence.

## Immutable recovery boundary

- Preserve `v0.3.6` and its empty draft `362689039` unchanged.
- Preserve `v0.3.7` at `3453c4717f4feaac1984271d9a5eb7eee6d03d93` and its
  unpublished nine-asset draft `362821773` unchanged. Its publish failure was
  GitHub normalization of the space-bearing installer filename; `0.3.7` was
  never published to GitHub Packages.
- Do not reuse an occupied tag, delete a draft/release, clobber an asset, or
  overwrite a package version. A changed candidate after tag creation requires
  the next patch version.

## Candidate contract

- [ ] All package, runtime, Cargo, Tauri, manifest, generated catalog, fixture,
      workflow, and live documentation owners are synchronized at `0.3.8`.
- [ ] The classifier reports exactly `core-only`, with no model/worker ZIP,
      receipt, fixture, or model asset in the release candidate.
- [ ] Tauri may build its local
      `Capture Workbench_0.3.8_x64-setup.exe`, but candidate staging copies the
      byte-identical installer as the canonical GitHub asset
      `Capture.Workbench_0.3.8_x64-setup.exe` and rebinds the candidate size
      report plus checksum to that staged name.
- [ ] Before draft creation, upload, or package publication, publisher preflight
      rejects every non-GitHub-stable asset basename (including whitespace,
      Unicode, path separators, leading/trailing punctuation, or other
      normalization-prone characters). All nine expected core-only basenames
      pass the conservative ASCII allowlist.
- [ ] Remote inventory and downloaded bytes remain the second defense: absent
      names upload without clobber; present names download and byte-compare;
      duplicate, extra, missing, or byte-different assets fail closed before
      package publication and again before public edit.
- [ ] Release notes disclose the unsigned NSIS feasibility status,
      Unknown publisher/SmartScreen risk, SHA-256 verification expectation, and
      GitHub-Packages-only package tarball.

## Evidence and publication gates

- [ ] `corepack pnpm run verify:release-version -- v0.3.8` passes.
- [ ] `capture-runtime:classify-release-model-mode` reports `core-only`.
- [ ] Focused publisher tests cover stable-name preflight, empty/partial retry,
      matching and mismatched bytes, extras, no-clobber, upload/readback names,
      release disclosure, and package-before-public order.
- [ ] One `corepack pnpm verify` passes; do not separately rerun package QA or
      a second local `capture-angular:pack` unless a local publisher consumes it.
- [ ] The release-only path passes once: production runtime staging, NSIS build,
      release installed-size smoke, and size regression check.
- [ ] Independent review approves the exact prospective tree SHA before commit.
- [ ] After merge, one terminal-success `ci.yml` `main` push run matches the
      exact merge SHA. Then and only then create and push the one immutable
      `v0.3.8` tag; the tag workflow owns release draft, asset upload, package
      publish/integrity, final readback, and public transition.
