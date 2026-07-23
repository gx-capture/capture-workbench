# @gx/capture-workbench

Publishable Capture Workbench UI and transport contracts for Capture Runtime. The package
owns runtime setup, file preprocessing, queued capture jobs, progress,
cancellation, raw diagnostics, and JSON/text export.

Install the pinned GitHub Packages version with a token that has only
`read:packages` access. Consumer Actions jobs should declare `contents: read`
and `packages: read`; they do not need write permissions.

Configure the scope without committing the token (the repository root includes
the same `.npmrc.example`):

```ini
@gx:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Then install an exact synchronized version:

```powershell
$env:GITHUB_PACKAGES_TOKEN = '<read:packages token>'
corepack pnpm add @gx/capture-workbench@0.3.0 --save-exact
```

## v0.3.0 breaking Angular integration contract

All public asynchronous client, provider, preprocessor, and reconciliation
context methods return cold `Observable<T>` values. Compose them with RxJS and
subscribe at the application boundary; no Promise compatibility adapter is
provided. Angular runtime state is exposed through signals backed by
`rxResource`, while store commands such as `refreshRuntime()` remain `void` and
publish their result through signals/events. `defineCaptureWorkbenchElement()`
also returns an `Observable<void>` and should be subscribed during startup.

Successful output is always the runtime-validated `CaptureDocumentV1`. A
structuring failure may expose `RawCaptureV1` with `diagnosticOnly: true`, but
the component never emits `completed` for that path.

If every commit/report status check is temporarily unreachable, the task remains
non-terminal as `reconciliation_required`. The component preserves its
`captureId` and raw diagnostics, emits no terminal event, and offers status-check
and cancel-and-check actions without invoking the provider or commit again.

## Production host pattern

Production hosts such as `cert-prep` should implement `CaptureClient` through
their own backend and inject it with `provideCaptureClient()`. This keeps the
sidecar URL and high-entropy bearer token backend-only.

```ts
import { provideCaptureClient } from '@gx/capture-workbench';

bootstrapApplication(App, {
  providers: [provideCaptureClient(certPrepCaptureClient)],
});
```

When that backend also invokes the host's existing LLM provider, configure
`structuringMode: 'host'` and `hostStructuringOwner: 'client'`. The component
then polls the injected client through `awaiting_structuring` and never requests
raw capture data or an LLM provider in the WebView.

Do not put a sidecar bearer token in a URL, browser log, or `localStorage`.

`HttpCaptureClient` is the default direct sidecar client for the standalone
Tauri validation app, or for a host that intentionally exposes the loopback
token to its trusted WebView process:

```ts
import { invoke } from '@tauri-apps/api/core';
import { provideHttpCaptureClient } from '@gx/capture-workbench';
import { from, map } from 'rxjs';

const backendConfig$ = from(
  invoke<{
    baseUrl: string;
    token: string;
  }>('backend_config'),
);

bootstrapApplication(App, {
  providers: [
    provideHttpCaptureClient({
      baseUrl: () => backendConfig$.pipe(map(({ baseUrl }) => baseUrl)),
      bearerToken: () => backendConfig$.pipe(map(({ token }) => token)),
    }),
  ],
});
```

Keep `backendConfig` in memory only. `HttpCaptureClient` rejects non-HTTP or
non-loopback origins before resolving the bearer token, and enforces the
`capture-runtime` service identity during its compatibility handshake.

## Structuring ownership

The default `runtime` mode uses Capture Runtime's isolated Ollama process and
model. A host that already owns an Ollama or another LLM provider can select
`host` mode and inject the narrow `CaptureStructuringProvider` interface:

```ts
import { provideCaptureStructuringProvider, type CaptureStructuringProvider } from '@gx/capture-workbench';
import { defer } from 'rxjs';

const provider: CaptureStructuringProvider = {
  structure({ raw, documentContract, signal, reportProgress }) {
    return defer(() =>
      hostBackend.structureCapture(raw, {
        schemaVersion: documentContract.schemaVersion,
        jsonSchema: documentContract.jsonSchema,
        signal,
        reportProgress,
      }),
    );
  },
};

