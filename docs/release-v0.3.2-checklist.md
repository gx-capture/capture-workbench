# Capture Workbench v0.3.2 Release Checklist

This checklist is the release gate, not a record of intent. Check an item only
after the exact candidate bytes and the current commit have produced the stated
evidence.

## Candidate identity

- [x] Version synchronized at `0.3.2`.
- [x] Old public owner references removed; current URLs use `gx-capture`.
- [ ] Tag commit is reachable from `main`.

The annotated `v0.3.1` tag was created externally and prematurely from
`develop`. GitHub Actions run `30427950949` failed during the frozen install
because that tag did not contain its matching lockfile. No build, package,
installer, or publish step ran, and no `v0.3.1` GitHub Release was created.
The tag is nevertheless occupied and must not be overwritten, so it cannot
remain the candidate version. Read-only checks found no local or remote
`v0.3.2` tag and no `v0.3.2` GitHub Release.

## Automated candidate evidence

- [x] Packed package consumer smoke passed for the final candidate.
- [x] Angular, Vanilla, React, and Vue Web Component browser smoke passed for
      the final candidate.
- [x] `corepack pnpm verify` passed from a frozen install.
- [x] Production runtime canonical asset set built and verified.
- [x] Exact `0.3.2` package tarball built and verified.
- [x] Exact `0.3.2` NSIS installer built and verified.

Local evidence on the uncommitted closeout worktree above `410c914`:

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

These local results prove the implementation and candidate-building path. They
do not prove that a future `v0.3.2` tag contains this worktree, is reachable
from `main`, or satisfies any manual GitHub boundary below.

Run in order from a clean checkout of the intended tag commit:

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm verify:release-version -- v0.3.2
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
- [ ] Draft release contains the exact four runtime assets and NSIS installer.
- [ ] Published npm package integrity equals the candidate tarball integrity.
- [ ] Release made public only after every asset and package check passed.

Current read-only evidence:

- Public `v0.3.0` exists with the four runtime assets and no installer.
- The annotated `v0.3.1` tag is externally occupied; its workflow failed and
  no `v0.3.1` GitHub Release exists.
- No local or remote `v0.3.2` tag and no `v0.3.2` GitHub Release were found.
- Unauthenticated GitHub Packages inspection returns `E401`; package
  visibility and the `0.3.0`/`0.3.1`/`0.3.2` package state are therefore
  unverified.
- Organization branch-protection settings were not changed or claimed by this
  closeout.

The publisher must receive `--tag`, `--runtime-dir`, `--installer`, and
`--package`. It preflights all local bytes before remote mutation, creates or
resumes a draft, uploads only missing assets, verifies downloaded bytes,
publishes or reuses only an exact-integrity package, verifies everything again,
and makes the release public last. A public release retry is read-only; it
fails on missing or different bytes and never clobbers assets.
