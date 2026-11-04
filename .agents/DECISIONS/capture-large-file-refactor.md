# Capture Workbench Large-File Refactor Decisions

## Status

Accepted on 2026-08-17 and closed on 2026-09-28. Decision 3 was replaced by
the DDD refactor plan on 2026-10-26.

## Decisions

1. Scope all tracked, human-maintained files under `apps/` and `packages/`,
   including tests, scripts, docs, and fixtures. Generated artifacts, release
   outputs, binaries, caches, and third-party files are excluded.
2. Preserve all public import paths, package exports, DI tokens, Tauri commands,
   runtime wire/schema/digest, persistence formats, and SDK APIs.
3. Code moves into bounded contexts with domain/application/infrastructure/api
   layers, built only where they hold code, as the DDD refactor plan
   (`.agents/PLANS/ddd-refactor/`, decision P1 of 2026-10-26) sets out. Thin
   wrapper layers are still rejected (see below).
4. Use injectable Angular collaborators, signals/`rxResource` for view state,
   and RxJS for asynchronous workflow/event pipelines. Do not add product-code
   async-boundary exceptions.
5. Keep `capture_runtime.contracts` and generated contract outputs in place.
   Keep `capture_runtime.contract_set`, SDK client modules, and Rust public
   modules as compatibility facades when private implementations move.
6. Add public-seam tests before extracting untested workflow behavior. Tests
   must not depend on private helpers or filenames.
7. Run implementation lanes in parallel only when their write sets are
   disjoint. Luna workers do not own `.agents`, `project.json`, generated
   assets, public entrypoints, or final integration.
8. Process smoke harness scripts after production refactors, while preserving
   their CLI paths, evidence schema, async-boundary rules, and release meaning.
9. Documentation coverage is advisory for this refactor; it is not an
   immediate CI-blocking gate.

## Rejected alternatives

- Breaking public APIs during a readability refactor.
- Splitting canonical contracts or generated codecs.
- Replacing RxJS workflow boundaries with Promise/async code.
- Creating thin wrapper layers solely to satisfy DDD folder names.
- Running all release/real-media smoke work in parallel with production edits.

## 2026-09-28 closeout

- Not splitting the remaining TypeScript SDK, Python SDK, and Tauri runtime
  client files: the largest are 560-850 lines, stable, and without open
  defects, so a split adds churn and regression risk for no concrete gain.
  Revisit only when a change in one of them becomes hard to review.
- Not refactoring the desktop smoke and evidence harnesses: their source-marker
  tests pin the current structure, and no defect needs the change.
- Public API documentation is prioritised by consumers: the published
  TypeScript and Python client SDKs are documented; launcher rustdoc remains a
  TODO.
