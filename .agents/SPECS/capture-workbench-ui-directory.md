# Capture Workbench UI Directory Rename Spec

## Purpose

Rename the publishable UI package from its legacy Angular-named directory to
`packages/capture-workbench-ui` so its filesystem identity matches the public
`@gx-capture/capture-workbench-ui` package.

## Non-Goals

- Do not rename the public NPM package.
- Do not rename the Nx project id `capture-angular`.
- Do not rename internal Angular component or source-folder identifiers.
- Do not change runtime behavior or published API contracts.

## Key Decisions

- Update every live source, build-output, release-tooling, and repository metadata
  path that points at the legacy package directory.
- Preserve Git history by recording the package tree as a rename.

## Acceptance Criteria

- The package is tracked under `packages/capture-workbench-ui` and no tracked path
  remains under the legacy directory.
- No live repository reference uses the retired package or dist path.
- Nx resolves `capture-angular` with `packages/capture-workbench-ui` as its root.
- Lint, typecheck, tests, build, pack, and clean consumer smoke pass through Nx.

## Test Plan

- Search tracked content and paths for the retired package directory.
- Run `pnpm nx show project capture-angular --json`.
- Run the affected `capture-angular` Nx targets without relying on cache.
