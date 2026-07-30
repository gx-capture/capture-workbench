# Capture Workbench v0.3.3 Release Checklist

This checklist is the release gate, not a record of intent. Check a locally
verifiable item only after the exact candidate bytes have produced the stated
evidence; commit- and GitHub-bound items remain open until the exact intended
tag commit produces their evidence.

## Candidate identity

- [x] Version synchronized at `0.3.3`.
- [x] Old public owner references removed; current URLs use `gx-capture`.
- [ ] Tag commit is reachable from `main`.
- [ ] Exactly one trusted `.github/workflows/ci.yml` `push` run completed
      successfully on `main` for the exact intended tag commit.

## Release model mode

- [x] The canonical checked-in source lock was classified from its exact bytes.
- [x] Core-only: source-lock and generated-catalog `requirements` are both
      exactly empty; no model receipt, optional worker, model, or fixture asset
      is present.
- [ ] Model-enabled: the non-empty source lock is fully approved and the exact
      two complete catalog requirements are bound to one fresh successful
      exact-commit `capture-directml` candidate receipt.

Missing, malformed, non-canonical, partial, or unknown requirements are not
core-only. They block the release. The release mode is derived from repository
metadata and has no caller override.

The annotated `v0.3.1` tag was created externally and prematurely from
`develop`. GitHub Actions run `30427950949` failed during the frozen install
because that tag did not contain its matching lockfile. No build, package,
installer, or publish step ran, and no `v0.3.1` GitHub Release was created.
The tag is nevertheless occupied and must not be overwritten.

The lightweight `v0.3.2` tag points to main merge commit
`8d5b3364320f60a1f16cf9ee222663150cb57c11`. Release run `30517094297`
passed ancestry, exact-main-CI, dependency, and version gates, then failed
before build or publication because Windows checkout converted the canonical
source-lock JSON to CRLF. The classifier rejected those non-canonical bytes;
the publish job was skipped, and no `v0.3.2` GitHub Release, package, or assets
were created. Preserve the tag and run as immutable failure evidence. The next
candidate is `v0.3.3`.

## Automated candidate evidence

- [x] Packed package consumer smoke passed for the final candidate.
- [x] Angular, Vanilla, React, and Vue Web Component browser smoke passed for
      the final candidate.
- [ ] `corepack pnpm verify` passed from a frozen install.
- [x] Production runtime canonical asset set built and verified.
- [x] Exact `0.3.3` package tarball built and verified.
- [ ] Exact `0.3.3` NSIS installer built and verified.

Local uncommitted `v0.3.3` recovery evidence:

- `pnpm verify:release-version -- v0.3.3` passed.
- The exact 960-byte source lock contains no CR byte, ends in LF, and
  classified as `core-only`; a real temporary Git checkout with
  `core.autocrlf=true` is covered by the passing runtime tests.
- `pnpm verify` passed, including 161 runtime tests, 34 desktop Rust tests,
  63 package QA tests plus one expected Windows symlink skip, four clean
  consumer builds/browser smokes, deterministic desktop smoke, and three
  Playwright tests. The frozen-install-specific gate remains open because this
  local run did not reinstall dependencies first.
- `build-release-artifacts` produced exactly six canonical release files. The
  executable is 21,580,980 bytes with SHA-256
  `e1b7c12c66876f6d61e80f21f97db19acf0d5e3c5771ca3a9d1270357b00b7c4`;
  the empty-requirements catalog is 79 bytes with SHA-256
  `b6238b01334485c9c1e49f1ea7f784960c100948dad30ffb24878f0465910a72`.
  No optional worker, model, fixture, model receipt, ZIP, or model binary is in
  the release directory.
- `gx-capture-capture-workbench-0.3.3.tgz` is 84,363 bytes with SHA-256
  `69ce2abefb33d2b73f9da5f04b97307f9f49d074ade98bdb75579c8c13d24f05`.
- Read-only remote checks found no `v0.3.3` tag and no `v0.3.3` GitHub Release.
  No NSIS build, Git mutation, package publication, tag, or release was
  performed.

Historical `v0.3.2` local evidence on the uncommitted closeout worktree above
`410c914`:

- `gx-capture-capture-workbench-0.3.2.tgz`: 84,363 bytes,
  SHA-256 `e408a8c5dd0027577ff87267e586d5813f9bf7fdaf93a77eb605c43e3be2ff50`.
