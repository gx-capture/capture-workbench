# Capture Workbench

Cross-project PDF/image OCR and audio transcription with a reusable Angular UI,
an authenticated local runtime, and a Tauri Windows desktop product.

## Artifacts

- `@gx-capture/capture-workbench` — Capture Workbench UI, client, and contracts.
- `capture-runtime-windows-x64` — versioned local sidecar distributed through a
  GitHub Release manifest.
- Capture Workbench Desktop — the Windows 11 x64 local-first application.

Host applications may supply their existing AI provider through the
`CaptureStructuringProvider` interface. The standalone Workbench uses its own
isolated Ollama process and model store to prove the complete flow.

## Development

Requires Node.js 24 or newer and pnpm 11 or newer. Corepack selects the
repository-pinned pnpm 11.15.1 release, including when another pnpm version is
installed globally.

```powershell
corepack install
corepack pnpm install
corepack pnpm nx show projects
corepack pnpm dev
corepack pnpm verify
```

`corepack pnpm dev` builds and stages the verified release runtime before
starting the real desktop product. WindowsML stays a runtime-owned,
user-consented installation requirement: its descriptor and model archive are
not bundled into the app and require no desktop environment variables.
`corepack pnpm dev:deterministic` is test-only and never exercises Ollama.

Run the opt-in installed Windows deterministic smoke separately because it performs a
scoped NSIS install and uninstall:

```powershell
corepack pnpm nx run capture-workbench-desktop:smoke-installed-deterministic --skipNxCache
```

That target uses deterministic engines and produces diagnostic evidence only;
it is not a real-engine or release-readiness gate.

The v1 product lane is Windows 11 x64. OCR uses WindowsML, transcription uses
Whisper, and every completed result must satisfy the `CaptureDocumentV1`
contract.

## Local NPM-compatible Registry

Use the checked-in Verdaccio configuration when a host application needs to
install the package as a normal registry dependency without publishing it to a
remote registry. The registry listens only on `127.0.0.1:4873`; its package
storage is ignored by Git.

Start the registry in one terminal:

```powershell
corepack pnpm run local-registry:start
```

Publish the current packed package in a second terminal:

```powershell
corepack pnpm run local-registry:publish
```

The publish script runs the Nx package target and publishes the package with
the `local` dist-tag. Re-running it with the same package bytes reuses the
existing registry version; a same-version integrity mismatch fails closed.
Bump the package version before publishing a changed revision.

The cert-prep trial uses this registry through an isolated temporary consumer,
so its normal dependency manifest and lockfile are not changed. Verdaccio
proxies ordinary dependencies to npmjs; a fully offline run requires those
dependencies to already be available in the local pnpm store.

## Local release consumer smoke

`capture-runtime` is distributed as a Windows x64 sidecar, not as an npm
dependency. Build or stage the canonical release directory first, then run the
consumer smoke:

```powershell
corepack pnpm nx run capture-runtime:local-release-consumer-smoke
```

The smoke copies the four release assets into a temporary local HTTP mirror,
downloads them as a sibling host would, verifies the manifest, byte count,
checksum, schema digest, and canonical file set, then starts the downloaded
sidecar with fake providers and checks authenticated readiness. The mirror,
consumer, process, and bearer token are temporary and never published or
persisted.

The runtime smoke expects these files under
`packages/capture-runtime/dist/release`; the release directory is produced by
`capture-runtime:build-release-artifacts` in the release workflow. It does not
call GitHub or publish to a remote registry.
