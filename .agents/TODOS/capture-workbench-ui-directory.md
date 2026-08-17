# Capture Workbench UI Directory Rename TODO

- [x] Move the legacy UI package directory to `packages/capture-workbench-ui`.
  Verify: `git ls-files packages/capture-workbench-ui`
- [x] Update package, build-output, release-tooling, and documentation paths.
  Verify: search tracked content and paths for the retired directory name.
- [x] Verify the renamed Nx package and its packaged consumers.
  Verify: `pnpm nx run capture-angular:lint --skip-nx-cache`, `typecheck`, `test`,
  `build`, `pack`, and `clean-consumer-smoke`
- [x] Review and commit only the directory rename slice.
  Verify: `git diff --cached --name-only` and `git diff --cached --check`
