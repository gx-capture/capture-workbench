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
pnpm verify
```

The v1 product lane is Windows 11 x64. OCR uses WindowsML, transcription uses
Whisper, and every completed result must satisfy the `CaptureDocumentV1`
contract.
