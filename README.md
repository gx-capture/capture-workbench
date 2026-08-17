# Capture Workbench

Capture Workbench is a local-first capture platform for turning PDFs, images,
and audio into validated, structured documents. The repository contains the
user interface, the local Capture Runtime that performs extraction and
structuring, the typed client SDKs, and the Windows desktop host that ties
them together.

The same runtime contract is used by the desktop application and by trusted
backend integrations. A host owns durable source and domain data; runtime jobs
are ephemeral and are deleted after the host has copied the data it needs.

## What is in this repository

| Area | Location | Responsibility |
| --- | --- | --- |
| Desktop product | `apps/capture-workbench-desktop` | Tauri 2 Windows 11 x64 host, local library/history, native process lifecycle, and runtime integration |
| UI application | `apps/capture-workbench` | Angular renderer used by the desktop product |
| Embeddable UI | `packages/capture-workbench-ui` | Angular component and framework-neutral `capture-workbench` custom element |
| Capture Runtime | `packages/capture-runtime` | Authenticated loopback service for ingestion, extraction, OCR, transcription, streaming, setup, and structuring |
| TypeScript SDK | `packages/capture-runtime-client` | Framework-neutral runtime client with discovery, authentication, v2 operations, SSE, retries, and typed errors |
| Python SDK | `packages/capture-runtime-client-python` | Typed backend client for the same runtime contract |
| Java SDK | `packages/capture-runtime-client-java` | Typed JVM client for the same runtime contract |
| Sidecar launcher | `packages/capture-sidecar-launcher` | Shared Windows process and authenticated loopback lifecycle support |
| Browser and package verification | `apps/capture-workbench-e2e`, `tools` | Consumer, packaging, contract, and end-to-end verification |

## How the pieces work together

1. A desktop host or trusted backend starts, or proxies, one authenticated
   Capture Runtime instance on loopback.
2. The client performs readiness and contract discovery before using the
   runtime. The runtime-owned contract bundle and its SHA-256 digest define
   compatibility; runtime semver alone is not the wire contract.
3. The host opens an ingestion and capture operation for a PDF, image, or
   audio file. The v2 API provides snapshots and authenticated SSE progress,
   with cancellation, retry, and reconciliation support.
4. Capture Runtime extracts raw text or time-based audio segments. PDF and
   image extraction can use the runtime-managed OCR engine; audio extraction
   uses the runtime-managed Whisper engine. Optional requirements are installed
   through an explicit, checksum-verified setup flow.
5. Structuring can be owned by the runtime's isolated Ollama process or by the
   host's provider. The runtime validates the resulting `CaptureDocument`,
   including schema, ordering, and raw provenance, before reporting completion.
6. The host persists source files, raw diagnostics, structured results, and
   application-specific data. The browser-facing UI receives a host-provided
   client and never needs the sidecar URL or bearer token.

## Choose an integration

### Use the Windows desktop application

Windows users can install the current Windows x64 application from the
[GitHub Releases](https://github.com/gx-capture/capture-workbench/releases)
page.

After launching the application:

1. Complete the runtime setup shown by the application.
2. Approve optional OCR, Whisper, or model requirements when a workflow needs
   them. Downloads are verified before activation, and a failed replacement
   does not discard the last working installation.
3. Import a PDF, image, or audio file.
4. Review progress and provenance, inspect the resulting document, and use the
   local library to reopen, retry, export, or delete captures.

The desktop host keeps the source and result library in its application data
directory. Runtime credentials and local source paths stay in native code; they
are not placed in the Angular state, DOM, browser storage, URLs, logs, or
reports.

### Embed the UI in an Angular host

The publishable UI package is
`@gx-capture/capture-workbench-ui`. It is distributed through the configured
NPM-compatible registry. Configure the scope without committing credentials:

```ini
@gx-capture:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Install the exact coordinated package version selected by your release:

```powershell
$env:GITHUB_PACKAGES_TOKEN = '<token with read:packages>'
corepack pnpm add @gx-capture/capture-workbench-ui@<release> --save-exact
```

An Angular application supplies a `CaptureClient` backed by its own backend:

```ts
import { Component } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  CaptureWorkbenchComponent,
  provideCaptureClient,
} from '@gx-capture/capture-workbench-ui';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CaptureWorkbenchComponent],
  template: '<gx-capture-workbench />',
})
export class App {}

