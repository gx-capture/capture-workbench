# Capture Workbench

Cross-project PDF/image OCR and audio transcription with a reusable Angular UI,
an authenticated local runtime, and a Tauri reference harness.

## Artifacts

- `@wodenwang820118/capture-angular` — Angular component, client, and contracts.
- `capture-runtime-windows-x64` — versioned local sidecar distributed through a
  GitHub Release manifest.
- Capture Workbench Desktop — a verification host; it is not a public desktop
  product in v1.

Host applications may supply their existing AI provider through the
`CaptureStructuringProvider` interface. The standalone Workbench uses its own
isolated Ollama process and model store to prove the complete flow.

## Development

```powershell
pnpm install
pnpm nx show projects
pnpm dev
pnpm verify
```

`pnpm dev` stages deterministic runtime assets first, so it works from a fresh
checkout. Use `pnpm dev:staged-runtime` only after explicitly staging the real
runtime executable, manifest, and schema that the Tauri harness should launch.

Run the opt-in installed Windows harness separately because it performs a
scoped NSIS install and uninstall:

```powershell
pnpm nx run capture-workbench-desktop:smoke-installed-deterministic --skipNxCache
```

That target uses deterministic engines and produces diagnostic evidence only;
it is not a real-engine or release-readiness gate.

The v1 product lane is Windows 11 x64. OCR uses WindowsML, transcription uses
Whisper, and every completed result must satisfy the `CaptureDocumentV1`
contract.
