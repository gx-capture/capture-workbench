# @gx-capture/capture-contracts

Generated wire-contract artifacts for the Capture Runtime API v1 and the
authenticated streaming API v2. The canonical source is
`packages/capture-runtime/src/capture_runtime/contracts/__init__.py`; do not
edit anything under `src/generated/` by hand.

Regenerate and verify drift:

```powershell
corepack pnpm nx run capture-runtime:generate-contracts
corepack pnpm nx run capture-runtime:check-contracts
```

Build and smoke-test the independently installable artifacts:

```powershell
corepack pnpm nx run capture-contracts:build
corepack pnpm nx run capture-contracts:python-build
corepack pnpm nx run capture-contracts:python-smoke
corepack pnpm nx run capture-contracts:python-wheel-smoke
corepack pnpm nx run capture-contracts:pack
```

The TypeScript declarations are ergonomic structural types, not a replacement
for JSON Schema or Pydantic validation. Discriminated unions, `boundingBox`
tuple shape, and the pinned `CaptureDocumentV1` schema are generated from the
same runtime source. `allOf` composition, cross-field invariants, and every
schema constraint are not necessarily encoded in `contracts.ts`; the runtime
remains the canonical validator. Hosts can use `CAPTURE_CONTRACT_INVARIANTS` and
`CAPTURE_CONTRACT_EXTRA_POLICIES` as metadata for early client-side checks,
then submit candidates to the runtime validator.

`CAPTURE_DOCUMENT_V1_JSON_SCHEMA` is a browser-safe generated TypeScript
constant. The JSON copies under `generated/schemas/` remain release and
Python-loader artifacts; consumers should import the package constant instead
of maintaining a schema copy.

## v2 authenticated streaming contract

The generated declarations include `OpenIngestionV2`, `IngestionV2`,
`StartCaptureV2`, `CaptureOperationV2`, `PartialCaptureV2`, `CaptureEventV2`,
`RuntimeStreamingCapabilitiesV2`, and their streaming enums. The runtime owns
the HTTP behavior and validation; the package supplies types and schemas only.

Every `/v2` request requires `Authorization: Bearer <token>` and the runtime
must be reached through a host backend or trusted local process. Do not use a
browser `EventSource` directly when authentication requires a bearer header;
keep the sidecar URL and token outside Angular, Web Components, browser
storage, URLs, and logs. `GET /v2/captures/{captureId}/events` returns a
finite `text/event-stream` replay of durable events. Reconnect with
`Last-Event-ID` to receive only later sequence numbers; a `resync_required`
event requires refreshing the operation and partial/result snapshots.

The package version stays synchronized with the runtime (currently `0.3.12`).
The release workflow publishes both `@gx-capture/capture-contracts` and
`@gx-capture/capture-workbench` to GitHub Packages after validating their exact
tarball identities and integrities. The Python contract/structuring wheels and
the `capture-sidecar-launcher` crate retain their separate PyPI and crates.io
publication workflows; they are not replaced by the npm package.
