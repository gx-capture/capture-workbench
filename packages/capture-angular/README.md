# @gx-capture/capture-workbench

Publishable Capture Workbench UI and transport contracts for Capture Runtime. The package
owns runtime setup, file preprocessing, queued capture jobs, progress,
cancellation, raw diagnostics, and JSON/text export.

Install the pinned GitHub Packages version with a token that has only
`read:packages` access. Consumer Actions jobs should declare `contents: read`
and `packages: read`; they do not need write permissions.

Configure the scope without committing the token (the repository root includes
the same `.npmrc.example`):

```ini
@gx-capture:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

Then install an exact synchronized version:

```powershell
$env:GITHUB_PACKAGES_TOKEN = '<read:packages token>'
corepack pnpm add @gx-capture/capture-workbench@0.3.11 --save-exact
```

## v0.3.11 Angular integration contract

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
import { provideCaptureClient } from '@gx-capture/capture-workbench';

bootstrapApplication(App, {
  providers: [provideCaptureClient(certPrepCaptureClient)],
});
```

When that backend also invokes the host's existing LLM provider, configure
`structuringMode: 'host'` and `hostStructuringOwner: 'client'`. The component
then follows the authenticated v2 `CaptureEventV2` SSE stream and uses the
host-owned status/reconciliation methods only as a recovery fallback. It never
requests raw capture data or an LLM provider in the WebView.

Do not put a sidecar bearer token in a URL, browser log, or `localStorage`.

`HttpCaptureClient` remains available for framework-neutral transport use, but
the public consumer contract does not pass a bearer token into Angular or a
WebView. Use a host-owned `CaptureClient` adapter and keep authentication in
the host backend. The client rejects non-HTTP or non-loopback origins before
any credential resolver is evaluated and enforces the `capture-runtime`
service identity during its compatibility handshake.

## v2 capture event streaming (SSE)

`CaptureClient.captureEvents(captureId, options?)` opens a cold, authenticated
SSE stream for a v2 capture:

```ts
client.captureEvents(captureId, { lastEventId }).subscribe({
  next: (event) => updateProgress(event),
});
```

`HttpCaptureClient` implements it with `fetch` plus `ReadableStream` parsing
against `/v2/captures/{captureId}/events`. Native `EventSource` is not used
because the stream requires an `Authorization` header, and bearer tokens are
never placed in URLs. Every subscription starts a fresh request and
unsubscribing aborts it. Pass `lastEventId` (an SSE sequence) to resume replay
after a reconnect; the runtime suppresses already-delivered events. Terminal
`completed`, `failed`, and `cancelled` events close the stream, and
`resync_required` tells consumers to reload the capture snapshot.

Host adapters that proxy the v2 endpoint must implement `captureEvents` and the
v2 operation methods. The first-party client no longer exposes the removed v1
capture methods; external consumers may keep importing deprecated wire types
until the coordinated Cert Prep/Law Prep migration gate closes.

## Structuring ownership

The default `runtime` mode uses Capture Runtime's isolated Ollama process and
model. A host that already owns an Ollama or another LLM provider can select
`host` mode and inject the narrow `CaptureStructuringProvider` interface:

```ts
import { provideCaptureStructuringProvider, type CaptureStructuringProvider } from '@gx-capture/capture-workbench';
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
import { provideCaptureWorkbenchInputs, type CaptureWorkbenchInputSource } from '@gx-capture/capture-workbench';

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
property-first. `@angular/elements` is a package-owned implementation
dependency. A package-owned loader initializes Angular's compiler before the
partially compiled FESM for non-Angular bundlers. Consumers import only
`@gx-capture/capture-workbench`; they do not import `@angular/elements` or
`@angular/compiler` directly:

```ts
import { CAPTURE_WORKBENCH_CUSTOM_EVENTS, defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx-capture/capture-workbench';

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

- `capture-review-required` — `CaptureReviewRequiredEvent`
- `capture-completed` — `CaptureCompletedEvent`
- `capture-failed` — `CaptureFailedEvent`
- `capture-canceled` — `CaptureTaskView`
- `capture-task-changed` — `CaptureTaskView`

Registration is idempotent across package service instances and repeated calls.
Re-registering a tag owned by this package succeeds; a tag owned by another
constructor fails explicitly. Failed startup does not poison the tag, so a
later registration attempt may retry after the underlying error is corrected.

The framework-neutral fixture is
[`fixtures/web-component/index.html`](./fixtures/web-component/index.html).
Install `@gx-capture/capture-workbench` from the configured NPM-compatible registry and
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

For normal browser and desktop WebView hosts, `hostCaptureClient` should call
the host backend. A sidecar bearer token must never enter the Web Component,
Angular state, DOM, URL, storage, log, or error/report payload.

For a direct loopback runtime client, keep the same strict CSP used by the
Tauri reference host: permit only `http://127.0.0.1:*` in `connect-src`, and
do not grant arbitrary HTTPS, `unsafe-eval`, or wildcard origins. The element
uses the existing CSS variables `--capture-accent`, `--capture-background`,
`--capture-foreground`, `--capture-muted`, `--capture-border`, and
`--capture-danger`. It preserves the package's runtime API-major and
`CaptureDocumentV1` schema handshake; element and runtime versions must remain
compatible.
