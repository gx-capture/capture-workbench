# Capture Workbench

Capture Workbench is a reusable Angular UI with a local Windows desktop
application. Version 0.3.9 is the model-enabled Windows x64 release. It keeps
the core runtime small and installs the OCR and Whisper workers only after an
explicit user consent, checksum, and probe gate.

## Use the Windows app

Windows 11 x64 users can download
[`Capture.Workbench_0.3.9_x64-setup.exe`](https://github.com/gx-capture/capture-workbench/releases/download/v0.3.9/Capture.Workbench_0.3.9_x64-setup.exe)
from the [v0.3.9 release](https://github.com/gx-capture/capture-workbench/releases/tag/v0.3.9).

The installer is unsigned. Windows may show an **Unknown publisher** or
SmartScreen warning. Download only from the release above and verify the
asset's SHA-256 value on the release page before running it.

1. Run the installer and open **Capture Workbench**.
2. Confirm that the workspace opens with the installer-bundled core Capture
   Runtime. Optional worker and model dependencies are not downloaded at
   startup.
3. Choose **Install core requirements** to consent to the WindowsML OCR setup.
   Importing audio makes Whisper installable; use the setup action again to
   consent to that download. Each download is immutable, checksum-verified,
   and probed before it is activated. A failed upgrade keeps the last active
   version.
4. Import a scanned PDF, image, or audio file. PDF and image results report
   `windowsml-ocr` / `pp-ocrv6-medium-windowsml` with `windowsml-dml` when
   DirectML is available (CPU is used only when the provider is absent). Audio
   reports the lock-selected Whisper model and device with non-empty,
   time-located segments.

The app stores source and result data in its own local workspace. Runtime
tokens remain in the host process and never enter the Angular UI, Web
Component, URL, browser storage, logs, or release evidence.

### Historical v0.3.8 core-only evidence

[`Capture.Workbench_0.3.8_x64-setup.exe`](https://github.com/gx-capture/capture-workbench/releases/download/v0.3.8/Capture.Workbench_0.3.8_x64-setup.exe)
and the [v0.3.8 release](https://github.com/gx-capture/capture-workbench/releases/tag/v0.3.8)
are immutable core-only feasibility evidence. That release verifies install,
launch, an empty workspace, and core Ollama setup only; its catalog has no OCR
or Whisper requirements. Do not retrofit, replace, or use v0.3.8 as a
model-enabled candidate.

## Use the package

The public package is
[`@gx-capture/capture-workbench@0.3.9`](https://github.com/orgs/gx-capture/packages/npm/package/capture-workbench).
In the consuming workspace, configure the GitHub Packages scope without
committing a token:

```ini
@gx-capture:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```powershell
$env:GITHUB_PACKAGES_TOKEN = '<GitHub token with read:packages>'
corepack pnpm add @gx-capture/capture-workbench@0.3.9 --save-exact
```

An Angular host supplies its own `CaptureClient`, normally backed by its
server, and renders the public component:

```ts
import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  CaptureWorkbenchComponent,
  provideCaptureClient,
} from '@gx-capture/capture-workbench';

@Component({
  selector: 'app-root',
  imports: [CaptureWorkbenchComponent],
  template: '<gx-capture-workbench />',
})
export class App {}

bootstrapApplication(App, {
  providers: [provideCaptureClient(hostCaptureClient)],
});
```

`hostCaptureClient` must call the host backend. Never expose a Capture Runtime
sidecar bearer token in browser code, URLs, storage, or logs.

## Contribute

Requires Node.js 24+ and the repository-pinned pnpm. From this repository:

```powershell
corepack install
corepack pnpm install
corepack pnpm dev
corepack pnpm verify
```

`dev` starts the Windows desktop product. Use `corepack pnpm dev:deterministic`
only for deterministic development fixtures.

### Diagnose a Cert Prep integration boundary

The read-only boundary doctor compares an already-running Cert Prep proxy with
the same already-running Capture Runtime. It does not launch, install, cancel,
or mutate either service. Supply bearer tokens through the environment only:

```powershell
$env:CAPTURE_BOUNDARY_CERT_PREP_TOKEN = '<Cert Prep API token>'
$env:CAPTURE_BOUNDARY_RUNTIME_TOKEN = '<Capture Runtime API token>'
pnpm nx run capture-tools:boundary-doctor -- `
  --cert-prep-url http://127.0.0.1:8765 `
  --runtime-url http://127.0.0.1:8766
```

Add `--project-id`, `--operation-id`, and `--capture-id` together to correlate
one in-flight import, or run
`pnpm nx run capture-tools:boundary-doctor --args="--help"` for bounded watch and
JSON output options. The report contains only normalized allowlisted state; it
excludes tokens, response bodies, source content, and local data paths.

## Support and security

Open a GitHub issue for non-sensitive problems. Do not include source files,
access tokens, or sidecar bearer tokens in issues or logs.
