# Local NPM Registry Cert Prep Trial Decision

> Status: Retired. The local Verdaccio trial is historical evidence only; its
> publisher, configuration, and test have been removed after published-consumer
> gates became the canonical verification path.
> The sections below record the historical decision and are not current
> implementation guidance.

## Accepted approach

Use Verdaccio on `127.0.0.1:4873` as a local npm-compatible registry. Publish
the packed `@gx-capture/capture-workbench-ui` tarball there, then let cert-prep's isolated
trial consumer run ordinary `pnpm install` against that registry.

## Rejected alternatives

- A direct `file:.tgz` dependency proves tarball installation but does not model
  registry metadata, scope routing, or package publication.
- Adding the localhost registry to cert-prep's shared `.npmrc` would make normal
  development and CI depend on a developer-local process.
- Replacing `@cert-prep/capture-ui` is outside this distribution trial because
  its `CaptureAdapter` contract is different from Capture Workbench's
  `CaptureClient` contract.

## Operational boundary

The trial owns package distribution and browser-consumer compatibility only.
Backend mapping, runtime endpoints, persistence, and source-import behavior
remain cert-prep-owned until a separate adapter contract is approved.
