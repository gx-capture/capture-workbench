# Capture Workbench

Capture Workbench is a reusable Angular UI with a local Windows desktop
feasibility app. Version 0.3.8 is an unsigned, core-only release for verifying
install, launch, an empty workspace, and core Ollama requirement setup.

## Use the Windows app

Windows 11 x64 users can download
[`Capture.Workbench_0.3.8_x64-setup.exe`](https://github.com/gx-capture/capture-workbench/releases/download/v0.3.8/Capture.Workbench_0.3.8_x64-setup.exe)
from the [v0.3.8 release](https://github.com/gx-capture/capture-workbench/releases/tag/v0.3.8).

The installer is unsigned. Windows may show an **Unknown publisher** or
SmartScreen warning. Download only from the release above and verify the
asset's SHA-256 value on the release page before running it.

1. Run the installer and open **Capture Workbench**.
2. On first launch, choose **Install core requirements** to set up the isolated
   Ollama prerequisite.
3. Confirm that the empty workspace opens after setup completes.
4. The v0.3.8 workspace is intentionally empty; this release does not run
   document or audio capture.

v0.3.8 does not bundle or enable scanned-image WindowsML OCR or audio/Whisper
engines. Those flows need a future model-enabled release, or a host-provided
supported `CaptureClient` and runtime when using the package.

## Use the package

The public package is
[`@gx-capture/capture-workbench@0.3.8`](https://github.com/orgs/gx-capture/packages/npm/package/capture-workbench).
In the consuming workspace, configure the GitHub Packages scope without
committing a token:

```ini
@gx-capture:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

```powershell
$env:GITHUB_PACKAGES_TOKEN = '<GitHub token with read:packages>'
corepack pnpm add @gx-capture/capture-workbench@0.3.8 --save-exact
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

## Support and security

Open a GitHub issue for non-sensitive problems. Do not include source files,
access tokens, or sidecar bearer tokens in issues or logs.
