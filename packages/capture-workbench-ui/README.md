# @gx-capture/capture-workbench-ui

Publishable Capture Workbench UI and transport contracts for Capture Runtime. The package
owns runtime setup, file preprocessing, queued capture jobs, progress,
cancellation, raw diagnostics, and JSON/text export.

When release policy permits consumer verification, use a GitHub Packages token
that has only `read:packages` access. Consumer Actions jobs should declare
`contents: read` and `packages: read`; they do not need write permissions.

Configure the scope without committing the token (the repository root includes
the same `.npmrc.example`):

```ini
@gx-capture:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

> Phase 2 checkpoint (2026-09-10): this checkout is documentation/design-only.
> It does not assert that any release is published or that registry bytes exist.
> D4/D7 acceptance records are producer-owned; a consumer never writes the
> producer scope, semantic-result, or acceptance-wire paths.
> D6 immutable public downloads are permitted and required for D7 verification:
> D7 installs/uses only the exact bytes bound by the D6 ledger, before D8.
> Ordinary stable or mutable-pointer consumer installation waits until D8
> stable-pointer promotion in the canonical Phase 2 delivery state machine.
> Until D6, do not install from a mutable pointer or infer release identity
> from this source tree.

## Angular integration contract

All public asynchronous client, provider, preprocessor, and reconciliation
context methods return cold `Observable<T>` values. Compose them with RxJS and
subscribe at the application boundary; no Promise compatibility adapter is
provided. Angular runtime state is exposed through signals backed by
`rxResource`, while store commands such as `refreshRuntime()` remain `void` and
publish their result through signals/events. `defineCaptureWorkbenchElement()`
also returns an `Observable<void>` and should be subscribed during startup.

Successful output is always the runtime-validated `CaptureDocument`. A
structuring failure may expose `RawCapture` with `diagnosticOnly: true`, but
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
import { provideCaptureClient } from '@gx-capture/capture-workbench-ui';

bootstrapApplication(App, {
  providers: [provideCaptureClient(certPrepCaptureClient)],
});
```

When that backend also invokes the host's existing LLM provider, configure
`structuringMode: 'host'` and `hostStructuringOwner: 'client'`. The v2 client
uses `captureEvents()` for authenticated SSE and the streaming operation
methods for snapshot/reconciliation. The host commits a validated candidate
with `commitStreamingStructuredResult()` or reports a terminal failure with
`reportStreamingStructuringFailure()`; the package never receives a bearer
token or invokes an LLM provider in the WebView.

Do not put a sidecar bearer token in a URL, browser log, or `localStorage`.

`HttpCaptureClient` is the RxJS adapter over the canonical TypeScript Runtime
SDK. It accepts only a host-owned `RuntimeTransport`; sidecar origins and bearer
credentials are deliberately absent from the Angular/WebView API. Its
readiness call performs strict `/meta/v2/contracts` discovery, validates the
content-addressed bundle against the release allowlist, and rejects any
non-`capture-runtime` service identity.

## v2 capture event streaming (SSE)

`CaptureClient.captureEvents(captureId, options?)` opens a cold, authenticated
SSE stream for a v2 capture:

```ts
client.captureEvents(captureId, { lastEventId }).subscribe({
  next: (event) => updateProgress(event),
});
```

`HttpCaptureClient` delegates the stream to the TypeScript SDK through the
host-provided transport and exposes it as a cold RxJS Observable. Native
`EventSource` is not used. Every subscription starts a fresh request and
unsubscribing aborts it. Pass `lastEventId` (an SSE sequence) to resume replay
after a reconnect; the runtime suppresses already-delivered events. Terminal
`completed`, `failed`, and `cancelled` events close the stream, and
`resync_required` tells consumers to reload the capture snapshot.

Host adapters that proxy the v2 endpoint must implement `captureEvents`,
`startStreamingCapture`, `getStreamingCapture`, `cancelStreamingCapture`,
`getStreamingPartial`, `getStreamingResult`,
`commitStreamingStructuredResult`, `reportStreamingStructuringFailure`, and
`deleteStreamingCapture`. The first-party client exposes only the canonical v2
capture methods and public DTOs. Generated wire codecs remain private
implementation details.

The host commit boundary is `POST /v2/captures/{captureId}/structure/commit`
with a full `CaptureDocument` candidate and an idempotency key. The runtime
validates schema, locator/order, non-empty text, and raw provenance before
terminal completion. Host failure uses
`POST /v2/captures/{captureId}/structure/failure` with `{ code, message }` and
terminates at `failed/structuring`; source and document persistence remains
host-owned because runtime capture state is ephemeral.

## Structuring ownership

The default `runtime` mode uses Capture Runtime's isolated Ollama process and
model. A host that already owns an Ollama or another LLM provider can select
`host` mode and inject the narrow `CaptureStructuringProvider` interface:

```ts
import { provideCaptureStructuringProvider, type CaptureStructuringProvider } from '@gx-capture/capture-workbench-ui';
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
`CaptureDocument` candidate. The component submits that candidate to the
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
import { provideCaptureWorkbenchInputs, type CaptureWorkbenchInputSource } from '@gx-capture/capture-workbench-ui';

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
`@gx-capture/capture-workbench-ui`; they do not import `@angular/elements` or
`@angular/compiler` directly:

```ts
import { CAPTURE_WORKBENCH_CUSTOM_EVENTS, defineCaptureWorkbenchElement, type CaptureWorkbenchElement } from '@gx-capture/capture-workbench-ui';

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
For D7 published acceptance, install the exact immutable package version and
runtime bytes identified by the D6 download-back ledger; this exact install is
required before D8 and must not resolve through `stable`, `latest`, or another
mutable pointer. After D8 stable-pointer promotion, ordinary consumers may
follow the stable channel and install from the configured NPM-compatible
registry. The package does not publish a standalone browser
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
`CaptureDocument` schema handshake; element and runtime versions must remain
compatible.
