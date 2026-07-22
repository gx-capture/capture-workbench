# @wodenwang820118/capture-angular

Publishable Angular UI and transport contracts for Capture Runtime. The package
owns runtime setup, file preprocessing, queued capture jobs, progress,
cancellation, raw diagnostics, and JSON/text export.

Install the pinned GitHub Packages version with a token that has only
`read:packages` access. Consumer Actions jobs should declare `contents: read`
and `packages: read`; they do not need write permissions.

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
import { provideCaptureClient } from '@wodenwang820118/capture-angular';

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
import { provideHttpCaptureClient } from '@wodenwang820118/capture-angular';

const backendConfig = invoke<{
  baseUrl: string;
  token: string;
}>('backend_config');

bootstrapApplication(App, {
  providers: [
    provideHttpCaptureClient({
      baseUrl: async () => (await backendConfig).baseUrl,
      bearerToken: async () => (await backendConfig).token,
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
import { provideCaptureStructuringProvider, type CaptureStructuringProvider } from '@wodenwang820118/capture-angular';

const provider: CaptureStructuringProvider = {
  async structure({ raw, documentContract, signal, reportProgress }) {
    return hostBackend.structureCapture(raw, {
      schemaVersion: documentContract.schemaVersion,
      jsonSchema: documentContract.jsonSchema,
      signal,
      reportProgress,
    });
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

```html
<capture-workbench
  [config]="{
    structuringMode: 'host',
    outputMode: 'json',
    width: '48rem',
    height: '75vh',
    theme: { accent: '#7c3aed' }
  }"
  (completed)="saveDocument($event.document)"
/>
```

Use `provideCapturePreprocessor()` or the component `preprocessor` input for a
crop/normalization seam before upload. The seam must preserve abort semantics
and return the `File` that should be hashed and captured.

## Web Component

TODO for a later release: custom-element wrapper, properties/attributes,
framework-neutral `CustomEvent` payloads, a non-Angular fixture, and public
documentation. No custom element is shipped in v1.
