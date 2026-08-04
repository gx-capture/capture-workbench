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
```

The package is not yet published. Its version stays synchronized with the
runtime (currently `0.3.9`).
