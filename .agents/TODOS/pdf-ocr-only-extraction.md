# PDF OCR-only extraction TODO

- [x] Replace embedded/mixed PDF extraction with all-page OCR worker dispatch.
  Verify: `pnpm nx run capture-runtime:test-unit --skip-nx-cache`

- [x] Make the OCR worker enumerate, bound, render, and recognize every PDF page.
  Verify: `pnpm nx run capture-runtime:test-unit --skip-nx-cache`

- [x] Add an explicit bounded PDF page-prefix seam for Phase 1 while retaining
  all-page behavior for callers that omit it; expose source/requested/processed
  page evidence through raw capture output.
  Verify: `pnpm nx run capture-runtime:test-unit --skip-nx-cache` and the
  packaged desktop OCR acceptance manifest.

- [x] Remove production `pypdf` code/dependency and refresh the lockfile.
  Verify: `pnpm nx run capture-runtime:lint --skip-nx-cache` and
  `pnpm nx run capture-runtime:typecheck --skip-nx-cache`

- [x] Gate Cert Prep PDF admission on `windowsml-ocr` in frontend and backend.
  Verify: `pnpm nx run cert-prep:test --skip-nx-cache` and
  `pnpm nx run cert-prep-backend:test --skip-nx-cache`

- [x] Update current behavior specs and deterministic package assertions.
  Verify: `pnpm nx run cert-prep-desktop:package-qa-test --skip-nx-cache`

- [x] Split runtime unit, integration, local-package E2E, and online-package E2E
  into independently collected directories and Nx targets.
  Verify: `pnpm nx run-many -t test-unit test-integration -p capture-runtime --parallel=2 --skip-nx-cache`

- [x] Build the local runtime release and run the real-runtime PDF OCR E2E.
  Verify: `pnpm nx run capture-runtime:e2e-local-package-pdf-ocr --skip-nx-cache`
  with the 2024-07 N1 PDF, 44 expected pages, and exact manually transcribed
  samples from pages 2, 8, 15, 22, 29, 36, 41, and 44 (81 normalized
  characters matched).

- [ ] After a package containing this change is published, run the official
  online-package E2E with the same PDF semantics.
  Verify: `pnpm nx run capture-runtime:e2e-online-package-pdf-ocr --skip-nx-cache`
