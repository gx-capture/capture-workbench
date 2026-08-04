# @gx-capture/capture-contracts

Generated wire-contract artifacts for the Capture Runtime API v1. The canonical
source is `packages/capture-runtime/src/capture_runtime/contracts/__init__.py`;
do not edit anything under `src/generated/` by hand.

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
tuple shape, `allOf` composition, cross-field invariants, and every schema
constraint are not necessarily encoded in `contracts.ts`; the runtime remains
the canonical validator. Hosts can use `CAPTURE_CONTRACT_INVARIANTS` and
`CAPTURE_CONTRACT_EXTRA_POLICIES` as metadata for early client-side checks,
then submit candidates to the runtime validator.

The package version stays synchronized with the runtime (currently `0.3.9`).
The release workflow publishes both `@gx-capture/capture-contracts` and
`@gx-capture/capture-workbench` to GitHub Packages after validating their exact
tarball identities and integrities.
