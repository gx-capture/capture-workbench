# Web Component and Runtime Baselines

## Purpose

Ship `capture-workbench` as a framework-neutral custom element without changing
`CaptureDocumentV1`, while aligning the published package scope and the
workspace runtime baselines with the product requirements.

## Interfaces

- `defineCaptureWorkbenchElement()` registers the `capture-workbench` custom
  element and resolves after its Angular application context is available.
- The `config` attribute is a JSON object. The `config` property accepts a
  `CaptureWorkbenchConfig` object and does not reflect it back to an attribute.
- `client`, `structuringProvider`, and `preprocessor` are object-only
  properties; no credential-bearing value is serialized to an attribute.
- DOM events are stable, bubbling, composed `CustomEvent`s:
  `capture-completed`, `capture-failed`, `capture-canceled`,
  `capture-task-changed`, and `capture-config-error`.
- The publishable package name becomes `@gx/capture-angular`. The actual
  GitHub repository owner, release URLs, and copyright holder stay unchanged.
- `tools/*.mjs` and desktop harness `scripts/*.mjs` become `.ts`; Node 24
  executes these type-strippable TypeScript files directly. ESLint's flat
  configuration files remain `.mjs`, because they are tool configuration rather
  than application or verification scripts.
- The workspace requires Node `>=24.0.0` and pnpm `>=11.0.0`.

## Non-goals

- Changing the `CaptureDocumentV1` schema, runtime API, or provenance rules.
- Moving or renaming the existing GitHub repository.
- Serializing a `CaptureClient`, provider, preprocessor, or bearer token into
  HTML attributes.
- Converting ESLint flat-configuration files, which are loaded by the existing
  ESLint toolchain rather than executed as workspace scripts.

## Edge Cases

- An invalid `config` attribute leaves the previous valid configuration in
  place and emits `capture-config-error`; it does not throw from the custom
  element lifecycle callback.
- An element can be disconnected and reconnected; its component view and
  output subscriptions are always cleaned up before remounting.
- Repeated registration of the same tag is idempotent. A supplied tag name
  must be a valid custom-element name.

## Acceptance Criteria

- A non-Angular HTML fixture can register, configure, and consume
  `capture-workbench` with stable event names.
- The wrapper forwards object properties to the Angular component without
  changing its Angular input/output API or `CaptureDocumentV1` contracts.
- All root `tools/*.mjs` and desktop harness `scripts/*.mjs` files and their
  references are replaced by `.ts`.
- Every published package/import reference uses `@gx/capture-angular`.
- Local and CI configuration enforce Node 24 and pnpm 11 or newer.

## Verification

- `pnpm nx run capture-angular:test`
- `pnpm nx run capture-angular:clean-consumer-smoke`
- `pnpm nx run capture-workbench-desktop:package-qa-test`
- `pnpm verify`