bootstrapApplication(App, {
  providers: [provideCaptureClient(hostCaptureClient)],
});
```

`hostCaptureClient` should call the host backend rather than exposing a
Capture Runtime sidecar directly to the browser. The package also supports a
host-owned structuring provider and a preprocessing hook when those boundaries
belong to the integrating application.

### Embed the framework-neutral custom element

The same package can register a property-first custom element for vanilla
JavaScript, React, Vue, or another host framework:

```ts
import {
  CAPTURE_WORKBENCH_CUSTOM_EVENTS,
  defineCaptureWorkbenchElement,
} from '@gx-capture/capture-workbench-ui';

defineCaptureWorkbenchElement().subscribe();

const element = document.querySelector('capture-workbench');
if (element) {
  Object.assign(element, {
    client: hostCaptureClient,
    config: { outputMode: 'json' },
  });
  element.addEventListener(
    CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed,
    (event) => saveDocument((event as CustomEvent).detail.document),
  );
}
```

Object dependencies such as `client`, `config`, `structuringProvider`, and
`preprocessor` are assigned as DOM properties. Simple presentation settings
may use the documented attributes. The element emits stable bubbling events,
including `capture-review-required`, `capture-completed`, `capture-failed`,
`capture-canceled`, and `capture-task-changed`.

### Use the runtime SDKs directly

When the UI is not the right boundary, use the client for the host language:

| Host | Package |
| --- | --- |
| TypeScript | `@gx-capture/capture-runtime-client` |
| Python | `capture-runtime-client` |
| Java | `com.gx.capture:capture-runtime-client` |

Each SDK exposes typed readiness and contract discovery, runtime setup,
ingestion and capture operations, streaming events, retries/idempotency, and
structured remote errors. The generated wire codecs and contract bundle are
implementation details; applications use the public SDK types and methods.

## Runtime contract

Capture Runtime exposes an authenticated v2 HTTP API on loopback. Its public
surface includes:

- readiness and capability checks;
- runtime requirements, installations, and model options;
- PDF, image, and audio ingestion;
- capture snapshots, raw output, structured results, cancellation, and
  deletion;
- authenticated SSE events with resume and resynchronization; and
- immutable contract discovery at `GET /meta/v2/contracts` and
  `GET /meta/v2/contracts/sha256/{digest}`.

All runtime endpoints require a bearer token. The token is created and held by
the native desktop host or a trusted backend. Browser code should receive a
host adapter, not runtime credentials.

## Develop from source

The workspace uses Nx and requires Node.js 24 or newer, pnpm 11 or newer via
Corepack, Python 3.12 with `uv` for the runtime, and Rust for Tauri/native
targets.

```powershell
corepack install
corepack pnpm install
corepack pnpm dev
```

`dev` runs the Windows desktop product lane and stages the runtime it uses.
For a browser renderer or deterministic fixture work, use the corresponding
explicit targets:

```powershell
corepack pnpm nx serve capture-workbench
corepack pnpm dev:deterministic
```

The deterministic lane is for repeatable development and diagnostics. It does
not prove that WindowsML, Whisper, Ollama, or a packaged release is working.

To run the runtime directly for backend development, set a private
`CAPTURE_API_TOKEN` with at least 32 characters and start the runtime target:

```powershell
$env:CAPTURE_API_TOKEN = '<private development token>'
corepack pnpm nx run capture-runtime:serve
```

Do not share that token with browser code or commit it to a file.

## Verification

Run the workspace gate from the repository root:

```powershell
corepack pnpm verify
```

Useful focused checks are:

```powershell
corepack pnpm nx run capture-runtime:check-contracts
corepack pnpm nx run capture-angular:clean-consumer-smoke
corepack pnpm nx run capture-workbench-desktop:package-qa-test
corepack pnpm nx run capture-workbench-e2e:e2e
```

Use `pnpm nx` targets for discovery, build, lint, test, packaging, and smoke
work. Product smokes and release checks should use their explicit Nx target;
test fixtures are not release evidence.

## Security and data boundaries

- Keep bearer tokens in native or backend processes only. Never put them in
  DOM attributes, browser storage, URLs, logs, or screenshots.
- Treat runtime jobs as temporary. The host is responsible for durable source,
  result, review, and domain persistence.
- Use the runtime's authenticated discovery and digest validation before
  decoding or sending capture operations.
- Report security issues privately rather than including source files, tokens,
  or private media in an issue or test report.

## License

Capture Workbench is released under the MIT license.
