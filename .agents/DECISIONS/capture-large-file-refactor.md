# Capture Workbench Large-File Refactor Decisions

## Status

Accepted for implementation from HEAD
`351a53bbab6b1de2622d00f01d607206c9a9c6ea`.

## Decisions

1. Scope all tracked, human-maintained files under `apps/` and `packages/`,
   including tests, scripts, docs, and fixtures. Generated artifacts, release
   outputs, binaries, caches, and third-party files are excluded.
2. Preserve all public import paths, package exports, DI tokens, Tauri commands,
   runtime wire/schema/digest, persistence formats, and SDK APIs.
3. Keep existing repository conventions. Do not impose a workspace-wide
   `core/features/modules` or four-layer DDD layout.
4. Use injectable Angular collaborators, signals/`rxResource` for view state,
   and RxJS for asynchronous workflow/event pipelines. Do not add product-code
   async-boundary exceptions.
5. Keep `capture_runtime.contracts` and generated contract outputs in place.
   Keep `capture_runtime.contract_set`, SDK client modules, and Rust public
   modules as compatibility facades when private implementations move.
6. Freeze Java public DTO namespace and generated Java codecs; document public
   APIs without restructuring their compatibility surface.
7. Add public-seam tests before extracting untested workflow behavior. Tests
   must not depend on private helpers or filenames.
8. Run implementation lanes in parallel only when their write sets are
   disjoint. Luna workers do not own `.agents`, `project.json`, generated
   assets, public entrypoints, or final integration.
   The concrete write sets are recorded in the spec's
   `Implementation lane ownership` table and are checked before staging.
9. Process smoke harness scripts after production refactors, while preserving
   their CLI paths, evidence schema, async-boundary rules, and release meaning.
10. Documentation coverage is advisory for this refactor; it is not an
    immediate CI-blocking gate.

## Rejected alternatives

- Breaking public APIs during a readability refactor.
- Splitting canonical contracts or generated codecs.
- Replacing RxJS workflow boundaries with Promise/async code.
- Creating thin wrapper layers solely to satisfy DDD folder names.
- Running all release/real-media smoke work in parallel with production edits.
