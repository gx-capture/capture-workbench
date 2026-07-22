# Capture Workbench Desktop Harness

This Tauri 2 app is the Windows 11 x64 packaging and clean-install verification host for Capture Workbench. It is intentionally not the public desktop product.

The harness starts one verified `capture-runtime` sidecar on a random loopback port with a memory-only 256-bit bearer token. Its default development provider is an isolated Ollama lane with dedicated app data, model storage, port, profile, and PID file.

## Native checks

```powershell
pnpm nx run capture-workbench-desktop:cargo-fmt-check
pnpm nx run capture-workbench-desktop:cargo-check
pnpm nx run capture-workbench-desktop:cargo-test
pnpm nx run capture-workbench-desktop:package-qa-test
```

## Runtime staging

Release automation must stage a Windows x64 runtime and its release manifest before `build`:

```powershell
node apps/capture-workbench-desktop/scripts/stage-runtime.mjs `
  --artifact <capture-runtime.exe> `
  --manifest <capture-runtime-manifest.json> `
  --schema <capture-document-v1.schema.json> `
  --source release
pnpm nx run capture-workbench-desktop:build-nsis-release
```

The ordinary `build` target compiles the Tauri app with `--no-bundle` so workspace-wide verification does not silently package a fake runtime. `stage-deterministic-runtime` and `build-nsis-deterministic` are test-only; their outputs cannot be used as clean-install or release evidence.
