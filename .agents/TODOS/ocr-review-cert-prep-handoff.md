# OCR Review and Cert Prep Handoff TODO

- [x] Add review contracts, opt-in config, and client confirmation seam.
  Verify: focused capture-angular typecheck and contract tests.
  Done: review contracts and confirmation seam in `capture-angular`.
- [x] Pause host workflow at raw extraction and implement review UI/actions.
  Verify: capture-angular workflow/host tests.
  Done: review workflow in `capture-angular.ts` with `capture-angular.workflow.spec.ts`.
- [x] Add review-required/completed custom events and documentation.
  Verify: custom-element event tests and package lint.
  Done: review events exposed by `capture-workbench-element-facade.ts`.
- [x] Add Cert Prep capture-review session persistence and coordinator split.
  Verify: focused backend capture-workbench tests.
  Done: Cert Prep `domains/capture_workbench/review_sessions.py` and `review_workflow.py`.
- [x] Add capture-review API routes and regenerate the Angular API client.
  Verify: OpenAPI/client generator tests and backend contract tests.
  Done: Cert Prep review routes in `api/app.py`; regenerated `libs/cert-prep-api`.
- [x] Persist review overlay while preserving raw OCR provenance.
  Verify: backend persistence and Markdown tests.
  Done: Cert Prep review sessions keep the raw OCR result alongside the review overlay.
- [x] Run real PDF review/confirm smoke and all relevant Nx regressions.
  Verify: real-PDF smoke, lint, typecheck, test, and git diff --check.
  Done: Cert Prep packaged flow smoke covers review; published-mode practical OCR passed 2026-09-27.