- `capture-runtime-x86_64-pc-windows-msvc.exe`: 206,652,755 bytes,
  SHA-256 `d787dc096d688c6b834432f98410aedddd6e4f797b36b4a76a3e6693b35bbcf9`.
- `Capture Workbench_0.3.2_x64-setup.exe`: 208,071,907 bytes,
  SHA-256 `5c6c926a7131013654a0c903948c14060cbac94ff964e5cf9845835bb99c7806`.
- The production environment contained only `onnxruntime-directml 1.24.4`
  as the ONNX Runtime distribution owner and exposed `DmlExecutionProvider`
  plus the CPU fallback provider.
- Repeated package finalization passed from both pristine and already-finalized
  cached output, and the final clean-consumer smoke left no current-run fixture.
- Generated Tauri capabilities grant the `main` window exactly
  `core:default` and `dialog:allow-open`; broader dialog message/save
  permissions are absent.
- The release ancestry step refreshes `refs/remotes/origin/main` with an
  explicit `--no-tags` fetch before `merge-base` and before tool installation.

These historical results proved the implementation and candidate-building path
for `v0.3.2`; they are not `v0.3.3` candidate evidence and do not satisfy any
manual GitHub boundary below.

Run in order from a clean checkout of the intended tag commit:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify:release-version -- v0.3.3
$candidateSha = git rev-parse HEAD
node tools/model-candidate-receipt.ts verify-main-ci `
  --repository "gx-capture/capture-workbench" `
  --commit "$candidateSha" `
  --workflow-path ".github/workflows/ci.yml" `
  --branch "main"
corepack pnpm nx run capture-runtime:classify-release-model-mode
Get-Content packages/capture-runtime/dist/metadata/release-model-mode.json
corepack pnpm verify
corepack pnpm nx run capture-runtime:build-release-artifacts --skip-nx-cache
node apps/capture-workbench-desktop/scripts/stage-runtime.ts `
  --artifact packages/capture-runtime/dist/release/capture-runtime-x86_64-pc-windows-msvc.exe `
  --manifest packages/capture-runtime/dist/release/capture-runtime-manifest.json `
  --schema packages/capture-runtime/dist/release/capture-document-v1.schema.json `
  --source release
corepack pnpm nx run capture-workbench-desktop:build-nsis
corepack pnpm nx run capture-angular:pack
corepack pnpm nx run capture-angular:clean-consumer-smoke
```

The clean-consumer smoke installs the packed tarball into isolated Angular,
Vanilla, React, and Vue consumers. The Angular host uses only
`defineCaptureWorkbenchElement()` and the tag; non-Angular hosts likewise do
not import Angular implementation packages. The local registry and isolated
cert-prep-style trial are consumer evidence only and do not change cert-prep.

## Manual GitHub boundary

- [ ] Package write permission confirmed for the release workflow.
- [ ] GitHub Package visibility confirmed for unauthenticated or intended
      authenticated consumers.
- [ ] Required `main` and `develop` branch protection/rulesets confirmed.
- [ ] Draft release contains the exact canonical assets for the classified mode
      and no model file/ZIP or QA fixture.
- [ ] Published npm package integrity equals the candidate tarball integrity.
- [ ] Release made public only after every asset and package check passed.

Current read-only evidence:

- Public `v0.3.0` exists with the four runtime assets and no installer.
- The annotated `v0.3.1` tag is externally occupied; its workflow failed and
  no `v0.3.1` GitHub Release exists.
- The lightweight `v0.3.2` tag is externally occupied at `8d5b3364320f60a1f16cf9ee222663150cb57c11`;
  run `30517094297` failed before publication, and no `v0.3.2` GitHub Release
  exists.
- No local or remote `v0.3.3` tag and no `v0.3.3` GitHub Release were found.
- Unauthenticated GitHub Packages inspection returns `E401`; package
  visibility and the `0.3.0`/`0.3.1`/`0.3.2`/`0.3.3` package state are therefore
  unverified.
- Organization branch-protection settings were not changed or claimed by this
  closeout.

The publisher must receive `--tag`, `--runtime-dir`, `--installer`, and
`--package`. It preflights all local bytes before remote mutation, creates or
resumes a draft, uploads only missing assets, verifies downloaded bytes,
publishes or reuses only an exact-integrity package, verifies everything again,
and makes the release public last. A public release retry is read-only; it
fails on missing or different bytes and never clobbers assets.