bootstrapApplication(App, {
  providers: [provideCaptureStructuringProvider(provider)],
});
```

For a trusted frontend-owned integration, the provider receives canonical raw OCR/STT and returns a full
`CaptureDocumentV1` candidate. The component submits that candidate to the
runtime; only a candidate accepted by runtime schema, locator, non-empty, and
ordering validation can produce `completed`.

`showRuntimeSetup: false` only hides the package UI; it does not skip the
capability/version handshake. Set `hostManagedHandshake: true` only when a host
adapter has already enforced the same runtime major, API major, schema, service
identity, and capability checks.

The runtime handshake is signal-first. Calling `store.refreshRuntime()` requests
a new capability check and returns immediately; read `store.runtime()` or wait
for the host framework's normal stabilization boundary instead of awaiting the
method.

```ts
import { provideCaptureWorkbenchInputs, type CaptureWorkbenchInputSource } from '@gx/capture-workbench';

const captureInputs: CaptureWorkbenchInputSource = {
  config: () => ({
    structuringMode: 'host',
    outputMode: 'json',
    width: '48rem',
    height: '75vh',
    theme: { accent: '#7c3aed' },
  }),
};

bootstrapApplication(App, {
  providers: [provideCaptureWorkbenchInputs(captureInputs)],
});
```

Use `provideCapturePreprocessor()` for a
crop/normalization seam before upload. The seam must preserve abort semantics
and return the `File` that should be hashed and captured.

## Web Component

Register the framework-neutral element once during application startup. Angular
Elements owns the element lifecycle; the public configuration API is
property-first:

```ts
import { CAPTURE_WORKBENCH_CUSTOM_EVENTS, defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx/capture-workbench';

defineCaptureWorkbenchElement().subscribe({
  error: (error) => console.error('Capture element registration failed.', error),
});
const capture = document.querySelector('capture-workbench') as CaptureWorkbenchElement;
capture.config = {
  structuringMode: 'host',
  hostStructuringOwner: 'client',
  outputMode: 'json',
};
capture.client = hostCaptureClient;
capture.addEventListener(CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed, (event) => {
  const completed = event as CustomEvent;
  saveDocument(completed.detail.document);
});
```

The full `config` object, `client`, `structuringProvider`, and `preprocessor`
are JavaScript properties. The supported simple HTML attributes are
`output-mode`, `multiple`, `target-language`, `show-runtime-setup`, `width`,
`height`, and `density`; values supplied through `config` take precedence.
Object dependencies are never accepted from attributes or serialized into
HTML.

All events bubble and are composed. Their stable names and detail values are:

- `capture-completed` — `CaptureCompletedEvent`
- `capture-failed` — `CaptureFailedEvent`
- `capture-canceled` — `CaptureTaskView`
- `capture-task-changed` — `CaptureTaskView`

The framework-neutral fixture is
[`fixtures/web-component/index.html`](./fixtures/web-component/index.html).
Install `@gx/capture-workbench` from the configured NPM-compatible registry and
import it from your bundler. The package does not publish a standalone browser
bundle or CDN entry.

React and Vue consumers can assign the object properties through a DOM ref and
listen with `addEventListener`:

```ts
const capture = ref.current as CaptureWorkbenchElement;
capture.config = { outputMode: 'text', showRuntimeSetup: false };
capture.client = hostCaptureClient;
capture.addEventListener(CAPTURE_WORKBENCH_CUSTOM_EVENTS.completed, onCompleted);
```

For normal browser hosts, `hostCaptureClient` should call the host backend.
Only a trusted Tauri WebView may use a direct loopback `HttpCaptureClient`; a
sidecar bearer token must never enter a normal browser bundle, URL, storage, or
log.

For a direct loopback runtime client, keep the same strict CSP used by the
Tauri reference host: permit only `http://127.0.0.1:*` in `connect-src`, and
do not grant arbitrary HTTPS, `unsafe-eval`, or wildcard origins. The element
uses the existing CSS variables `--capture-accent`, `--capture-background`,
`--capture-foreground`, `--capture-muted`, `--capture-border`, and
`--capture-danger`. It preserves the package's runtime API-major and
`CaptureDocumentV1` schema handshake; element and runtime versions must remain
compatible.
